// TODO #24 (Group F): not yet wired up. This schema models
// `active_session.json`, but nothing in the backend currently writes or reads
// it — full session restore on startup is still open. Keep this comment until
// the read/write path lands so the schema reads honestly.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `~/.local/share/eldrun/active_session.json`.
/// Written when a project becomes active; removed or nulled on clean exit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveSession {
    pub project_id: String,
    /// ISO-8601 timestamp (with timezone offset).
    pub start_real: String,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}
