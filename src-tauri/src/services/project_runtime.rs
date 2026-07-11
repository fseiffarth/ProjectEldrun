
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::apps::WindowRegistryState;
use crate::commands::workspace::WorkspaceStateArc;
use crate::schema::project::TabEntry;
use crate::schema::session::{FileTabSession, LayoutSession, ProjectState};
use crate::services::{restore_service, terminal_service, window_service};
use crate::services::terminal_service::eldrun_sessions_dir;
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
    /// Opaque split/group layout tree to persist alongside `tab_layout`.
    #[serde(default)]
    pub tab_groups: Option<serde_json::Value>,
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
    /// Opaque split/group layout tree for the next project (None → legacy).
    pub tab_groups: Option<serde_json::Value>,
    pub file_tabs: Vec<serde_json::Value>,
    pub right_panel_folder: Option<String>,
    /// Registry IDs of all project-owned tracked windows after the switch.
    pub opened_window_ids: Vec<String>,
}

// ── Switch coordinator ────────────────────────────────────────────────────

/// Execute a full project-runtime switch.
///
/// `previous_local_file` and `next_local_file` are the paths to the respective
/// `project.json` files.
pub fn switch(
    app: &AppHandle,
    workspace: &WorkspaceStateArc,
    win_registry: &WindowRegistryState,
    project_id: Option<&str>,
    previous_project_id: Option<&str>,
    previous_local_file: Option<&str>,
    next_local_file: Option<&str>,
    snapshot: &PreviousProjectSnapshot,
) -> Result<ProjectRuntimeSwitchedPayload, String> {
    // 1. Flush elapsed time for the previous project.
    if snapshot.flush_secs > 0.0 {
        if let Some(prev_id) = previous_project_id {
            flush_project_secs(prev_id, snapshot.flush_secs);
        }
    }

    // 2. Save previous project's tab layout to project.json + .eldrun/sessions/.
    if let Some(local_file) = previous_local_file {
        if let Err(e) = terminal_service::save_terminal_session(
            local_file,
            &snapshot.tab_layout,
            snapshot.active_tab_index,
            snapshot.tab_groups.clone(),
        ) {
            eprintln!("ProjectRuntime: save tab layout: {e}");
        }
        save_previous_sessions(local_file, previous_project_id, snapshot);
    }

    // 2b. Remote projects are SSH/SFTP-native (no mount): the pooled connection
    //     is opened by the frontend on activation (`remote_connect`), and file
    //     browse / I-O / git dispatch over SFTP/SSH. Nothing to mount here.

    // 3. Load the next project's session data (terminal, apps, file tabs).
    //    This is the only part the frontend waits on, so it runs before the
    //    slow window hide/show below.
    let next_terminal_session = next_local_file
        .map(terminal_service::load_terminal_session)
        .unwrap_or_default();
    let next_open_apps = next_local_file
        .map(terminal_service::load_open_apps)
        .unwrap_or_default();
    let (next_file_tabs, next_right_panel_folder) = next_local_file
        .map(load_file_tab_session)
        .unwrap_or_default();

    // 4. Emit the layout payload now so the frontend restores tabs immediately,
    //    without waiting on window management. `opened_window_ids` is filled in
    //    on the returned payload below; the frontend doesn't use it, so the
    //    early event leaves it empty.
    let payload = ProjectRuntimeSwitchedPayload {
        project_id: project_id.map(String::from),
        tab_layout: next_terminal_session.tab_layout,
        active_tab_index: next_terminal_session.active_tab_index,
        tab_groups: next_terminal_session.tab_groups,
        file_tabs: next_file_tabs,
        right_panel_folder: next_right_panel_folder,
        opened_window_ids: vec![],
    };
    let _ = app.emit("project-runtime-switched", payload.clone());

    // 5. Hide previous project-owned windows.
    //    Acquire WindowRegistry before WorkspaceState (lock order).
    {
        let prev_wids = {
            // `mut` is only exercised on Windows/macOS (the cfg'd re-resolve
            // below); other targets bind it immutably.
            #[cfg_attr(
                not(any(target_os = "windows", target_os = "macos")),
                allow(unused_mut)
            )]
            let mut wins = win_registry.lock().unwrap();
            // Windows/macOS: re-resolve any project-owned window whose id was never
            // captured at launch time (the visible top-level often belongs to a
            // CHILD of the spawned pid). Runs while holding ONLY the registry lock,
            // before the WorkspaceState lock below — lock order preserved. The
            // back-populated ids make this hide AND the switch-back show (step 8)
            // work through the existing id-based primitives. No-op on Linux,
            // where launch-time `_NET_WM_PID` resolution already fills the id.
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            window_service::resolve_missing_window_ids(
                &mut wins.windows,
                previous_project_id,
                |pid| crate::commands::apps::resolve_window_id_for_pid(pid),
            );
            window_service::project_window_ids(&wins.windows, previous_project_id)
        };
        let ws = workspace.lock().unwrap();
        window_service::hide_windows(&*ws.backend, &prev_wids);
    }

    // 5b. #42: Tauri-level hide of the previous project's DETACHED subwindows.
    //     Backend-independent: on X11 it complements the desktop-park above; on
    //     Wayland/KDE/null (where desktop-parking is a no-op) it is the ONLY
    //     mechanism keeping an inactive project's detached window from floating
    //     over every project. Re-shown in step 8b on switch-back.
    {
        let prev_labels = {
            let wins = win_registry.lock().unwrap();
            window_service::project_detached_labels(&wins.windows, previous_project_id)
        };
        for label in &prev_labels {
            if let Some(win) = app.get_webview_window(label) {
                let _ = win.hide();
            }
        }
    }

    // 6. Save previous window session IDs to .eldrun/sessions/windows.json.
    if let Some(local_file) = previous_local_file {
        let prev_reg_ids = {
            let wins = win_registry.lock().unwrap();
            window_service::project_tracked_ids(&wins.windows, previous_project_id)
        };
        window_service::save_window_session(local_file, &prev_reg_ids);
    }

    // 7. Restore standalone project apps.
    if let Some(next_id) = project_id {
        restore_service::restore_project_apps(win_registry, &next_open_apps, next_id);
    }

    // 8. Show next project-owned windows (including freshly restored ones).
    {
        let next_wids = {
            let wins = win_registry.lock().unwrap();
            window_service::project_window_ids(&wins.windows, project_id)
        };
        let ws = workspace.lock().unwrap();
        window_service::show_windows(&*ws.backend, &next_wids);
    }

    // 8b. #42: Tauri-level re-show of the next project's detached subwindows
    //     (mirrors 5b). On Wayland/null this un-hides them; on X11 it pairs with
    //     the desktop un-park in step 8. `unminimize()` first in case a backend
    //     minimized rather than hid them.
    {
        let next_labels = {
            let wins = win_registry.lock().unwrap();
            window_service::project_detached_labels(&wins.windows, project_id)
        };
        for label in &next_labels {
            if let Some(win) = app.get_webview_window(label) {
                let _ = win.unminimize();
                let _ = win.show();
            }
        }
    }

    // 9. Collect opened window IDs and return the completed payload.
    let opened_window_ids = {
        let wins = win_registry.lock().unwrap();
        window_service::project_tracked_ids(&wins.windows, project_id)
    };

    Ok(ProjectRuntimeSwitchedPayload {
        opened_window_ids,
        ..payload
    })
}

// ── Helpers ───────────────────────────────────────────────────────────────

/// Persist file-tab, layout, and state snapshots for the project being left.
fn save_previous_sessions(
    local_file: &str,
    project_id: Option<&str>,
    snapshot: &PreviousProjectSnapshot,
) {
    let Some(sessions_dir) = eldrun_sessions_dir(local_file) else {
        return;
    };

    let file_tab_session = FileTabSession {
        file_tabs: snapshot.file_tabs.clone(),
        right_panel_folder: snapshot.right_panel_folder.clone(),
        extra: Default::default(),
    };
    if let Err(e) = storage::write_json(&sessions_dir.join("filetabs.json"), &file_tab_session) {
        eprintln!("ProjectRuntime: write filetabs session: {e}");
    }

    let layout_session = LayoutSession {
        active_layout_metadata: snapshot.active_layout_metadata.clone(),
        extra: Default::default(),
    };
    if let Err(e) = storage::write_json(&sessions_dir.join("layout.json"), &layout_session) {
        eprintln!("ProjectRuntime: write layout session: {e}");
    }

    // Write .eldrun/state.json one level up from sessions/.
    if let Some(eldrun_dir) = sessions_dir.parent() {
        if let Some(project_dir) = std::path::Path::new(local_file).parent() {
            let state = ProjectState {
                project_id: project_id.unwrap_or("").to_string(),
                project_dir: project_dir.to_string_lossy().into_owned(),
                saved_at: Some(storage::iso_now()),
                extra: Default::default(),
            };
            if let Err(e) = storage::write_json(&eldrun_dir.join("state.json"), &state) {
                eprintln!("ProjectRuntime: write .eldrun/state.json: {e}");
            }
        }
    }
}

/// Load just the right-panel subfolder for a project from its session file.
/// Used to restore the panel view at startup, before any project switch occurs.
pub fn load_right_panel_folder(local_file: &str) -> Option<String> {
    load_file_tab_session(local_file).1
}

/// Persist the right-panel subfolder for a project, preserving any other
/// fields already stored in `.eldrun/sessions/filetabs.json`. Lets the active
/// project's panel view survive a restart even without a project switch.
pub fn save_right_panel_folder(local_file: &str, folder: Option<String>) -> Result<(), String> {
    let Some(sessions_dir) = eldrun_sessions_dir(local_file) else {
        return Err("cannot resolve project sessions directory".into());
    };
    let path = sessions_dir.join("filetabs.json");
    let mut session: FileTabSession = if path.exists() {
        storage::read_json(&path).unwrap_or_default()
    } else {
        FileTabSession::default()
    };
    session.right_panel_folder = folder;
    storage::write_json(&path, &session).map_err(|e| e.to_string())
}

/// Load file tabs and right-panel folder from `.eldrun/sessions/filetabs.json`.
/// Returns (file_tabs, right_panel_folder).
fn load_file_tab_session(local_file: &str) -> (Vec<serde_json::Value>, Option<String>) {
    if let Some(sessions_dir) = eldrun_sessions_dir(local_file) {
        let path = sessions_dir.join("filetabs.json");
        if path.exists() {
            if let Ok(session) = storage::read_json::<FileTabSession>(&path) {
                return (session.file_tabs, session.right_panel_folder);
            }
        }
    }
    (vec![], None)
}

fn flush_project_secs(project_id: &str, secs: f64) {
    // Efficiency #12: record into the rolling daily-summary file (a small,
    // bounded map) instead of appending to the unbounded `time_log.json` and
    // rewriting the whole growing file on every switch / 60s tick.
    crate::schema::time_log::record_secs(project_id, secs);
}
