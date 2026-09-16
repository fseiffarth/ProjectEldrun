//! The turn state an agent's **own hooks** report — working, blocked on a
//! decision, finished — carried from the hook script's record file to the
//! window as an `agent-turn` event keyed by PTY id.
//!
//! Why this exists: the working / decision / finished marks on a tab used to be
//! inferred from the bytes the agent painted, and every agent TUI defeats that
//! in its own way. Codex repaints a braille spinner and its terminal title on a
//! 100 ms timer whether it is working, blocked or idle, and while it works the
//! only *text* that changes is a once-a-second timer; Claude Code goes silent
//! when it stops but animates a spinner cell while it waits on a tool. Two
//! rounds of filtering (drop empty frames, drop braille cells) each fixed one
//! agent's habit and broke another's reading. The agents themselves know
//! exactly when a turn starts (`UserPromptSubmit`), pauses on the user
//! (`Notification` with `permission_prompt`), resumes (`PostToolUse`) and ends
//! (`Stop`), and both Claude Code and Codex run Eldrun's hook script on those
//! events already (see `services::agent_session`). The script writes one small
//! record per tab, `<live_sessions>/<ELDRUN_TAB_UID>.turn`, holding the state
//! word; this module watches that directory and hands the state to the
//! frontend's activity store, which treats it as the authority for the tab and
//! keeps the byte heuristic only for agents that fire no hooks (Gemini, Qwen,
//! a custom command, a Codex whose hooks are not yet trusted).
//!
//! The record is keyed by the tab's launch uid, which the frontend never sees;
//! `pty_spawn` registers the uid → PTY id pair here (and clears a record left
//! by a previous run, so a tab never restarts "working" off a stale file), and
//! the watcher resolves each record to the PTY id the activity store already
//! keys everything by. Inside the agent fence a project's own live-sessions
//! slice is mounted at the shared root's path, so on the host the file lands
//! in `<live_sessions>/<project>/`; the watch is recursive for that reason.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::services::agent_session::{live_sessions_dir, project_live_sessions_dir};

/// Suffix of the per-tab turn record beside the session record (`<uid>.turn`).
pub const TURN_SUFFIX: &str = ".turn";

/// The event the frontend listens for: `{ id: <pty id>, state: <word> }`.
pub const TURN_EVENT: &str = "agent-turn";

/// What the hook script may write. `Idle` (a `SessionEnd`) means the agent is
/// gone and the tab is back to whatever its bytes say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnState {
    Working,
    Decision,
    Done,
    Idle,
}

impl TurnState {
    pub fn as_str(self) -> &'static str {
        match self {
            TurnState::Working => "working",
            TurnState::Decision => "decision",
            TurnState::Done => "done",
            TurnState::Idle => "idle",
        }
    }
}

/// Parse a turn record: the state word, optionally followed by the epoch
/// seconds the hook wrote it (kept for diagnosis; the window stamps receipt).
/// Anything else — an empty file mid-write, a word from a newer script — is
/// `None`, never a guess.
pub fn parse_turn_record(text: &str) -> Option<TurnState> {
    let word = text.split_whitespace().next()?;
    match word {
        "working" => Some(TurnState::Working),
        "decision" => Some(TurnState::Decision),
        "done" => Some(TurnState::Done),
        "idle" => Some(TurnState::Idle),
        _ => None,
    }
}

/// uid → PTY id, for every agent tab spawned this run.
fn bindings() -> &'static Mutex<HashMap<String, String>> {
    static B: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Remember that the tab whose hooks key by `uid` is the PTY `pty_id`, and
/// forget any turn record an earlier run of that tab left behind — a resumable
/// tab keeps its uid across relaunches, and a `working` written before a crash
/// or quit would otherwise be the first thing the watcher reports for it.
pub fn bind_tab(uid: &str, pty_id: &str, project_id: Option<&str>) {
    if uid.is_empty() || uid.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '-')) {
        return;
    }
    let mut b = bindings().lock().unwrap();
    // One PTY, one uid: a respawn under a new uid must not leave the old key
    // pointing at this PTY.
    b.retain(|_, v| v != pty_id);
    b.insert(uid.to_string(), pty_id.to_string());
    drop(b);
    clear_record(uid, project_id);
}

/// Drop the binding(s) of a PTY that is gone.
pub fn on_tab_gone(pty_id: &str) {
    bindings().lock().unwrap().retain(|_, v| v != pty_id);
}

/// The PTY id bound to `uid`, if any.
pub fn pty_for(uid: &str) -> Option<String> {
    bindings().lock().unwrap().get(uid).cloned()
}

fn record_paths(uid: &str, project_id: Option<&str>) -> Vec<PathBuf> {
    let name = format!("{uid}{TURN_SUFFIX}");
    let mut paths = vec![live_sessions_dir().join(&name)];
    if let Some(pid) = project_id {
        paths.push(project_live_sessions_dir(pid).join(&name));
    }
    paths
}

/// Remove the turn record(s) for `uid`: the shared root's and, when the tab has
/// a project, the project's own slice (where a fenced or contained agent's
/// hook writes).
pub fn clear_record(uid: &str, project_id: Option<&str>) {
    for p in record_paths(uid, project_id) {
        let _ = std::fs::remove_file(p);
    }
}

/// The uid a record path stands for, or `None` for any other file.
fn uid_of(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let uid = name.strip_suffix(TURN_SUFFIX)?;
    if uid.is_empty() || uid.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '-')) {
        return None;
    }
    Some(uid.to_string())
}

/// What one filesystem event on `path` means for the window: the PTY it maps to
/// and the state now in the file. `None` when the path is not a record, is not
/// a tab of this run, or holds nothing readable (a removal, a half-written
/// file — the next write will say).
pub fn resolve_event(path: &Path) -> Option<(String, TurnState)> {
    let uid = uid_of(path)?;
    let pty = pty_for(&uid)?;
    let text = std::fs::read_to_string(path).ok()?;
    let state = parse_turn_record(&text)?;
    Some((pty, state))
}

#[derive(serde::Serialize, Clone)]
struct TurnPayload {
    id: String,
    state: &'static str,
}

/// How often a held `done` (see [`background_job_running`]) is re-checked.
const HOLD_POLL: Duration = Duration::from_secs(2);

/// How often a held tab's `working` is re-sent while its job runs. Under the
/// activity store's `HOOK_WORK_SILENCE_MS` (20 s): an agent waiting on a
/// background job paints nothing, and a verdict that outlives all paint is
/// retired there as a turn nobody ended.
const HOLD_REFRESH: Duration = Duration::from_secs(8);

/// Tabs whose `done` is being held back as `working` because a shell the agent
/// started is still running, keyed by uid, with when `working` was last sent.
fn held() -> &'static Mutex<HashMap<String, Instant>> {
    static H: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What the window is told for a hook state. A `done` while the agent still has
/// a background shell of its own running (Claude's `run_in_background`, a
/// Codex exec session left open) is `working`: the turn ended, the work did
/// not. The tab is then held, and [`tick_held`] releases the `done` once the
/// last such shell exits. Any other state ends a hold.
fn relay_state(uid: &str, state: TurnState) -> TurnState {
    let mut held = held().lock().unwrap();
    if state == TurnState::Done && background_job_running(uid) {
        held.insert(uid.to_string(), Instant::now());
        return TurnState::Working;
    }
    held.remove(uid);
    state
}

/// One pass over the held tabs: `(pty, state)` for each that needs an event —
/// `done` for a tab whose background shells are gone, a refreshed `working`
/// for one whose job has run another [`HOLD_REFRESH`]. A tab whose PTY is gone
/// is dropped silently.
fn tick_held() -> Vec<(String, TurnState)> {
    let mut held = held().lock().unwrap();
    let mut out = Vec::new();
    held.retain(|uid, sent| {
        let Some(pty) = pty_for(uid) else { return false };
        if !background_job_running(uid) {
            out.push((pty, TurnState::Done));
            return false;
        }
        if sent.elapsed() >= HOLD_REFRESH {
            *sent = Instant::now();
            out.push((pty, TurnState::Working));
        }
        true
    });
    out
}

/// Shells a tool call runs in. A background job is one of these, never one of
/// the agent's other long-lived children (an MCP server, Codex's code-mode host).
#[cfg(any(target_os = "linux", test))]
const SHELL_COMMS: &[&str] = &["bash", "sh", "dash", "zsh", "fish", "ksh", "mksh"];

/// Whether a process is a shell the agent started for a tool call: a shell
/// running Claude Code's Bash-tool wrapper (it sources the CLI's shell
/// snapshot), or a shell whose parent is Codex (or its sandbox helper, whose
/// 15-byte `comm` still starts with `codex`). The tab's launcher shell
/// (`bash -c 'claude' …`, the fence's launch script) is neither.
#[cfg(any(target_os = "linux", test))]
fn is_agent_tool_shell(comm: &str, cmdline: &str, parent_comm: &str) -> bool {
    SHELL_COMMS.contains(&comm)
        && (cmdline.contains("/shell-snapshots/snapshot-") || parent_comm.starts_with("codex"))
}

/// Whether a NUL-separated environment block sets `ELDRUN_TAB_UID` to `uid`.
#[cfg(any(target_os = "linux", test))]
fn environ_has_uid(environ: &[u8], uid: &str) -> bool {
    let want = format!("ELDRUN_TAB_UID={uid}");
    environ.split(|b| *b == 0).any(|kv| kv == want.as_bytes())
}

/// Whether the agent in tab `uid` still has a tool shell running. Asked only on
/// a `done` and, for a held tab, every [`HOLD_POLL`]: the turn has ended, so a
/// tool shell still alive is one the agent put in the background.
///
/// The PTY's process tree cannot answer this — an agent tab runs under tmux, so
/// the agent hangs off the tmux server, not the tab's PTY — but every process
/// under the tab inherits `ELDRUN_TAB_UID`, fenced ones included (bubblewrap
/// moves the pid namespace, not the owner, so the host still reads their
/// environ). Linux reads `/proc`; elsewhere the hook verdict stands as sent. A
/// contained agent's shells belong to the container's user and a remote one's
/// live on its host, so those keep the plain verdict too.
#[cfg(target_os = "linux")]
fn background_job_running(uid: &str) -> bool {
    fn stat_of(pid: &str) -> Option<(String, String)> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let comm = stat.get(stat.find('(')? + 1..stat.rfind(')')?)?.to_string();
        let ppid = stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.to_string();
        Some((comm, ppid))
    }
    let Ok(dir) = std::fs::read_dir("/proc") else { return false };
    dir.flatten().any(|entry| {
        let name = entry.file_name();
        let Some(pid) = name.to_str().filter(|n| n.bytes().all(|b| b.is_ascii_digit())) else {
            return false;
        };
        // `comm` first: a stat read is cheap, and only shells go on to have
        // their environment read.
        let Some((comm, ppid)) = stat_of(pid) else { return false };
        if !SHELL_COMMS.contains(&comm.as_str()) {
            return false;
        }
        let Ok(environ) = std::fs::read(format!("/proc/{pid}/environ")) else { return false };
        if !environ_has_uid(&environ, uid) {
            return false;
        }
        let cmdline = crate::sysstat::cmdline(pid.parse().unwrap_or(0)).unwrap_or_default();
        let parent_comm = stat_of(&ppid).map(|(c, _)| c).unwrap_or_default();
        is_agent_tool_shell(&comm, &cmdline, &parent_comm)
    })
}

#[cfg(not(target_os = "linux"))]
fn background_job_running(_uid: &str) -> bool {
    false
}

/// Watch the live-sessions tree for turn records and relay each write as an
/// `agent-turn` event. Runs for the app's lifetime on its own thread; a watcher
/// that cannot be created only costs the hook path (the activity store falls
/// back to its byte heuristic), so failures are logged and swallowed.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        use notify::{RecursiveMode, Watcher};
        use std::sync::mpsc::RecvTimeoutError;
        let root = live_sessions_dir();
        if let Err(e) = std::fs::create_dir_all(&root) {
            eprintln!("agent_turn: create {}: {e}", root.display());
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
        let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            if !(ev.kind.is_create() || ev.kind.is_modify()) {
                return;
            }
            for p in ev.paths {
                if p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(TURN_SUFFIX)) {
                    let _ = tx.send(p);
                }
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("agent_turn: watcher: {e}");
                return;
            }
        };
        if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
            eprintln!("agent_turn: watch {}: {e}", root.display());
            return;
        }
        let emit = |id: String, state: TurnState| {
            let _ = app.emit(TURN_EVENT, TurnPayload { id, state: state.as_str() });
        };
        // Keep the watcher alive for as long as events flow; the loop ends only
        // when the sender side is dropped, i.e. never before the app exits. The
        // timeout is the held tabs' poll, which costs nothing while none is held.
        loop {
            match rx.recv_timeout(HOLD_POLL) {
                Ok(path) => {
                    if let (Some((id, state)), Some(uid)) = (resolve_event(&path), uid_of(&path)) {
                        emit(id, relay_state(&uid, state));
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            for (id, state) in tick_held() {
                emit(id, state);
            }
        }
        drop(watcher);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_state_word_and_refuses_the_rest() {
        assert_eq!(parse_turn_record("working 1758000000"), Some(TurnState::Working));
        assert_eq!(parse_turn_record("decision"), Some(TurnState::Decision));
        assert_eq!(parse_turn_record("done 1\n"), Some(TurnState::Done));
        assert_eq!(parse_turn_record("idle"), Some(TurnState::Idle));
        assert_eq!(parse_turn_record(""), None);
        assert_eq!(parse_turn_record("thinking"), None);
    }

    #[test]
    fn record_paths_are_keyed_by_uid_and_only_uid_shaped_names_resolve() {
        assert_eq!(
            uid_of(Path::new("/x/live/1111-aaaa.turn")).as_deref(),
            Some("1111-aaaa")
        );
        assert_eq!(uid_of(Path::new("/x/live/1111-aaaa")), None);
        assert_eq!(uid_of(Path::new("/x/live/1111-aaaa.mode")), None);
        assert_eq!(uid_of(Path::new("/x/live/a.b.turn")), None);
        assert_eq!(uid_of(Path::new("/x/live/.turn")), None);
    }

    #[test]
    fn binding_maps_a_record_to_its_pty_and_a_gone_pty_unbinds() {
        let dir = std::env::temp_dir().join(format!("eldrun-turn-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&dir).unwrap();
        let uid = "turn-test-uid-1";
        let pty = "proj-a:agent-turn-1";
        // No binding: a record is nobody's.
        let rec = dir.join(format!("{uid}{TURN_SUFFIX}"));
        std::fs::write(&rec, "working 1").unwrap();
        assert_eq!(resolve_event(&rec), None);
        // A record path with a bad uid never resolves, bound or not.
        bindings().lock().unwrap().insert(uid.to_string(), pty.to_string());
        assert_eq!(resolve_event(&rec), Some((pty.to_string(), TurnState::Working)));
        std::fs::write(&rec, "decision 2").unwrap();
        assert_eq!(resolve_event(&rec), Some((pty.to_string(), TurnState::Decision)));
        std::fs::write(&rec, "").unwrap();
        assert_eq!(resolve_event(&rec), None);
        on_tab_gone(pty);
        assert_eq!(pty_for(uid), None);
        std::fs::write(&rec, "done").unwrap();
        assert_eq!(resolve_event(&rec), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebinding_a_pty_forgets_its_previous_uid_and_refuses_a_bad_one() {
        let pty = "proj-b:agent-turn-2";
        bind_tab("old-uid-2", pty, None);
        bind_tab("new-uid-2", pty, None);
        assert_eq!(pty_for("old-uid-2"), None);
        assert_eq!(pty_for("new-uid-2").as_deref(), Some(pty));
        bind_tab("../escape", pty, None);
        assert_eq!(pty_for("../escape"), None);
        assert_eq!(pty_for("new-uid-2").as_deref(), Some(pty));
        on_tab_gone(pty);
        assert_eq!(pty_for("new-uid-2"), None);
    }

    #[test]
    fn only_the_agents_own_tool_shells_count_as_background_jobs() {
        let claude_tool = "/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1-x.sh 2>/dev/null || true && eval 'npm test'";
        assert!(is_agent_tool_shell("bash", claude_tool, "claude"));
        assert!(is_agent_tool_shell("bash", "/bin/bash -lc cargo build", "codex"));
        assert!(is_agent_tool_shell("bash", "bash -lc sleep 60", "codex-linux-san"));
        // The tab's launcher, a Codex helper, an MCP server: none is a job.
        assert!(!is_agent_tool_shell("bash", "bash -c claude --resume x; exec bash -l", "tmux: server"));
        assert!(!is_agent_tool_shell("codex-code-mod", "codex-code-mode-host", "codex"));
        assert!(!is_agent_tool_shell("node", "node mcp-server.js", "claude"));
        // The snapshot path marks a shell, not whatever the shell runs.
        assert!(!is_agent_tool_shell("npm", claude_tool, "bash"));
    }

    #[test]
    fn environ_match_is_exact_on_the_uid() {
        let env = b"HOME=/h\0ELDRUN_TAB_UID=aaaa-1\0PATH=/bin\0";
        assert!(environ_has_uid(env, "aaaa-1"));
        assert!(!environ_has_uid(env, "aaaa"));
        assert!(!environ_has_uid(b"X_ELDRUN_TAB_UID=aaaa-1\0", "aaaa-1"));
    }

    #[test]
    fn a_done_with_no_background_job_passes_through_and_ends_a_hold() {
        let uid = "hold-test-uid-no-such-tab";
        held().lock().unwrap().insert(uid.to_string(), Instant::now());
        // No process carries this uid, so the done stands and the hold ends.
        assert_eq!(relay_state(uid, TurnState::Done), TurnState::Done);
        assert!(!held().lock().unwrap().contains_key(uid));
        assert_eq!(relay_state(uid, TurnState::Working), TurnState::Working);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_live_tool_shell_carrying_the_uid_holds_the_done() {
        let uid = format!("hold-live-{}", std::process::id());
        let tmp = std::env::temp_dir().join(format!("eldrun-hold-{}", std::process::id()));
        let snap = tmp.join("shell-snapshots");
        std::fs::create_dir_all(&snap).unwrap();
        let snapshot = snap.join("snapshot-bash-test.sh");
        std::fs::write(&snapshot, "").unwrap();
        // The shape of Claude's Bash tool: a shell sourcing its snapshot, then
        // the command — here one that outlives the turn (the trailing `true`
        // keeps bash from exec-ing into `sleep`, as the real wrapper does).
        let mut child = std::process::Command::new("bash")
            .arg("-c")
            .arg(format!("source {} && sleep 30; true", snapshot.display()))
            .env("ELDRUN_TAB_UID", &uid)
            .spawn()
            .unwrap();
        let seen = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            background_job_running(&uid)
        });
        assert!(seen);
        assert!(!background_job_running("hold-live-someone-else"));
        let _ = child.kill();
        let _ = child.wait();
        assert!(!background_job_running(&uid));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
