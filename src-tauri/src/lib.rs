pub mod commands;
pub mod paths;
pub mod platform;
pub mod schema;
pub mod services;
pub mod storage;
#[cfg(target_os = "linux")]
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

    tauri::Builder::default()
        .manage(pty_registry)
        .manage(win_registry)
        .manage(workspace)
        .manage(fs_watch)
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
            // Install the global Claude SessionStart hook so Eldrun can follow a
            // tab's live session id across `/clear` (see services::agent_session).
            if let Err(e) = services::agent_session::install_session_start_hook() {
                eprintln!("agent_session: install SessionStart hook: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Settings
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::default_apps::get_default_apps,
            commands::default_apps::save_default_apps,
            // Projects
            commands::projects::get_projects,
            commands::projects::save_projects,
            commands::projects::load_project,
            commands::projects::save_project,
            commands::projects::set_project_description,
            commands::projects::set_project_sandbox,
            commands::projects::save_tab_layout,
            commands::projects::root_work_dir,
            commands::projects::projects_root_dir,
            commands::projects::open_in_file_manager,
            commands::projects::create_project,
            commands::projects::preview_project_scaffold,
            commands::projects::import_project,
            commands::projects::get_time_today,
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
            // SSH / remote projects
            commands::ssh::ssh_connect,
            commands::ssh::ssh_default_dir,
            commands::ssh::ssh_list_dir,
            commands::ssh::ensure_project_mounted,
            commands::ssh::ssh_tooling_status,
            // OpenVPN tunnels for VPN-gated remote projects
            commands::openvpn::openvpn_connect,
            commands::openvpn::openvpn_disconnect,
            commands::openvpn::openvpn_status,
            commands::openvpn::openvpn_store_config,
            // GitHub publishing
            commands::github::github_publish,
            // Timer flush + activity
            commands::timer::timer_flush_app,
            commands::timer::timer_flush_project,
            commands::timer::get_project_activity,
            // File tree + file I/O (commands::fs)
            commands::fs::list_dir,
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
            commands::fs::read_file_text,
            commands::fs::write_file_text,
            commands::fs::read_file_bytes,
            commands::fs::write_file_bytes,
            commands::fs::file_mtime,
            commands::format::format_source,
            commands::format::formatter_available,
            commands::format::check_syntax,
            commands::fs_watch::watch_dir,
            commands::fs_watch::unwatch_dir,
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
            commands::git::git_add_all,
            commands::git::git_generate_commit_message,
            commands::git::git_commit,
            commands::git::git_push,
            commands::git::git_file_statuses,
            commands::git::git_unpushed_commits,
            commands::git::git_add_path,
            commands::git::git_log,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_commit_message,
            commands::git::git_reword_head,
            commands::git::git_diff_file,
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
            // Downloads
            commands::downloads::configure_browser_downloads,
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
            commands::ollama::vibe_is_installed,
            commands::ollama::install_vibe,
            commands::agents::agent_is_installed,
            commands::agents::list_agents,
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
            commands::ollama::delete_ollama_model,
            commands::ollama::list_installable_models,
            commands::ollama::search_ollama_registry,
            // Local code/text autocomplete (opt-in, local-only)
            commands::ollama::complete_text,
            // Local grammar/spelling check (opt-in, local-only)
            commands::ollama::check_grammar,
        ])
        .plugin(tauri_plugin_dialog::init())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Tear down any sshfs mounts for remote projects when the app exits
            // so the user isn't left with stale FUSE mounts after shutdown.
            if let tauri::RunEvent::Exit = event {
                services::ssh_mount::unmount_all();
                // Tear down any OpenVPN tunnels brought up for VPN-gated
                // remote projects so no privileged tunnel outlives the app.
                services::openvpn::disconnect_all();
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
}
