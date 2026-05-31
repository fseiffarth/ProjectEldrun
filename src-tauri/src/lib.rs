pub mod commands;
pub mod schema;
pub mod storage;
pub mod terminal;

use std::sync::{Arc, Mutex};
use commands::apps::{WindowRegistry, WindowRegistryState};
use commands::terminal::RegistryState;
use terminal::PtyRegistry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pty_registry: RegistryState = Arc::new(Mutex::new(PtyRegistry::default()));
    let win_registry: WindowRegistryState = Arc::new(Mutex::new(WindowRegistry::default()));

    tauri::Builder::default()
        .manage(pty_registry)
        .manage(win_registry)
        .invoke_handler(tauri::generate_handler![
            // Settings
            commands::settings::get_settings,
            commands::settings::save_settings,
            // Projects
            commands::projects::get_projects,
            commands::projects::save_projects,
            commands::projects::load_project,
            commands::projects::save_project,
            commands::projects::create_project,
            // File tree
            commands::projects::list_dir,
            commands::projects::rename_path,
            commands::projects::delete_file,
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
            commands::apps::open_file,
            commands::apps::list_tracked_windows,
            commands::apps::untrack_window,
            commands::apps::check_pid_alive,
            commands::apps::restore_open_apps,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
