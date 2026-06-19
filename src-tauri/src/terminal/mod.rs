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
            let _ = e.child.kill();
        }
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
    // re-spawn. The session resolution below runs on every Claude spawn, not just
    // re-spawns: an agent launched with `--session-id <uuid>` created that session
    // on first launch (a second `--session-id` with the same id is rejected), and
    // a fresh-app restore reuses the saved launch id under a brand-new PTY id — so
    // gating on "seen" would miss the restore path. `resolve_claude_session` keeps
    // `--session-id` for a never-used tab and only resumes when a log exists, so
    // running it unconditionally is safe.
    registry.lock().unwrap().seen.insert(opts.id.clone());
    let opts = resolve_agent_session(opts);

    let pty_system = NativePtySystem::default();

    let pair = pty_system
        .openpty(PtySize {
            rows: opts.rows,
            cols: opts.cols,
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

/// Resolve a tracked agent tab's session args at spawn so it resumes the right
/// conversation. Dispatches per agent; non-tracked commands pass through.
fn resolve_agent_session(opts: PtyOptions) -> PtyOptions {
    match opts.cmd.as_str() {
        "claude" => resolve_claude_session(opts),
        "codex" => resolve_codex_session(opts),
        _ => opts,
    }
}

/// Resolve a Codex tab's session args. Unlike Claude, Codex mints its own session
/// id (no launch-time `--session-id`), so the only stable per-tab key is the
/// `ELDRUN_TAB_UID` env var Eldrun sets from the tab's id. The global Codex
/// `SessionStart` hook records the live session id under that key (see
/// `services::agent_session`); here we read it and, when a matching rollout log
/// exists, launch `codex resume <live-id>`. With no record yet (first launch, or
/// the hook not trusted), we leave the args untouched → a fresh Codex session.
fn resolve_codex_session(opts: PtyOptions) -> PtyOptions {
    let sessions = crate::paths::home_dir().join(".codex").join("sessions");
    resolve_codex_session_impl(opts, &sessions, |uid| {
        crate::services::agent_session::read_live_session(uid)
    })
}

/// Testable core of [`resolve_codex_session`].
fn resolve_codex_session_impl<F>(
    mut opts: PtyOptions,
    sessions_root: &std::path::Path,
    live_lookup: F,
) -> PtyOptions
where
    F: Fn(&str) -> Option<String>,
{
    if opts.cmd != "codex" {
        return opts;
    }
    let Some(uid) = opts.env.get("ELDRUN_TAB_UID").cloned() else {
        return opts;
    };
    if let Some(id) = live_lookup(&uid).filter(|id| codex_session_exists(sessions_root, id)) {
        opts.args = vec!["resume".to_string(), id];
    }
    opts
}

/// Whether Codex has a persisted rollout log for `uuid`. Codex stores sessions at
/// `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`, so we walk the
/// date buckets (bounded depth) for a `.jsonl` whose name contains the uuid.
fn codex_session_exists(root: &std::path::Path, uuid: &str) -> bool {
    fn walk(dir: &std::path::Path, uuid: &str, depth: u8) -> bool {
        if depth > 5 {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if walk(&path, uuid, depth + 1) {
                    return true;
                }
            } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.ends_with(".jsonl") && name.contains(uuid) {
                    return true;
                }
            }
        }
        false
    }
    walk(root, uuid, 0)
}

/// Resolve a Claude tab's session args at spawn so it (re)attaches to the right
/// conversation, including after a `/clear`.
///
/// The tab is launched with a deterministic *launch id* (`--session-id <uuid>`),
/// which doubles as the tab's stable key. We:
///
/// 1. Expose that launch id to the global `SessionStart` hook via the
///    `ELDRUN_TAB_UID` env var, so the hook can record this tab's *live* session
///    id (see `services::agent_session`). The live id diverges from the launch
///    id after `/clear` (Claude rolls onto a fresh session with no recorded
///    back-link), so this is the only reliable way to follow it.
/// 2. Pick the resume target: the hook-recorded live id when it has a persisted
///    log, else the launch id when *it* has one.
/// 3. Emit `--resume <target>` only when a session log actually exists; Claude
///    writes the log lazily (first message), so a never-used tab has none — in
///    that case keep `--session-id <launch>` and start fresh under the reserved
///    id (nothing is lost, and `--resume` would exit with "No conversation
///    found"). This also safely downgrades a restore that asked for `--resume`.
fn resolve_claude_session(opts: PtyOptions) -> PtyOptions {
    let projects = crate::paths::home_dir().join(".claude").join("projects");
    resolve_claude_session_impl(opts, &projects, |uid| {
        crate::services::agent_session::read_live_session(uid)
    })
}

/// Testable core of [`resolve_claude_session`]: `projects` is the Claude session
/// root and `live_lookup` maps a launch id → recorded live id (if any).
fn resolve_claude_session_impl<F>(
    mut opts: PtyOptions,
    projects: &std::path::Path,
    live_lookup: F,
) -> PtyOptions
where
    F: Fn(&str) -> Option<String>,
{
    if opts.cmd != "claude" {
        return opts;
    }
    let Some(i) = opts
        .args
        .iter()
        .position(|a| a == "--session-id" || a == "--resume")
    else {
        return opts;
    };
    if i + 1 >= opts.args.len() {
        return opts;
    }
    let launch_id = opts.args[i + 1].clone();

    // The stable per-tab key is the launch id; expose it to the SessionStart hook.
    opts.env
        .entry("ELDRUN_TAB_UID".to_string())
        .or_insert_with(|| launch_id.clone());

    // Prefer the hook-recorded live id (survives /clear); fall back to launch id.
    let resume_target = live_lookup(&launch_id)
        .filter(|id| claude_session_exists(projects, id))
        .or_else(|| claude_session_exists(projects, &launch_id).then(|| launch_id.clone()));

    match resume_target {
        Some(id) => {
            opts.args[i] = "--resume".to_string();
            opts.args[i + 1] = id;
        }
        None => {
            // No resumable log yet → (re)create under the launch id.
            opts.args[i] = "--session-id".to_string();
            opts.args[i + 1] = launch_id;
        }
    }
    opts
}

/// Whether Claude has a persisted session log for `uuid` under `projects`
/// (`~/.claude/projects`). Claude stores sessions at
/// `<projects>/<encoded-cwd>/<uuid>.jsonl`; since uuids are globally unique we
/// scan the project dirs for `<uuid>.jsonl` rather than re-deriving the cwd
/// encoding.
fn claude_session_exists(projects: &std::path::Path, uuid: &str) -> bool {
    let file = format!("{uuid}.jsonl");
    let Ok(dirs) = std::fs::read_dir(projects) else {
        return false;
    };
    dirs.flatten()
        .any(|entry| entry.path().join(&file).is_file())
}

// ── Command builder ────────────────────────────────────────────────────────

fn build_command(opts: &PtyOptions) -> CommandBuilder {
    let cmd_str = if opts.cmd.is_empty() { default_shell() } else { opts.cmd.clone() };
    let mut cmd = CommandBuilder::new(&cmd_str);
    for arg in &opts.args {
        cmd.arg(arg);
    }
    cmd.cwd(&opts.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
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

    /// Process-and-test-unique temp path. Tests run in parallel threads sharing
    /// one pid, so a counter is needed to keep each test's dir distinct (else one
    /// test's cleanup races another's reads).
    fn unique_tmp(prefix: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()))
    }

    fn opts_with_args(args: &[&str]) -> PtyOptions {
        PtyOptions {
            id: "t".to_string(),
            cmd: "claude".to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: Default::default(),
            cwd: "/".to_string(),
            cols: 80,
            rows: 24,
            local_only: false,
        }
    }

    /// Temp Claude `projects` root containing a persisted log for each given uuid.
    fn projects_with_sessions(uuids: &[&str]) -> std::path::PathBuf {
        let tmp = unique_tmp("eldrun-resolve");
        let proj = tmp.join("-encoded-cwd");
        std::fs::create_dir_all(&proj).unwrap();
        for u in uuids {
            std::fs::write(proj.join(format!("{u}.jsonl")), b"{}").unwrap();
        }
        tmp
    }

    #[test]
    fn resolve_keeps_session_id_when_no_log_exists() {
        // A never-used tab must not turn into `--resume` (Claude would exit with
        // "No conversation found with session ID ...").
        let uuid = "00000000-0000-0000-0000-000000000000";
        let projects = projects_with_sessions(&[]);
        let out =
            resolve_claude_session_impl(opts_with_args(&["--session-id", uuid]), &projects, |_| None);
        assert_eq!(out.args, vec!["--session-id".to_string(), uuid.to_string()]);
        // The launch id is always exposed to the SessionStart hook.
        assert_eq!(out.env.get("ELDRUN_TAB_UID").map(String::as_str), Some(uuid));
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn resolve_resumes_launch_id_when_its_log_exists() {
        let uuid = "00000000-0000-0000-0000-000000000000";
        let projects = projects_with_sessions(&[uuid]);
        let out =
            resolve_claude_session_impl(opts_with_args(&["--session-id", uuid]), &projects, |_| None);
        assert_eq!(out.args, vec!["--resume".to_string(), uuid.to_string()]);
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn resolve_follows_live_id_after_clear() {
        // After /clear the hook records a fresh live id under the launch key; we
        // resume that, not the (pre-clear) launch id.
        let launch = "00000000-0000-0000-0000-000000000000";
        let live = "99999999-8888-7777-6666-555555555555";
        let projects = projects_with_sessions(&[launch, live]);
        let out = resolve_claude_session_impl(
            // restore path passes `--resume <launch>`; we rewrite the id to live.
            opts_with_args(&["--resume", launch]),
            &projects,
            |uid| (uid == launch).then(|| live.to_string()),
        );
        assert_eq!(out.args, vec!["--resume".to_string(), live.to_string()]);
        assert_eq!(out.env.get("ELDRUN_TAB_UID").map(String::as_str), Some(launch));
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn resolve_downgrades_resume_without_log_to_session_id() {
        // Restore asked for `--resume <launch>` but no log exists (never-used tab)
        // → downgrade to `--session-id` so Claude starts fresh instead of erroring.
        let launch = "00000000-0000-0000-0000-000000000000";
        let projects = projects_with_sessions(&[]);
        let out = resolve_claude_session_impl(
            opts_with_args(&["--resume", launch]),
            &projects,
            |_| None,
        );
        assert_eq!(out.args, vec!["--session-id".to_string(), launch.to_string()]);
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn resolve_ignores_non_claude_commands() {
        let mut opts = opts_with_args(&["--session-id", "abc-123"]);
        opts.cmd = "bash".to_string();
        let projects = projects_with_sessions(&[]);
        let out = resolve_claude_session_impl(opts, &projects, |_| Some("x".to_string()));
        assert_eq!(out.args, vec!["--session-id".to_string(), "abc-123".to_string()]);
        assert!(out.env.get("ELDRUN_TAB_UID").is_none());
        let _ = std::fs::remove_dir_all(&projects);
    }

    #[test]
    fn claude_session_exists_detects_persisted_log() {
        let tmp = std::env::temp_dir().join(format!("eldrun-sess-test-{}", std::process::id()));
        let proj = tmp.join("-some-encoded-cwd");
        std::fs::create_dir_all(&proj).unwrap();
        let uuid = "11111111-2222-3333-4444-555555555555";
        std::fs::write(proj.join(format!("{uuid}.jsonl")), b"{}").unwrap();

        assert!(claude_session_exists(&tmp, uuid));
        assert!(!claude_session_exists(&tmp, "no-such-uuid"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_leaves_args_without_session_flag_untouched() {
        let projects = projects_with_sessions(&[]);
        let out = resolve_claude_session_impl(opts_with_args(&["--foo", "bar"]), &projects, |_| None);
        assert_eq!(out.args, vec!["--foo".to_string(), "bar".to_string()]);
        let _ = std::fs::remove_dir_all(&projects);
    }

    /// Temp Codex sessions root with a `YYYY/MM/DD/rollout-…-<uuid>.jsonl` log.
    fn codex_sessions_with(uuid: &str) -> std::path::PathBuf {
        let tmp = unique_tmp("eldrun-codex-sess");
        let day = tmp.join("2026").join("06").join("08");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(
            day.join(format!("rollout-2026-06-08T17-10-09-{uuid}.jsonl")),
            b"{}",
        )
        .unwrap();
        tmp
    }

    fn codex_opts() -> PtyOptions {
        let mut o = opts_with_args(&[]);
        o.cmd = "codex".to_string();
        o
    }

    #[test]
    fn codex_resumes_live_id_when_rollout_exists() {
        let live = "019ea7c8-b7d5-7a13-80e2-1ad6608db5e6";
        let root = codex_sessions_with(live);
        let mut opts = codex_opts();
        opts.env.insert("ELDRUN_TAB_UID".to_string(), "tab-key-123".to_string());
        let out = resolve_codex_session_impl(opts, &root, |uid| {
            (uid == "tab-key-123").then(|| live.to_string())
        });
        assert_eq!(out.args, vec!["resume".to_string(), live.to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_starts_fresh_without_record_or_without_uid() {
        let root = codex_sessions_with("00000000-0000-0000-0000-000000000000");
        // No live record → fresh launch (args stay empty).
        let mut opts = codex_opts();
        opts.env.insert("ELDRUN_TAB_UID".to_string(), "tab-key".to_string());
        let out = resolve_codex_session_impl(opts, &root, |_| None);
        assert!(out.args.is_empty());
        // No ELDRUN_TAB_UID at all → cannot track → fresh launch.
        let out2 = resolve_codex_session_impl(codex_opts(), &root, |_| Some("x".to_string()));
        assert!(out2.args.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_ignores_when_recorded_session_missing_on_disk() {
        let root = codex_sessions_with("aaaaaaaa-0000-0000-0000-000000000000");
        let mut opts = codex_opts();
        opts.env.insert("ELDRUN_TAB_UID".to_string(), "tab-key".to_string());
        // Recorded id has no rollout log → don't pass a bad `resume` arg.
        let out = resolve_codex_session_impl(opts, &root, |_| {
            Some("ffffffff-1111-2222-3333-444444444444".to_string())
        });
        assert!(out.args.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

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
}
