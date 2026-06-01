pub mod commands;
pub mod platform;
pub mod schema;
pub mod storage;
pub mod terminal;

use std::sync::{Arc, Mutex};
use commands::apps::{WindowRegistry, WindowRegistryState};
use commands::terminal::RegistryState;
use commands::workspace::{WorkspaceState, WorkspaceStateArc};
use terminal::PtyRegistry;

/// Install a panic hook that writes a crash log under the pinned state dir.
fn install_crash_logger() {
    let state_dir = storage::state_dir();
    std::panic::set_hook(Box::new(move |info| {
        let msg = format!(
            "{}\nbacktrace: {:?}\n",
            info,
            std::backtrace::Backtrace::capture()
        );
        let path = state_dir.join("crash.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            use std::io::Write;
            let _ = writeln!(f, "=== {} ===\n{}", chrono_utc_now(), msg);
        }
        eprintln!("{msg}");
    }));
}

fn chrono_utc_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
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
            commands::projects::root_work_dir,
            commands::projects::projects_root_dir,
            commands::projects::create_project,
            commands::projects::import_project,
            commands::projects::get_time_today,
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
            commands::workspace::workspace_name,
            commands::workspace::network_conn_type,
            // Downloads
            commands::downloads::update_downloads_symlink,
            commands::downloads::configure_browser_downloads,
        ])
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
