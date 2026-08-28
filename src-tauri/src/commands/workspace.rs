use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use crate::commands::apps::{opened_windows_for_project, TrackedWindow, WindowRegistryState};
use crate::platform::{detect_backend, WorkspaceBackend, WorkspaceInfo};
use crate::services::window_service;

pub struct WorkspaceState {
    pub backend: Box<dyn WorkspaceBackend>,
}

pub type WorkspaceStateArc = Arc<Mutex<WorkspaceState>>;

impl Default for WorkspaceState {
    fn default() -> Self {
        Self::new()
    }
}

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
        let previous_window_ids =
            window_service::project_window_ids(&windows.windows, previous_project_id.as_deref());
        let current_window_ids =
            window_service::project_window_ids(&windows.windows, project_id.as_deref());
        (previous_window_ids, current_window_ids)
    };

    {
        let workspace = state.lock().unwrap();
        window_service::hide_windows(&*workspace.backend, &previous_window_ids);
        window_service::show_windows(&*workspace.backend, &current_window_ids);
    }
    let info = state.lock().unwrap().backend.info();
    let _ = app.emit("workspace-changed", info);
    Ok(())
}

#[tauri::command]
pub fn show_window(state: State<'_, WorkspaceStateArc>, window_id: u64) -> Result<(), String> {
    state.lock().unwrap().backend.show_window(window_id)
}

#[tauri::command]
pub fn hide_window(state: State<'_, WorkspaceStateArc>, window_id: u64) -> Result<(), String> {
    state.lock().unwrap().backend.hide_window(window_id)
}

#[tauri::command]
pub fn get_opened_windows(
    windows: State<'_, WindowRegistryState>,
    project_id: Option<String>,
) -> Vec<TrackedWindow> {
    let windows = windows.lock().unwrap();
    opened_windows_for_project(windows.windows.values(), project_id.as_deref())
}

#[tauri::command]
pub fn switch_project_windows(
    state: State<'_, WorkspaceStateArc>,
    windows: State<'_, WindowRegistryState>,
    project_id: Option<String>,
    previous_project_id: Option<String>,
) -> Result<(), String> {
    let (previous_window_ids, current_window_ids) = {
        let windows = windows.lock().unwrap();
        let previous =
            opened_windows_for_project(windows.windows.values(), previous_project_id.as_deref());
        let current = opened_windows_for_project(windows.windows.values(), project_id.as_deref());
        (
            previous
                .into_iter()
                .filter_map(|window| window.window_id)
                .collect::<Vec<_>>(),
            current
                .into_iter()
                .filter_map(|window| window.window_id)
                .collect::<Vec<_>>(),
        )
    };

    let backend = state.lock().unwrap();
    for window_id in previous_window_ids {
        if let Err(error) = backend.backend.hide_window(window_id) {
            eprintln!("hide tracked window {window_id} failed: {error}");
        }
    }
    for window_id in current_window_ids {
        if let Err(error) = backend.backend.show_window(window_id) {
            eprintln!("show tracked window {window_id} failed: {error}");
        }
    }
    Ok(())
}

#[tauri::command]
pub fn workspace_name(state: State<'_, WorkspaceStateArc>) -> String {
    state.lock().unwrap().backend.name().to_string()
}

/// Returns "wlan", "lan", or "disconnected".
///
/// Async + `spawn_blocking`: the header polls this every 10 s, and on
/// Windows/macOS the probe spawns `netsh` / `route` + `networksetup`
/// (100–500 ms each, worse when the network stack is wedged) — run
/// synchronously that work landed on the main thread every tick. The spawns
/// are additionally time-capped ([`probe_output_capped`]) so a hung tool
/// yields "disconnected" instead of a stuck poll.
#[tauri::command]
pub async fn network_conn_type() -> String {
    tokio::task::spawn_blocking(network_conn_type_blocking)
        .await
        .unwrap_or_else(|_| "disconnected".into())
}

pub(crate) fn network_conn_type_blocking() -> String {
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

/// Hard cap on one connectivity-probe spawn. Well under the header's 10 s poll
/// interval so a slow tool cannot make ticks pile up.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Run `bin args…` and return its stdout, or `None` on spawn failure or when it
/// exceeds [`PROBE_TIMEOUT`] (the child is killed). The slimmed-down twin of
/// `printing.rs`'s `run_capped`: `netsh`/`networksetup` talk to OS services
/// that can hang, and `.output()` alone would wait with them. stderr is
/// discarded (these probes only pattern-match stdout), so a single reader
/// thread suffices and cannot deadlock on a full pipe.
fn probe_output_capped(bin: &str, args: &[&str]) -> Option<String> {
    use std::process::Stdio;
    let mut child = crate::paths::command_no_window(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out_pipe = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = std::io::Read::read_to_end(p, &mut buf);
        }
        buf
    });
    let deadline = std::time::Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(40)),
            Err(_) => return None,
        }
    }
    Some(String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned())
}

pub(crate) fn detect_conn_type_linux(net_dir: &Path) -> String {
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
    // `command_no_window` (inside `probe_output_capped`) keeps these probes
    // from flashing a console window on every poll (Eldrun is a windowed app
    // with no console).
    if let Some(text) = probe_output_capped("netsh", &["wlan", "show", "interfaces"]) {
        let text = text.to_lowercase();
        if text.contains("state") && text.contains("connected") {
            return "wlan".into();
        }
    }
    // Check for any active Ethernet via `netsh interface show interface`.
    if let Some(text) = probe_output_capped("netsh", &["interface", "show", "interface"]) {
        if text.to_lowercase().contains("connected") {
            return "lan".into();
        }
    }
    "disconnected".into()
}

pub(crate) fn detect_conn_type_macos() -> String {
    // Check the default route's interface, then probe its type via networksetup.
    let Some(text) = probe_output_capped("route", &["-n", "get", "default"]) else {
        return "disconnected".into();
    };
    for line in text.lines() {
        if let Some(iface) = line.trim().strip_prefix("interface:") {
            let iface = iface.trim();
            let hw = probe_output_capped("networksetup", &["-getinfo", iface])
                .map(|o| o.to_lowercase())
                .unwrap_or_default();
            if hw.contains("wi-fi") || hw.contains("airport") {
                return "wlan".into();
            }
            return "lan".into();
        }
    }
    "disconnected".into()
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn mk(dir: &std::path::Path, iface: &str, up: bool, wireless: bool) {
        let iface_dir = dir.join(iface);
        fs::create_dir_all(&iface_dir).unwrap();
        fs::write(
            iface_dir.join("operstate"),
            if up { "up\n" } else { "down\n" },
        )
        .unwrap();
        if wireless {
            fs::create_dir_all(iface_dir.join("wireless")).unwrap();
        }
    }

    #[test]
    fn empty_net_dir_is_disconnected() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(detect_conn_type_linux(tmp.path()), "disconnected");
    }

    #[test]
    fn loopback_only_is_disconnected() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "lo", true, false);
        assert_eq!(detect_conn_type_linux(tmp.path()), "disconnected");
    }

    #[test]
    fn ethernet_up_is_lan() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "eth0", true, false);
        assert_eq!(detect_conn_type_linux(tmp.path()), "lan");
    }

    #[test]
    fn ethernet_down_is_disconnected() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "eth0", false, false);
        assert_eq!(detect_conn_type_linux(tmp.path()), "disconnected");
    }

    #[test]
    fn wireless_up_is_wlan() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "wlan0", true, true);
        assert_eq!(detect_conn_type_linux(tmp.path()), "wlan");
    }

    #[test]
    fn wireless_down_is_disconnected() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "wlan0", false, true);
        assert_eq!(detect_conn_type_linux(tmp.path()), "disconnected");
    }

    #[test]
    fn loopback_plus_ethernet_is_lan() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "lo", true, false);
        mk(tmp.path(), "eth0", true, false);
        assert_eq!(detect_conn_type_linux(tmp.path()), "lan");
    }

    #[test]
    fn missing_net_dir_is_disconnected() {
        assert_eq!(
            detect_conn_type_linux(std::path::Path::new("/nonexistent/sys/class/net")),
            "disconnected"
        );
    }

    #[test]
    fn network_conn_type_returns_known_value() {
        let val = network_conn_type_blocking();
        assert!(
            ["wlan", "lan", "disconnected"].contains(&val.as_str()),
            "unexpected network type: {val}"
        );
    }
}
