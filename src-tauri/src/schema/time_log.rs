use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One session record in `~/.local/share/eldrun/time_log.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeLogEntry {
    pub project_id: String,
    /// "YYYY-MM-DD"
    pub date: String,
    /// ISO-8601 timestamp with timezone (e.g. "2026-05-25T21:23:53.674831+00:00")
    pub start_iso: String,
    pub duration_s: f64,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Full `time_log.json` — append-only list of completed sessions.
pub type TimeLog = Vec<TimeLogEntry>;
