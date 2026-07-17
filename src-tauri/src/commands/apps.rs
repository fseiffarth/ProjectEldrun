//! External app launching and window tracking.
//!
//! Eldrun's X11 window embedding model is intentionally dropped in the Tauri
//! rewrite (fundamentally incompatible with the WebView). Instead, external
//! apps are tracked by PID and launched/raised as separate windows.
//! `project.json["open_apps"]` is preserved for backward compatibility but
//! treated as best-effort restore metadata.
//!
//! ## Per-OS backends (TODO 30d)
//!
//! App discovery, icon resolution and launching are inherently OS-specific, so
//! the platform-divergent pieces are gated behind `cfg`:
//! - **Linux** uses the freedesktop/XDG model: it scans `.desktop` entries under
//!   `$XDG_DATA_HOME/applications` and every `$XDG_DATA_DIRS` entry's
//!   `applications` dir (see [`xdg_application_dirs`]) — which, since desktop
//!   sessions add Flatpak/Snap export paths to `XDG_DATA_DIRS`, is what makes
//!   apps installed that way discoverable too — resolves icons through the
//!   icon-theme directories, and launches the `Exec=` line. Multi-word `Exec=`
//!   values (Flatpak's `flatpak run --branch=... app.id`) are preserved in full
//!   by [`parse_exec_command`] and shell-split back into program+args at launch
//!   time by [`split_exec_command`], rather than truncated to their first token.
//! - **Windows** has no XDG layer, so [`list_installed_apps`] instead enumerates
//!   Start-Menu `.lnk` shortcuts under `%ProgramData%`/`%APPDATA%`, reading each
//!   shortcut's display name and resolving its target executable via
//!   `IShellLinkW` (see [`windows_shortcuts`]). Launching resolves a bare app
//!   name or `.lnk` back to that target exe ([`resolve_windows_launch_exec`]) and
//!   spawns it; [`run_script_detached`] runs scripts through `cmd`/PowerShell
//!   rather than `bash`. Icons are best-effort: a `.png`/`.ico` referenced by the
//!   shortcut is inlined as a data URL, otherwise the target path is returned for
//!   the frontend to resolve lazily (no native HICON rasterization — that would
//!   need GDI, which is out of scope here).
//! - **Other OSes** fall back to empty/no-op results so the commands never fail
//!   to build or error at runtime.

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
    /// Detached-subwindow display numbers, keyed by the window's stable label.
    /// Assigned in `detach_subwindow` (lowest free positive int) so each popout's
    /// OS title reads "Eldrun win-N", and freed on dock-back/close
    /// (`attach_subwindow`) and on any other window destruction (the
    /// `WindowEvent::Destroyed` hook in `lib.rs`) so numbers stay small and
    /// reuse freed slots — a lone popout is always "win-1".
    pub detached_seqs: HashMap<String, u32>,
}

pub type WindowRegistryState = Arc<Mutex<WindowRegistry>>;

pub const ORIGIN_RIGHT_FILE_TREE: &str = "right_file_tree";
pub const ORIGIN_MIDDLE_FILE_BROWSER: &str = "middle_file_browser";
pub const ORIGIN_GLOBAL_APP: &str = "global_app";
pub const ORIGIN_MANUAL_LAUNCH: &str = "manual_launch";
pub const ORIGIN_RESTORED: &str = "restored";
/// A tiling subwindow popped out into its own borderless Tauri WebviewWindow
/// (#42). Project-owned: it follows the same project-switch hide/show parking
/// path as the other project-owned window origins.
pub const ORIGIN_DETACHED_SUBWINDOW: &str = "detached_subwindow";

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
    args: &[String],
    file: Option<&str>,
    project_id: Option<&str>,
    role: Option<&str>,
    origin: &str,
) -> Result<TrackedWindow, String> {
    let launch_exec = resolve_launch_exec(exec);
    let mut cmd = launch_command(&launch_exec, args, file);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let pid = crate::paths::spawn_reaped(cmd).map_err(|e| format!("launch {launch_exec}: {e}"))?;
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

/// Split an exec string into the literal program to spawn and any leading
/// arguments already baked into it (e.g. Flatpak's
/// `flatpak run --branch=stable --command=... app.id`, from
/// [`parse_exec_command`]).
///
/// An exec with no whitespace is always a single program. One that does
/// contain whitespace is still treated as a single program when the whole
/// string exists as a literal path on disk — this covers Windows targets like
/// `C:\Program Files\App\app.exe` and any manually typed Linux path with a
/// space, both of which must be spawned whole, not split. Only when the whole
/// string is *not* a real path do we fall back to splitting on whitespace,
/// which is exactly the multi-word-launcher case: the single-program
/// interpretation could never have spawned it anyway (no file is literally
/// named `flatpak run --branch=stable ...`).
fn split_exec_command(exec: &str) -> (&str, Vec<&str>) {
    if !exec.contains(' ') || Path::new(exec).exists() {
        return (exec, Vec::new());
    }
    let mut parts = exec.split_whitespace();
    let program = parts.next().unwrap_or(exec);
    (program, parts.collect())
}

fn launch_command(exec: &str, args: &[String], file: Option<&str>) -> Command {
    #[cfg(target_os = "macos")]
    if Path::new(exec)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
    {
        let mut cmd = crate::paths::command_no_window("/usr/bin/open");
        cmd.arg("-a").arg(exec);
        if let Some(file) = file {
            cmd.arg(file);
        }
        if !args.is_empty() {
            cmd.arg("--args").args(args);
        }
        return cmd;
    }

    let (program, leading_args) = split_exec_command(exec);
    let mut cmd = crate::paths::command_for_program(Path::new(program));
    cmd.args(leading_args);
    cmd.args(args);
    if let Some(file) = file {
        cmd.arg(file);
    }
    cmd
}

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn launch_app(
    registry: State<'_, WindowRegistryState>,
    exec: String,
    args: Option<Vec<String>>,
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
        &args.unwrap_or_default(),
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

    let (exec_program, _) = split_exec_command(exec);
    let exec_base = Path::new(exec_program)
        .file_name()?
        .to_string_lossy()
        .to_lowercase();
    for desktop_file in desktop_files() {
        if let Some(entry) = parse_desktop_entry(&desktop_file) {
            let (entry_program, _) = split_exec_command(&entry.exec);
            let Some(entry_base) = Path::new(entry_program)
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
    workspace: State<'_, crate::commands::workspace::WorkspaceStateArc>,
    path: String,
    handler: Option<String>,
    project_id: Option<String>,
    origin: Option<String>,
    // Physical desktop coordinates to place the launched window at (the point a
    // file was dropped, on the target monitor). Both must be present to apply;
    // absent on double-click / manual launch, leaving WM placement untouched.
    x: Option<i32>,
    y: Option<i32>,
) -> Result<TrackedWindow, String> {
    let origin = origin.unwrap_or_else(|| ORIGIN_MANUAL_LAUNCH.to_string());
    // Best-effort: move a resolved window to the drop point so an externally
    // launched app lands on the screen the file was dropped onto. Placement
    // failure never fails the open (X11-only; a no-op elsewhere).
    let place = |window_id: Option<u64>| {
        if let (Some(wid), Some(px), Some(py)) = (window_id, x, y) {
            if let Err(e) = workspace.lock().unwrap().backend.position_window(wid, px, py) {
                eprintln!("position_window failed: {e}");
            }
        }
    };
    let before = list_window_ids();
    // Resolve the executable to launch: an explicit handler always wins;
    // otherwise consult the project-then-global default-app map (keyed by
    // extension). When neither has an entry we leave it to the OS default below,
    // preserving the prior plain-open behaviour.
    let effective = match handler {
        Some(h) => Some(h),
        None => {
            let global_apps = crate::commands::default_apps::get_default_apps()
                .map(|d| d.0)
                .unwrap_or_default();
            let project_apps = project_apps_for_id(project_id.as_deref());
            Path::new(&path)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
                .and_then(|ext| {
                    project_apps
                        .get(&ext)
                        .or_else(|| global_apps.get(&ext))
                        .cloned()
                })
                .filter(|s| !s.trim().is_empty())
        }
    };
    if let Some(exec) = effective {
        let launch_exec = resolve_launch_exec(&exec);
        let mut cmd = launch_command(&launch_exec, &[], Some(&path));
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let pid =
            crate::paths::spawn_reaped(cmd).map_err(|e| format!("open with {launch_exec}: {e}"))?;
        let window_id = find_window_for_pid(pid, 20).or_else(|| find_new_window(&before, 20));
        place(window_id);
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
    place(window_id);
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
/// stdio fully detached, and is not tracked as a window or tab. No output is
/// surfaced — callers that want to watch a script should open a terminal tab
/// instead. When a `run_id` is supplied, a background thread waits for the
/// process and emits a `script-finished` event (`{ runId, success }`) so the UI
/// can show a running animation that clears on completion.
///
/// On Linux/Unix the script is run with `bash <path>`. Windows has no `bash`, so
/// [`windows_script_command`] picks an interpreter by extension (`.ps1` →
/// PowerShell, everything else → `cmd /C`, which honours `.bat`/`.cmd` and the
/// file's shell association) while still yielding a waitable child process.
#[tauri::command]
pub fn run_script_detached(
    app: tauri::AppHandle,
    script_path: String,
    cwd: Option<String>,
    run_id: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut cmd = windows_script_command(&script_path);
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut cmd = Command::new("bash");
        cmd.arg(&script_path);
        cmd
    };
    if let Some(dir) = cwd.as_deref().filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::paths::augment_command_path(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("run {script_path}: {e}"))?;
    if let Some(run_id) = run_id {
        let mut child = child;
        std::thread::spawn(move || {
            let success = child.wait().map(|s| s.success()).unwrap_or(false);
            let _ = app.emit(
                "script-finished",
                serde_json::json!({ "runId": run_id, "success": success }),
            );
        });
    } else {
        std::thread::spawn(move || {
            let mut child = child;
            let _ = child.wait();
        });
    }
    Ok(())
}

// ── Frameless embedding capability (TODO Group K #40, Phase 1) ──────────────

/// Conservative allowlist of app executables (by basename) we'll attempt to
/// embed frameless into a tab. These are single-window, single-process apps
/// that map exactly one stable top-level window we can reparent.
///
/// CAVEAT — fork-and-exit: an embeddable app MUST keep running under the PID we
/// spawn and own its top-level directly. Single-instance D-Bus apps
/// (e.g. `gnome-text-editor`, `kate`) fork a server and exit the launched
/// process, so our spawned PID dies before mapping a window — there is nothing
/// to reparent and `find_window_for_pid` would fail. Those remain excluded.
///
/// `gedit` and `code` are included by explicit request even though they exhibit
/// this single-instance behavior (gedit forks a D-Bus server; VS Code is
/// multi-window Electron and reuses an existing instance). Phase-2 embedding may
/// need `--new-window`/`--wait`-style flags or a different window-find strategy
/// to make them reparent reliably; until then they at least get the drag-to-tab
/// affordance. Keep this list small; expand only after verifying an app maps a
/// single stable top-level under its own PID.
pub const EMBEDDABLE_EXECS: &[&str] = &[
    "xterm", "xev", "mousepad", "okular", "evince", "eog", "feh", "mpv", "qpdfview", "gedit",
    "code", "blender",
];

/// Whether `exec` (a path, bare command, or multi-word launcher line) names an
/// embeddable app, matched by the basename of its program (see
/// [`split_exec_command`]) against `EMBEDDABLE_EXECS`.
pub fn is_embeddable_exec(exec: &str) -> bool {
    let (program, _) = split_exec_command(exec);
    let base = Path::new(program)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| program.to_lowercase());
    EMBEDDABLE_EXECS.iter().any(|&e| e == base)
}

/// Resolve the executable that would open `path`, in precedence order:
///   1. an explicitly passed `handler`;
///   2. the project's `default_apps` map, then the global one, keyed by the
///      file extension (including the leading dot, e.g. `.md`);
///   3. the system default via `xdg-mime query default <mime>` → the matching
///      `.desktop` entry's `Exec` first token.
/// Returns `None` when nothing resolves (capability then degrades to external).
///
/// Pure with respect to the app maps (passed in) so it is unit-testable; only
/// the xdg/mime fallback touches the system.
pub fn resolve_default_handler(
    path: &str,
    handler: Option<&str>,
    project_apps: Option<&HashMap<String, String>>,
    global_apps: &HashMap<String, String>,
) -> Option<String> {
    if let Some(h) = handler.map(str::trim).filter(|h| !h.is_empty()) {
        return Some(h.to_string());
    }
    let ext = Path::new(path)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()));
    if let Some(ext) = ext.as_deref() {
        if let Some(app) = project_apps.and_then(|m| m.get(ext)) {
            if !app.is_empty() {
                return Some(app.clone());
            }
        }
        if let Some(app) = global_apps.get(ext) {
            if !app.is_empty() {
                return Some(app.clone());
            }
        }
    }
    resolve_handler_via_mime(path)
}

/// System-default handler via `xdg-mime` → `.desktop` `Exec` first token.
///
/// Linux-only: `xdg-mime` and `.desktop` entries are a freedesktop concept. On
/// other platforms this is a no-op (`None`) so the caller falls back to
/// `opener::open` / the OS default.
fn resolve_handler_via_mime(path: &str) -> Option<String> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        None
    }
    #[cfg(target_os = "linux")]
    {
        let mime = Command::new("xdg-mime")
            .args(["query", "filetype", path])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())?;
        let desktop = Command::new("xdg-mime")
            .args(["query", "default", &mime])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())?;
        // Locate the named .desktop file and pull its Exec first token.
        for dir in desktop_app_dirs() {
            let candidate = dir.join(&desktop);
            if candidate.exists() {
                if let Some(entry) = parse_desktop_entry(&candidate) {
                    return Some(entry.exec);
                }
            }
        }
        None
    }
}

/// XDG application directories, in precedence order: `$XDG_DATA_HOME/applications`
/// (falling back to `~/.local/share/applications`), then each dir in
/// `$XDG_DATA_DIRS` (falling back to `/usr/local/share:/usr/share`) joined with
/// `applications`. Respecting `XDG_DATA_DIRS` (rather than hardcoding just
/// `/usr/share` + `/usr/local/share`) is what picks up Flatpak/Snap exports
/// (e.g. `/var/lib/flatpak/exports/share`), which the desktop session already
/// adds to that variable.
fn xdg_application_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    if let Some(home) = data_home {
        dirs.push(home.join("applications"));
    }
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
    for dir in data_dirs.split(':').filter(|s| !s.is_empty()) {
        dirs.push(PathBuf::from(dir).join("applications"));
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

/// Linux-only after the mime-resolver was platform-gated; the icon resolver still
/// uses the separate `desktop_files`, so keep this compiled but quiet elsewhere.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn desktop_app_dirs() -> Vec<PathBuf> {
    xdg_application_dirs()
}

/// Return the native file-drag preview icon as a PNG `data:` URL.
///
/// `tauri-plugin-drag`'s `startDrag` icon field is deserialized through an
/// untagged enum whose only string form is a base64 PNG **data URL**
/// (`data:image/png;base64,…`) — a bare file path fails to deserialize and the
/// whole drag command rejects before it starts. So embed the app icon at compile
/// time and hand back a data URL the frontend can pass straight to `startDrag`.
#[tauri::command]
pub fn drag_preview_icon() -> String {
    use base64::Engine;
    const ICON_PNG: &[u8] = include_bytes!("../../icons/128x128.png");
    let b64 = base64::engine::general_purpose::STANDARD.encode(ICON_PNG);
    format!("data:image/png;base64,{b64}")
}

#[cfg(target_os = "linux")]
thread_local! {
    /// The in-flight GTK drag, so `cancel_file_drag` can abort it when the
    /// cursor comes back into the window. GTK/GDK objects are not `Send`, and
    /// every access is on the GTK main thread (sync Tauri commands and GTK
    /// signal handlers both run there), so a thread-local is the right home.
    static ACTIVE_DRAG: std::cell::RefCell<Option<gtk::gdk::DragContext>> =
        const { std::cell::RefCell::new(None) };
    /// Set by `cancel_file_drag` so the `cancel` signal it provokes is
    /// recognised as OURS: the gesture is being handed back to the in-app drag
    /// and is NOT over, so it must not emit `FILE_DRAG_ENDED`.
    static CANCEL_REQUESTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Emitted when a native drag reaches its true end (dropped, failed, or
/// cancelled by the user/WM). The frontend keeps a gesture alive across the
/// handoff, so it needs to hear the end from the OS: once GTK owns the pointer,
/// the webview never sees the `pointerup` that would otherwise end it.
#[cfg(target_os = "linux")]
pub const FILE_DRAG_ENDED: &str = "eldrun:file-drag-ended";

/// Start a native OS drag-out of `paths` from the calling window (Linux/GTK).
///
/// Replaces `tauri-plugin-drag`'s GTK path for the Ctrl-drag file export. That
/// path LOOKS right (OS drag icon, drop animation) but delivers an empty
/// payload to external targets: it disconnects its `drag-data-get` handler on
/// `drop-performed` — emitted at the instant of the drop, BEFORE the target
/// asynchronously requests the `text/uri-list` selection — so a browser's or
/// file manager's data request finds no provider and the drop silently does
/// nothing. It also builds `file://{path}` with no percent-encoding (a space
/// in the name yields an invalid URI strict consumers discard) and passes
/// `GDK_BUTTON1_MASK` (256) where GTK expects the button NUMBER (1).
///
/// Here URIs are encoded canonically (`glib::filename_to_uri`) and teardown is
/// deferred to `dnd-finished` (the target has read the data), with `cancel` /
/// `drag-failed` covering the abort paths. Windows/macOS keep the plugin
/// (their OLE/NSDragging backends are sound).
///
/// Deliberately a SYNC command: Tauri dispatches those on the main (GTK)
/// thread, which is exactly where every call below must run.
#[cfg(target_os = "linux")]
#[tauri::command]
pub fn start_file_drag(window: tauri::Window, paths: Vec<String>) -> Result<(), String> {
    use gtk::{gdk, glib, prelude::*};
    use std::cell::RefCell;
    use std::rc::Rc;

    if paths.is_empty() {
        return Err("start_file_drag: no paths".into());
    }
    let uris: Vec<String> = paths
        .iter()
        .map(|p| {
            glib::filename_to_uri(p, None)
                .map(|u| u.to_string())
                .map_err(|e| format!("start_file_drag: invalid path {p:?}: {e}"))
        })
        .collect::<Result<_, _>>()?;

    let win = window.gtk_window().map_err(|e| e.to_string())?;
    win.drag_source_set(gdk::ModifierType::BUTTON1_MASK, &[], gdk::DragAction::COPY);
    win.drag_source_add_uri_targets();

    // Window-level signal handlers live until an end-of-drag signal fires;
    // the drag-data-get one MUST survive past the drop itself (see above).
    let handler_ids: Rc<RefCell<Vec<glib::SignalHandlerId>>> = Rc::new(RefCell::new(Vec::new()));
    {
        let uris = uris.clone();
        handler_ids
            .borrow_mut()
            .push(win.connect_drag_data_get(move |_, _, data, _, _| {
                let refs: Vec<&str> = uris.iter().map(String::as_str).collect();
                data.set_uris(&refs);
            }));
    }

    let target_list = win
        .drag_source_get_target_list()
        .ok_or("start_file_drag: empty target list")?;
    let context = win
        .drag_begin_with_coordinates(&target_list, gdk::DragAction::COPY, 1, None, -1, -1)
        .ok_or("start_file_drag: drag_begin refused (no pointer grab?)")?;
    ACTIVE_DRAG.with(|c| *c.borrow_mut() = Some(context.clone()));

    // Idempotent teardown shared by every end-of-drag signal — a cancelled drag
    // can raise more than one of them for the same gesture. `ours` marks the
    // cancel WE asked for (handing the gesture back to the in-app drag): the
    // GTK drag is over, but the user's gesture is not, so no end event.
    let cleanup = {
        let win = win.clone();
        let window = window.clone();
        let handler_ids = handler_ids.clone();
        move || {
            for id in handler_ids.borrow_mut().drain(..) {
                win.disconnect(id);
            }
            win.drag_source_unset();
            ACTIVE_DRAG.with(|c| *c.borrow_mut() = None);
            let ours = CANCEL_REQUESTED.with(|f| f.replace(false));
            if !ours {
                use tauri::Emitter;
                let _ = window.emit(FILE_DRAG_ENDED, ());
            }
        }
    };
    {
        let cleanup = cleanup.clone();
        context.connect_dnd_finished(move |_| cleanup());
    }
    {
        let cleanup = cleanup.clone();
        context.connect_cancel(move |_, _| cleanup());
    }
    {
        let cleanup = cleanup.clone();
        let id = win.connect_drag_failed(move |_, _, _| {
            cleanup();
            // Proceed keeps GTK's snap-back animation for the failed drop.
            glib::Propagation::Proceed
        });
        handler_ids.borrow_mut().push(id);
    }

    // Same OS drag icon the plugin path used (the app icon).
    const ICON_PNG: &[u8] = include_bytes!("../../icons/128x128.png");
    let loader = gtk::gdk_pixbuf::PixbufLoader::new();
    if loader.write(ICON_PNG).and_then(|_| loader.close()).is_ok() {
        if let Some(pixbuf) = loader.pixbuf() {
            context.drag_set_icon_pixbuf(&pixbuf, 0, 0);
        }
    }
    Ok(())
}

/// Abort the in-flight native drag, handing the still-held button back to the
/// in-app pointer drag (the cursor re-entered the Eldrun window, so the ghost
/// and hover take over again from the OS drag icon). A no-op when no native
/// drag is running, so the frontend can call it unconditionally.
#[cfg(target_os = "linux")]
#[tauri::command]
pub fn cancel_file_drag() {
    use gtk::prelude::DragContextExtManual;
    let Some(context) = ACTIVE_DRAG.with(|c| c.borrow().clone()) else {
        return;
    };
    // Read back in `cleanup` (via the `cancel` signal this raises) to tell our
    // own abort apart from a real one.
    CANCEL_REQUESTED.with(|f| f.set(true));
    context.drag_cancel();
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub fn cancel_file_drag() {}

/// Non-Linux stub so the command registers everywhere; the frontend only
/// routes to it on Linux (Windows/macOS stay on `tauri-plugin-drag`).
#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub fn start_file_drag(paths: Vec<String>) -> Result<(), String> {
    let _ = paths;
    Err("start_file_drag is Linux-only; use tauri-plugin-drag".into())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedCapability {
    /// OS can host an embedded frameless window (X11 backend, not XWayland).
    pub os_embeddable: bool,
    /// The resolved default app is on the conservative allowlist.
    pub app_embeddable: bool,
    /// The executable we would embed (or launch externally on fallback).
    pub resolved_exec: Option<String>,
}

/// Report whether `path` can be opened as a frameless embedded tab.
///
/// `os_embeddable` is true only when the active workspace backend supports
/// embedding (X11) AND we're not on Wayland (XWayland reparenting is
/// unreliable). `app_embeddable` is true when the resolved default handler is
/// on the conservative allowlist. The frontend gates the tab-bar drop target on
/// `os_embeddable && app_embeddable`; otherwise the file opens externally.
///
/// Phase 1: this reports capability only — no reparenting happens yet.
#[tauri::command]
pub fn embed_capability(
    workspace: State<'_, crate::commands::workspace::WorkspaceStateArc>,
    path: String,
    handler: Option<String>,
    project_id: Option<String>,
) -> EmbedCapability {
    let os_embeddable = {
        let ws = workspace.lock().unwrap();
        ws.backend.supports_embedding()
    } && std::env::var("WAYLAND_DISPLAY").is_err();

    let global_apps = crate::commands::default_apps::get_default_apps()
        .map(|d| d.0)
        .unwrap_or_default();
    // Resolution precedence: explicit handler → project default_apps → global →
    // system mime default. A project override therefore wins over the global map.
    let project_apps = project_apps_for_id(project_id.as_deref());
    let resolved_exec =
        resolve_default_handler(&path, handler.as_deref(), Some(&project_apps), &global_apps);
    let app_embeddable = resolved_exec.as_deref().map_or(false, is_embeddable_exec);

    EmbedCapability {
        os_embeddable,
        app_embeddable,
        resolved_exec,
    }
}

/// Project-level default-app map for `project_id`, resolved via projects.json →
/// the project's `local_file` → project.json `default_apps`. Returns an empty
/// map when the id is absent or any read fails, so resolution then falls back to
/// the global map / system default.
fn project_apps_for_id(project_id: Option<&str>) -> HashMap<String, String> {
    let Some(id) = project_id else {
        return HashMap::new();
    };
    let list_path = crate::storage::state_dir().join("projects.json");
    let list: Vec<crate::schema::ProjectEntry> =
        crate::storage::read_json(&list_path).unwrap_or_default();
    let Some(entry) = list.into_iter().find(|e| e.id == id) else {
        return HashMap::new();
    };
    let project: crate::schema::Project =
        match crate::storage::read_json(Path::new(&entry.local_file)) {
            Ok(p) => p,
            Err(_) => return HashMap::new(),
        };
    project.default_apps.unwrap_or_default()
}

/// One installed application, surfaced to the "set default app" picker.
#[derive(Debug, Clone, Serialize)]
pub struct InstalledApp {
    /// Display name (`Name=` from the `.desktop` entry).
    pub name: String,
    /// Launch command line, parsed from `Exec=` with desktop field codes
    /// (`%f`/`%U`/...) and Flatpak's `@@` quoting markers stripped. Kept as the
    /// full command line (not just the first token) so multi-word launchers like
    /// `flatpak run --branch=stable --command=... app.id` still work — see
    /// [`parse_exec_command`].
    pub exec: String,
    /// Raw `Icon=` value (theme name or path); the frontend resolves it lazily.
    pub icon: Option<String>,
}

/// List installed applications, powering the search box in the "set default app"
/// dialog. On Linux this scans `.desktop` entries in the standard application
/// directories (skipping hidden entries and non-`Application` types, deduped by
/// executable basename with user dirs taking precedence); on Windows it
/// enumerates Start-Menu shortcuts. Sorted by name.
#[tauri::command]
pub fn list_installed_apps() -> Vec<InstalledApp> {
    #[cfg(target_os = "windows")]
    {
        return windows_installed_apps();
    }
    #[cfg(target_os = "macos")]
    {
        return macos_installed_apps();
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut apps: Vec<InstalledApp> = Vec::new();
        for dir in desktop_app_dirs() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                    continue;
                }
                if let Some(app) = parse_installed_app(&path) {
                    let key = Path::new(&app.exec)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_lowercase())
                        .unwrap_or_else(|| app.exec.to_lowercase());
                    if seen.insert(key) {
                        apps.push(app);
                    }
                }
            }
        }
        apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        apps
    }
}

/// Windows installed-app list: every Start-Menu `.lnk` shortcut, mapped to its
/// display name and resolved target executable (which is what the picker stores
/// and later launches). Deduped by target-exe path (case-insensitive), sorted by
/// name. The icon is left to lazy resolution via [`resolve_app_icon`].
#[cfg(target_os = "windows")]
fn windows_installed_apps() -> Vec<InstalledApp> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut apps: Vec<InstalledApp> = Vec::new();
    for shortcut in windows_shortcuts() {
        let exec = shortcut.target_path.to_string_lossy().into_owned();
        if exec.trim().is_empty() {
            continue;
        }
        if seen.insert(exec.to_lowercase()) {
            apps.push(InstalledApp {
                name: shortcut.display_name,
                exec,
                icon: None,
            });
        }
    }
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

/// macOS installed-app list from each bundle's Info.plist. The picker persists
/// the bundle path so launch goes through LaunchServices.
#[cfg(target_os = "macos")]
fn macos_installed_apps() -> Vec<InstalledApp> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        roots.insert(0, PathBuf::from(home).join("Applications"));
    }

    macos_installed_apps_in(&roots)
}

#[cfg(target_os = "macos")]
fn macos_installed_apps_in(roots: &[PathBuf]) -> Vec<InstalledApp> {
    let mut seen = std::collections::HashSet::new();
    let mut apps: Vec<InstalledApp> = Vec::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("app") {
                continue;
            }
            let Some(app) = parse_macos_app_bundle(&path) else {
                continue;
            };
            if !seen.insert(app.exec.to_lowercase()) {
                continue;
            }
            apps.push(app);
        }
    }
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

#[cfg(target_os = "macos")]
fn parse_macos_app_bundle(app: &Path) -> Option<InstalledApp> {
    let plist = plist::Value::from_file(app.join("Contents").join("Info.plist")).ok()?;
    let dict = plist.as_dictionary()?;
    let executable = dict.get("CFBundleExecutable")?.as_string()?.trim();
    if executable.is_empty()
        || !app
            .join("Contents")
            .join("MacOS")
            .join(executable)
            .is_file()
    {
        return None;
    }
    let name = ["CFBundleDisplayName", "CFBundleName"]
        .iter()
        .find_map(|key| dict.get(*key).and_then(plist::Value::as_string))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| {
            app.file_stem()
                .map(|name| name.to_string_lossy().into_owned())
        })?;
    Some(InstalledApp {
        name,
        exec: app.to_string_lossy().into_owned(),
        icon: None,
    })
}

/// Parse a single `.desktop` file into an `InstalledApp`, or `None` when it is
/// hidden, not an application, or has no `Exec`. First value of each key wins so
/// the unlocalized `Name=`/`Exec=` take precedence over later `[Action]` groups.
/// Linux-only (Windows lists Start-Menu shortcuts instead); kept compiled for the
/// shared unit tests.
#[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
fn parse_installed_app(path: &Path) -> Option<InstalledApp> {
    let content = fs::read_to_string(path).ok()?;
    let mut in_entry = false;
    let mut name: Option<String> = None;
    let mut exec: Option<String> = None;
    let mut icon: Option<String> = None;
    let mut no_display = false;
    let mut is_app = true;
    for raw in content.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        if let Some(v) = line.strip_prefix("Name=") {
            if name.is_none() {
                name = Some(v.to_string());
            }
        } else if let Some(v) = line.strip_prefix("Exec=") {
            if exec.is_none() {
                exec = parse_exec_command(v);
            }
        } else if let Some(v) = line.strip_prefix("Icon=") {
            if icon.is_none() {
                icon = Some(v.to_string());
            }
        } else if let Some(v) = line.strip_prefix("NoDisplay=") {
            no_display = v.eq_ignore_ascii_case("true");
        } else if let Some(v) = line.strip_prefix("Type=") {
            is_app = v == "Application";
        }
    }
    if no_display || !is_app {
        return None;
    }
    let exec = exec?;
    Some(InstalledApp {
        name: name.unwrap_or_else(|| exec.clone()),
        exec,
        icon,
    })
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

/// Build the [`Command`] that runs `script_path` on Windows, choosing an
/// interpreter by extension: `.ps1` is run through PowerShell with an execution
/// policy bypass; anything else is handed to `cmd /C`, which executes `.bat`/
/// `.cmd` directly and otherwise opens the file via its shell association. Either
/// way the returned command spawns a child whose exit status the caller can wait
/// on for the `script-finished` event.
#[cfg(target_os = "windows")]
fn windows_script_command(script_path: &str) -> Command {
    let is_ps1 = Path::new(script_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map_or(false, |ext| ext.eq_ignore_ascii_case("ps1"));
    // `command_no_window` sets CREATE_NO_WINDOW so a background "run script"
    // action doesn't pop a transient console window — its output is intentionally
    // not surfaced (callers wanting output open a terminal tab instead).
    if is_ps1 {
        let mut cmd = crate::paths::command_no_window("powershell");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
        cmd.arg(script_path);
        cmd
    } else {
        let mut cmd = crate::paths::command_no_window("cmd");
        cmd.args(["/C", script_path]);
        cmd
    }
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
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist: IPersistFile = link.cast().ok()?;
        let wide = wide_null(path.as_os_str());
        persist.Load(PCWSTR(wide.as_ptr()), STGM_READ).ok()?;

        let mut target_buf = [0u16; 32768];
        link.GetPath(&mut target_buf, std::ptr::null_mut(), 0)
            .ok()?;
        let target = utf16_buf_to_path(&target_buf)?;

        let mut icon_buf = [0u16; 32768];
        let mut icon_index = 0i32;
        let icon_path = link
            .GetIconLocation(&mut icon_buf, &mut icon_index)
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
    // A raster `.png` is already a valid `<img>` source, so inline it directly
    // with the correct MIME. Everything else — `.exe`/`.dll` (no embedded raster),
    // `.ico` (whose `image/png` mislabel did not render reliably), or an extension-
    // less target — is rasterized through the shell to a real PNG data URL below.
    // Returning a bare filesystem path here (the prior behaviour) produced an
    // `<img src="C:\...\app.exe">` the WebView cannot load, hence blank icons.
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .map_or(false, |ext| ext.eq_ignore_ascii_case("png"))
    {
        return icon_to_data_url(path);
    }
    extract_windows_icon_png(path)
}

/// Rasterize the shell icon for `path` (an `.exe`/`.ico`/`.dll`/associated file)
/// to a base64 PNG data URL via GDI. Returns `None` on any failure so the
/// frontend falls back to its glyph rather than rendering a broken image. Every
/// GDI/shell handle acquired here is released on all paths.
#[cfg(target_os = "windows")]
fn extract_windows_icon_png(path: &Path) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

    // SAFETY: the HICON returned in `info.hIcon` is destroyed before returning on
    // both the success and failure paths.
    unsafe {
        let wide = wide_null(path.as_os_str());
        let mut info = SHFILEINFOW::default();
        let res = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if res == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let rgba = hicon_to_rgba(info.hIcon);
        let _ = DestroyIcon(info.hIcon);
        let (width, height, pixels) = rgba?;
        encode_png_data_url(width, height, &pixels)
    }
}

/// Convert an `HICON` to a top-down RGBA buffer `(width, height, pixels)`. The
/// icon's color bitmap supplies BGR (and per-pixel alpha for modern 32-bit
/// icons); when that alpha channel is entirely zero — legacy icons — opacity is
/// reconstructed from the 1-bpp AND mask instead. The color/mask GDI bitmaps from
/// `GetIconInfo` are deleted on every path.
#[cfg(target_os = "windows")]
unsafe fn hicon_to_rgba(
    hicon: windows::Win32::UI::WindowsAndMessaging::HICON,
) -> Option<(u32, u32, Vec<u8>)> {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    let mut icon_info = ICONINFO::default();
    if GetIconInfo(hicon, &mut icon_info).is_err() {
        return None;
    }
    let color = icon_info.hbmColor;
    let mask = icon_info.hbmMask;

    let result = (|| {
        if color.is_invalid() {
            return None;
        }
        let mut bmp = BITMAP::default();
        let got = GetObjectW(
            HGDIOBJ(color.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut BITMAP as *mut c_void),
        );
        if got == 0 || bmp.bmWidth <= 0 || bmp.bmHeight <= 0 {
            return None;
        }
        let width = bmp.bmWidth;
        let height = bmp.bmHeight;
        let pixel_count = (width as usize) * (height as usize);

        // Negative biHeight requests top-down rows (the order the PNG encoder
        // wants); 32-bit BI_RGB unpacks any source depth to BGRA scanlines.
        let header = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0 as u32,
            ..Default::default()
        };

        let dc = GetDC(None);
        if dc.is_invalid() {
            return None;
        }

        let read_dib = |hbm: windows::Win32::Graphics::Gdi::HBITMAP, buf: &mut [u8]| -> bool {
            let mut info = BITMAPINFO {
                bmiHeader: header,
                ..Default::default()
            };
            GetDIBits(
                dc,
                hbm,
                0,
                height as u32,
                Some(buf.as_mut_ptr() as *mut c_void),
                &mut info,
                DIB_RGB_COLORS,
            ) != 0
        };

        let mut pixels = vec![0u8; pixel_count * 4];
        let outcome = (|| {
            if !read_dib(color, &mut pixels) {
                return None;
            }
            // Reconstruct alpha from the AND mask when the color bitmap carries
            // none (mask: 0 = opaque, white = transparent).
            if !pixels.chunks_exact(4).any(|px| px[3] != 0) && !mask.is_invalid() {
                let mut mask_px = vec![0u8; pixel_count * 4];
                if read_dib(mask, &mut mask_px) {
                    for (px, m) in pixels.chunks_exact_mut(4).zip(mask_px.chunks_exact(4)) {
                        px[3] = if m[0] == 0 { 0xFF } else { 0x00 };
                    }
                } else {
                    for px in pixels.chunks_exact_mut(4) {
                        px[3] = 0xFF;
                    }
                }
            }
            // GDI delivers BGRA; the PNG encoder wants RGBA.
            for px in pixels.chunks_exact_mut(4) {
                px.swap(0, 2);
            }
            Some((width as u32, height as u32, pixels))
        })();

        ReleaseDC(None, dc);
        outcome
    })();

    if !color.is_invalid() {
        let _ = DeleteObject(HGDIOBJ(color.0));
    }
    if !mask.is_invalid() {
        let _ = DeleteObject(HGDIOBJ(mask.0));
    }
    result
}

/// Encode a top-down RGBA buffer to a base64 `data:image/png` URL in memory.
#[cfg(target_os = "windows")]
fn encode_png_data_url(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
    let mut buf = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut buf, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64_encode(&buf)))
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
    let mut files = Vec::new();
    for dir in xdg_application_dirs() {
        let Ok(entries) = fs::read_dir(&dir) else {
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
            exec = parse_exec_command(value);
        } else if let Some(value) = line.strip_prefix("Icon=") {
            icon = Some(value.to_string());
        }
    }
    Some(DesktopEntry {
        exec: exec?,
        icon: icon?,
    })
}

/// Parse a desktop-entry `Exec=` value into the literal command line to launch.
///
/// Desktop field codes (`%f`, `%U`, `%i`, ...) are placeholders the file/URL
/// argument fills in separately (see `file` in [`launch_command`]), and
/// Flatpak's `@@...@@` quoting markers wrap those placeholders, so both are
/// dropped. Every remaining token is kept and rejoined with single spaces —
/// unlike a first-token-only parse, this preserves multi-word launchers such as
/// Flatpak's `flatpak run --branch=stable --command=entrypoint app.id`, which
/// would otherwise be truncated to a bare `flatpak` with no way to know which
/// app to run.
pub(crate) fn parse_exec_command(value: &str) -> Option<String> {
    let tokens: Vec<&str> = value
        .split_whitespace()
        .filter(|part| !part.starts_with('%') && !part.starts_with("@@"))
        .map(|part| part.trim_matches('"'))
        .filter(|part| !part.is_empty())
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
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
    if pid == 0 {
        return false;
    }
    if cfg!(target_os = "linux") {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    } else if cfg!(target_os = "windows") {
        // Native liveness check: open the process and read its exit code.
        // STILL_ACTIVE (259) means the process is still running. A handle to an
        // already-exited process still opens successfully but GetExitCodeProcess
        // then reports the real exit code, so OpenProcess succeeding alone is not
        // enough — we must inspect the code. A failed OpenProcess (e.g. the PID
        // no longer exists) is treated as dead.
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::CloseHandle;
            use windows::Win32::System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            };
            const STILL_ACTIVE: u32 = 259;
            unsafe {
                match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                    Ok(handle) => {
                        let mut code: u32 = 0;
                        let alive =
                            GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE;
                        let _ = CloseHandle(handle);
                        alive
                    }
                    Err(_) => false,
                }
            }
        }
        // On non-Windows targets this branch is never taken at runtime; the
        // `false` keeps the expression well-typed when the cfg above is absent.
        #[cfg(not(target_os = "windows"))]
        {
            false
        }
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
            &[],
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

#[cfg(target_os = "macos")]
fn list_window_ids() -> Vec<u64> {
    crate::platform::macos::list_window_ids()
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
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

#[cfg(target_os = "macos")]
fn find_window_for_pid(pid: u32, attempts: usize) -> Option<u64> {
    crate::platform::macos::find_window_for_pid(pid, attempts)
}

/// Single-pass, non-blocking window-id resolver injected into `window_service`
/// at project-switch (hide) time. A launch-time miss (race, or the visible
/// top-level belonging to a child of the spawned pid) leaves `window_id` None;
/// re-resolving here just before hiding lets such a window still be parked, and
/// the back-populated id keeps the later switch-back SHOW symmetric. `attempts:
/// 1` does one enumeration with no `thread::sleep`, so it never stalls the
/// switch worker.
#[cfg(target_os = "windows")]
pub fn resolve_window_id_for_pid(pid: u32) -> Option<u64> {
    crate::platform::windows::find_window_for_pid(pid, 1)
}

/// macOS twin of the Windows resolver above — the launcher-stub → child-pid
/// hand-off happens with `open`-style launches too.
#[cfg(target_os = "macos")]
pub fn resolve_window_id_for_pid(pid: u32) -> Option<u64> {
    crate::platform::macos::find_window_for_pid(pid, 1)
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
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

#[cfg(target_os = "macos")]
fn find_new_window(before: &[u64], attempts: usize) -> Option<u64> {
    crate::platform::macos::find_new_window(before, attempts)
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
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
    fn base64_roundtrip_via_reference_crate() {
        use base64::Engine;

        let input = b"Eldrun workspace manager";
        let encoded = base64_encode(input);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("custom encoder should produce valid base64");

        assert_eq!(decoded, input.as_ref());
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

    // ── parse_exec_command ──────────────────────────────────────────────────

    #[test]
    fn parse_exec_command_plain_path() {
        assert_eq!(
            parse_exec_command("/usr/bin/firefox"),
            Some("/usr/bin/firefox".into())
        );
    }

    #[test]
    fn parse_exec_command_strips_desktop_field_codes() {
        // %U, %F etc. must be skipped.
        assert_eq!(
            parse_exec_command("/usr/bin/code %F"),
            Some("/usr/bin/code".into())
        );
    }

    #[test]
    fn parse_exec_command_strips_leading_percent_args() {
        assert_eq!(
            parse_exec_command("%u /usr/bin/app"),
            Some("/usr/bin/app".into())
        );
    }

    #[test]
    fn parse_exec_command_empty_string() {
        assert_eq!(parse_exec_command(""), None);
    }

    #[test]
    fn parse_exec_command_only_field_codes() {
        assert_eq!(parse_exec_command("%U %F %i"), None);
    }

    #[test]
    fn parse_exec_command_quoted_token_outer_quotes_stripped() {
        // The function strips outer quotes from the final string but splits on
        // whitespace first, so a quoted path with spaces is split at the space.
        // This documents the actual behavior.
        let result = parse_exec_command("\"/usr/bin/myapp\"");
        assert_eq!(result, Some("/usr/bin/myapp".into()));
    }

    #[test]
    fn parse_exec_command_preserves_multi_token_flatpak_launcher() {
        // A first-token-only parse would truncate this to a bare `flatpak`
        // with no way to know which app to run — the full command line
        // (minus field codes/@@ markers) must survive.
        let result = parse_exec_command(
            "/usr/bin/flatpak run --branch=stable --arch=x86_64 \
             --command=entrypoint --file-forwarding com.prusa3d.PrusaSlicer \
             --single-instance-on-url @@u %u @@",
        );
        assert_eq!(
            result,
            Some(
                "/usr/bin/flatpak run --branch=stable --arch=x86_64 \
                 --command=entrypoint --file-forwarding com.prusa3d.PrusaSlicer \
                 --single-instance-on-url"
                    .into()
            )
        );
    }

    // ── split_exec_command ──────────────────────────────────────────────────

    #[test]
    fn split_exec_command_no_whitespace_is_single_program() {
        assert_eq!(split_exec_command("/usr/bin/firefox"), ("/usr/bin/firefox", vec![]));
    }

    #[test]
    fn split_exec_command_splits_nonexistent_multi_word_launcher() {
        let (program, args) =
            split_exec_command("/usr/bin/flatpak run --branch=stable com.prusa3d.PrusaSlicer");
        assert_eq!(program, "/usr/bin/flatpak");
        assert_eq!(args, vec!["run", "--branch=stable", "com.prusa3d.PrusaSlicer"]);
    }

    #[test]
    fn split_exec_command_keeps_existing_path_with_spaces_whole() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "eldrun test app {}.txt",
            std::process::id()
        ));
        fs::write(&path, b"").unwrap();
        let exec = path.to_string_lossy().into_owned();
        assert_eq!(split_exec_command(&exec), (exec.as_str(), vec![]));
        let _ = fs::remove_file(&path);
    }

    // ── installed-app parsing / embeddable allowlist ───────────────────────

    fn write_desktop(body: &str) -> PathBuf {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "eldrun-test-{}-{}.desktop",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn parse_installed_app_extracts_name_exec_icon() {
        let path = write_desktop(
            "[Desktop Entry]\nType=Application\nName=Blender\nExec=/opt/blender/blender %f\nIcon=blender\n",
        );
        let app = parse_installed_app(&path).expect("should parse");
        fs::remove_file(&path).ok();
        assert_eq!(app.name, "Blender");
        assert_eq!(app.exec, "/opt/blender/blender");
        assert_eq!(app.icon.as_deref(), Some("blender"));
    }

    #[test]
    fn parse_installed_app_skips_nodisplay_and_non_application() {
        let hidden = write_desktop(
            "[Desktop Entry]\nType=Application\nName=Hidden\nExec=foo\nNoDisplay=true\n",
        );
        let link =
            write_desktop("[Desktop Entry]\nType=Link\nName=Bookmark\nExec=foo\nURL=http://x\n");
        let no_exec = write_desktop("[Desktop Entry]\nType=Application\nName=NoExec\n");
        assert!(parse_installed_app(&hidden).is_none());
        assert!(parse_installed_app(&link).is_none());
        assert!(parse_installed_app(&no_exec).is_none());
        for p in [hidden, link, no_exec] {
            fs::remove_file(&p).ok();
        }
    }

    #[test]
    fn blender_is_on_embeddable_allowlist() {
        assert!(is_embeddable_exec("/opt/blender-5.1.2-linux-x64/blender"));
        assert!(is_embeddable_exec("blender"));
    }

    #[test]
    fn project_apps_for_id_empty_without_id() {
        assert!(project_apps_for_id(None).is_empty());
    }

    #[test]
    fn pid_zero_is_never_alive() {
        assert!(!check_pid_alive(0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_bundle_discovery_uses_info_plist_and_bundle_path() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("Filename.app");
        let contents = app.join("Contents");
        let executable = contents.join("MacOS").join("real-bin");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, b"binary").unwrap();

        let mut info = plist::Dictionary::new();
        info.insert(
            "CFBundleDisplayName".into(),
            plist::Value::String("Preferred Name".into()),
        );
        info.insert(
            "CFBundleName".into(),
            plist::Value::String("Fallback Name".into()),
        );
        info.insert(
            "CFBundleExecutable".into(),
            plist::Value::String("real-bin".into()),
        );
        plist::Value::Dictionary(info)
            .to_file_xml(contents.join("Info.plist"))
            .unwrap();

        let apps = macos_installed_apps_in(&[temp.path().to_path_buf()]);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].name, "Preferred Name");
        assert_eq!(apps[0].exec, app.to_string_lossy().into_owned());
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

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_script_command_picks_interpreter_by_extension() {
        // .ps1 → PowerShell; .bat / .cmd / everything else → cmd /C.
        let ps1 = windows_script_command(r"C:\tmp\build.ps1");
        assert_eq!(ps1.get_program().to_string_lossy(), "powershell");

        for script in [r"C:\tmp\build.bat", r"C:\tmp\run.cmd", r"C:\tmp\go.sh"] {
            let cmd = windows_script_command(script);
            assert_eq!(cmd.get_program().to_string_lossy(), "cmd");
        }
    }
}
