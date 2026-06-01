use crate::schema::DefaultApps;
use crate::storage;

#[tauri::command]
pub fn get_default_apps() -> Result<DefaultApps, String> {
    let path = storage::state_dir().join("default_apps.json");
    if !path.exists() {
        return Ok(DefaultApps::default());
    }
    storage::read_json(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_default_apps(default_apps: DefaultApps) -> Result<(), String> {
    let path = storage::state_dir().join("default_apps.json");
    storage::write_json(&path, &default_apps).map_err(|e| e.to_string())
}
