pub mod commands;
pub mod duscan;
pub mod paths;
pub mod platform;
pub mod schema;
pub mod services;
pub mod storage;
pub mod sysstat;
pub mod terminal;

use std::sync::{Arc, Mutex};
use commands::apps::{WindowRegistry, WindowRegistryState};
use commands::terminal::RegistryState;
use commands::workspace::{WorkspaceState, WorkspaceStateArc};
use terminal::PtyRegistry;

/// Raw fd kept open so the async-signal-safe crash handler can write to it.
#[cfg(unix)]
static CRASH_LOG_FD: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

/// Raw file HANDLE kept open so the SEH crash filter can write to it — the
/// Windows analog of `CRASH_LOG_FD`. `0` (null, never a valid file handle)
/// means "not installed".
#[cfg(windows)]
static CRASH_LOG_HANDLE: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// Install a panic hook + OS signal handlers that append to crash.log.
fn install_crash_logger() {
    let state_dir = storage::state_dir();
    let _ = std::fs::create_dir_all(&state_dir);
    let path = state_dir.join("crash.log");

    append_to_log(&path, &format!("=== STARTED {} ===", iso_now()));

    let path2 = path.clone();
    std::panic::set_hook(Box::new(move |info| {
        let bt = std::backtrace::Backtrace::force_capture();
        let msg = format!("=== PANIC {} ===\n{info}\nbacktrace:\n{bt}\n", iso_now());
        append_to_log(&path2, &msg);
        eprintln!("{msg}");
    }));

    #[cfg(unix)]
    // SAFETY: called once at startup before any threads that touch signals.
    unsafe { install_signal_handlers(&path) };

    #[cfg(windows)]
    // SAFETY: called once at startup before any thread can crash.
    unsafe { install_seh_filter(&path) };
}

/// Append one entry to crash.log in the state dir.
pub(crate) fn crash_log_append(msg: &str) {
    append_to_log(&storage::state_dir().join("crash.log"), msg);
}

fn append_to_log(path: &std::path::Path, msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{msg}");
    }
}

/// Human-readable ISO 8601 UTC timestamp with no external dependencies.
pub(crate) fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, h, mi, s) = storage::epoch_to_utc(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Register async-signal-safe handlers for fatal signals.
/// Uses `SA_RESETHAND` so the default handler fires after ours, producing a
/// core dump and proper exit code.
#[cfg(unix)]
unsafe fn install_signal_handlers(path: &std::path::Path) {
    use std::os::unix::io::IntoRawFd;
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        CRASH_LOG_FD.store(
            file.into_raw_fd(),
            std::sync::atomic::Ordering::Relaxed,
        );
    }
    for &sig in &[libc::SIGSEGV, libc::SIGABRT, libc::SIGBUS, libc::SIGFPE] {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = signal_crash_handler as *const () as libc::sighandler_t;
        sa.sa_flags = libc::SA_SIGINFO | libc::SA_RESETHAND;
        libc::sigaction(sig, &sa, std::ptr::null_mut());
    }
}

/// Async-signal-safe crash handler: writes signal name to the pre-opened fd,
/// then returns so `SA_RESETHAND` lets the default handler terminate the process.
#[cfg(unix)]
extern "C" fn signal_crash_handler(
    sig: libc::c_int,
    _info: *mut libc::siginfo_t,
    _ctx: *mut libc::c_void,
) {
    let fd = CRASH_LOG_FD.load(std::sync::atomic::Ordering::Relaxed);
    if fd >= 0 {
        let name: &[u8] = match sig {
            libc::SIGSEGV => b"SIGSEGV",
            libc::SIGABRT => b"SIGABRT",
            libc::SIGBUS  => b"SIGBUS",
            libc::SIGFPE  => b"SIGFPE",
            _             => b"SIGNAL",
        };
        sig_write(fd, b"=== CRASH: ");
        sig_write(fd, name);
        sig_write(fd, b" ===\n");
    }
}

#[cfg(unix)]
#[inline(always)]
fn sig_write(fd: i32, buf: &[u8]) {
    // SAFETY: `write` is async-signal-safe per POSIX.
    unsafe { libc::write(fd, buf.as_ptr() as *const libc::c_void, buf.len()) };
}

/// Register a Windows SEH unhandled-exception filter that appends a
/// `=== CRASH: … ===` line to crash.log — the native-fault analog of the Unix
/// signal handlers above (a Rust panic is already covered by the panic hook;
/// this catches access violations and friends that never unwind).
#[cfg(windows)]
unsafe fn install_seh_filter(path: &std::path::Path) {
    use std::os::windows::io::IntoRawHandle;
    use windows::Win32::System::Diagnostics::Debug::SetUnhandledExceptionFilter;
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        CRASH_LOG_HANDLE.store(
            file.into_raw_handle() as isize,
            std::sync::atomic::Ordering::Relaxed,
        );
    }
    // SAFETY: `crash_filter` matches the required `extern "system"` signature
    // and only performs handle writes on pre-opened state.
    unsafe {
        SetUnhandledExceptionFilter(Some(crash_filter));
    }
}

/// SEH top-level filter: write one crash line to the pre-opened handle, then
/// return `EXCEPTION_CONTINUE_SEARCH` (0) so default termination (WER, exit
/// code) proceeds — the moral equivalent of `SA_RESETHAND` on Unix. Runs on
/// the crashing thread with a possibly corrupt heap, so it formats into a
/// stack buffer via the allocation-free `format_crash_line`.
#[cfg(windows)]
unsafe extern "system" fn crash_filter(
    info: *const windows::Win32::System::Diagnostics::Debug::EXCEPTION_POINTERS,
) -> i32 {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::WriteFile;

    // SAFETY: the OS hands us a valid EXCEPTION_POINTERS for the duration of
    // the filter call; both pointers are null-checked before dereference.
    let (code, addr) = unsafe {
        if info.is_null() || (*info).ExceptionRecord.is_null() {
            (0u32, 0usize)
        } else {
            let rec = &*(*info).ExceptionRecord;
            (rec.ExceptionCode.0 as u32, rec.ExceptionAddress as usize)
        }
    };
    let handle = CRASH_LOG_HANDLE.load(std::sync::atomic::Ordering::Relaxed);
    if handle != 0 {
        let mut buf = [0u8; 64];
        let len = format_crash_line(code, addr, &mut buf);
        // SAFETY: the handle was opened at install time and is kept open for
        // the process lifetime; WriteFile on a file handle is safe here.
        unsafe {
            let _ = WriteFile(
                HANDLE(handle as *mut core::ffi::c_void),
                Some(&buf[..len]),
                None,
                None,
            );
        }
    }
    0 // EXCEPTION_CONTINUE_SEARCH
}

/// Format `=== CRASH: code=0x… addr=0x… ===\n` into `buf` without allocating
/// (an SEH filter runs on a crashing thread whose heap may be corrupt) and
/// return the byte length. Truncates silently if `buf` is too small. Compiled
/// on every OS so its unit tests run on Linux; only the Windows crash filter
/// consumes it at runtime.
pub fn format_crash_line(code: u32, addr: usize, buf: &mut [u8]) -> usize {
    fn push(buf: &mut [u8], pos: usize, bytes: &[u8]) -> usize {
        let n = bytes.len().min(buf.len().saturating_sub(pos));
        buf[pos..pos + n].copy_from_slice(&bytes[..n]);
        pos + n
    }
    fn push_hex(buf: &mut [u8], pos: usize, mut v: u64, min_digits: usize) -> usize {
        let mut digits = [0u8; 16];
        let mut i = 0;
        loop {
            let d = (v & 0xF) as u8;
            digits[i] = if d < 10 { b'0' + d } else { b'A' + (d - 10) };
            i += 1;
            v >>= 4;
            if (v == 0 && i >= min_digits) || i == digits.len() {
                break;
            }
        }
        let mut pos = pos;
        while i > 0 {
            i -= 1;
            pos = push(buf, pos, &digits[i..i + 1]);
        }
        pos
    }
    let mut pos = 0;
    pos = push(buf, pos, b"=== CRASH: code=0x");
    pos = push_hex(buf, pos, code as u64, 8);
    pos = push(buf, pos, b" addr=0x");
    pos = push_hex(buf, pos, addr as u64, 1);
    pos = push(buf, pos, b" ===\n");
    pos
}

/// Webview renderer crashes (e.g. WebKitWebProcess SIGBUS) happen in a child
/// process, so the signal handlers above never fire and the window keeps
/// showing its last frame — an apparent freeze. Hook WebKit's
/// web-process-terminated signal to log the reason to crash.log and reload
/// the page, which respawns the renderer.
#[cfg(target_os = "linux")]
fn install_webview_crash_reporter(app: &tauri::App) {
    use tauri::Manager;
    use webkit2gtk::{WebProcessTerminationReason, WebViewExt};

    static RELOADS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    const MAX_RELOADS: u32 = 5;

    for window in app.webview_windows().values() {
        let label = window.label().to_string();
        let _ = window.with_webview(move |webview| {
            let label = label.clone();
            webview
                .inner()
                .connect_web_process_terminated(move |view, reason| {
                    let msg = format!(
                        "=== WEBVIEW '{label}' TERMINATED {} reason={reason:?} ===",
                        iso_now()
                    );
                    crash_log_append(&msg);
                    eprintln!("{msg}");
                    if reason == WebProcessTerminationReason::TerminatedByApi {
                        return;
                    }
                    if RELOADS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) < MAX_RELOADS {
                        view.reload();
                    }
                });
        });
    }
}

/// WebKitGTK draws the scrollbars INSIDE the web content with the native GTK
/// theme, not the page's CSS — the standard `scrollbar-color` property is ignored
/// on this WebKitGTK build (confirmed on 2.50.x). On a light GTK system theme
/// that leaves a white trough + grey slider regardless of Eldrun's in-app theme.
///
/// WebKit's scrollbar renderer queries the default screen's GTK style providers,
/// so an APPLICATION-priority `GtkCssProvider` that recolors the `scrollbar`
/// nodes is picked up for the in-content bars. We apply a theme-agnostic look —
/// a translucent-grey trough (subtle on both light and dark surfaces) with a
/// solid accent-blue slider — so it reads as "Eldrun blue" without having to
/// follow the live in-app theme. Best-effort and behind an env opt-out: any
/// failure simply leaves the native scrollbar untouched.
#[cfg(target_os = "linux")]
fn install_scrollbar_theme() {
    use gtk::prelude::*;

    if std::env::var_os("ELDRUN_NO_SCROLLBAR_THEME").is_some() {
        return;
    }

    // GTK3 scrollbar node structure: `scrollbar > contents > trough > slider`.
    // Recolor the trough + slider; `min-width/height` keep the thin overlay bar
    // wide enough to see. Colors mirror the frontend's fancy_dark accent so the
    // native bar matches the webview's themed bars on every surface.
    const CSS: &str = "
        scrollbar trough {
            background-color: rgba(127, 127, 127, 0.14);
            border-radius: 8px;
            border: none;
        }
        scrollbar slider {
            background-color: #36c5f0;
            border: 2px solid transparent;
            border-radius: 8px;
            min-width: 8px;
            min-height: 8px;
        }
        scrollbar slider:hover { background-color: #5edcff; }
        scrollbar slider:active { background-color: #1ca7d8; }
    ";

    let provider = gtk::CssProvider::new();
    if let Err(e) = provider.load_from_data(CSS.as_bytes()) {
        eprintln!("scrollbar theme: load css: {e}");
        return;
    }
    match gtk::gdk::Screen::default() {
        Some(screen) => gtk::StyleContext::add_provider_for_screen(
            &screen,
            &provider,
            gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
        ),
        None => eprintln!("scrollbar theme: no default GDK screen"),
    }
}

/// Reopen the main window on the monitor and at the geometry it was last closed
/// at, then show it. The counterpart of the debounced save in `AppShell.tsx`.
///
/// The window is declared `"visible": false` in `tauri.conf.json` purely so this
/// can run before the first frame: it opens `maximized`, so on a multi-monitor
/// desk the WM maps it on the primary monitor and a restore onto the *other*
/// monitor would be a visible jump. Hidden → placed → shown, and the user only
/// ever sees the final position. The cost is that `win.show()` below is now
/// load-bearing; every call in here is best-effort (`let _ =`) so no failure can
/// skip it.
///
/// Geometry rules (which monitor, what if it was unplugged) live in
/// `services::window_state::resolve_startup_geometry`, which is pure and tested.
fn restore_main_window(app: &tauri::App) {
    use tauri::Manager;

    let Some(win) = app.get_webview_window("main") else {
        return; // No main window: nothing to place and nothing to show.
    };

    // Guard against a stray fullscreen state surviving into this launch. On Linux
    // this is not cosmetic: a window the WM has put into fullscreen keeps
    // `_NET_WM_STATE_FULLSCREEN`, which under KWin wins over MAXIMIZED and makes
    // the window UNMOVABLE — KWin refuses the `_NET_WM_MOVERESIZE` that
    // `startDragging` sends, so the header title-bar drag silently no-ops. A
    // maximized window fills the monitor identically yet stays draggable and
    // edge-snappable, so that is what Eldrun uses instead. macOS is excluded: real
    // fullscreen (its own Space) is the platform-expected behaviour there, and
    // `AppShell.tsx` opts into it explicitly after load.
    #[cfg(not(target_os = "macos"))]
    let _ = win.set_fullscreen(false);

    let saved = storage::read_json::<schema::Settings>(&storage::state_dir().join("settings.json"))
        .ok()
        .and_then(|s| s.window_state);
    let monitors: Vec<services::window_state::MonitorRect> = win
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| services::window_state::MonitorRect {
            x: m.position().x,
            y: m.position().y,
            w: m.size().width,
            h: m.size().height,
        })
        .collect();
    if saved.is_some() && monitors.is_empty() {
        // We have a rect to restore but nothing to validate it against, so it is
        // dropped and the window opens at the configured default. Not fatal, but
        // it silently defeats the whole feature — say so rather than leave the
        // user wondering why their window never comes back where they left it.
        eprintln!("window_state: no monitors reported at startup; ignoring the saved geometry");
    }

    match services::window_state::resolve_startup_geometry(saved, &monitors) {
        Some(g) => {
            // Unmaximize FIRST, even when we are about to re-maximize immediately:
            // the window is mapped maximized, and assigning a size/position while
            // it is in that state is what gives the WM a genuine restore geometry
            // to fall back to. Without it the WM's only record of a "normal" size
            // is the full monitor, so the maximize button appears to do nothing —
            // the exact bug `WindowControls.tsx` has to work around today.
            let _ = win.unmaximize();
            let _ = win.set_size(tauri::PhysicalSize::new(g.w, g.h));
            let _ = win.set_position(tauri::PhysicalPosition::new(g.x, g.y));
            if g.maximized {
                let _ = win.maximize();
            }
        }
        None => {
            // Fresh install, or a saved rect no connected monitor can host (the
            // undocked-external-display case). Fall back to the configured default
            // and re-assert it, in case the WM dropped the `maximized` hint at map
            // time.
            #[cfg(not(target_os = "macos"))]
            let _ = win.maximize();
        }
    }

    let _ = win.show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKit's DMA-BUF renderer SIGBUSes inside Mesa on some driver stacks
    // (seen 2026-06-11 with Mesa 26.0.3: renderer died, window froze). Fall
    // back to shared-memory rendering unless the user explicitly overrides.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    install_crash_logger();

    let pty_registry: RegistryState = Arc::new(Mutex::new(PtyRegistry::default()));
    let win_registry: WindowRegistryState = Arc::new(Mutex::new(WindowRegistry::default()));
    let workspace: WorkspaceStateArc = Arc::new(Mutex::new(WorkspaceState::new()));
    let fs_watch = commands::fs_watch::new_state();
    // Pooled SSH/SFTP connections, one per active remote project (Phase 0 of the
    // mount-free remote model). Opened on activation, torn down at exit below.
    let remote_pool = services::remote::new_pool();
    // Single-writer cache of per-project sync manifests (SSH-sync Phase 1). Guards
    // every `sync.json` mutation so concurrent syncs/saves can't clobber it (G7).
    let sync_manifest = services::remote_sync::new_manifest_state();
    // Registry of per-project auto-sync tasks (started on remote_connect, stopped
    // on remote_disconnect / app exit). See `services::sync_auto`.
    let auto_sync = services::sync_auto::new_state();
    // Registry of per-project git lockstep tasks (.git watcher + host poll; started
    // on remote_connect when enabled, stopped on disconnect / exit). See
    // `services::git_peer` (TODO #28n).
    let git_peer = services::git_peer::new_registry();
    // Cancel flags for in-flight disk-usage scans, one per scanning pane. See
    // `commands::disk_usage`.
    let disk_scans = commands::disk_usage::new_state();
    // Recursive file-churn watcher on the active project + the counters it has
    // seen since the last flush (see `services::usage_stats`).
    let usage_watch = services::usage_stats::new_state();

    tauri::Builder::default()
        .manage(pty_registry)
        .manage(win_registry)
        .manage(workspace)
        .manage(fs_watch)
        .manage(remote_pool)
        // Carries PDF pages between two Eldrun windows: they are separate WebViews
        // with separate JS heaps, so the bytes must cross the process boundary.
        .manage(commands::pdf_clip::PdfClipboard::default())
        .manage(sync_manifest)
        .manage(auto_sync)
        .manage(git_peer)
        .manage(disk_scans)
        .manage(usage_watch.clone())
        .setup(|_app| {
            #[cfg(target_os = "linux")]
            install_webview_crash_reporter(_app);
            // Recolor WebKitGTK's native in-content scrollbars (page CSS can't —
            // `scrollbar-color` is ignored on this build). Runs on the GTK main
            // thread, which `setup` is, after GTK is initialized.
            #[cfg(target_os = "linux")]
            install_scrollbar_theme();
            // Record the MAIN window's X11 id so the workspace backend can
            // STRUCTURALLY refuse to ever park it (#42 detached-subwindow
            // parkable override). Resolved off-thread so a slow compositor never
            // blocks startup; the main window has a stable title from
            // tauri.conf.json so `find_window_for_title` finds it.
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                let workspace = _app.state::<WorkspaceStateArc>().inner().clone();
                std::thread::spawn(move || {
                    if let Some(id) = platform::x11::find_window_for_title("Eldrun", 30) {
                        workspace.lock().unwrap().backend.set_main_window_id(id);
                    }
                });
            }
            // Windows: the HWND is known synchronously from Tauri, so no off-thread
            // title scan is needed. Binding the main-window id arms the structural
            // guard so the override can never park the main window (defense-in-depth
            // on top of the self_pid protection that already shields it).
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                let workspace = _app.state::<WorkspaceStateArc>().inner().clone();
                if let Some(hwnd) = _app
                    .get_webview_window("main")
                    .and_then(|w| w.hwnd().ok())
                {
                    let id = hwnd.0 as usize as u64;
                    workspace.lock().unwrap().backend.set_main_window_id(id);
                    // Add the WS_MAXIMIZEBOX/WS_THICKFRAME styles a borderless wry
                    // window lacks, so dragging the header against a screen edge
                    // triggers the native Aero Snap (top → maximize, sides → half).
                    platform::windows::enable_aero_snap(id);
                }
            }
            // macOS: bind the MAIN window's CGWindowID (== NSWindow.windowNumber)
            // for the structural parkable guard, like the Windows arm above.
            // `ns_window()` must be used on the main thread, which setup is.
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                let workspace = _app.state::<WorkspaceStateArc>().inner().clone();
                if let Some(id) = _app
                    .get_webview_window("main")
                    .and_then(|w| w.ns_window().ok())
                    .and_then(|ns| platform::macos::ns_window_id(ns as *mut std::ffi::c_void))
                {
                    workspace.lock().unwrap().backend.set_main_window_id(id);
                }
            }
            // Install the global Claude SessionStart hook so Eldrun can follow a
            // tab's live session id across `/clear` (see services::agent_session).
            if let Err(e) = services::agent_session::install_session_start_hook() {
                eprintln!("agent_session: install SessionStart hook: {e}");
            }
            // Bring legacy `projects.json` entries (written by older Eldrun
            // versions) up to the current shape and refresh their scaffold, then
            // persist. Off-thread so file I/O never blocks startup; additive and
            // idempotent, so a race with the frontend's first load is benign.
            std::thread::spawn(commands::projects::migrate_legacy_projects);
            // Remove project containers a previous run left behind (a crash
            // skips the exit teardown) and the staged config copies. Off-thread:
            // docker may be slow or absent, and neither may block startup.
            std::thread::spawn(services::sandbox::sweep_orphans);
            // Start the background per-project SSH-link traffic sampler so each
            // remote project's daily/monthly/overall usage accrues even when its
            // Network Traffic tab is closed (see services::net_usage). No-op on
            // non-Linux.
            {
                use tauri::Manager;
                let pool = _app
                    .state::<services::remote::RemotePoolState>()
                    .inner()
                    .clone();
                services::net_usage::start(pool);
            }
            // Periodically fold the file-churn the watcher has seen into
            // `usage_stats.json` (see services::usage_stats). The watcher itself is
            // attached on project activation, via `usage_watch_project`.
            services::usage_stats::start(usage_watch);
            // Place the main window where it was last closed and MAKE IT VISIBLE.
            // Must stay last in `setup`: the window is created hidden (see
            // `restore_main_window`), so anything that returns early before this
            // leaves Eldrun running with no window on screen.
            restore_main_window(_app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Settings
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::save_window_state,
            commands::default_apps::get_default_apps,
            commands::default_apps::save_default_apps,
            // Projects
            commands::projects::get_projects,
            commands::projects::save_projects,
            commands::projects::load_project,
            commands::projects::save_project,
            commands::projects::set_project_description,
            commands::projects::set_project_name,
            commands::projects::set_project_sandbox,
            commands::projects::set_project_sandbox_spec,
            commands::projects::sandbox_preflight,
            commands::projects::set_project_openvpn,
            commands::projects::set_project_auto_connect,
            commands::projects::set_project_categories,
            commands::projects::set_project_git_disabled,
            commands::projects::save_tab_layout,
            commands::projects::root_work_dir,
            commands::projects::projects_root_dir,
            commands::projects::remote_mirror_root_dir,
            commands::projects::open_in_file_manager,
            commands::projects::remote_mirror_status,
            commands::projects::set_remote_mirror_dir,
            commands::projects::move_remote_mirror,
            commands::projects::create_project,
            commands::projects::preview_project_scaffold,
            commands::projects::project_scaffold_missing,
            commands::projects::repair_project_scaffold,
            commands::projects::repair_all_project_scaffolds,
            commands::projects::import_project,
            commands::projects::extend_project_to_remote,
            commands::projects::detach_project_from_remote,
            commands::projects::get_time_today,
            commands::projects::archive_project,
            commands::projects::list_archived_projects,
            commands::projects::restore_archived_project,
            commands::projects::delete_archived_project,
            commands::projects::archived_mirror_unsynced,
            commands::projects::clear_archive,
            // Project boxes (meta-project grouping)
            commands::boxes::get_boxes,
            commands::boxes::save_boxes,
            commands::boxes::create_box,
            commands::boxes::rename_box,
            commands::boxes::delete_box,
            commands::boxes::set_box_members,
            commands::boxes::ensure_box_folder,
            commands::boxes::refresh_box_agent_docs,
            commands::boxes::set_box_relations,
            // Native calendar (local event store)
            commands::calendar::calendar_load,
            commands::calendar::calendar_save,
            commands::calendar::create_event,
            commands::calendar::update_event,
            commands::calendar::delete_event,
            commands::calendar::create_task,
            commands::calendar::update_task,
            commands::calendar::delete_task,
            commands::calendar::create_calendar,
            commands::calendar::update_calendar,
            commands::calendar::delete_calendar,
            commands::calendar::calendar_read_ics,
            commands::calendar::calendar_write_ics,
            // SSH / remote projects
            commands::ssh::ssh_connect,
            commands::ssh::ssh_probe,
            commands::ssh::remote_has_saved_password,
            commands::ssh::remote_forget_password,
            commands::ssh::remote_login_command,
            commands::ssh::ssh_default_dir,
            commands::ssh::ssh_list_dir,
            commands::ssh::ssh_mkdir,
            // Pooled SSH/SFTP connection lifecycle (mount-free remote, Phase 0)
            commands::remote::remote_connect,
            commands::remote::remote_disconnect,
            // Read-only local/remote host + SSH transport monitoring.
            commands::network::network_host_snapshot,
            commands::network::network_ssh_link_snapshot,
            commands::net_usage::get_net_usage,
            // Usage counters + daily recap.
            commands::usage_stats::usage_bump,
            commands::usage_stats::usage_summary,
            commands::usage_stats::usage_watch_project,
            commands::usage_stats::usage_git_stats,
            commands::monitor::system_monitor_snapshot,
            // AC-vs-battery detection for Energy Saver mode.
            commands::power::get_power_state,
            // SSH-sync (Phase 1): selective local↔remote mirror sync.
            commands::sync::sync_pull,
            commands::sync::sync_whole_project,
            commands::sync::sync_now,
            commands::sync::sync_push,
            commands::sync::sync_mark_selected,
            commands::sync::sync_set_auto,
            commands::sync::sync_auto_preview,
            commands::sync::sync_status,
            commands::sync::sync_file_meta,
            commands::sync::sync_diff,
            commands::ssh::ssh_tooling_status,
            commands::ssh::ssh_list_addresses,
            commands::ssh::ssh_remember_address,
            commands::ssh::remote_list_paths,
            commands::ssh::remote_remember_path,
            commands::ssh::remote_list_default_paths,
            commands::ssh::remote_get_default_path,
            commands::ssh::remote_set_default_path,
            commands::ssh::open_external_url,
            // OpenVPN tunnels for VPN-gated remote projects
            commands::openvpn::openvpn_connect,
            commands::openvpn::openvpn_auth_needs,
            commands::openvpn::vpn_has_saved_password,
            commands::openvpn::vpn_can_connect_silently,
            commands::openvpn::vpn_forget_password,
            commands::openvpn::openvpn_login_command,
            commands::openvpn::openvpn_disconnect,
            commands::openvpn::openvpn_status,
            commands::openvpn::openvpn_active,
            commands::openvpn::openvpn_store_config,
            commands::openvpn::openvpn_list_configs,
            // Git hosting (GitHub / GitLab) publishing
            commands::git_publish::publish_project,
            commands::git_publish::unpublish_project,
            commands::git_publish::set_project_visibility,
            commands::git_publish::switch_project_provider,
            commands::git_hosting::get_project_git_hosting,
            commands::git_hosting::set_project_git_hosting,
            // Timer flush + activity
            commands::timer::timer_flush_app,
            commands::timer::timer_flush_project,
            commands::timer::get_project_activity,
            commands::timer::get_time_activity_all,
            // File tree + file I/O (commands::fs)
            commands::fs::list_dir,
            commands::fs::list_recent_downloads,
            commands::fs::dir_size,
            commands::fs::dir_size_breakdown,
            commands::fs::list_dirs,
            commands::fs::list_project_endings,
            commands::fs::list_project_paths,
            commands::fs::rename_path,
            commands::fs::copy_path,
            commands::fs::move_path,
            commands::fs::import_external_file,
            commands::fs::project_path_exists,
            commands::fs::extract_archive,
            commands::clipboard::clipboard_has_image,
            commands::clipboard::save_clipboard_image,
            commands::screenshot::capture_project_screenshot,
            commands::fs::delete_file,
            commands::fs::delete_dir,
            commands::fs::create_file,
            commands::fs::write_project_file,
            commands::fs::write_project_file_bytes,
            commands::fs::update_gitignore_rule,
            commands::fs::create_dir,
            commands::fs::detect_mime,
            commands::fs::file_source,
            commands::fs::read_file_text,
            commands::fs::write_file_text,
            commands::fs::read_file_bytes,
            commands::fs::write_file_bytes,
            commands::pdf_clip::pdf_clip_set,
            commands::pdf_clip::pdf_clip_get,
            commands::fs::file_mtime,
            commands::format::format_source,
            commands::format::formatter_available,
            commands::format::check_syntax,
            commands::fs_watch::watch_dir,
            commands::fs_watch::unwatch_dir,
            // Disk usage analyzer (commands::disk_usage)
            commands::disk_usage::disk_usage_scan,
            commands::disk_usage::disk_usage_cancel,
            commands::disk_usage::disk_usage_devices,
            // LaTeX view / compile (gated on a TeX engine being on PATH)
            commands::tex::tex_capability,
            commands::tex::compile_tex,
            commands::tex::synctex_edit,
            commands::tex::synctex_view,
            commands::tex::resolve_tex_root,
            // Terminal
            commands::terminal::pty_spawn,
            commands::terminal::pty_write,
            commands::terminal::pty_resize,
            commands::terminal::pty_kill,
            commands::terminal::project_cpu_percent,
            // External apps / window tracking
            commands::apps::launch_app,
            commands::apps::resolve_app_icon,
            commands::apps::open_file,
            commands::apps::list_tracked_windows,
            commands::apps::untrack_window,
            commands::apps::check_pid_alive,
            commands::apps::restore_open_apps,
            commands::apps::run_script_detached,
            commands::apps::drag_preview_icon,
            commands::apps::start_file_drag,
            commands::apps::cancel_file_drag,
            commands::apps::embed_capability,
            commands::apps::list_installed_apps,
            // Workspace / network
            commands::workspace::workspace_info,
            commands::workspace::workspace_switch,
            commands::workspace::show_window,
            commands::workspace::hide_window,
            commands::workspace::get_opened_windows,
            commands::workspace::switch_project_windows, // deprecated; use switch_project_runtime
            // Detached subwindows (#42)
            commands::subwindow::detach_subwindow,
            commands::subwindow::attach_subwindow,
            commands::subwindow::detached_window_frontmost,
            commands::workspace::workspace_name,
            commands::workspace::network_conn_type,
            // Project-runtime switching (replaces switch_project_windows)
            commands::project_runtime::switch_project_runtime,
            commands::project_runtime::load_right_panel_folder,
            commands::project_runtime::save_right_panel_folder,
            // Git
            commands::git::git_status,
            commands::git::git_repo_root,
            commands::git::detect_git_providers,
            commands::git::git_add_all,
            commands::git::git_generate_commit_message,
            commands::git::git_commit,
            commands::git::git_push,
            commands::git::git_clone,
            commands::git::git_file_statuses,
            commands::git::git_unpushed_commits,
            commands::git::git_change_stats,
            commands::git::git_add_path,
            commands::git::git_log,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_commit_message,
            commands::git::git_reword_head,
            commands::git_peer::git_peer_status,
            commands::git_peer::git_peer_set_enabled,
            commands::git_peer::git_peer_sync_now,
            commands::git_peer::git_peer_checkout,
            commands::git_peer::git_peer_resolve,
            commands::git_peer::git_peer_pair_confirm,
            commands::git_peer::git_peer_backups,
            commands::git_peer::git_peer_restore_backup,
            commands::git_peer::git_peer_mirror_dir,
            // Local-loss warnings (#28q): what lockstep/sync destroyed in the mirror.
            commands::local_loss::local_loss_list,
            commands::local_loss::local_loss_ack,
            commands::git::git_diff_file,
            commands::git::git_blame,
            commands::git::git_file_log,
            commands::git::git_file_at_rev,
            // Project-wide content search
            commands::search::project_search,
            // SQLite database browser (Dev C)
            commands::sqlite::sqlite_tables,
            commands::sqlite::sqlite_page,
            // Spreadsheet (.xlsx/.xls) reader (Dev G)
            commands::sheets::read_spreadsheet,
            // Git worktrees (TODO Group E #23)
            commands::git::git_worktree_list,
            commands::git::git_worktree_add,
            commands::git::git_worktree_remove,
            commands::git::git_worktree_prune,
            // Crash reporting
            commands::crash::report_frontend_error,
            // Debug diagnostics
            commands::debug::debug_app_resource_usage,
            // Ollama local models
            commands::ollama::list_ollama_models,
            commands::ollama::ensure_vibe_ollama_model,
            commands::ollama::prepare_local_agent,
            commands::ollama::list_local_drivers,
            commands::ollama::prepare_local_launch,
            commands::ollama::ensure_ollama_running,
            // Ollama model management
            commands::ollama::ollama_is_installed,
            commands::ollama::install_ollama,
            commands::ollama::ollama_install_strategy,
            commands::ollama::vibe_is_installed,
            commands::ollama::install_vibe,
            commands::ollama::vibe_install_strategy,
            commands::agents::agent_is_installed,
            commands::agents::npm_is_installed,
            commands::agents::list_agents,
            commands::agents::codex_hook_status,
            commands::agents::install_agent,
            commands::ollama::ollama_is_running,
            commands::ollama::ollama_status,
            commands::ollama::ollama_registry_size,
            commands::ollama::list_ollama_models_detailed,
            commands::ollama::stop_ollama_model,
            commands::ollama::load_ollama_model,
            commands::ollama::list_pending_ollama_pulls,
            commands::ollama::clear_pending_ollama_pull,
            commands::ollama::list_orphan_partial_blobs,
            commands::ollama::delete_partial_blob,
            commands::ollama::pull_ollama_model,
            commands::ollama::pause_ollama_pull,
            commands::ollama::delete_ollama_pull,
            commands::ollama::delete_ollama_model,
            commands::ollama::list_installable_models,
            commands::ollama::search_ollama_registry,
            // Local code/text autocomplete (opt-in, local-only)
            commands::ollama::complete_text,
            // Local grammar/spelling check (opt-in, local-only)
            commands::ollama::check_grammar,
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_notification::init())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                // Tear down any OpenVPN tunnels brought up for VPN-gated
                // remote projects so no privileged tunnel outlives the app.
                services::openvpn::disconnect_all();
                // Remove every project container this run created — container
                // lifetime is the project session, never longer than the app.
                services::sandbox::down_all();
                // Tear down pooled SSH/SFTP connections so no ssh ControlMaster
                // child (and the master socket it owns) outlives Eldrun.
                use tauri::Manager;
                // Stop every auto-sync task first (cancel loops + drop watchers)
                // so none races the pool teardown below.
                let auto = _app
                    .state::<services::sync_auto::AutoSyncState>()
                    .inner()
                    .clone();
                tauri::async_runtime::block_on(services::sync_auto::stop_all(&auto));
                // Stop every git-peer lockstep task (cancel poll loops + drop .git
                // watchers) before the pool teardown.
                let git_peer = _app
                    .state::<services::git_peer::GitPeerRegistry>()
                    .inner()
                    .clone();
                tauri::async_runtime::block_on(services::git_peer::stop_all(&git_peer));
                let pool = _app
                    .state::<services::remote::RemotePoolState>()
                    .inner()
                    .clone();
                tauri::async_runtime::block_on(services::remote::disconnect_all(&pool));
            }
        });
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_now_uses_z_suffix() {
        let s = iso_now();
        assert!(s.ends_with('Z'), "crash-log timestamps end with Z: {s}");
        assert!(s.contains('T'));
    }

    fn crash_line(code: u32, addr: usize, cap: usize) -> (String, usize) {
        let mut buf = vec![0u8; cap];
        let len = format_crash_line(code, addr, &mut buf);
        (String::from_utf8(buf[..len].to_vec()).unwrap(), len)
    }

    #[test]
    fn format_crash_line_access_violation() {
        // 0xC0000005 = STATUS_ACCESS_VIOLATION, the canonical native crash.
        let (s, _) = crash_line(0xC000_0005, 0x7FF6_1234_ABCD, 64);
        assert_eq!(s, "=== CRASH: code=0xC0000005 addr=0x7FF61234ABCD ===\n");
    }

    #[test]
    fn format_crash_line_pads_code_to_8_digits_and_addr_to_1() {
        let (s, _) = crash_line(0x5, 0x0, 64);
        assert_eq!(s, "=== CRASH: code=0x00000005 addr=0x0 ===\n");
    }

    #[test]
    fn format_crash_line_truncates_without_panicking() {
        for cap in 0..48 {
            let (s, len) = crash_line(0xC000_0005, usize::MAX, cap);
            assert!(len <= cap, "len {len} must fit cap {cap}");
            assert!("=== CRASH: code=0xC0000005 addr=0xFFFFFFFFFFFFFFFF ===\n".starts_with(&s));
        }
    }

    #[test]
    fn format_crash_line_max_values_fit_a_64_byte_buffer() {
        let (s, len) = crash_line(u32::MAX, usize::MAX, 64);
        assert!(len < 64, "worst case must fit the filter's stack buffer");
        assert_eq!(s, "=== CRASH: code=0xFFFFFFFF addr=0xFFFFFFFFFFFFFFFF ===\n");
    }
}
