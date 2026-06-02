use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::commands::apps::WindowRegistryState;
use crate::commands::workspace::WorkspaceStateArc;
use crate::schema::project::TabEntry;
use crate::schema::time_log::TimeLogEntry;
use crate::services::{download_routing, restore_service, terminal_service, window_service};
use crate::storage;

// ── Public snapshot types ─────────────────────────────────────────────────

/// Runtime snapshot the frontend sends when leaving a project.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousProjectSnapshot {
    #[serde(default)]
    pub tab_layout: Vec<TabEntry>,
    #[serde(default)]
    pub active_tab_index: usize,
    #[serde(default)]
    pub file_tabs: Vec<serde_json::Value>,
    pub right_panel_folder: Option<String>,
    #[serde(default)]
    pub active_layout_metadata: Option<serde_json::Value>,
    /// Elapsed project seconds to flush atomically with the switch.
    #[serde(default)]
    pub flush_secs: f64,
}

/// Payload emitted as `project-runtime-switched` and returned to the caller.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRuntimeSwitchedPayload {
    pub project_id: Option<String>,
    pub tab_layout: Vec<TabEntry>,
    pub active_tab_index: usize,
    pub file_tabs: Vec<serde_json::Value>,
    pub right_panel_folder: Option<String>,
    /// Registry IDs of all project-owned tracked windows after the switch.
    pub opened_window_ids: Vec<String>,
}

// ── Switch coordinator ────────────────────────────────────────────────────

/// Execute a full project-runtime switch.
///
/// `previous_local_file` and `next_local_file` are the paths to the respective
/// `project.json` files.  `next_project_dir` is the directory that should
/// receive the `~/eldrun/downloads` symlink; pass the root work dir when
/// switching to the root scope (project_id == None).
pub fn switch(
    app: &AppHandle,
    workspace: &WorkspaceStateArc,
    win_registry: &WindowRegistryState,
    project_id: Option<&str>,
    previous_project_id: Option<&str>,
    previous_local_file: Option<&str>,
    next_local_file: Option<&str>,
    next_project_dir: &str,
    snapshot: &PreviousProjectSnapshot,
) -> Result<ProjectRuntimeSwitchedPayload, String> {
    // 1. Flush elapsed time for the previous project.
    if snapshot.flush_secs > 0.0 {
        if let Some(prev_id) = previous_project_id {
            flush_project_secs(prev_id, snapshot.flush_secs);
        }
    }

    // 2. Save previous project's tab layout to its project.json.
    if let Some(local_file) = previous_local_file {
        if let Err(e) = terminal_service::save_tab_layout(local_file, &snapshot.tab_layout) {
            eprintln!("ProjectRuntime: save tab layout: {e}");
        }
    }

    // 3. Hide previous project-owned windows.
    //    Acquire WindowRegistry before WorkspaceState (lock order).
    {
        let prev_wids = {
            let wins = win_registry.lock().unwrap();
            window_service::project_window_ids(&wins.windows, previous_project_id)
        };
        let ws = workspace.lock().unwrap();
        window_service::hide_windows(&*ws.backend, &prev_wids);
    }

    // 4. Point ~/eldrun/downloads at the next project (or root work dir).
    if let Err(e) = download_routing::route_downloads(next_project_dir) {
        eprintln!("ProjectRuntime: download routing: {e}");
    }

    // 5. Load next project data.
    let next_tab_layout = next_local_file
        .map(terminal_service::load_tab_layout)
        .unwrap_or_default();
    let next_open_apps = next_local_file
        .map(terminal_service::load_open_apps)
        .unwrap_or_default();

    // 6. Restore standalone project apps.
    if let Some(next_id) = project_id {
        restore_service::restore_project_apps(win_registry, &next_open_apps, next_id);
    }

    // 7. Show next project-owned windows (including freshly restored ones).
    {
        let next_wids = {
            let wins = win_registry.lock().unwrap();
            window_service::project_window_ids(&wins.windows, project_id)
        };
        let ws = workspace.lock().unwrap();
        window_service::show_windows(&*ws.backend, &next_wids);
    }

    // 8. Collect opened window IDs for the payload.
    let opened_window_ids = {
        let wins = win_registry.lock().unwrap();
        window_service::project_tracked_ids(&wins.windows, project_id)
    };

    let payload = ProjectRuntimeSwitchedPayload {
        project_id: project_id.map(String::from),
        tab_layout: next_tab_layout,
        active_tab_index: 0,
        file_tabs: vec![],
        right_panel_folder: None,
        opened_window_ids,
    };

    let _ = app.emit("project-runtime-switched", payload.clone());
    Ok(payload)
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn flush_project_secs(project_id: &str, secs: f64) {
    let path = storage::state_dir().join("time_log.json");
    let mut log: crate::schema::time_log::TimeLog = if path.exists() {
        storage::read_json(&path).unwrap_or_default()
    } else {
        vec![]
    };
    log.push(TimeLogEntry {
        project_id: project_id.to_string(),
        date: storage::today_utc(),
        start_iso: storage::iso_now(),
        duration_s: secs,
        extra: HashMap::new(),
    });
    let _ = storage::write_json(&path, &log);
}
