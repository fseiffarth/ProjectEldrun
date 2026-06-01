use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use crate::platform::{detect_backend, WorkspaceBackend, WorkspaceInfo};

pub struct WorkspaceState {
    pub backend: Box<dyn WorkspaceBackend>,
}

pub type WorkspaceStateArc = Arc<Mutex<WorkspaceState>>;

impl WorkspaceState {
    pub fn new() -> Self {
        WorkspaceState {
            backend: detect_backend(),
        }
    }
}

#[tauri::command]
pub fn workspace_info(state: State<'_, WorkspaceStateArc>) -> WorkspaceInfo {
    state.lock().unwrap().backend.info()
}

#[tauri::command]
pub fn workspace_switch(
    state: State<'_, WorkspaceStateArc>,
    app: AppHandle,
    project_id: String,
    previous_project_id: Option<String>,
) -> Result<(), String> {
    state
        .lock()
        .unwrap()
        .backend
        .switch_to_project(&project_id, previous_project_id.as_deref())?;
    let info = state.lock().unwrap().backend.info();
    let _ = app.emit("workspace-changed", info);
    Ok(())
}

#[tauri::command]
pub fn workspace_name(state: State<'_, WorkspaceStateArc>) -> String {
    state.lock().unwrap().backend.name().to_string()
}

/// Returns "wlan", "lan", or "disconnected" by reading /sys/class/net/.
/// Mirrors the Python detect_connection_type() in the GTK4 branch.
#[tauri::command]
pub fn network_conn_type() -> String {
    detect_conn_type(Path::new("/sys/class/net"))
}

fn detect_conn_type(net_dir: &Path) -> String {
    let Ok(entries) = std::fs::read_dir(net_dir) else {
        return "disconnected".into();
    };
    let mut names: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    names.sort();
    for iface in names {
        let name = iface.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == "lo" {
            continue;
        }
        let state = std::fs::read_to_string(iface.join("operstate"))
            .unwrap_or_default();
        if state.trim() != "up" {
            continue;
        }
        if iface.join("wireless").is_dir() {
            return "wlan".into();
        }
        return "lan".into();
    }
    "disconnected".into()
}
