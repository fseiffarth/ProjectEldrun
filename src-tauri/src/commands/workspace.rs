use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use crate::commands::apps::WindowRegistryState;
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
    windows: State<'_, WindowRegistryState>,
    app: AppHandle,
    project_id: Option<String>,
    previous_project_id: Option<String>,
) -> Result<(), String> {
    let (previous_window_ids, current_window_ids) = {
        let windows = windows.lock().unwrap();
        let previous_window_ids = workspace_window_ids(&windows.windows, previous_project_id.as_deref());
        let current_window_ids = workspace_window_ids(&windows.windows, project_id.as_deref());
        (previous_window_ids, current_window_ids)
    };

    state
        .lock()
        .unwrap()
        .backend
        .switch_to_project(
            project_id.as_deref(),
            previous_project_id.as_deref(),
            &previous_window_ids,
            &current_window_ids,
        )?;
    let info = state.lock().unwrap().backend.info();
    let _ = app.emit("workspace-changed", info);
    Ok(())
}

fn workspace_window_ids(
    windows: &std::collections::HashMap<String, crate::commands::apps::TrackedWindow>,
    project_id: Option<&str>,
) -> Vec<u32> {
    windows
        .values()
        .filter(|window| window.role.is_none())
        .filter(|window| window.project_id.as_deref() == project_id)
        .filter_map(|window| window.window_id)
        .collect()
}

#[tauri::command]
pub fn workspace_name(state: State<'_, WorkspaceStateArc>) -> String {
    state.lock().unwrap().backend.name().to_string()
}

/// Returns "wlan", "lan", or "disconnected".
#[tauri::command]
pub fn network_conn_type() -> String {
    if cfg!(target_os = "linux") {
        detect_conn_type_linux(Path::new("/sys/class/net"))
    } else if cfg!(target_os = "windows") {
        detect_conn_type_windows()
    } else if cfg!(target_os = "macos") {
        detect_conn_type_macos()
    } else {
        "disconnected".into()
    }
}

fn detect_conn_type_linux(net_dir: &Path) -> String {
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
        let state = std::fs::read_to_string(iface.join("operstate")).unwrap_or_default();
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

fn detect_conn_type_windows() -> String {
    // Check for an active Wi-Fi connection via `netsh wlan show interfaces`.
    if let Ok(out) = std::process::Command::new("netsh")
        .args(["wlan", "show", "interfaces"])
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
        if text.contains("state") && text.contains("connected") {
            return "wlan".into();
        }
    }
    // Check for any active Ethernet via `netsh interface show interface`.
    if let Ok(out) = std::process::Command::new("netsh")
        .args(["interface", "show", "interface"])
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
        if text.contains("connected") {
            return "lan".into();
        }
    }
    "disconnected".into()
}

fn detect_conn_type_macos() -> String {
    // Check the default route's interface, then probe its type via networksetup.
    let out = std::process::Command::new("route")
        .args(["-n", "get", "default"])
        .output();
    let Ok(out) = out else {
        return "disconnected".into();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if let Some(iface) = line.trim().strip_prefix("interface:") {
            let iface = iface.trim();
            let hw = std::process::Command::new("networksetup")
                .args(["-getinfo", iface])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase())
                .unwrap_or_default();
            if hw.contains("wi-fi") || hw.contains("airport") {
                return "wlan".into();
            }
            return "lan".into();
        }
    }
    "disconnected".into()
}
