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
use tauri::{Emitter, State};

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
    pub window_id: Option<u64>,
    #[serde(default = "default_window_origin")]
    pub origin: String,
}

#[derive(Default)]
pub struct WindowRegistry {
    pub windows: HashMap<String, TrackedWindow>,
}

pub type WindowRegistryState = Arc<Mutex<WindowRegistry>>;

pub const ORIGIN_RIGHT_FILE_TREE: &str = "right_file_tree";
pub const ORIGIN_MIDDLE_FILE_BROWSER: &str = "middle_file_browser";
pub const ORIGIN_GLOBAL_APP: &str = "global_app";
pub const ORIGIN_MANUAL_LAUNCH: &str = "manual_launch";
pub const ORIGIN_RESTORED: &str = "restored";

fn default_window_origin() -> String {
    ORIGIN_MANUAL_LAUNCH.to_string()
}

pub fn is_project_opened_window(window: &TrackedWindow) -> bool {
    matches!(
        window.origin.as_str(),
        ORIGIN_RIGHT_FILE_TREE | ORIGIN_MIDDLE_FILE_BROWSER
    )
}

pub fn opened_windows_for_project<'a>(
    windows: impl Iterator<Item = &'a TrackedWindow>,
    project_id: Option<&str>,
) -> Vec<TrackedWindow> {
    windows
        .filter(|window| window.project_id.as_deref() == project_id)
        .filter(|window| is_project_opened_window(window))
        .cloned()
        .collect()
}

// ── Core launch helper ────────────────────────────────────────────────────

pub fn do_launch(
    registry: &WindowRegistryState,
    exec: &str,
    file: Option<&str>,
    project_id: Option<&str>,
    role: Option<&str>,
    origin: &str,
) -> Result<TrackedWindow, String> {
    let launch_exec = resolve_launch_exec(exec);
    let mut cmd = Command::new(&launch_exec);
    if let Some(f) = file {
        cmd.arg(f);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let child = cmd
        .spawn()
        .map_err(|e| format!("launch {launch_exec}: {e}"))?;
    let pid = child.id();
    let window_id = find_window_for_pid(pid, 20);

    let opened_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();

    let safe_exec = launch_exec.replace(['/', '\\', ' '], "-");
    let id = format!("{safe_exec}-{pid}");
    let win = TrackedWindow {
        id: id.clone(),
        exec: launch_exec,
        file: file.map(String::from),
        pid,
        project_id: project_id.map(String::from),
        role: role.map(String::from),
        opened_at,
        window_id,
        origin: origin.to_string(),
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
    origin: Option<String>,
) -> Result<TrackedWindow, String> {
    let origin = origin.unwrap_or_else(|| {
        if role.is_some() {
            ORIGIN_GLOBAL_APP.to_string()
        } else {
            ORIGIN_MANUAL_LAUNCH.to_string()
        }
    });
    do_launch(
        registry.inner(),
        &exec,
        file.as_deref(),
        project_id.as_deref(),
        role.as_deref(),
        &origin,
    )
}

/// Icon lookups walk desktop-entry and icon-theme directories recursively, so
/// results (including misses) are cached per exec for the app's lifetime.
static ICON_CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

#[tauri::command]
pub fn resolve_app_icon(exec: String) -> Option<String> {
    if let Some(cached) = ICON_CACHE
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .get(&exec)
    {
        return cached.clone();
    }
    let icon = resolve_app_icon_uncached(&exec);
    ICON_CACHE
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(exec, icon.clone());
    icon
}

fn resolve_app_icon_uncached(exec: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(icon) = resolve_windows_app_icon(exec) {
            return Some(icon);
        }
    }

    let exec_base = Path::new(&exec)
        .file_name()?
        .to_string_lossy()
        .to_lowercase();
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

pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize]);
        out.push(T[((n >> 12) & 63) as usize]);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize]
        } else {
            b'='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize]
        } else {
            b'='
        });
    }
    String::from_utf8(out).unwrap_or_default()
}

#[tauri::command]
pub fn open_file(
    registry: State<'_, WindowRegistryState>,
    path: String,
    handler: Option<String>,
    project_id: Option<String>,
    origin: Option<String>,
) -> Result<TrackedWindow, String> {
    let origin = origin.unwrap_or_else(|| ORIGIN_MANUAL_LAUNCH.to_string());
    let before = list_window_ids();
    if let Some(exec) = handler {
        let launch_exec = resolve_launch_exec(&exec);
        let child = Command::new(&launch_exec)
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("open with {launch_exec}: {e}"))?;
        let pid = child.id();
        let window_id = find_window_for_pid(pid, 20).or_else(|| find_new_window(&before, 20));
        return track_opened_file(
            registry.inner(),
            launch_exec,
            path,
            pid,
            project_id,
            window_id,
            origin,
        );
    }
    opener::open(&path).map_err(|e| e.to_string())?;
    let window_id = find_new_window(&before, 20);
    track_opened_file(
        registry.inner(),
        "open-file".to_string(),
        path,
        0,
        project_id,
        window_id,
        origin,
    )
}

/// Run a shell script as a fire-and-forget detached process.
///
/// Used by the right-panel "run in background" mode: the script is spawned with
/// `bash <path>`, stdio fully detached, and is not tracked as a window or tab.
/// No output is surfaced — callers that want to watch a script should open a
/// terminal tab instead. When a `run_id` is supplied, a background thread waits
/// for the process and emits a `script-finished` event (`{ runId, success }`)
/// so the UI can show a running animation that clears on completion.
#[tauri::command]
pub fn run_script_detached(
    app: tauri::AppHandle,
    script_path: String,
    cwd: Option<String>,
    run_id: Option<String>,
) -> Result<(), String> {
    let mut cmd = Command::new("bash");
    cmd.arg(&script_path);
    if let Some(dir) = cwd.as_deref().filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("run {script_path}: {e}"))?;
    if let Some(run_id) = run_id {
        std::thread::spawn(move || {
            let success = child.wait().map(|s| s.success()).unwrap_or(false);
            let _ = app.emit(
                "script-finished",
                serde_json::json!({ "runId": run_id, "success": success }),
            );
        });
    }
    Ok(())
}

struct DesktopEntry {
    exec: String,
    icon: String,
}

fn resolve_launch_exec(exec: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        if let Some(resolved) = resolve_windows_launch_exec(exec) {
            return resolved;
        }
    }
    exec.to_string()
}

#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct ShortcutEntry {
    display_name: String,
    shortcut_path: PathBuf,
    target_path: PathBuf,
    icon_path: Option<PathBuf>,
}

#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
fn shortcut_matches(query: &str, shortcut: &ShortcutEntry) -> bool {
    let query = normalize_app_match(query);
    if query.is_empty() {
        return false;
    }

    let display = normalize_app_match(&shortcut.display_name);
    let shortcut_path = normalize_app_match(&shortcut.shortcut_path.to_string_lossy());
    let target_path = normalize_app_match(&shortcut.target_path.to_string_lossy());
    let shortcut_stem = normalized_path_stem(&shortcut_path);
    let target_base = normalized_path_basename(&target_path);
    let target_stem = normalized_path_stem(&target_path);

    [
        display,
        shortcut_stem,
        shortcut_path,
        target_path,
        target_base,
        target_stem,
    ]
    .into_iter()
    .any(|candidate| candidate == query)
}

fn normalize_app_match(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .to_lowercase()
        .replace('\\', "/")
}

#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
fn normalized_path_basename(normalized_path: &str) -> String {
    normalized_path
        .rsplit('/')
        .next()
        .unwrap_or(normalized_path)
        .to_string()
}

#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
fn normalized_path_stem(normalized_path: &str) -> String {
    let base = normalized_path_basename(normalized_path);
    base.rsplit_once('.')
        .map(|(stem, _)| stem.to_string())
        .unwrap_or(base)
}

#[cfg(target_os = "windows")]
fn resolve_windows_launch_exec(exec: &str) -> Option<String> {
    let direct = PathBuf::from(exec.trim_matches('"'));
    if direct.exists() {
        return Some(direct.to_string_lossy().into_owned());
    }
    windows_shortcuts()
        .into_iter()
        .find(|shortcut| shortcut_matches(exec, shortcut))
        .map(|shortcut| shortcut.target_path.to_string_lossy().into_owned())
}

#[cfg(target_os = "windows")]
fn resolve_windows_app_icon(exec: &str) -> Option<String> {
    let direct = PathBuf::from(exec.trim_matches('"'));
    if direct.exists() {
        if direct
            .extension()
            .and_then(|ext| ext.to_str())
            .map_or(false, |ext| ext.eq_ignore_ascii_case("lnk"))
        {
            return resolve_windows_shortcut(&direct)
                .and_then(|shortcut| shortcut.icon_path.or(Some(shortcut.target_path)))
                .and_then(|path| windows_icon_to_data_url(&path));
        }
        return windows_icon_to_data_url(&direct);
    }

    windows_shortcuts()
        .into_iter()
        .find(|shortcut| shortcut_matches(exec, shortcut))
        .and_then(|shortcut| shortcut.icon_path.or(Some(shortcut.target_path)))
        .and_then(|path| windows_icon_to_data_url(&path))
}

#[cfg(target_os = "windows")]
fn windows_shortcuts() -> Vec<ShortcutEntry> {
    let mut roots = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(
            PathBuf::from(appdata)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    if let Some(program_data) = std::env::var_os("ProgramData") {
        roots.push(
            PathBuf::from(program_data)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }

    let mut shortcuts = Vec::new();
    for root in roots {
        collect_windows_shortcuts(&root, 4, &mut shortcuts);
    }
    shortcuts
}

#[cfg(target_os = "windows")]
fn collect_windows_shortcuts(dir: &Path, depth: usize, out: &mut Vec<ShortcutEntry>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_windows_shortcuts(&path, depth - 1, out);
        } else if path
            .extension()
            .and_then(|ext| ext.to_str())
            .map_or(false, |ext| ext.eq_ignore_ascii_case("lnk"))
        {
            if let Some(shortcut) = resolve_windows_shortcut(&path) {
                out.push(shortcut);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn resolve_windows_shortcut(path: &Path) -> Option<ShortcutEntry> {
    use windows::core::{Interface, PCWSTR, PWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist: IPersistFile = link.cast().ok()?;
        let wide = wide_null(path.as_os_str());
        persist.Load(PCWSTR(wide.as_ptr()), 0).ok()?;

        let mut target_buf = [0u16; 32768];
        link.GetPath(
            PWSTR(target_buf.as_mut_ptr()),
            target_buf.len() as i32,
            None,
            0,
        )
        .ok()?;
        let target = utf16_buf_to_path(&target_buf)?;

        let mut icon_buf = [0u16; 32768];
        let mut icon_index = 0i32;
        let icon_path = link
            .GetIconLocation(
                PWSTR(icon_buf.as_mut_ptr()),
                icon_buf.len() as i32,
                &mut icon_index,
            )
            .ok()
            .and_then(|_| utf16_buf_to_path(&icon_buf));

        Some(ShortcutEntry {
            display_name: path.file_stem()?.to_string_lossy().into_owned(),
            shortcut_path: path.to_path_buf(),
            target_path: target,
            icon_path,
        })
    }
}

#[cfg(target_os = "windows")]
fn windows_icon_to_data_url(path: &Path) -> Option<String> {
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .map_or(false, |ext| {
            ext.eq_ignore_ascii_case("png") || ext.eq_ignore_ascii_case("ico")
        })
    {
        return icon_to_data_url(path);
    }
    Some(path.to_string_lossy().into_owned())
}

#[cfg(target_os = "windows")]
fn wide_null(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn utf16_buf_to_path(buf: &[u16]) -> Option<PathBuf> {
    let len = buf.iter().position(|&ch| ch == 0).unwrap_or(buf.len());
    if len == 0 {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(&buf[..len])))
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

pub(crate) fn first_exec_token(value: &str) -> Option<String> {
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
    let entries: Vec<_> = fs::read_dir(dir).ok()?.flatten().collect();
    for entry in &entries {
        let path = entry.path();
        if path.is_file() {
            let file_name = path.file_name()?.to_string_lossy();
            if names.iter().any(|name| name == file_name.as_ref()) {
                return Some(path);
            }
        }
    }
    for entry in &entries {
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
        {
            return unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };
        }
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
            if reg
                .windows
                .values()
                .any(|w| w.exec == app.exec && w.project_id.as_deref() == Some(&project_id))
            {
                continue;
            }
        }
        if let Ok(win) = do_launch(
            registry.inner(),
            &app.exec,
            app.file.as_deref(),
            Some(&project_id),
            None,
            ORIGIN_RESTORED,
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
    window_id: Option<u64>,
    origin: String,
) -> Result<TrackedWindow, String> {
    let opened_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let id_suffix = window_id.unwrap_or(pid as u64);
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
        origin,
    };
    registry.lock().unwrap().windows.insert(id, win.clone());
    Ok(win)
}

#[cfg(target_os = "linux")]
fn list_window_ids() -> Vec<u64> {
    x11_client_windows()
        .map(|windows| windows.into_iter().map(|w| w.id as u64).collect())
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn list_window_ids() -> Vec<u64> {
    crate::platform::windows::list_window_ids()
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn list_window_ids() -> Vec<u64> {
    Vec::new()
}

#[cfg(target_os = "linux")]
fn find_window_for_pid(pid: u32, attempts: usize) -> Option<u64> {
    for _ in 0..attempts {
        if let Ok(windows) = x11_client_windows() {
            if let Some(window) = windows
                .into_iter()
                .find(|w| w.pid == Some(pid) && !w.protected)
            {
                return Some(window.id as u64);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    None
}

#[cfg(target_os = "windows")]
fn find_window_for_pid(pid: u32, attempts: usize) -> Option<u64> {
    crate::platform::windows::find_window_for_pid(pid, attempts)
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn find_window_for_pid(_pid: u32, _attempts: usize) -> Option<u64> {
    None
}

#[cfg(target_os = "linux")]
fn find_new_window(before: &[u64], attempts: usize) -> Option<u64> {
    for _ in 0..attempts {
        if let Ok(windows) = x11_client_windows() {
            if let Some(window) = windows
                .into_iter()
                .find(|w| !before.contains(&(w.id as u64)) && !w.protected)
            {
                return Some(window.id as u64);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    None
}

#[cfg(target_os = "windows")]
fn find_new_window(before: &[u64], attempts: usize) -> Option<u64> {
    crate::platform::windows::find_new_window(before, attempts)
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn find_new_window(_before: &[u64], _attempts: usize) -> Option<u64> {
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

    let (conn, screen_num) = Connection::connect(None).map_err(|e| format!("xcb connect: {e}"))?;
    let root = conn
        .get_setup()
        .roots()
        .nth(screen_num as usize)
        .ok_or_else(|| "missing x11 screen".to_string())?
        .root();
    let net_client_list = crate::platform::x11::intern_atom(&conn, b"_NET_CLIENT_LIST")?;
    let net_wm_pid = crate::platform::x11::intern_atom(&conn, b"_NET_WM_PID")?;
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
        .map(|r| String::from_utf8_lossy(r.value::<u8>()).into_owned())
        .unwrap_or_default();

    crate::platform::x11::is_protected_class(&class)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracked(project_id: Option<&str>, origin: &str, window_id: Option<u64>) -> TrackedWindow {
        TrackedWindow {
            id: format!("{}-{window_id:?}", project_id.unwrap_or("root")),
            exec: "editor".to_string(),
            file: Some("/tmp/file.txt".to_string()),
            pid: 42,
            project_id: project_id.map(String::from),
            role: None,
            opened_at: 1.0,
            window_id,
            origin: origin.to_string(),
        }
    }

    #[test]
    fn opened_windows_are_only_project_file_ui_windows() {
        let windows = vec![
            tracked(Some("p1"), ORIGIN_RIGHT_FILE_TREE, Some(10)),
            tracked(Some("p1"), ORIGIN_MIDDLE_FILE_BROWSER, Some(11)),
            tracked(Some("p1"), ORIGIN_GLOBAL_APP, Some(12)),
            tracked(Some("p1"), ORIGIN_MANUAL_LAUNCH, Some(13)),
            tracked(Some("p2"), ORIGIN_RIGHT_FILE_TREE, Some(20)),
            tracked(None, ORIGIN_RIGHT_FILE_TREE, Some(30)),
        ];

        let opened = opened_windows_for_project(windows.iter(), Some("p1"));
        let ids = opened
            .into_iter()
            .filter_map(|window| window.window_id)
            .collect::<Vec<_>>();

        assert_eq!(ids, vec![10, 11]);
    }

    #[test]
    fn project_opened_window_predicate_matches_file_ui_origins() {
        assert!(is_project_opened_window(&tracked(
            Some("p1"),
            ORIGIN_RIGHT_FILE_TREE,
            Some(1),
        )));
        assert!(is_project_opened_window(&tracked(
            Some("p1"),
            ORIGIN_MIDDLE_FILE_BROWSER,
            Some(1),
        )));
        assert!(!is_project_opened_window(&tracked(
            Some("p1"),
            ORIGIN_GLOBAL_APP,
            Some(1),
        )));
        assert!(!is_project_opened_window(&tracked(
            Some("p1"),
            ORIGIN_MANUAL_LAUNCH,
            Some(1),
        )));
    }

    #[test]
    fn tracked_window_defaults_missing_origin_to_manual_launch() {
        let raw = r#"{
            "id": "old",
            "exec": "editor",
            "file": null,
            "pid": 7,
            "project_id": "p1",
            "role": null,
            "opened_at": 1.0,
            "window_id": 99
        }"#;

        let window: TrackedWindow = serde_json::from_str(raw).unwrap();

        assert_eq!(window.origin, ORIGIN_MANUAL_LAUNCH);
        assert!(!is_project_opened_window(&window));
    }

    // ── base64_encode ──────────────────────────────────────────────────────

    #[test]
    fn base64_empty_input() {
        assert_eq!(base64_encode(b""), "");
    }

    #[test]
    fn base64_one_byte() {
        // "M" = 0x4D → base64 "TQ=="
        assert_eq!(base64_encode(b"M"), "TQ==");
    }

    #[test]
    fn base64_two_bytes() {
        // "Ma" = 0x4D 0x61 → base64 "TWE="
        assert_eq!(base64_encode(b"Ma"), "TWE=");
    }

    #[test]
    fn base64_three_bytes_no_padding() {
        // "Man" = 0x4D 0x61 0x6E → base64 "TWFu"
        assert_eq!(base64_encode(b"Man"), "TWFu");
    }

    #[test]
    fn base64_hello_world() {
        assert_eq!(base64_encode(b"Hello, World!"), "SGVsbG8sIFdvcmxkIQ==");
    }

    #[test]
    fn base64_roundtrip_via_stdlib() {
        use std::process::Command;
        // Cross-check against system base64 on Linux.
        let input = b"Eldrun workspace manager";
        let encoded = base64_encode(input);

        // Use base64 --decode via shell to verify correctness.
        if let Ok(out) = Command::new("sh")
            .arg("-c")
            .arg(format!("echo -n '{encoded}' | base64 -d"))
            .output()
        {
            if out.status.success() {
                assert_eq!(out.stdout, input.as_ref());
            }
        }
    }

    #[test]
    fn base64_output_length_is_multiple_of_four() {
        for n in 0..=12usize {
            let input: Vec<u8> = (0..n).map(|i| i as u8).collect();
            let encoded = base64_encode(&input);
            assert_eq!(
                encoded.len() % 4,
                0,
                "length must be divisible by 4 for n={n}"
            );
        }
    }

    // ── origin predicates ──────────────────────────────────────────────────

    #[test]
    fn restored_origin_is_not_project_opened_window() {
        // ORIGIN_RESTORED is project-owned (window_service) but NOT a
        // "project opened window" in apps.rs — the distinction matters for
        // which windows are sent to opened_windows_for_project.
        let w = tracked(Some("p1"), ORIGIN_RESTORED, Some(1));
        assert!(!is_project_opened_window(&w));
    }

    #[test]
    fn opened_windows_returns_empty_for_wrong_project() {
        let windows = vec![
            tracked(Some("p1"), ORIGIN_RIGHT_FILE_TREE, Some(10)),
            tracked(Some("p1"), ORIGIN_MIDDLE_FILE_BROWSER, Some(11)),
        ];
        let opened = opened_windows_for_project(windows.iter(), Some("p2"));
        assert!(opened.is_empty());
    }

    #[test]
    fn opened_windows_returns_empty_for_root_scope_when_all_in_project() {
        let windows = vec![tracked(Some("p1"), ORIGIN_RIGHT_FILE_TREE, Some(10))];
        let opened = opened_windows_for_project(windows.iter(), None);
        assert!(
            opened.is_empty(),
            "root scope (None) must not see project windows"
        );
    }

    // ── first_exec_token ───────────────────────────────────────────────────

    #[test]
    fn first_exec_token_plain_path() {
        assert_eq!(
            first_exec_token("/usr/bin/firefox"),
            Some("/usr/bin/firefox".into())
        );
    }

    #[test]
    fn first_exec_token_strips_desktop_field_codes() {
        // %U, %F etc. must be skipped.
        assert_eq!(
            first_exec_token("/usr/bin/code %F"),
            Some("/usr/bin/code".into())
        );
    }

    #[test]
    fn first_exec_token_strips_leading_percent_args() {
        assert_eq!(
            first_exec_token("%u /usr/bin/app"),
            Some("/usr/bin/app".into())
        );
    }

    #[test]
    fn first_exec_token_empty_string() {
        assert_eq!(first_exec_token(""), None);
    }

    #[test]
    fn first_exec_token_only_field_codes() {
        assert_eq!(first_exec_token("%U %F %i"), None);
    }

    #[test]
    fn first_exec_token_quoted_token_outer_quotes_stripped() {
        // The function strips outer quotes from the final string but splits on
        // whitespace first, so a quoted path with spaces is split at the space.
        // This documents the actual behavior.
        let result = first_exec_token("\"/usr/bin/myapp\"");
        assert_eq!(result, Some("/usr/bin/myapp".into()));
    }

    // ── Windows Start Menu matching ────────────────────────────────────────

    fn shortcut() -> ShortcutEntry {
        ShortcutEntry {
            display_name: "Visual Studio Code".to_string(),
            shortcut_path: PathBuf::from(
                r"C:\Users\alice\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Visual Studio Code.lnk",
            ),
            target_path: PathBuf::from(
                r"C:\Users\alice\AppData\Local\Programs\Microsoft VS Code\Code.exe",
            ),
            icon_path: Some(PathBuf::from(
                r"C:\Users\alice\AppData\Local\Programs\Microsoft VS Code\Code.exe",
            )),
        }
    }

    #[test]
    fn shortcut_matches_display_name() {
        assert!(shortcut_matches("visual studio code", &shortcut()));
    }

    #[test]
    fn shortcut_matches_target_basename() {
        assert!(shortcut_matches("Code.exe", &shortcut()));
    }

    #[test]
    fn shortcut_matches_direct_executable_path() {
        assert!(shortcut_matches(
            r"C:\Users\alice\AppData\Local\Programs\Microsoft VS Code\Code.exe",
            &shortcut()
        ));
    }

    #[test]
    fn shortcut_does_not_match_unrelated_name() {
        assert!(!shortcut_matches("notepad", &shortcut()));
    }
}
