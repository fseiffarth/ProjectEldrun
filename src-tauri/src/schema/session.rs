use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::schema::project::{OpenApp, TabEntry};

/// A project's terminal tab layout snapshot.
///
/// Lives at `<state_dir>/sessions/<project key>/terminals.json` — see
/// [`crate::storage::project_session_dir`] for why it is **not** in the project
/// tree. A copy is still written to `<project>/.eldrun/sessions/terminals.json`
/// so the layout keeps travelling with a folder that gets synced or copied, but
/// that copy is **export-only**: nothing reads it without an explicit user
/// action (`commands::projects::adopt_folder_tab_layout`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub tab_layout: Vec<TabEntry>,
    #[serde(default)]
    pub active_tab_index: usize,
    /// Opaque split/group layout tree (frontend-owned). Absent for legacy
    /// sessions, where the frontend rebuilds a single root group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_groups: Option<Value>,
    /// Opaque list of open agent-session UUIDs (frontend-owned).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_tab_sessions: Option<Value>,
    /// Standalone apps to relaunch on project activation. Moved here out of
    /// `project.json`, whose home is the container's writable mount: this list
    /// is a host-side `spawn_reaped` on every activation, so it is exactly the
    /// kind of state that must not be writable from inside the boundary it
    /// escapes. Still filtered by `services::restore_service`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_apps: Option<Vec<OpenApp>>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// `.eldrun/sessions/windows.json` — project-owned window registry IDs.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowSession {
    pub project_window_ids: Vec<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// `.eldrun/sessions/filetabs.json` — file browser tab state and side panel.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileTabSession {
    pub file_tabs: Vec<Value>,
    /// The folder the side panel was browsing. Serialized as `sidePanelFolder`;
    /// the alias reads back the `rightPanelFolder` every build before the panel
    /// was renamed wrote, so an existing `filetabs.json` keeps its folder. Only
    /// the new spelling is ever written — and an older Eldrun reading a new file
    /// merely opens the panel at the project root, which is what it does for a
    /// project that never had one.
    #[serde(alias = "rightPanelFolder", skip_serializing_if = "Option::is_none")]
    pub side_panel_folder: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// `.eldrun/sessions/layout.json` — active layout metadata.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSession {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_layout_metadata: Option<Value>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// `.eldrun/state.json` — top-level project runtime state.
///
/// Written whenever a project is switched away from so that the next restore
/// can quickly identify the last-known runtime state without reading all
/// session sub-files.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectState {
    pub project_id: String,
    pub project_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_at: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}
