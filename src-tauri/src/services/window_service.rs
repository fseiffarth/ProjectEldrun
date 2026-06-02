use std::collections::HashMap;

use crate::commands::apps::{
    TrackedWindow, ORIGIN_MIDDLE_FILE_BROWSER, ORIGIN_RESTORED, ORIGIN_RIGHT_FILE_TREE,
};
use crate::platform::WorkspaceBackend;

pub fn hide_windows(backend: &dyn WorkspaceBackend, window_ids: &[u64]) {
    for &wid in window_ids {
        if let Err(e) = backend.hide_window(wid) {
            eprintln!("WindowService: hide {wid}: {e}");
        }
    }
}

pub fn show_windows(backend: &dyn WorkspaceBackend, window_ids: &[u64]) {
    for &wid in window_ids {
        if let Err(e) = backend.show_window(wid) {
            eprintln!("WindowService: show {wid}: {e}");
        }
    }
}

/// X11/compositor window IDs for project-owned windows in the given scope.
pub fn project_window_ids(
    windows: &HashMap<String, TrackedWindow>,
    project_id: Option<&str>,
) -> Vec<u64> {
    windows
        .values()
        .filter(|w| w.project_id.as_deref() == project_id)
        .filter(|w| is_project_owned(&w.origin))
        .filter_map(|w| w.window_id)
        .collect()
}

/// Registry keys for all project-owned tracked windows in the given scope.
pub fn project_tracked_ids(
    windows: &HashMap<String, TrackedWindow>,
    project_id: Option<&str>,
) -> Vec<String> {
    windows
        .values()
        .filter(|w| w.project_id.as_deref() == project_id)
        .filter(|w| is_project_owned(&w.origin))
        .map(|w| w.id.clone())
        .collect()
}

fn is_project_owned(origin: &str) -> bool {
    matches!(
        origin,
        ORIGIN_RIGHT_FILE_TREE | ORIGIN_MIDDLE_FILE_BROWSER | ORIGIN_RESTORED
    )
}
