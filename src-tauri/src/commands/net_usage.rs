use std::collections::HashMap;

use crate::schema::net_usage::{self, ByteCounts};

/// Per-date SSH-link byte totals for `project_id` (or every project when empty).
/// Result: `{ "YYYY-MM-DD" -> { rx, tx } }`, from which the Network Traffic tab
/// derives today / this-month / overall. Recording is internal (driven by the
/// `services::net_usage` sampler), so there is no companion write command —
/// mirrors `commands::timer::get_project_activity`.
#[tauri::command]
pub fn get_net_usage(project_id: String) -> HashMap<String, ByteCounts> {
    net_usage::load().activity_for(&project_id)
}
