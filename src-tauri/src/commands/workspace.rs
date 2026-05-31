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
) -> Result<(), String> {
    state
        .lock()
        .unwrap()
        .backend
        .switch_to_project(&project_id)?;
    let info = state.lock().unwrap().backend.info();
    let _ = app.emit("workspace-changed", info);
    Ok(())
}

#[tauri::command]
pub fn workspace_name(state: State<'_, WorkspaceStateArc>) -> String {
    state.lock().unwrap().backend.name().to_string()
}
