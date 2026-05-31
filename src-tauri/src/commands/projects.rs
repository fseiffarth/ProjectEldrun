use crate::schema::projects::ProjectsList;
use crate::storage;

#[tauri::command]
pub fn get_projects() -> Result<ProjectsList, String> {
    let path = storage::state_dir().join("projects.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    storage::read_json(&path).map_err(|e| e.to_string())
}
