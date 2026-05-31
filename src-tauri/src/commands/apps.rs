//! External app launching and window tracking.
//!
//! Eldrun's X11 window embedding model is intentionally dropped in the Tauri
//! rewrite (fundamentally incompatible with the WebView). Instead, external
//! apps are tracked by PID and launched/raised as separate windows.
//! `project.json["open_apps"]` is preserved for backward compatibility but
//! treated as best-effort restore metadata.

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

// ── Types ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackedWindow {
    pub id: String,
    pub exec: String,
    pub file: Option<String>,
    pub pid: u32,
    pub project_id: Option<String>,
    pub role: Option<String>,
    pub opened_at: f64,
}

#[derive(Default)]
pub struct WindowRegistry {
    pub windows: HashMap<String, TrackedWindow>,
}

pub type WindowRegistryState = Arc<Mutex<WindowRegistry>>;

// ── Core launch helper ────────────────────────────────────────────────────

fn do_launch(
    registry: &WindowRegistryState,
    exec: &str,
    file: Option<&str>,
    project_id: Option<&str>,
    role: Option<&str>,
) -> Result<TrackedWindow, String> {
    let mut cmd = Command::new(exec);
    if let Some(f) = file {
        cmd.arg(f);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let child = cmd.spawn().map_err(|e| format!("launch {exec}: {e}"))?;
    let pid = child.id();

    let opened_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();

    let safe_exec = exec.replace(['/', ' '], "-");
    let id = format!("{safe_exec}-{pid}");
    let win = TrackedWindow {
        id: id.clone(),
        exec: exec.to_string(),
        file: file.map(String::from),
        pid,
        project_id: project_id.map(String::from),
        role: role.map(String::from),
        opened_at,
    };
    registry.lock().unwrap().windows.insert(id, win.clone());
    Ok(win)
}

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn launch_app(
    registry: State<'_, WindowRegistryState>,
    exec: String,
    file: Option<String>,
    project_id: Option<String>,
    role: Option<String>,
) -> Result<TrackedWindow, String> {
    do_launch(
        registry.inner(),
        &exec,
        file.as_deref(),
        project_id.as_deref(),
        role.as_deref(),
    )
}

#[tauri::command]
pub fn open_file(path: String, handler: Option<String>) -> Result<(), String> {
    if let Some(exec) = handler {
        Command::new(&exec)
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("open with {exec}: {e}"))?;
        return Ok(());
    }
    opener::open(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_tracked_windows(
    registry: State<'_, WindowRegistryState>,
    project_id: Option<String>,
) -> Vec<TrackedWindow> {
    let reg = registry.lock().unwrap();
    reg.windows
        .values()
        .filter(|w| {
            project_id
                .as_deref()
                .map_or(true, |pid| w.project_id.as_deref() == Some(pid))
        })
        .cloned()
        .collect()
}

#[tauri::command]
pub fn untrack_window(registry: State<'_, WindowRegistryState>, id: String) -> bool {
    registry.lock().unwrap().windows.remove(&id).is_some()
}

#[tauri::command]
pub fn check_pid_alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    return std::path::Path::new(&format!("/proc/{pid}")).exists();
    #[cfg(not(target_os = "linux"))]
    return false;
}

/// Best-effort restore: launch apps from `open_apps` metadata.
/// Skips embedded-mode apps (unsupported in Tauri).
#[tauri::command]
pub fn restore_open_apps(
    registry: State<'_, WindowRegistryState>,
    open_apps: Vec<crate::schema::project::OpenApp>,
    project_id: String,
) -> Vec<TrackedWindow> {
    let mut launched = Vec::new();
    for app in open_apps {
        if app.mode.as_deref() == Some("embedded") {
            continue;
        }
        // Skip if already running for this project.
        {
            let reg = registry.lock().unwrap();
            if reg.windows.values().any(|w| {
                w.exec == app.exec && w.project_id.as_deref() == Some(&project_id)
            }) {
                continue;
            }
        }
        if let Ok(win) = do_launch(
            registry.inner(),
            &app.exec,
            app.file.as_deref(),
            Some(&project_id),
            None,
        ) {
            launched.push(win);
        }
    }
    launched
}
