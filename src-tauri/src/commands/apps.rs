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
    pub window_id: Option<u32>,
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
    let window_id = find_window_for_pid(pid, 20);

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
        window_id,
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
                    return icon_to_data_url(&icon_path);
                }
            }
        }
    }
    None
}

fn icon_to_data_url(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("xpm") => "image/x-xpixmap",
        _ => "image/png",
    };
    Some(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize]);
        out.push(T[((n >> 12) & 63) as usize]);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] } else { b'=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] } else { b'=' });
    }
    String::from_utf8(out).unwrap_or_default()
}

#[tauri::command]
pub fn open_file(
    registry: State<'_, WindowRegistryState>,
    path: String,
    handler: Option<String>,
    project_id: Option<String>,
) -> Result<TrackedWindow, String> {
    let before = list_x11_window_ids();
    if let Some(exec) = handler {
        let child = Command::new(&exec)
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("open with {exec}: {e}"))?;
        let pid = child.id();
        let window_id = find_window_for_pid(pid, 20).or_else(|| find_new_x11_window(&before, 20));
        return track_opened_file(
            registry.inner(),
            exec,
            path,
            pid,
            project_id,
            window_id,
        );
    }
    opener::open(&path).map_err(|e| e.to_string())?;
    let window_id = find_new_x11_window(&before, 20);
    track_opened_file(
        registry.inner(),
        "open-file".to_string(),
        path,
        0,
        project_id,
        window_id,
    )
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
    if cfg!(target_os = "linux") {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    } else if cfg!(target_os = "windows") {
        // tasklist /FI "PID eq <pid>" exits 0 even if the PID is not found;
        // check that the PID number appears in the output instead.
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {}", pid), "/NH", "/FO", "CSV"])
            .output()
            .map(|o| {
                let out = String::from_utf8_lossy(&o.stdout);
                out.contains(&format!(",\"{}\",", pid))
            })
            .unwrap_or(false)
    } else {
        // macOS / non-Linux Unix: kill(pid, 0) returns 0 if process exists.
        // On non-Unix platforms this branch is never reached (Windows is
        // handled above), so the `false` fallback is a compile-time safety net.
        #[cfg(unix)]
        { return unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }; }
        #[allow(unreachable_code)]
        false
    }
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

fn track_opened_file(
    registry: &WindowRegistryState,
    exec: String,
    path: String,
    pid: u32,
    project_id: Option<String>,
    window_id: Option<u32>,
) -> Result<TrackedWindow, String> {
    let opened_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let id_suffix = window_id.unwrap_or(pid);
    let id = format!("file-{id_suffix}-{opened_at:.0}");
    let win = TrackedWindow {
        id: id.clone(),
        exec,
        file: Some(path),
        pid,
        project_id,
        role: None,
        opened_at,
        window_id,
    };
    registry.lock().unwrap().windows.insert(id, win.clone());
    Ok(win)
}

#[cfg(target_os = "linux")]
fn list_x11_window_ids() -> Vec<u32> {
    x11_client_windows()
        .map(|windows| windows.into_iter().map(|w| w.id).collect())
        .unwrap_or_default()
}

#[cfg(not(target_os = "linux"))]
fn list_x11_window_ids() -> Vec<u32> {
    Vec::new()
}

#[cfg(target_os = "linux")]
fn find_window_for_pid(pid: u32, attempts: usize) -> Option<u32> {
    for _ in 0..attempts {
        if let Ok(windows) = x11_client_windows() {
            if let Some(window) = windows.into_iter().find(|w| w.pid == Some(pid) && !w.protected) {
                return Some(window.id);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn find_window_for_pid(_pid: u32, _attempts: usize) -> Option<u32> {
    None
}

#[cfg(target_os = "linux")]
fn find_new_x11_window(before: &[u32], attempts: usize) -> Option<u32> {
    for _ in 0..attempts {
        if let Ok(windows) = x11_client_windows() {
            if let Some(window) = windows
                .into_iter()
                .find(|w| !before.contains(&w.id) && !w.protected)
            {
                return Some(window.id);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn find_new_x11_window(_before: &[u32], _attempts: usize) -> Option<u32> {
    None
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct X11ClientWindow {
    id: u32,
    pid: Option<u32>,
    protected: bool,
}

#[cfg(target_os = "linux")]
fn x11_client_windows() -> Result<Vec<X11ClientWindow>, String> {
    use xcb::x::{self, Window};
    use xcb::{Connection, Xid};

    let (conn, screen_num) =
        Connection::connect(None).map_err(|e| format!("xcb connect: {e}"))?;
    let root = conn
        .get_setup()
        .roots()
        .nth(screen_num as usize)
        .ok_or_else(|| "missing x11 screen".to_string())?
        .root();
    let net_client_list = intern_atom(&conn, b"_NET_CLIENT_LIST")?;
    let net_wm_pid = intern_atom(&conn, b"_NET_WM_PID")?;
    let reply = conn
        .wait_for_reply(conn.send_request(&x::GetProperty {
            delete: false,
            window: root,
            property: net_client_list,
            r#type: x::ATOM_WINDOW,
            long_offset: 0,
            long_length: 2048,
        }))
        .map_err(|e| e.to_string())?;

    Ok(reply
        .value::<Window>()
        .iter()
        .map(|&window| X11ClientWindow {
            id: window.resource_id(),
            pid: window_pid(&conn, window, net_wm_pid),
            protected: is_protected_window(&conn, window),
        })
        .collect())
}

#[cfg(target_os = "linux")]
fn intern_atom(conn: &xcb::Connection, name: &[u8]) -> Result<xcb::x::Atom, String> {
    conn.wait_for_reply(conn.send_request(&xcb::x::InternAtom {
        only_if_exists: false,
        name,
    }))
    .map(|r| r.atom())
    .map_err(|e| format!("InternAtom {}: {e}", String::from_utf8_lossy(name)))
}

#[cfg(target_os = "linux")]
fn window_pid(conn: &xcb::Connection, window: xcb::x::Window, atom: xcb::x::Atom) -> Option<u32> {
    conn.wait_for_reply(conn.send_request(&xcb::x::GetProperty {
        delete: false,
        window,
        property: atom,
        r#type: xcb::x::ATOM_CARDINAL,
        long_offset: 0,
        long_length: 1,
    }))
    .ok()
    .and_then(|r| r.value::<u32>().first().copied())
}

#[cfg(target_os = "linux")]
fn is_protected_window(conn: &xcb::Connection, window: xcb::x::Window) -> bool {
    let class = conn
        .wait_for_reply(conn.send_request(&xcb::x::GetProperty {
            delete: false,
            window,
            property: xcb::x::ATOM_WM_CLASS,
            r#type: xcb::x::ATOM_STRING,
            long_offset: 0,
            long_length: 64,
        }))
        .ok()
        .map(|r| String::from_utf8_lossy(r.value::<u8>()).to_lowercase())
        .unwrap_or_default();

    ["eldrun", "plasmashell", "kwin", "cinnamon"]
        .iter()
        .any(|protected| class.contains(protected))
}
