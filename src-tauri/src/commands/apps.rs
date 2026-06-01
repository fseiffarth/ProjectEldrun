//! External app launching and window tracking.
//!
//! Eldrun's X11 window embedding model is intentionally dropped in the Tauri
//! rewrite (fundamentally incompatible with the WebView). Instead, external
//! apps are tracked by PID and launched/raised as separate windows.
//! `project.json["open_apps"]` is preserved for backward compatibility but
//! treated as best-effort restore metadata.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
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
pub fn resolve_app_icon(exec: String) -> Option<String> {
    let exec_base = Path::new(&exec).file_name()?.to_string_lossy().to_lowercase();
    for desktop_file in desktop_files() {
        if let Some(entry) = parse_desktop_entry(&desktop_file) {
            let Some(entry_base) = Path::new(&entry.exec)
                .file_name()
                .map(|name| name.to_string_lossy().to_lowercase())
            else {
                continue;
            };
            if entry.exec == exec || entry_base == exec_base {
                if let Some(icon_path) = resolve_icon_path(&entry.icon) {
                    return Some(icon_path.to_string_lossy().to_string());
                }
            }
        }
    }
    None
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

struct DesktopEntry {
    exec: String,
    icon: String,
}

fn desktop_files() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.insert(0, PathBuf::from(home).join(".local/share/applications"));
    }

    let mut files = Vec::new();
    for dir in dirs {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("desktop") {
                files.push(path);
            }
        }
    }
    files
}

fn parse_desktop_entry(path: &Path) -> Option<DesktopEntry> {
    let content = fs::read_to_string(path).ok()?;
    let mut in_desktop_entry = false;
    let mut exec = None;
    let mut icon = None;
    for raw in content.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_desktop_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_desktop_entry {
            continue;
        }
        if let Some(value) = line.strip_prefix("Exec=") {
            exec = first_exec_token(value);
        } else if let Some(value) = line.strip_prefix("Icon=") {
            icon = Some(value.to_string());
        }
    }
    Some(DesktopEntry {
        exec: exec?,
        icon: icon?,
    })
}

fn first_exec_token(value: &str) -> Option<String> {
    let first = value
        .split_whitespace()
        .find(|part| !part.starts_with('%'))?
        .trim_matches('"')
        .to_string();
    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

fn resolve_icon_path(icon: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(icon);
    if direct.is_absolute() && direct.exists() {
        return Some(direct);
    }

    let names = [
        format!("{icon}.svg"),
        format!("{icon}.png"),
        format!("{icon}.xpm"),
        icon.to_string(),
    ];
    let mut roots = vec![
        PathBuf::from("/usr/share/pixmaps"),
        PathBuf::from("/usr/local/share/pixmaps"),
        PathBuf::from("/usr/share/icons/hicolor"),
        PathBuf::from("/usr/share/icons/Adwaita"),
        PathBuf::from("/usr/share/icons/breeze"),
        PathBuf::from("/usr/share/icons/breeze-dark"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        roots.insert(0, home.join(".local/share/icons"));
        roots.insert(1, home.join(".icons"));
    }

    for root in roots {
        if let Some(path) = find_icon_file(&root, &names, 5) {
            return Some(path);
        }
    }
    None
}

fn find_icon_file(dir: &Path, names: &[String], depth: usize) -> Option<PathBuf> {
    if depth == 0 || !dir.is_dir() {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let file_name = path.file_name()?.to_string_lossy();
            if names.iter().any(|name| name == file_name.as_ref()) {
                return Some(path);
            }
        }
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_icon_file(&path, names, depth - 1) {
                return Some(found);
            }
        }
    }
    None
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
