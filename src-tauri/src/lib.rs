pub mod commands;
pub mod schema;
pub mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::projects::get_projects,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
