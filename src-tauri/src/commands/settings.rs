use crate::schema::Settings;
use crate::storage;

#[tauri::command]
pub fn get_settings() -> Result<Settings, String> {
    let path = storage::state_dir().join("settings.json");
    if !path.exists() {
        return Ok(Settings::default());
    }
    storage::read_json(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_settings(settings: Settings) -> Result<(), String> {
    let path = storage::state_dir().join("settings.json");
    storage::write_json(&path, &settings).map_err(|e| e.to_string())
}
