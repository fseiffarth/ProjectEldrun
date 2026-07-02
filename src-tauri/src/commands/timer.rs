use std::collections::HashMap;

use crate::schema::time_log;

pub const APP_TIMER_ID: &str = "__eldrun__";

/// Flush elapsed app (Eldrun itself) usage seconds into the time log.
#[tauri::command]
pub fn timer_flush_app(secs: f64) {
    if secs <= 0.0 {
        return;
    }
    time_log::record_secs(APP_TIMER_ID, secs);
}

/// Flush elapsed project session seconds into the time log.
#[tauri::command]
pub fn timer_flush_project(project_id: String, secs: f64) {
    if secs <= 0.0 || project_id.is_empty() {
        return;
    }
    time_log::record_secs(&project_id, secs);
}

/// Returns total seconds per date for the given project_id (or global if empty).
/// Result: { "YYYY-MM-DD" -> total_seconds }
#[tauri::command]
pub fn get_project_activity(project_id: String) -> HashMap<String, f64> {
    time_log::load_summary_migrating().activity_for(&project_id)
}
