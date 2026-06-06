pub mod commands;
pub mod platform;
pub mod schema;
pub mod services;
pub mod storage;
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
fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, h, mi, s) = epoch_to_utc(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

pub(crate) fn epoch_to_utc(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let mut days = secs / 86400;
    let mut year = 1970u64;
    loop {
        let dy = if is_leap_year(year) { 366 } else { 365 };
        if days < dy { break; }
        days -= dy;
        year += 1;
    }
    let month_lens: [u64; 12] = [
        31, if is_leap_year(year) { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 1u64;
    for &ml in &month_lens {
        if days < ml { break; }
        days -= ml;
        month += 1;
    }
    (year, month, days + 1, h, m, s)
}

pub(crate) fn is_leap_year(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_crash_logger();

    let pty_registry: RegistryState = Arc::new(Mutex::new(PtyRegistry::default()));
    let win_registry: WindowRegistryState = Arc::new(Mutex::new(WindowRegistry::default()));
    let workspace: WorkspaceStateArc = Arc::new(Mutex::new(WorkspaceState::new()));

    tauri::Builder::default()
        .manage(pty_registry)
        .manage(win_registry)
        .manage(workspace)
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
            commands::projects::save_tab_layout,
            commands::projects::clear_project_session,
            commands::projects::root_work_dir,
            commands::projects::projects_root_dir,
            commands::projects::create_project,
            commands::projects::preview_project_scaffold,
            commands::projects::import_project,
            commands::projects::get_time_today,
            commands::projects::detect_agent_session_id,
            // Timer flush + activity
            commands::timer::timer_flush_app,
            commands::timer::timer_flush_project,
            commands::timer::get_project_activity,
            // File tree
            commands::projects::list_dir,
            commands::projects::rename_path,
            commands::projects::delete_file,
            commands::projects::delete_dir,
            commands::projects::create_file,
            commands::projects::create_dir,
            commands::projects::detect_mime,
            // Terminal
            commands::terminal::pty_spawn,
            commands::terminal::pty_write,
            commands::terminal::pty_resize,
            commands::terminal::pty_kill,
            // External apps / window tracking
            commands::apps::launch_app,
            commands::apps::resolve_app_icon,
            commands::apps::open_file,
            commands::apps::list_tracked_windows,
            commands::apps::untrack_window,
            commands::apps::check_pid_alive,
            commands::apps::restore_open_apps,
            // Workspace / network
            commands::workspace::workspace_info,
            commands::workspace::workspace_switch,
            commands::workspace::show_window,
            commands::workspace::hide_window,
            commands::workspace::get_opened_windows,
            commands::workspace::switch_project_windows, // deprecated; use switch_project_runtime
            commands::workspace::workspace_name,
            commands::workspace::network_conn_type,
            // Project-runtime switching (replaces switch_project_windows)
            commands::project_runtime::switch_project_runtime,
            // Downloads
            commands::downloads::update_downloads_symlink,
            commands::downloads::configure_browser_downloads,
            // Ollama local models
            commands::ollama::list_ollama_models,
            commands::ollama::ensure_vibe_ollama_model,
            commands::ollama::prepare_local_agent,
            commands::ollama::ensure_ollama_running,
            // Ollama model management
            commands::ollama::ollama_is_installed,
            commands::ollama::list_ollama_models_detailed,
            commands::ollama::stop_ollama_model,
            commands::ollama::pull_ollama_model,
            commands::ollama::delete_ollama_model,
            commands::ollama::list_installable_models,
        ])
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_leap_year ───────────────────────────────────────────────────────

    #[test]
    fn year_divisible_by_4_is_leap() {
        assert!(is_leap_year(2024));
        assert!(is_leap_year(2000));
        assert!(is_leap_year(1600));
    }

    #[test]
    fn year_divisible_by_100_but_not_400_is_not_leap() {
        assert!(!is_leap_year(1900));
        assert!(!is_leap_year(1800));
        assert!(!is_leap_year(2100));
    }

    #[test]
    fn year_not_divisible_by_4_is_not_leap() {
        assert!(!is_leap_year(2023));
        assert!(!is_leap_year(2025));
        assert!(!is_leap_year(1999));
    }

    #[test]
    fn year_2000_is_leap() {
        assert!(is_leap_year(2000));
    }

    // ── epoch_to_utc ───────────────────────────────────────────────────────

    #[test]
    fn epoch_zero_is_unix_epoch() {
        let (y, mo, d, h, m, s) = epoch_to_utc(0);
        assert_eq!((y, mo, d, h, m, s), (1970, 1, 1, 0, 0, 0));
    }

    #[test]
    fn epoch_midnight_jan_2_1970() {
        let (y, mo, d, h, m, s) = epoch_to_utc(86400);
        assert_eq!((y, mo, d, h, m, s), (1970, 1, 2, 0, 0, 0));
    }

    #[test]
    fn epoch_end_of_1970() {
        // Dec 31 1970 23:59:59 = 86400*365 - 1 = 31535999
        let (y, mo, d, ..) = epoch_to_utc(31535999);
        assert_eq!((y, mo, d), (1970, 12, 31));
    }

    #[test]
    fn epoch_jan_1_2000() {
        // 2000-01-01T00:00:00Z = 946684800
        let (y, mo, d, h, m, s) = epoch_to_utc(946684800);
        assert_eq!((y, mo, d, h, m, s), (2000, 1, 1, 0, 0, 0));
    }

    #[test]
    fn epoch_feb_29_leap_year() {
        // 2000-02-29T00:00:00Z = 951782400
        let (y, mo, d, ..) = epoch_to_utc(951782400);
        assert_eq!((y, mo, d), (2000, 2, 29));
    }

    #[test]
    fn epoch_time_components_are_correct() {
        // 1717414496 = 2024-06-03T11:34:56Z (verified: 1717372800 + 41696)
        let (y, mo, d, h, m, s) = epoch_to_utc(1717414496);
        assert_eq!((y, mo, d), (2024, 6, 3));
        assert_eq!((h, m, s), (11, 34, 56));
    }

    #[test]
    fn epoch_seconds_wrap_at_60() {
        let (_, _, _, _, _, s) = epoch_to_utc(59);
        assert_eq!(s, 59);
        let (_, _, _, _, _, s2) = epoch_to_utc(60);
        assert_eq!(s2, 0);
    }

    #[test]
    fn epoch_minutes_wrap_at_60() {
        let (_, _, _, _, m, _) = epoch_to_utc(3599); // 59m59s
        assert_eq!(m, 59);
        let (_, _, _, _, m2, _) = epoch_to_utc(3600); // 1h0m0s
        assert_eq!(m2, 0);
    }
}
