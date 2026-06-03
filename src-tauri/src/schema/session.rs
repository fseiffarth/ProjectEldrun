use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::schema::project::TabEntry;

/// `.eldrun/sessions/terminals.json` — terminal tab layout snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub tab_layout: Vec<TabEntry>,
    #[serde(default)]
    pub active_tab_index: usize,
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

/// `.eldrun/sessions/filetabs.json` — file browser tab state and right panel.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileTabSession {
    pub file_tabs: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_panel_folder: Option<String>,
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
