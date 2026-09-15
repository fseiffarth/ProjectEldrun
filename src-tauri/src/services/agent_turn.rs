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

/// Watch the live-sessions tree for turn records and relay each write as an
/// `agent-turn` event. Runs for the app's lifetime on its own thread; a watcher
/// that cannot be created only costs the hook path (the activity store falls
/// back to its byte heuristic), so failures are logged and swallowed.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        use notify::{RecursiveMode, Watcher};
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
        // Keep the watcher alive for as long as events flow; the loop ends only
        // when the sender side is dropped, i.e. never before the app exits.
        for path in rx {
            if let Some((id, state)) = resolve_event(&path) {
                let _ = app.emit(TURN_EVENT, TurnPayload { id, state: state.as_str() });
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
}
