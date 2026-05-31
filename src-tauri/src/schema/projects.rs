use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One entry in `~/.local/share/eldrun/projects.json`.
/// Unknown fields are preserved so Python rollback can still read the file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub id: String,
    pub name: String,
    /// "current" | "active" | "inactive"
    pub status: String,
    pub position: i64,
    pub local_file: String,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Full `projects.json` — an ordered list of registered projects.
pub type ProjectsList = Vec<ProjectEntry>;
