use std::path::PathBuf;

use crate::schema::project::{OpenApp, TabEntry};
use crate::storage;

/// Save tab layout into a project.json, preserving all other fields.
pub fn save_tab_layout(local_file: &str, tabs: &[TabEntry]) -> Result<(), String> {
    let path = PathBuf::from(local_file);
    let mut project: crate::schema::project::Project =
        storage::read_json(&path).unwrap_or_default();
    project.tab_layout = if tabs.is_empty() {
        None
    } else {
        Some(tabs.to_vec())
    };
    storage::write_json(&path, &project).map_err(|e| e.to_string())
}

/// Load tab layout from a project.json.
pub fn load_tab_layout(local_file: &str) -> Vec<TabEntry> {
    let path = PathBuf::from(local_file);
    storage::read_json::<crate::schema::project::Project>(&path)
        .ok()
        .and_then(|p| p.tab_layout)
        .unwrap_or_default()
}

/// Load open_apps list from a project.json.
pub fn load_open_apps(local_file: &str) -> Vec<OpenApp> {
    let path = PathBuf::from(local_file);
    storage::read_json::<crate::schema::project::Project>(&path)
        .ok()
        .and_then(|p| p.open_apps)
        .unwrap_or_default()
}
