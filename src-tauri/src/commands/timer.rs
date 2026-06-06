use std::collections::HashMap;

use crate::schema::time_log::TimeLogEntry;
use crate::storage;

pub const APP_TIMER_ID: &str = "__eldrun__";

/// Flush elapsed app (Eldrun itself) usage seconds into the time log.
#[tauri::command]
pub fn timer_flush_app(secs: f64) {
    if secs <= 0.0 {
        return;
    }
    flush_secs(APP_TIMER_ID, secs);
}

/// Flush elapsed project session seconds into the time log.
#[tauri::command]
pub fn timer_flush_project(project_id: String, secs: f64) {
    if secs <= 0.0 || project_id.is_empty() {
        return;
    }
    flush_secs(&project_id, secs);
}

/// Returns total seconds per date for the given project_id (or global if empty).
/// Result: { "YYYY-MM-DD" -> total_seconds }
#[tauri::command]
pub fn get_project_activity(project_id: String) -> HashMap<String, f64> {
    let path = storage::state_dir().join("time_log.json");
    if !path.exists() {
        return HashMap::new();
    }
    let log: crate::schema::time_log::TimeLog =
        storage::read_json(&path).unwrap_or_default();
    let mut result: HashMap<String, f64> = HashMap::new();
    for entry in log {
        if project_id.is_empty() || entry.project_id == project_id {
            *result.entry(entry.date).or_insert(0.0) += entry.duration_s;
        }
    }
    result
}

fn flush_secs(project_id: &str, secs: f64) {
    let path = storage::state_dir().join("time_log.json");
    let mut log: crate::schema::time_log::TimeLog = if path.exists() {
        storage::read_json(&path).unwrap_or_default()
    } else {
        vec![]
    };
    log.push(TimeLogEntry {
        project_id: project_id.to_string(),
        date: storage::today_utc(),
        start_iso: storage::iso_now(),
        duration_s: secs,
        extra: HashMap::new(),
    });
    let _ = storage::write_json(&path, &log);
}
