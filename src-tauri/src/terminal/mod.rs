//! PTY lifecycle management for Eldrun terminals.
//!
//! Design constraints from TauriRust.md Phase 3:
//! - portable-pty for cross-platform PTY creation.
//! - Bounded per-PTY output channels (backpressure via mpsc).
//! - Batched/throttled Tauri events (max one emit per 16 ms mid-burst; the
//!   first chunk after quiet flushes immediately, and an idle PTY parks with
//!   no timer at all — see `batch_output`).
//! - UTF-8 lossy output; binary-safe read loop.
//! - Crash-loop protection: tracks last-exit timestamps.
//! - Explicit terminal-ready event when the shell starts.
//! - Linux XDG sandbox env in a cfg(target_os="linux") block.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ── Constants ─────────────────────────────────────────────────────────────

const BATCH_INTERVAL: Duration = Duration::from_millis(16);
const BATCH_MAX_BYTES: usize = 4096;
#[allow(dead_code)]
const MIN_RESTART_INTERVAL: Duration = Duration::from_secs(2);
const CRASH_LOOP_THRESHOLD: usize = 5;
pub const SCROLLBACK_LIMIT: usize = 5000;

/// Internal channel capacity — limits buffered output chunks.
const CHANNEL_CAP: usize = 64;

// ── Visible-only streaming ────────────────────────────────────────────────
//
// A hidden pane's PTY used to stream every chunk over IPC anyway: the frontend
// buffered it instead of feeding xterm (its half of the fix), but each emit
// still woke the GTK main thread and a JS listener — with dozens of streaming
// agent tabs the renderer was poked constantly and never reached idle, which
// is what forfeits the scheduler's interactive fast path
// (docs/typing_latency_plan.md). So the gate moved backend-side: a PTY whose
// pane is hidden stops emitting `terminal-output` entirely. Its output
// accumulates in an in-Rust `pending` buffer (front-trimmed at
// `ROUTE_PENDING_CAP`; agent TUIs repaint whole screens, so the replay
// converges on the current frame), and the pills stay honest through
// `terminal-activity` digests: the accumulated tail, emitted leading-edge and
// then at most once per `ACTIVITY_INTERVAL`, with a trailing flush so the
// decision prompt that arrives right before quiet is still reported.
//
// Showing the pane again (`pty_set_visible`) drains `pending` as ONE
// `terminal-replay` event — a separate event name because replayed output is
// STALE output written late: the frontend must route it through its
// stripTerminalQueries guard, never a bare `term.write` (a terminal query in
// it would be answered on parse and typed into the shell). The drain is
// emitted while the routes lock is held; every live chunk emit also takes
// that lock first, so the replay provably precedes any output produced after
// the flip.
//
// `watchers` is the override for consumers that scan a possibly-hidden PTY's
// raw stream for markers (`useRemoteSession`/`useRemoteReconnect`'s login
// terminals): while a watch is held the PTY streams `terminal-output` as if
// visible. A watch's rising edge drains `pending` the same way, so the hidden
// pane's own buffer stays in byte order across the watch.

/// How often a hidden PTY's buffered output is condensed into a
/// `terminal-activity` digest. Must stay well under the activity store's
/// BUSY_WINDOW_MS (800 ms): the "working" classifier treats a gap that long
/// as the end of a burst, so a slower cadence would make every hidden
/// streaming tab read as idle between digests.
const ACTIVITY_INTERVAL: Duration = Duration::from_millis(500);

/// How much hidden-spell output is retained for the show-again replay.
/// Mirrors the frontend's PENDING_OUTPUT_CAP.
const ROUTE_PENDING_CAP: usize = 1_000_000;

/// How much tail one `terminal-activity` digest carries — enough for the
/// activity store's 8 KB decision-prompt scan.
const ACTIVITY_TAIL_CAP: usize = 8192;

/// Per-PTY routing state. `visible` defaults to true so a freshly spawned PTY
/// streams until its pane reports otherwise (the safe direction: at worst it
/// costs what every PTY used to cost).
struct OutputRoute {
    visible: bool,
    watchers: u32,
    /// Output accumulated while unsubscribed, replayed on the next rising edge.
    pending: Vec<u8>,
    /// Output since the last activity digest (tail-capped).
    digest: Vec<u8>,
    /// When the last digest was emitted; `None` = the next one is leading-edge.
    last_activity: Option<Instant>,
    /// A trailing-flush task is sleeping toward `last_activity + interval`.
    digest_armed: bool,
    /// Spawn generation, so a respawn under the same id survives the previous
    /// spawn's task-end cleanup.
    seq: u64,
}

impl Default for OutputRoute {
    fn default() -> Self {
        Self {
            visible: true,
            watchers: 0,
            pending: Vec::new(),
            digest: Vec::new(),
            last_activity: None,
            digest_armed: false,
            seq: 0,
        }
    }
}

impl OutputRoute {
    fn subscribed(&self) -> bool {
        self.visible || self.watchers > 0
    }

    /// Drain the hidden-spell buffer for a replay emit. Also drops the digest:
    /// its bytes are a subset of `pending` and have just been delivered.
    fn take_pending(&mut self) -> Option<String> {
        self.digest.clear();
        if self.pending.is_empty() {
            return None;
        }
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        Some(text)
    }
}

fn routes() -> &'static Mutex<HashMap<String, OutputRoute>> {
    static ROUTES: OnceLock<Mutex<HashMap<String, OutputRoute>>> = OnceLock::new();
    ROUTES.get_or_init(|| Mutex::new(HashMap::new()))
}

static ROUTE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Trim with hysteresis (the frontend buffer's rule): cutting exactly to the
/// cap on every chunk past it re-copies the whole buffer per chunk; letting it
/// grow to 2× and cutting back costs one copy per cap's worth of new output.
/// The cut may land mid-UTF-8-sequence; the lossy conversion at read time
/// degrades that to one replacement char, same as the frontend's slice did.
fn trim_with_hysteresis(buf: &mut Vec<u8>, cap: usize) {
    if buf.len() > cap * 2 {
        let cut = buf.len() - cap;
        buf.drain(..cut);
    }
}

/// What the batcher should do with one flushed chunk.
enum Routed {
    /// Subscribed: emit as ordinary `terminal-output`.
    Data(String),
    /// Hidden, digest due: emit as `terminal-activity`.
    Activity(String),
    /// Hidden, inside the digest window: spawn a trailing flush for this
    /// deadline (nothing was armed yet).
    ArmDigest(Instant),
    /// Hidden, a trailing flush is already armed: nothing to do.
    Quiet,
}

fn route_chunk_at(id: &str, bytes: &[u8], now: Instant) -> Routed {
    let mut map = routes().lock().unwrap();
    let route = map.entry(id.to_string()).or_default();
    if route.subscribed() {
        return Routed::Data(String::from_utf8_lossy(bytes).into_owned());
    }
    route.pending.extend_from_slice(bytes);
    trim_with_hysteresis(&mut route.pending, ROUTE_PENDING_CAP);
    route.digest.extend_from_slice(bytes);
    trim_with_hysteresis(&mut route.digest, ACTIVITY_TAIL_CAP);
    let due = route
        .last_activity
        .is_none_or(|t| now.duration_since(t) >= ACTIVITY_INTERVAL);
    if due {
        route.last_activity = Some(now);
        let text = String::from_utf8_lossy(&route.digest).into_owned();
        route.digest.clear();
        Routed::Activity(text)
    } else if !route.digest_armed {
        route.digest_armed = true;
        // `!due` implies `last_activity` is Some.
        Routed::ArmDigest(route.last_activity.unwrap() + ACTIVITY_INTERVAL)
    } else {
        Routed::Quiet
    }
}

fn route_chunk(id: &str, bytes: &[u8]) -> Routed {
    route_chunk_at(id, bytes, Instant::now())
}

/// The trailing digest flush: drain whatever the window's remaining chunks
/// left, so the last output before a quiet spell (the decision prompt, above
/// all) always reaches the activity store.
fn route_digest_take_at(id: &str, now: Instant) -> Option<String> {
    let mut map = routes().lock().unwrap();
    let route = map.get_mut(id)?;
    route.digest_armed = false;
    if route.subscribed() || route.digest.is_empty() {
        return None;
    }
    route.last_activity = Some(now);
    let text = String::from_utf8_lossy(&route.digest).into_owned();
    route.digest.clear();
    Some(text)
}

fn route_digest_take(id: &str) -> Option<String> {
    route_digest_take_at(id, Instant::now())
}

/// Register a (re)spawn: keep the pane's visibility and any watchers, drop
/// stale buffers, and mint the generation the task-end cleanup is guarded by.
fn route_open(id: &str) -> u64 {
    let seq = ROUTE_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let mut map = routes().lock().unwrap();
    let route = map.entry(id.to_string()).or_default();
    route.pending.clear();
    route.digest.clear();
    route.last_activity = None;
    route.seq = seq;
    seq
}

/// Task-end cleanup, guarded by generation so an old spawn's exit can never
/// remove the route a respawn under the same id just opened.
fn route_close(id: &str, seq: u64) {
    let mut map = routes().lock().unwrap();
    if map.get(id).is_some_and(|r| r.seq == seq) {
        map.remove(id);
    }
}

/// Emit a rising edge's replay while STILL holding the routes lock: every live
/// chunk emit also takes this lock first (`route_chunk`), so the replay is
/// guaranteed to precede any output produced after the flip.
fn emit_replay(app: &AppHandle, id: &str, route: &mut OutputRoute) {
    if let Some(text) = route.take_pending() {
        let _ = app.emit(
            "terminal-replay",
            TerminalOutput { id: id.to_string(), data: text },
        );
    }
}

/// The pane's visibility report (`pty_set_visible`).
pub fn route_set_visible(app: &AppHandle, id: &str, visible: bool) {
    let mut map = routes().lock().unwrap();
    let route = map.entry(id.to_string()).or_default();
    let was = route.subscribed();
    route.visible = visible;
    if !was && route.subscribed() {
        emit_replay(app, id, route);
    }
}

/// A marker-watcher's hold (`pty_watch`): stream this PTY as if visible.
pub fn route_watch(app: &AppHandle, id: &str) {
    let mut map = routes().lock().unwrap();
    let route = map.entry(id.to_string()).or_default();
    let was = route.subscribed();
    route.watchers += 1;
    if !was {
        emit_replay(app, id, route);
    }
}

/// Release a watch. Unbalanced releases are harmless (saturating), and a
/// watch leaked by a webview reload merely leaves the PTY streaming — today's
/// behaviour, the fail-open direction.
pub fn route_unwatch(id: &str) {
    let mut map = routes().lock().unwrap();
    if let Some(route) = map.get_mut(id) {
        route.watchers = route.watchers.saturating_sub(1);
    }
}

// ── Public data types ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyOptions {
    pub id: String,
    pub cmd: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    /// When true, never rewrite this spawn to run over ssh even if its `cwd`
    /// lives under a remote project's mountpoint. Set for locally-bound tabs
    /// (e.g. Ollama `local_agent` tabs that depend on local `VIBE_HOME`).
    #[serde(default)]
    pub local_only: bool,
    /// When true, run this (agent) tab inside a Docker sandbox that mounts only
    /// the project directory. Set by the frontend only for `kind:"agent"` tabs
    /// of a project whose sandbox toggle is enabled. See `services::sandbox`.
    #[serde(default)]
    pub sandbox: bool,
    /// The owning project's id, set by the frontend for tabs that belong to a
    /// project scope (not the root scope). It makes remoteness **explicit**: the
    /// ssh-wrap spawn path resolves the project's `RemoteSpec` from this id (via
    /// `services::remote::remote_target_for`) instead of sniffing whether `cwd`
    /// lives under the sshfs mounts root. `None` for root/connection terminals
    /// (and any spawn path not yet updated), where the cwd-sniffing fallback
    /// still applies. Harmless for local projects — they resolve to no remote.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Which of the project's remote hosts this tab runs on
    /// (`docs/multi_host_remote_plan.md`): `None`/`"primary"` = the primary remote
    /// (`Project.remote`), any other id = an extra "worker" host from
    /// `compute_hosts`. Set by the frontend from the tab's `host:<id>` location.
    /// Ignored for a local project (resolves to no remote).
    #[serde(default)]
    pub remote_host_id: Option<String>,
    /// Persistent remote session (TODO #85): the **stable tmux session name** to
    /// spawn-or-attach on the host, wrapping the spawn in `tmux new-session -A` so
    /// the run survives an SSH drop / laptop sleep / Eldrun relaunch. The frontend
    /// mints it once per shell tab and **persists it** (`TabEntry.tmuxSession`), so
    /// it is stable across a relaunch even though the tab's PTY id (`scope:key`) is
    /// regenerated on restore — that stability is what makes reattach work. Set
    /// only for remote shell/script tabs of a persist-enabled project (agent tabs
    /// are excluded — they resume via their own session). `None`/local → no wrap.
    #[serde(default)]
    pub tmux_session: Option<String>,
    /// Attach this tab to an **existing named** tmux session on the host instead
    /// of spawning a fresh one (TODO #85): set when a tab is opened from the
    /// Sessions view onto a running (possibly hand-started) session, and persisted
    /// so the tab reattaches to that same session across a restart. Takes
    /// precedence over `tmux_session` when set. No-op for a local project.
    #[serde(default)]
    pub tmux_attach: Option<String>,
    /// The tab's **host-bound marker id** — the frontend-minted, layout-persisted
    /// uuid of a local-model driver tab that is allowed to run on the host rather
    /// than inside the project's container (`services::sandbox`).
    ///
    /// It is only an *index*: the grant itself is a file under
    /// `<state_dir>/sessions/<project>/host_bound/`, written when the tab is
    /// genuinely created. This replaced keying that decision on the tab's
    /// `ELDRUN_LOCAL_MODEL` env var, which is a usage-recap label.
    #[serde(default)]
    pub host_bound_uid: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalOutput {
    pub id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalExit {
    pub id: String,
    pub code: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalReady {
    pub id: String,
}

// ── Internal entry ─────────────────────────────────────────────────────────

struct PtyEntry {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    dead: Arc<AtomicBool>,
    crash_times: Vec<Instant>,
}

/// Invalidate the cached process tree used for CPU sampling. Called whenever a
/// PTY is spawned or dies so the next `sysstat::descendant_pids` rebuilds rather
/// than reusing a stale walk. `sysstat` is cross-platform (Linux/Windows sample,
/// other OSes return zero), so this is a plain atomic bump everywhere.
fn invalidate_proc_tree_cache() {
    crate::sysstat::invalidate_descendant_cache();
}

/// How aggressively [`reap_child_subtree`] signals a doomed process subtree.
pub(crate) enum ReapMode {
    /// SIGTERM now, then SIGKILL any survivors after a short grace period on a
    /// detached thread. Used on tab close / respawn, where the app stays alive
    /// long enough to deliver the escalation.
    Graceful,
    /// SIGKILL immediately. Used at app exit, where a delayed escalation thread
    /// would be torn down with the process before it could fire.
    Immediate,
    /// SIGTERM now, then SIGKILL whatever is still alive when `grace` runs out —
    /// escalated on the **calling** thread, and returning as soon as the subtree
    /// is gone. This is the mode for an exit-time teardown that must let the
    /// process shut itself down first: [`ReapMode::Graceful`]'s escalation thread
    /// dies with the app before it can fire, and [`ReapMode::Immediate`] never
    /// offers the chance. The caller pays the wait, so keep the grace short.
    ///
    /// The grace is unread on Windows, where `TerminateProcess` is the only
    /// per-pid primitive and every mode reaps immediately.
    GracefulBlocking(#[cfg_attr(not(unix), allow(dead_code))] Duration),
}

/// Best-effort abort of a PTY child's **entire process subtree**.
///
/// `portable_pty`'s [`Child::kill`] signals only the shell leader; anything it
/// spawned (a dev server, a build, a training run) is otherwise orphaned and
/// keeps running after its tab — or the whole app — is gone. So we walk the
/// subtree rooted at the leader and signal every pid. The walk must happen
/// *before* the leader is killed: once it dies its children reparent to init and
/// the tree rooted at its pid is no longer reachable.
///
/// The leader pid is included in the returned set; re-signalling a leader the
/// caller also `Child::kill`s is a harmless no-op (a dead pid yields ESRCH).
pub(crate) fn reap_child_subtree(leader_pid: u32, mode: ReapMode) {
    // Force a fresh process-tree walk rather than reusing a cached CPU sample
    // that may predate a just-spawned child.
    crate::sysstat::invalidate_descendant_cache();
    let subtree = crate::sysstat::descendant_pids(&[leader_pid]);
    reap_pids(subtree, mode);
}

/// Signal a set of pids best-effort. Every pid came from a live process walk
/// moments earlier, so a stale one is expected and ignored (ESRCH on Unix, a
/// failed `OpenProcess` on Windows).
#[cfg(unix)]
fn reap_pids(pids: Vec<u32>, mode: ReapMode) {
    if pids.is_empty() {
        return;
    }
    // SAFETY: `libc::kill` takes no pointers and a real signal number; a stale
    // pid returns ESRCH, which we ignore.
    let signal = |pids: &[u32], sig: libc::c_int| unsafe {
        for &pid in pids {
            libc::kill(pid as libc::pid_t, sig);
        }
    };
    match mode {
        ReapMode::Immediate => signal(&pids, libc::SIGKILL),
        ReapMode::Graceful => {
            signal(&pids, libc::SIGTERM);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2));
                signal(&pids, libc::SIGKILL);
            });
        }
        ReapMode::GracefulBlocking(grace) => {
            signal(&pids, libc::SIGTERM);
            let deadline = Instant::now() + grace;
            while Instant::now() < deadline {
                // SAFETY: `kill(pid, 0)` probes existence without signalling.
                let any_alive = pids
                    .iter()
                    .any(|&pid| unsafe { libc::kill(pid as libc::pid_t, 0) } == 0);
                if !any_alive {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            signal(&pids, libc::SIGKILL);
        }
    }
}

/// Windows has no SIGTERM/SIGKILL split — `TerminateProcess` is the only per-pid
/// primitive — so both modes reap immediately.
#[cfg(windows)]
fn reap_pids(pids: Vec<u32>, _mode: ReapMode) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    for pid in pids {
        // SAFETY: the handle is closed before the next iteration; a failed open
        // (the pid already exited) is ignored.
        unsafe {
            if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                let _ = TerminateProcess(handle, 1);
                let _ = CloseHandle(handle);
            }
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn reap_pids(_pids: Vec<u32>, _mode: ReapMode) {}

// ── PtyRegistry ───────────────────────────────────────────────────────────

#[derive(Default)]
pub struct PtyRegistry {
    entries: HashMap<String, PtyEntry>,
    /// PTY ids that have been spawned at least once this app run. Never cleared
    /// (ids are unique per tab for the life of the app), so it records whether a
    /// later `spawn_pty` for the same id is a re-spawn — see `spawn_pty`'s
    /// `--session-id` → `--resume` rewrite. Survives webview reloads because the
    /// registry lives in the persistent Rust process, not the renderer.
    seen: HashSet<String>,
}

impl PtyRegistry {
    pub fn insert(
        &mut self,
        id: String,
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        child: Box<dyn Child + Send + Sync>,
        dead: Arc<AtomicBool>,
    ) {
        // A spawn that reuses an id must not leak the previous child process,
        // and must keep its crash history so the crash-loop guard stays armed.
        let crash_times = match self.entries.remove(&id) {
            Some(mut old) => {
                old.dead.store(true, Ordering::SeqCst);
                // A respawn under the same id replaces the old child; reap its
                // whole subtree, not just the leader, so a process it spawned
                // does not survive the tab it belonged to.
                if let Some(pid) = old.child.process_id() {
                    reap_child_subtree(pid, ReapMode::Graceful);
                }
                let _ = old.child.kill();
                old.crash_times
            }
            None => Vec::new(),
        };
        self.entries.insert(
            id,
            PtyEntry {
                master,
                writer,
                child,
                dead,
                crash_times,
            },
        );
        // A new child (and the old one it may have replaced) changes the process
        // tree, so drop the cached descendant-pid set.
        invalidate_proc_tree_cache();
    }

    pub fn write(&mut self, id: &str, data: &[u8]) -> std::io::Result<()> {
        if let Some(e) = self.entries.get_mut(id) {
            e.writer.write_all(data)?;
        }
        Ok(())
    }

    pub fn kill(&mut self, id: &str) {
        if let Some(mut e) = self.entries.remove(id) {
            e.dead.store(true, Ordering::SeqCst);
            // Abort the child's whole process subtree, not just the shell leader.
            // `child.kill()` below reaps only the leader, so a long-running
            // descendant (a dev server, a build, a training run) started in the
            // tab would otherwise be orphaned and keep running after the tab
            // closes. Gather the subtree first — it is unreachable once the
            // leader dies and its children reparent to init.
            if let Some(pid) = e.child.process_id() {
                reap_child_subtree(pid, ReapMode::Graceful);
            }
            let _ = e.child.kill();
            // The tree shrank; drop the cached descendant-pid set.
            invalidate_proc_tree_cache();
            // The tab is gone for good, so stop watching for its Codex session.
            crate::services::codex_bind::untrack_now(id);
            // Containerized tab: killing the child above only killed the
            // `docker exec` CLIENT — TERM the process inside the container too
            // (best-effort, no-op for tabs that never containerized).
            crate::services::sandbox::kill_tab_process(id);
        }
    }

    /// Abort every live PTY and its process subtree. Called once at app exit so
    /// no terminal's inner process (a dev server, a build, a training run)
    /// outlives Eldrun — dropping the registry alone kills only the shell
    /// leaders and orphans everything they spawned. Uses [`ReapMode::Immediate`]
    /// because a delayed escalation thread would die with the exiting process.
    pub fn kill_all(&mut self) {
        // One process-tree walk over all leaders (their subtrees include the
        // leader pids themselves, which `child.kill()` below re-kills harmlessly).
        let leaders: Vec<u32> = self
            .entries
            .values()
            .filter_map(|e| e.child.process_id())
            .collect();
        crate::sysstat::invalidate_descendant_cache();
        let subtree = crate::sysstat::descendant_pids(&leaders);

        for (id, mut e) in self.entries.drain() {
            e.dead.store(true, Ordering::SeqCst);
            let _ = e.child.kill();
            // Containerized tab: also TERM the in-container process (the docker
            // exec client we just killed is not it).
            crate::services::sandbox::kill_tab_process(&id);
        }
        reap_pids(subtree, ReapMode::Immediate);
        invalidate_proc_tree_cache();
    }

    /// True when any live (not-yet-dead) PTY belongs to `scope`. PTY ids are
    /// `<scope>:<tab-key>` (CenterPanel), so a prefix match is authoritative.
    /// Used by the project-container teardown to keep a deactivated project's
    /// container alive while background tabs still run inside it.
    pub fn any_live_for_scope(&self, scope: &str) -> bool {
        let prefix = format!("{scope}:");
        self.entries
            .iter()
            .any(|(id, e)| id.starts_with(&prefix) && !e.dead.load(Ordering::SeqCst))
    }

    /// OS process id of the child for `id`, if it is still tracked.
    pub fn pid(&self, id: &str) -> Option<u32> {
        self.entries.get(id).and_then(|e| e.child.process_id())
    }

    pub fn check_crash_loop(&mut self, id: &str) -> bool {
        let Some(entry) = self.entries.get_mut(id) else {
            return true;
        };
        let now = Instant::now();
        entry
            .crash_times
            .retain(|t| now.duration_since(*t) < Duration::from_secs(10));
        if entry.crash_times.len() >= CRASH_LOOP_THRESHOLD {
            return false;
        }
        entry.crash_times.push(now);
        true
    }
}

// ── Spawn ─────────────────────────────────────────────────────────────────

/// Spawn a PTY and wire up Tauri event emission.
/// The read loop runs in a std::thread (blocking I/O) and passes chunks
/// through an mpsc channel to a Tokio task that batches and emits events.
pub fn spawn_pty(
    app: AppHandle,
    registry: Arc<Mutex<PtyRegistry>>,
    opts: PtyOptions,
) -> Result<(), String> {
    // Record this PTY id so a later remount (HMR, webview reload) is a known
    // re-spawn. Agent-session resolution (Claude/Codex resume args) happens in
    // the caller (`commands::terminal::pty_spawn`) *before* any ssh wrapping, so
    // remote agent tabs resume correctly; by the time the command reaches here it
    // is fully resolved (and possibly already rewritten to `ssh`).
    registry.lock().unwrap().seen.insert(opts.id.clone());

    let pty_system = NativePtySystem::default();

    // Never open a zero-size PTY. A 0-col/0-row size can slip in if the caller
    // spawns before xterm has measured a layout box; Unix ptys tolerate it but
    // Windows ConPTY accepts it silently and then emits no output, which shows up
    // as a black, dead agent tab. Clamp to a sane default so the child always has
    // a usable window — the frontend re-sends the real size via `pty_resize` as
    // soon as the pane is fitted.
    let cols = if opts.cols == 0 { 80 } else { opts.cols };
    let rows = if opts.rows == 0 { 24 } else { opts.rows };

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let cmd = build_command(&opts);
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    let dead = Arc::new(AtomicBool::new(false));
    {
        let mut reg = registry.lock().unwrap();
        reg.insert(opts.id.clone(), pair.master, writer, child, dead.clone());
    }

    let _ = app.emit("terminal-ready", TerminalReady { id: opts.id.clone() });

    // Channel: blocking reader thread → async emitter task.
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(CHANNEL_CAP);

    let dead_reader = dead.clone();
    let _id_reader = opts.id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            if dead_reader.load(Ordering::SeqCst) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // If the channel is full, drop the chunk (backpressure safety).
                    let _ = tx.try_send(buf[..n].to_vec());
                }
                Err(_) => break,
            }
        }
        // Signal EOF by dropping tx.
    });

    let id = opts.id.clone();
    // Token for this *particular* spawn's Codex session tracking (None for any
    // tab the binder isn't following). A re-spawn under the same id replaces the
    // tracking and mints a new token, so the old process exiting below can only
    // ever tear down its own.
    let bind_seq = crate::services::codex_bind::current_seq(&opts.id);
    let route_seq = route_open(&opts.id);
    tokio::spawn(async move {
        let emitter = app.clone();
        batch_output(rx, |bytes| match route_chunk(&id, bytes) {
            Routed::Data(text) => {
                let _ = emitter.emit(
                    "terminal-output",
                    TerminalOutput { id: id.clone(), data: text },
                );
            }
            Routed::Activity(text) => {
                let _ = emitter.emit(
                    "terminal-activity",
                    TerminalOutput { id: id.clone(), data: text },
                );
            }
            Routed::ArmDigest(deadline) => {
                // A short-lived task per digest window, only while a hidden PTY
                // is mid-burst — an idle or visible PTY arms nothing, keeping
                // the zero-idle-wakeups discipline of `batch_output` intact.
                let app2 = emitter.clone();
                let id2 = id.clone();
                tokio::spawn(async move {
                    tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
                    if let Some(text) = route_digest_take(&id2) {
                        let _ = app2.emit(
                            "terminal-activity",
                            TerminalOutput { id: id2, data: text },
                        );
                    }
                });
            }
            Routed::Quiet => {}
        })
        .await;
        route_close(&id, route_seq);
        // The child exited on its own; its subtree is gone, so the next CPU
        // sample must rebuild rather than count dead pids.
        invalidate_proc_tree_cache();
        // Codex quit by itself (`/exit`, crash) — stop watching for its session.
        if let Some(seq) = bind_seq {
            crate::services::codex_bind::untrack(&id, seq);
        }
        let _ = app.emit("terminal-exit", TerminalExit { id, code: None });
    });

    Ok(())
}

/// Drain a PTY's output channel into batched `flush` calls.
///
/// The wakeup discipline is the whole point (typing-latency plan, step 2): an
/// idle terminal must cost **zero** timer wakeups. The old loop re-armed a
/// 16 ms `timeout` unconditionally, so every idle tab woke a tokio task
/// 62.5×/s forever — with ~50 open PTYs that alone was ~647 context switches
/// per second at rest. The rules:
///
/// - Batch empty → park on `recv()` with no timer at all.
/// - A chunk arriving with `last_emit` a full window ago flushes immediately —
///   the leading edge. This is every keystroke echo at typing speed (inter-key
///   gaps far exceed the window), so echo latency stays ~0 ms.
/// - A chunk arriving inside the window arms one timeout for the *remainder*
///   of the window, coalescing a burst; `BATCH_MAX_BYTES` flushes early.
async fn batch_output<F: FnMut(&[u8])>(
    mut rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    mut flush: F,
) {
    let mut batch: Vec<u8> = Vec::with_capacity(BATCH_MAX_BYTES);
    // Start stale by one full window so the very first chunk takes the
    // leading-edge flush too (checked_sub: an Instant can't go below the
    // platform's epoch; the fallback merely delays the first flush one window).
    let mut last_emit = Instant::now()
        .checked_sub(BATCH_INTERVAL)
        .unwrap_or_else(Instant::now);

    loop {
        if batch.is_empty() {
            match rx.recv().await {
                Some(data) => batch.extend_from_slice(&data),
                None => break, // Channel closed = reader thread exited.
            }
        } else {
            let deadline = tokio::time::Instant::from_std(last_emit + BATCH_INTERVAL);
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(data)) => batch.extend_from_slice(&data),
                Ok(None) => break,
                Err(_expired) => {} // Window over with data pending: flush below.
            }
        }

        let now = Instant::now();
        let should_flush = !batch.is_empty()
            && (batch.len() >= BATCH_MAX_BYTES
                || now.duration_since(last_emit) >= BATCH_INTERVAL);

        if should_flush {
            flush(&batch);
            batch.clear();
            last_emit = now;
        }
    }

    // Final flush.
    if !batch.is_empty() {
        flush(&batch);
    }
}

/// Resize an existing PTY.
pub fn resize_pty(
    registry: &Arc<Mutex<PtyRegistry>>,
    id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut reg = registry.lock().unwrap();
    let Some(entry) = reg.entries.get_mut(id) else {
        return Ok(());
    };

    entry
        .master
        .resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))
}

// ── Shell detection ────────────────────────────────────────────────────────

/// Return the user's preferred login shell, falling back to a platform default.
pub fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    } else if cfg!(target_os = "macos") {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

// ── Command builder ────────────────────────────────────────────────────────

/// Wrap a resolved absolute executable path into a `CommandBuilder`. A `.exe`
/// (or a Unix binary) runs directly; a `.cmd`/`.bat` shim (npm-style) needs
/// `cmd.exe /c` and a `.ps1` needs PowerShell, since `CreateProcess` can't exec
/// those directly inside the PTY.
fn command_for_resolved(path: std::path::PathBuf) -> CommandBuilder {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("cmd") | Some("bat") => {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/c");
            c.arg(path);
            c
        }
        Some("ps1") => {
            let mut c = CommandBuilder::new("powershell.exe");
            c.arg("-NoProfile");
            c.arg("-ExecutionPolicy");
            c.arg("Bypass");
            c.arg("-File");
            c.arg(path);
            c
        }
        _ => CommandBuilder::new(path),
    }
}

fn build_command(opts: &PtyOptions) -> CommandBuilder {
    let cmd_str = if opts.cmd.is_empty() { default_shell() } else { opts.cmd.clone() };
    // A bare tool name (e.g. "vibe"/"ollama") that Eldrun detected as installed
    // may still not be launchable on Windows: winget/uv/npm install into per-user
    // dirs (%LOCALAPPDATA%\Programs, %USERPROFILE%\.local\bin, %APPDATA%\npm, …)
    // that the PATH this process inherited often omits. Resolve to an absolute
    // path so the spawn finds it. No-op when the name already resolves on PATH or
    // carries a path — so ssh/docker-wrapped tabs (cmd "ssh"/"docker", both on
    // PATH) keep their remote/in-container binary names, which live in `args`.
    let mut cmd = match crate::paths::resolve_offpath_binary(&cmd_str) {
        Some(resolved) => command_for_resolved(resolved),
        None => CommandBuilder::new(&cmd_str),
    };
    for arg in &opts.args {
        cmd.arg(arg);
    }
    cmd.cwd(&opts.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(path) = crate::paths::effective_path() {
        cmd.env("PATH", path);
    }
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }

    #[cfg(target_os = "linux")]
    {
        cmd.env_remove("GIO_LAUNCHED_DESKTOP_FILE");
        cmd.env_remove("GIO_LAUNCHED_DESKTOP_FILE_PID");
    }

    cmd
}

#[cfg(test)]
mod batch_tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    type Flushes = Arc<Mutex<Vec<Vec<u8>>>>;

    /// Spawn `batch_output` collecting flushes into a shared list.
    fn collectors() -> (
        tokio::sync::mpsc::Sender<Vec<u8>>,
        Flushes,
        tokio::task::JoinHandle<()>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(CHANNEL_CAP);
        let flushes: Flushes = Arc::new(Mutex::new(Vec::new()));
        let sink = flushes.clone();
        let handle = tokio::spawn(async move {
            batch_output(rx, |bytes| sink.lock().unwrap().push(bytes.to_vec())).await;
        });
        (tx, flushes, handle)
    }

    /// Let the batcher task run without advancing the paused clock: yielding
    /// keeps this task ready, so tokio's auto-advance never fires.
    async fn settle() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    /// The keystroke-echo invariant: the first chunk after quiet flushes with
    /// no batching delay at all. The clock is paused, so if the batcher waited
    /// on any timer the flush could not have happened yet.
    #[tokio::test(start_paused = true)]
    async fn first_chunk_after_quiet_flushes_immediately() {
        let (tx, flushes, _h) = collectors();
        tx.send(b"x".to_vec()).await.unwrap();
        settle().await;
        assert_eq!(*flushes.lock().unwrap(), vec![b"x".to_vec()]);
    }

    /// Chunks landing inside the window coalesce into one flush at the
    /// window's trailing edge — not one emit per chunk.
    #[tokio::test(start_paused = true)]
    async fn mid_burst_chunks_coalesce_until_window() {
        let (tx, flushes, _h) = collectors();
        tx.send(b"a".to_vec()).await.unwrap();
        settle().await; // leading-edge flush of "a"; window opens now
        tx.send(b"b".to_vec()).await.unwrap();
        settle().await;
        tx.send(b"c".to_vec()).await.unwrap();
        settle().await;
        // Sleeping past the window lets the paused clock auto-advance to the
        // batcher's armed deadline.
        tokio::time::sleep(BATCH_INTERVAL * 2).await;
        settle().await;
        assert_eq!(
            *flushes.lock().unwrap(),
            vec![b"a".to_vec(), b"bc".to_vec()]
        );
    }

    /// A full batch flushes immediately even inside the window.
    #[tokio::test(start_paused = true)]
    async fn max_bytes_flushes_inside_window() {
        let (tx, flushes, _h) = collectors();
        tx.send(b"a".to_vec()).await.unwrap();
        settle().await;
        tx.send(vec![b'z'; BATCH_MAX_BYTES]).await.unwrap();
        settle().await; // clock never advanced: only the size rule can flush
        assert_eq!(flushes.lock().unwrap().len(), 2);
        assert_eq!(flushes.lock().unwrap()[1].len(), BATCH_MAX_BYTES);
    }

    /// Data pending when the channel closes is not lost.
    #[tokio::test(start_paused = true)]
    async fn close_flushes_remainder() {
        let (tx, flushes, h) = collectors();
        tx.send(b"a".to_vec()).await.unwrap();
        settle().await;
        tx.send(b"tail".to_vec()).await.unwrap(); // inside the window: batched
        settle().await;
        drop(tx);
        h.await.unwrap();
        assert_eq!(
            *flushes.lock().unwrap(),
            vec![b"a".to_vec(), b"tail".to_vec()]
        );
    }
}

#[cfg(test)]
mod route_tests {
    use super::*;

    /// Flip a route's visibility without an AppHandle (the command wrapper's
    /// only extra is the replay emit); returns what that emit would carry.
    fn set_visible(id: &str, visible: bool) -> Option<String> {
        let mut map = routes().lock().unwrap();
        let route = map.entry(id.to_string()).or_default();
        let was = route.subscribed();
        route.visible = visible;
        if !was && route.subscribed() { route.take_pending() } else { None }
    }

    #[test]
    fn subscribed_by_default_streams_data() {
        let id = "route-t-default";
        let seq = route_open(id);
        assert!(matches!(
            route_chunk_at(id, b"hello", Instant::now()),
            Routed::Data(t) if t == "hello"
        ));
        route_close(id, seq);
    }

    #[test]
    fn hidden_digests_leading_edge_then_coalesces() {
        let id = "route-t-digest";
        let seq = route_open(id);
        assert_eq!(set_visible(id, false), None);
        let t0 = Instant::now();
        // First hidden chunk: leading-edge digest, no batching delay.
        assert!(matches!(
            route_chunk_at(id, b"abc", t0),
            Routed::Activity(t) if t == "abc"
        ));
        // Inside the window: buffered, one trailing flush armed at the window end.
        assert!(matches!(
            route_chunk_at(id, b"def", t0 + Duration::from_millis(10)),
            Routed::ArmDigest(d) if d == t0 + ACTIVITY_INTERVAL
        ));
        assert!(matches!(
            route_chunk_at(id, b"ghi", t0 + Duration::from_millis(20)),
            Routed::Quiet
        ));
        // The trailing flush drains what the window accumulated — the decision
        // prompt that arrived right before quiet is never stranded.
        assert_eq!(
            route_digest_take_at(id, t0 + ACTIVITY_INTERVAL).as_deref(),
            Some("defghi")
        );
        assert_eq!(route_digest_take_at(id, t0 + ACTIVITY_INTERVAL), None);
        route_close(id, seq);
    }

    #[test]
    fn showing_replays_every_hidden_byte_once() {
        let id = "route-t-replay";
        let seq = route_open(id);
        set_visible(id, false);
        let t0 = Instant::now();
        let _ = route_chunk_at(id, b"abc", t0);
        let _ = route_chunk_at(id, b"def", t0 + Duration::from_millis(10));
        // The replay carries ALL hidden bytes — including those a digest
        // already summarized (the digest fed the pills, not the pane).
        assert_eq!(set_visible(id, true).as_deref(), Some("abcdef"));
        // And streaming resumes.
        assert!(matches!(
            route_chunk_at(id, b"live", Instant::now()),
            Routed::Data(t) if t == "live"
        ));
        // No leftover digest fires after the drain.
        assert_eq!(route_digest_take_at(id, t0 + ACTIVITY_INTERVAL), None);
        route_close(id, seq);
    }

    #[test]
    fn a_watch_streams_a_hidden_pty() {
        let id = "route-t-watch";
        let seq = route_open(id);
        set_visible(id, false);
        let t0 = Instant::now();
        let _ = route_chunk_at(id, b"early", t0);
        // Rising edge drains pending (byte order across the watch) …
        {
            let mut map = routes().lock().unwrap();
            let route = map.get_mut(id).unwrap();
            let was = route.subscribed();
            route.watchers += 1;
            assert!(!was);
            assert_eq!(route.take_pending().as_deref(), Some("early"));
        }
        // … then the hidden PTY streams like a visible one.
        assert!(matches!(
            route_chunk_at(id, b"marker", Instant::now()),
            Routed::Data(t) if t == "marker"
        ));
        route_unwatch(id);
        // Released: back to buffering (leading-edge digest again).
        assert!(matches!(
            route_chunk_at(id, b"after", t0 + ACTIVITY_INTERVAL * 2),
            Routed::Activity(t) if t == "after"
        ));
        route_close(id, seq);
    }

    #[test]
    fn pending_is_capped_with_hysteresis() {
        let mut buf = vec![b'x'; ROUTE_PENDING_CAP * 2];
        trim_with_hysteresis(&mut buf, ROUTE_PENDING_CAP);
        assert_eq!(buf.len(), ROUTE_PENDING_CAP * 2, "at 2x nothing is cut yet");
        buf.push(b'y');
        trim_with_hysteresis(&mut buf, ROUTE_PENDING_CAP);
        assert_eq!(buf.len(), ROUTE_PENDING_CAP, "past 2x it cuts back to the cap");
        assert_eq!(*buf.last().unwrap(), b'y', "the newest bytes survive");
    }

    #[test]
    fn respawn_survives_the_old_spawns_cleanup() {
        let id = "route-t-respawn";
        let old = route_open(id);
        set_visible(id, false);
        let new = route_open(id);
        route_close(id, old); // the old spawn's task ends late
        assert!(
            routes().lock().unwrap().contains_key(id),
            "the respawn's route must survive"
        );
        // And the respawn kept the pane's hidden state.
        assert!(!routes().lock().unwrap().get(id).unwrap().subscribed());
        route_close(id, new);
        assert!(!routes().lock().unwrap().contains_key(id));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn resize_pty_updates_kernel_size() {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("1");
        let child = pair.slave.spawn_command(cmd).expect("spawn sleep");
        let writer = pair.master.take_writer().expect("take writer");
        let master = pair.master;

        let registry = Arc::new(Mutex::new(PtyRegistry::default()));
        let dead = Arc::new(AtomicBool::new(false));
        {
            let mut reg = registry.lock().unwrap();
            reg.insert("test".to_string(), master, writer, child, dead);
        }

        resize_pty(&registry, "test", 100, 40).expect("resize");

        let reg = registry.lock().unwrap();
        let entry = reg.entries.get("test").expect("entry exists");
        let size = entry.master.get_size().expect("get_size");
        assert_eq!(size.cols, 100);
        assert_eq!(size.rows, 40);
        drop(reg);

        registry.lock().unwrap().kill("test");
    }

    /// Closing a tab must abort the process **inside** it, not just the shell
    /// leader: a `sh` whose child is a long-running `sleep` must leave no live
    /// `sleep` behind once the PTY is killed.
    #[test]
    fn kill_reaps_the_child_subtree() {
        // This test invalidates and repopulates the process-tree cache in its
        // poll loop below, which is exactly the global state sysstat's
        // cache-mechanics tests seed synthetic entries into. Share their lock so
        // the two never interleave.
        let _cache_guard = crate::sysstat::lock_cache_for_test();
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");

        // The trailing `; true` defeats the shell's exec-optimization so `sleep`
        // is a genuine *child* of `sh` (the leader), not the leader itself.
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("sleep 300; true");
        let child = pair.slave.spawn_command(cmd).expect("spawn sh");
        let leader = child.process_id().expect("leader pid");
        let writer = pair.master.take_writer().expect("take writer");
        let master = pair.master;

        let registry = Arc::new(Mutex::new(PtyRegistry::default()));
        let dead = Arc::new(AtomicBool::new(false));
        registry
            .lock()
            .unwrap()
            .insert("test".to_string(), master, writer, child, dead);

        // SAFETY: kill(pid, 0) probes existence without signalling; no pointers.
        let alive = |pid: u32| unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };

        // Wait for the `sleep` child to appear as a descendant of the leader.
        let mut sleep_pid = None;
        for _ in 0..100 {
            crate::sysstat::invalidate_descendant_cache();
            if let Some(&pid) = crate::sysstat::descendant_pids(&[leader])
                .iter()
                .find(|&&p| p != leader)
            {
                sleep_pid = Some(pid);
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let sleep_pid = sleep_pid.expect("sleep child should have spawned");
        assert!(alive(sleep_pid), "sleep child should be running before kill");

        registry.lock().unwrap().kill("test");

        // The graceful SIGTERM terminates `sleep` (default disposition); init
        // then reaps the reparented zombie. Poll until the pid is truly gone.
        let mut gone = false;
        for _ in 0..250 {
            if !alive(sleep_pid) {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(gone, "the inner process must be aborted when the tab is closed");
    }
}
