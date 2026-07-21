//! PTY lifecycle management for Eldrun terminals.
//!
//! Design constraints from TauriRust.md Phase 3:
//! - portable-pty for cross-platform PTY creation.
//! - Bounded per-PTY output channels (backpressure via mpsc).
//! - Batched/throttled Tauri events (max one emit per 16 ms).
//! - UTF-8 lossy output; binary-safe read loop.
//! - Crash-loop protection: tracks last-exit timestamps.
//! - Explicit terminal-ready event when the shell starts.
//! - Linux XDG sandbox env in a cfg(target_os="linux") block.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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
enum ReapMode {
    /// SIGTERM now, then SIGKILL any survivors after a short grace period on a
    /// detached thread. Used on tab close / respawn, where the app stays alive
    /// long enough to deliver the escalation.
    Graceful,
    /// SIGKILL immediately. Used at app exit, where a delayed escalation thread
    /// would be torn down with the process before it could fire.
    Immediate,
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
fn reap_child_subtree(leader_pid: u32, mode: ReapMode) {
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
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(CHANNEL_CAP);

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
    tokio::spawn(async move {
        let mut batch: Vec<u8> = Vec::with_capacity(BATCH_MAX_BYTES);
        let mut last_emit = Instant::now();

        loop {
            // Poll with a short timeout so we can flush on the interval even
            // if no new data arrives.
            let chunk = tokio::time::timeout(BATCH_INTERVAL, rx.recv()).await;

            match chunk {
                Ok(Some(data)) => batch.extend_from_slice(&data),
                Ok(None) => {
                    // Channel closed = reader thread exited.
                    break;
                }
                Err(_timeout) => {} // Normal: flush on interval.
            }

            let now = Instant::now();
            let should_flush = !batch.is_empty()
                && (batch.len() >= BATCH_MAX_BYTES
                    || now.duration_since(last_emit) >= BATCH_INTERVAL);

            if should_flush {
                let text = String::from_utf8_lossy(&batch).into_owned();
                let _ = app.emit(
                    "terminal-output",
                    TerminalOutput {
                        id: id.clone(),
                        data: text,
                    },
                );
                batch.clear();
                last_emit = now;
            }
        }

        // Final flush.
        if !batch.is_empty() {
            let text = String::from_utf8_lossy(&batch).into_owned();
            let _ = app.emit(
                "terminal-output",
                TerminalOutput {
                    id: id.clone(),
                    data: text,
                },
            );
        }
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
