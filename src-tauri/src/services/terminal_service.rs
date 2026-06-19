use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::schema::project::{OpenApp, TabEntry};
use crate::schema::session::TerminalSession;
use crate::storage;

/// Save tab layout into a project.json, preserving all other fields.
/// Also mirrors the layout to `.eldrun/sessions/terminals.json`.
/// `groups` is the opaque split/group layout tree (None clears it).
/// `sessions` is the opaque list of open agent-session UUIDs: `Some([])` clears
/// it, `Some(list)` replaces it, and `None` leaves the stored value untouched.
pub fn save_tab_layout(
    local_file: &str,
    tabs: &[TabEntry],
    groups: Option<Value>,
    sessions: Option<Value>,
) -> Result<(), String> {
    write_terminal_session(local_file, tabs, 0, groups, sessions)
}

/// Save tab layout with the active tab index.
/// Writes to `.eldrun/sessions/terminals.json` (including active_tab_index)
/// and also saves to `project.json` (which does not store active_tab_index).
pub fn save_terminal_session(
    local_file: &str,
    tabs: &[TabEntry],
    active_tab_index: usize,
    groups: Option<Value>,
) -> Result<(), String> {
    // The project-switch snapshot carries no session list; leave the persisted
    // UUIDs untouched (the active project's debounced save_tab_layout owns them).
    write_terminal_session(local_file, tabs, active_tab_index, groups, None)
}

fn write_terminal_session(
    local_file: &str,
    tabs: &[TabEntry],
    active_tab_index: usize,
    groups: Option<Value>,
    sessions: Option<Value>,
) -> Result<(), String> {
    let path = PathBuf::from(local_file);
    let mut project: crate::schema::project::Project =
        storage::read_json(&path).unwrap_or_default();
    project.tab_layout = if tabs.is_empty() {
        None
    } else {
        Some(tabs.to_vec())
    };
    // Clear the tree when there are no tabs; otherwise persist what was sent
    // (a missing tree is tolerated → frontend rebuilds a single group on load).
    project.tab_groups = if tabs.is_empty() { None } else { groups.clone() };
    // Only touch the persisted session UUIDs when a list was supplied; an empty
    // list clears them, a missing list (None) preserves what's on disk.
    if let Some(sessions) = sessions {
        let is_empty = sessions.as_array().is_some_and(|a| a.is_empty());
        project.open_tab_sessions = if is_empty { None } else { Some(sessions) };
    }
    storage::write_json(&path, &project).map_err(|e| e.to_string())?;

    // Mirror to .eldrun/sessions/terminals.json.
    if let Some(sessions_dir) = eldrun_sessions_dir(local_file) {
        let session = TerminalSession {
            tab_layout: tabs.to_vec(),
            active_tab_index,
            tab_groups: if tabs.is_empty() { None } else { groups.clone() },
            extra: Default::default(),
        };
        if let Err(e) = storage::write_json(&sessions_dir.join("terminals.json"), &session) {
            eprintln!("terminal_service: write .eldrun session: {e}");
        }
    }

    Ok(())
}

/// Load tab layout. Tries `.eldrun/sessions/terminals.json` first; falls back
/// to `project.json` if the session file is absent or unreadable.
pub fn load_tab_layout(local_file: &str) -> Vec<TabEntry> {
    load_terminal_session(local_file).tab_layout
}

/// Load the full terminal session (tab layout + active tab index).
/// Tries `.eldrun/sessions/terminals.json` first; falls back to `project.json`
/// for the tab layout (active_tab_index will be 0 on fallback).
pub fn load_terminal_session(local_file: &str) -> TerminalSession {
    if let Some(session) = read_session_file(local_file) {
        return session;
    }
    let (tab_layout, tab_groups) = read_project_tab_state(local_file);
    TerminalSession {
        tab_layout,
        active_tab_index: 0,
        tab_groups,
        extra: Default::default(),
    }
}

fn read_session_file(local_file: &str) -> Option<TerminalSession> {
    if let Some(sessions_dir) = eldrun_sessions_dir(local_file) {
        let session_path = sessions_dir.join("terminals.json");
        if session_path.exists() {
            if let Ok(session) = storage::read_json::<TerminalSession>(&session_path) {
                return Some(session);
            }
        }
    }
    None
}

/// Read both the flat tab layout and the opaque layout tree from project.json.
fn read_project_tab_state(local_file: &str) -> (Vec<TabEntry>, Option<Value>) {
    let path = PathBuf::from(local_file);
    match storage::read_json::<crate::schema::project::Project>(&path) {
        Ok(p) => (p.tab_layout.unwrap_or_default(), p.tab_groups),
        Err(_) => (Vec::new(), None),
    }
}

/// Load open_apps list from a project.json.
pub fn load_open_apps(local_file: &str) -> Vec<OpenApp> {
    let path = PathBuf::from(local_file);
    storage::read_json::<crate::schema::project::Project>(&path)
        .ok()
        .and_then(|p| p.open_apps)
        .unwrap_or_default()
}

// ── helpers ───────────────────────────────────────────────────────────────

pub fn eldrun_sessions_dir(local_file: &str) -> Option<PathBuf> {
    Path::new(local_file)
        .parent()
        .map(|p| p.join(".eldrun").join("sessions"))
}
