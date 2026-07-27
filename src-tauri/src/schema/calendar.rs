//! `~/.local/share/eldrun/calendar.json` — the native calendar's on-disk model.
//!
//! The file is an object (`CalendarData`): a list of named calendars, the events
//! filed under them, and the tasks (VTODO-style to-dos). Version 1 of this file
//! was a bare JSON array of start-time-only events; `CalendarFile` still reads
//! that shape and `migrate_legacy` lifts it into the current model, so an
//! existing calendar survives the upgrade untouched. Eldrun always *writes* the
//! current shape.
//!
//! Times are **local wall-clock**, never UTC: `"YYYY-MM-DDTHH:MM"` for a timed
//! event and `"YYYY-MM-DD"` for an all-day one. This keeps "09:00 standup"
//! at 09:00 regardless of the machine's timezone, which is what a personal
//! calendar wants; it is also why no timezone crate is pulled in.
//!
//! Every non-required field defaults and each record keeps an `extra` flatten,
//! so a newer or hand-edited file round-trips without losing keys.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Current `version` written into `calendar.json`.
pub const CALENDAR_VERSION: u32 = 2;

/// Id of the calendar that legacy events (and events with no calendar) land in.
pub const DEFAULT_CALENDAR_ID: &str = "default";

/// Fallback duration for a timed event whose end is missing/invalid — also what a
/// migrated legacy event (which only had a start) gets.
pub const DEFAULT_EVENT_MINUTES: i64 = 60;

// ── Calendars ───────────────────────────────────────────────────────────────

/// One named, colored calendar in the sidebar list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Calendar {
    pub id: String,
    pub name: String,
    /// CSS color the calendar's events render in (e.g. `"#4aa3df"`).
    pub color: String,
    /// Unchecked in the sidebar → its events drop out of every view.
    #[serde(default = "default_true")]
    pub visible: bool,
    /// Read-only calendars (e.g. an imported feed) reject edits in the UI.
    #[serde(default)]
    pub readonly: bool,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

fn default_true() -> bool {
    true
}

impl Calendar {
    /// The calendar every migrated/unfiled event belongs to.
    pub fn default_calendar() -> Self {
        Self {
            id: DEFAULT_CALENDAR_ID.to_string(),
            name: "Personal".to_string(),
            color: "#4aa3df".to_string(),
            visible: true,
            readonly: false,
            extra: HashMap::new(),
        }
    }
}

// ── Recurrence ──────────────────────────────────────────────────────────────

/// How often a recurring event repeats. Mirrors the iCalendar `RRULE` subset
/// Eldrun supports.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Freq {
    #[default]
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

/// A recurrence rule. `until` and `count` are mutually exclusive ends; with
/// neither set the event repeats forever (expansion is always window-bounded, so
/// "forever" is safe).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Rrule {
    pub freq: Freq,
    /// Repeat every N periods. `0` is treated as `1` by the expander.
    #[serde(default = "default_interval")]
    pub interval: u32,
    /// Weekly only: weekdays to fire on, `0`=Sunday … `6`=Saturday. Empty → the
    /// weekday of the event's own start.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub byweekday: Vec<u8>,
    /// Monthly only: day of month (1–31). `None` → the event's own day of month.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bymonthday: Option<u8>,
    /// Inclusive last date (`"YYYY-MM-DD"`) the rule may fire on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    /// Total number of occurrences, counting the first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

fn default_interval() -> u32 {
    1
}

/// A single occurrence edited away from its master ("this event only"). Keyed by
/// the occurrence's *original* start, so it survives edits to its own start.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct EventOverride {
    /// The occurrence's start as the rule generated it — the key.
    pub occurrence_start: String,
    /// Fields that differ from the master; anything absent is inherited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

// ── Alarms ──────────────────────────────────────────────────────────────────

/// A reminder, fired `minutes_before` the occurrence starts. Negative values fire
/// *after* the start (iCalendar allows a positive trigger offset).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Alarm {
    pub minutes_before: i64,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

// ── Events ──────────────────────────────────────────────────────────────────

/// A calendar event.
///
/// `start`/`end` are local wall-clock: `"YYYY-MM-DDTHH:MM"` when timed, or
/// `"YYYY-MM-DD"` when `all_day`. `end` is **exclusive** — following the iCal
/// convention, an all-day event on the 8th has `start: "2026-07-08"` and
/// `end: "2026-07-09"`. A multi-day event is simply one whose `end` lands on a
/// later day than its `start`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct CalendarEvent {
    pub id: String,
    #[serde(default = "default_calendar_id")]
    pub calendar_id: String,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub all_day: bool,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub location: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub notes: String,
    /// Category key; maps to a color in the frontend's category palette.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub category: String,
    /// `"confirmed"` (default) | `"tentative"` | `"cancelled"`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rrule: Option<Rrule>,
    /// Occurrence starts deleted from the series ("this event only" → delete).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exdates: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub overrides: Vec<EventOverride>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alarms: Vec<Alarm>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

fn default_calendar_id() -> String {
    DEFAULT_CALENDAR_ID.to_string()
}

// ── Tasks ───────────────────────────────────────────────────────────────────

/// A to-do (VTODO). `due`/`start` use the same local encoding as events; a task
/// with no `due` simply never appears in the calendar views, only in the task list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct CalendarTask {
    pub id: String,
    #[serde(default = "default_calendar_id")]
    pub calendar_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub notes: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    /// iCalendar priority: `0` = unset, `1` = highest … `9` = lowest.
    #[serde(default)]
    pub priority: u8,
    /// Completion percentage, 0–100. `100` implies done.
    #[serde(default)]
    pub percent: u8,
    /// Local timestamp the task was completed at; `None` while open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub category: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alarms: Vec<Alarm>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

// ── The file ────────────────────────────────────────────────────────────────

/// The whole of `calendar.json` in its current shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CalendarData {
    pub version: u32,
    #[serde(default)]
    pub calendars: Vec<Calendar>,
    #[serde(default)]
    pub events: Vec<CalendarEvent>,
    #[serde(default)]
    pub tasks: Vec<CalendarTask>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

impl Default for CalendarData {
    fn default() -> Self {
        Self {
            version: CALENDAR_VERSION,
            calendars: vec![Calendar::default_calendar()],
            events: Vec::new(),
            tasks: Vec::new(),
            extra: HashMap::new(),
        }
    }
}

impl CalendarData {
    /// Guarantee the invariants every reader relies on: at least one calendar
    /// exists, and every event/task points at a calendar that is actually in the
    /// list (a dangling `calendar_id` — from a hand-edit or a deleted calendar —
    /// is refiled into the default rather than rendering invisibly).
    pub fn normalize(&mut self) {
        self.version = CALENDAR_VERSION;
        if self.calendars.is_empty() {
            self.calendars.push(Calendar::default_calendar());
        }
        let known: Vec<&str> = self.calendars.iter().map(|c| c.id.as_str()).collect();
        let fallback = self.calendars[0].id.clone();
        let orphan = |id: &String| !known.contains(&id.as_str());

        let refile: Vec<usize> = self
            .events
            .iter()
            .enumerate()
            .filter(|(_, e)| orphan(&e.calendar_id))
            .map(|(i, _)| i)
            .collect();
        for i in refile {
            self.events[i].calendar_id = fallback.clone();
        }
        let refile: Vec<usize> = self
            .tasks
            .iter()
            .enumerate()
            .filter(|(_, t)| orphan(&t.calendar_id))
            .map(|(i, _)| i)
            .collect();
        for i in refile {
            self.tasks[i].calendar_id = fallback.clone();
        }
    }
}

/// A version-1 event: a start moment, and nothing else.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct LegacyEvent {
    pub id: String,
    /// `"YYYY-MM-DD"`.
    pub date: String,
    /// `"HH:MM"`, or `""` for an all-day event.
    #[serde(default)]
    pub time: String,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// What `calendar.json` may deserialize as. Untagged, so serde tries the current
/// object shape first and falls back to the version-1 array.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CalendarFile {
    Current(CalendarData),
    Legacy(Vec<LegacyEvent>),
}

impl CalendarFile {
    /// Collapse either on-disk shape into the current model.
    pub fn into_data(self) -> CalendarData {
        let mut data = match self {
            CalendarFile::Current(data) => data,
            CalendarFile::Legacy(events) => migrate_legacy(events),
        };
        data.normalize();
        data
    }
}

/// Lift version-1 events into the current model.
///
/// An all-day legacy event (`time == ""`) becomes a true all-day event spanning
/// its one day (exclusive end = the next day). A timed one gets a
/// `DEFAULT_EVENT_MINUTES` duration, since v1 stored no end. Unknown keys ride
/// along in `extra`.
pub fn migrate_legacy(events: Vec<LegacyEvent>) -> CalendarData {
    let events = events
        .into_iter()
        .map(|old| {
            let all_day = old.time.is_empty();
            let (start, end) = if all_day {
                (old.date.clone(), add_days(&old.date, 1))
            } else {
                let start = format!("{}T{}", old.date, old.time);
                let end = add_minutes(&start, DEFAULT_EVENT_MINUTES);
                (start, end)
            };
            CalendarEvent {
                id: old.id,
                calendar_id: DEFAULT_CALENDAR_ID.to_string(),
                start,
                end,
                all_day,
                title: old.title,
                notes: old.notes,
                extra: old.extra,
                ..Default::default()
            }
        })
        .collect();

    CalendarData {
        version: CALENDAR_VERSION,
        calendars: vec![Calendar::default_calendar()],
        events,
        tasks: Vec::new(),
        extra: HashMap::new(),
    }
}

// ── Date math ───────────────────────────────────────────────────────────────
//
// Just enough civil-date arithmetic to migrate and validate. The frontend owns
// the real calendar math (`src/lib/calendarTime.ts`); this exists so the backend
// never has to parse a date to serve a request.

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(y) => 29,
        2 => 28,
        _ => 30,
    }
}

/// Parse `"YYYY-MM-DD"` (ignoring any `T…` suffix) into `(y, m, d)`.
fn parse_date(s: &str) -> Option<(i32, u32, u32)> {
    let date = s.split('T').next()?;
    let mut parts = date.split('-');
    let y: i32 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    let d: u32 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || d == 0 || d > days_in_month(y, m) {
        return None;
    }
    Some((y, m, d))
}

/// Add `n` days to a `"YYYY-MM-DD"` date, returning the same format. An
/// unparseable input is returned unchanged rather than panicking — a corrupt
/// record should render oddly, not take the app down.
pub fn add_days(date: &str, n: i64) -> String {
    let Some((mut y, mut m, mut d)) = parse_date(date) else {
        return date.to_string();
    };
    let mut left = n;
    while left > 0 {
        let dim = days_in_month(y, m);
        if d < dim {
            d += 1;
        } else {
            d = 1;
            if m == 12 {
                m = 1;
                y += 1;
            } else {
                m += 1;
            }
        }
        left -= 1;
    }
    while left < 0 {
        if d > 1 {
            d -= 1;
        } else {
            if m == 1 {
                m = 12;
                y -= 1;
            } else {
                m -= 1;
            }
            d = days_in_month(y, m);
        }
        left += 1;
    }
    format!("{y:04}-{m:02}-{d:02}")
}

/// Add `n` minutes to a `"YYYY-MM-DDTHH:MM"` timestamp, rolling the date over as
/// needed. An unparseable input is returned unchanged.
pub fn add_minutes(stamp: &str, n: i64) -> String {
    let Some((date, time)) = stamp.split_once('T') else {
        return stamp.to_string();
    };
    let Some((h, mi)) = time.split_once(':') else {
        return stamp.to_string();
    };
    let (Ok(h), Ok(mi)) = (h.parse::<i64>(), mi.parse::<i64>()) else {
        return stamp.to_string();
    };

    let total = h * 60 + mi + n;
    // Euclidean division, so a negative offset rolls back into the previous day.
    let day_shift = total.div_euclid(24 * 60);
    let within = total.rem_euclid(24 * 60);
    let new_date = add_days(date, day_shift);
    format!("{}T{:02}:{:02}", new_date, within / 60, within % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_days_rolls_month_and_year() {
        assert_eq!(add_days("2026-07-08", 1), "2026-07-09");
        assert_eq!(add_days("2026-07-31", 1), "2026-08-01");
        assert_eq!(add_days("2026-12-31", 1), "2027-01-01");
        assert_eq!(add_days("2026-01-01", -1), "2025-12-31");
        assert_eq!(add_days("2026-03-01", -1), "2026-02-28");
    }

    #[test]
    fn add_days_handles_leap_february() {
        assert_eq!(add_days("2024-02-28", 1), "2024-02-29");
        assert_eq!(add_days("2024-03-01", -1), "2024-02-29");
        assert_eq!(add_days("2026-02-28", 1), "2026-03-01");
    }

    #[test]
    fn add_days_leaves_garbage_alone() {
        assert_eq!(add_days("not-a-date", 1), "not-a-date");
    }

    #[test]
    fn add_minutes_rolls_across_midnight() {
        assert_eq!(add_minutes("2026-07-08T09:00", 60), "2026-07-08T10:00");
        assert_eq!(add_minutes("2026-07-08T23:30", 60), "2026-07-09T00:30");
        assert_eq!(add_minutes("2026-07-08T00:15", -30), "2026-07-07T23:45");
        assert_eq!(add_minutes("2026-12-31T23:00", 120), "2027-01-01T01:00");
    }

    #[test]
    fn migrate_timed_legacy_event() {
        let data = migrate_legacy(vec![LegacyEvent {
            id: "a".into(),
            date: "2026-07-08".into(),
            time: "09:00".into(),
            title: "standup".into(),
            notes: "daily".into(),
            extra: HashMap::new(),
        }]);
        assert_eq!(data.version, CALENDAR_VERSION);
        assert_eq!(data.calendars.len(), 1);
        let ev = &data.events[0];
        assert_eq!(ev.start, "2026-07-08T09:00");
        assert_eq!(ev.end, "2026-07-08T10:00");
        assert!(!ev.all_day);
        assert_eq!(ev.title, "standup");
        assert_eq!(ev.notes, "daily");
        assert_eq!(ev.calendar_id, DEFAULT_CALENDAR_ID);
    }

    #[test]
    fn migrate_all_day_legacy_event() {
        let data = migrate_legacy(vec![LegacyEvent {
            id: "a".into(),
            date: "2026-07-08".into(),
            time: String::new(),
            title: "holiday".into(),
            ..Default::default()
        }]);
        let ev = &data.events[0];
        assert!(ev.all_day);
        assert_eq!(ev.start, "2026-07-08");
        // Exclusive end: a one-day all-day event ends on the NEXT day.
        assert_eq!(ev.end, "2026-07-09");
    }

    #[test]
    fn legacy_array_deserializes_through_untagged() {
        let raw = r#"[{"id":"a","date":"2026-07-08","time":"09:00","title":"standup"}]"#;
        let file: CalendarFile = serde_json::from_str(raw).unwrap();
        let data = file.into_data();
        assert_eq!(data.events.len(), 1);
        assert_eq!(data.events[0].start, "2026-07-08T09:00");
    }

    #[test]
    fn current_object_deserializes_through_untagged() {
        let raw = r#"{"version":2,"calendars":[],"events":[],"tasks":[]}"#;
        let file: CalendarFile = serde_json::from_str(raw).unwrap();
        let data = file.into_data();
        // normalize() backfills the default calendar.
        assert_eq!(data.calendars.len(), 1);
        assert_eq!(data.calendars[0].id, DEFAULT_CALENDAR_ID);
    }

    #[test]
    fn normalize_refiles_orphaned_events() {
        let mut data = CalendarData {
            version: CALENDAR_VERSION,
            calendars: vec![Calendar::default_calendar()],
            events: vec![CalendarEvent {
                id: "a".into(),
                calendar_id: "deleted-cal".into(),
                ..Default::default()
            }],
            tasks: vec![CalendarTask {
                id: "t".into(),
                calendar_id: "deleted-cal".into(),
                ..Default::default()
            }],
            extra: HashMap::new(),
        };
        data.normalize();
        assert_eq!(data.events[0].calendar_id, DEFAULT_CALENDAR_ID);
        assert_eq!(data.tasks[0].calendar_id, DEFAULT_CALENDAR_ID);
    }

    #[test]
    fn unknown_keys_round_trip() {
        let raw = r#"{"version":2,"calendars":[],"events":[
            {"id":"a","calendar_id":"default","start":"2026-07-08T09:00",
             "end":"2026-07-08T10:00","title":"x","future_field":"keep me"}
        ],"tasks":[],"top_level_future":"also keep"}"#;
        let data: CalendarFile = serde_json::from_str(raw).unwrap();
        let data = data.into_data();
        let out = serde_json::to_string(&data).unwrap();
        assert!(out.contains("keep me"), "event extra must survive: {out}");
        assert!(out.contains("also keep"), "file extra must survive: {out}");
    }
}
