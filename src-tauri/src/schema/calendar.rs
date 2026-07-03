use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One entry in `~/.local/share/eldrun/calendar.json`.
///
/// A user-authored calendar event. Only `id`, `date`, and `title` carry meaning
/// on their own; `time` is `""` for an all-day event and `notes` is optional.
/// Back-compat: every non-required field defaults, and `extra` flattens any
/// unknown keys so a newer or hand-edited record round-trips without loss.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct CalendarEvent {
    pub id: String,
    /// Day the event is anchored to, as `"YYYY-MM-DD"` (local calendar day).
    pub date: String,
    /// Start time as `"HH:MM"`, or `""` for an all-day event.
    #[serde(default)]
    pub time: String,
    pub title: String,
    /// Free-form notes; omitted from the file when empty.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub notes: String,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Full `calendar.json` — an unordered list of events (the frontend sorts by
/// `date`/`time` for display).
pub type CalendarStore = Vec<CalendarEvent>;
