//! Native calendar — a single global, local store of calendars, events and tasks.
//!
//! Everything lives in `~/.local/share/eldrun/calendar.json` (like `boxes.json`),
//! read/written through the shared `storage` helpers. Reads go through
//! `schema::calendar::CalendarFile`, so a version-1 file (a bare array of
//! start-time-only events) still loads and is migrated on the way in; writes are
//! always the current shape.
//!
//! The CRUD logic is factored onto a `&Path` so the `#[tauri::command]` wrappers
//! stay thin (they just pass `calendar_path()`) and the tests can drive a tempdir.
//!
//! The backend deliberately stays dumb about calendar *semantics*: it does not
//! expand recurrences, evaluate alarms, or parse ICS. Those are pure functions in
//! the frontend (`src/lib/{recurrence,ics,calendarTime}.ts`) where they are cheap
//! to unit-test. This module is storage plus identity.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::commands::projects::uuid_v4;
use crate::schema::calendar::{
    Calendar, CalendarData, CalendarEvent, CalendarFile, CalendarTask, DEFAULT_CALENDAR_ID,
};
use crate::storage;

fn calendar_path() -> PathBuf {
    storage::state_dir().join("calendar.json")
}

/// Read the store, migrating a legacy file in the process. A missing file is an
/// empty calendar, not an error.
fn read_data(path: &Path) -> Result<CalendarData, String> {
    if !path.exists() {
        return Ok(CalendarData::default());
    }
    let file: CalendarFile = storage::read_json(path).map_err(|e| e.to_string())?;
    Ok(file.into_data())
}

fn write_data(path: &Path, data: &CalendarData) -> Result<(), String> {
    storage::write_json(path, data).map_err(|e| e.to_string())
}

/// Mint an id not already present among `existing` (guards against back-to-back
/// time-based `uuid_v4` collisions, mirroring `create_box`).
fn fresh_id(existing: &HashSet<&str>) -> String {
    let mut id = uuid_v4();
    while existing.contains(id.as_str()) {
        id = uuid_v4();
    }
    id
}

fn event_ids(data: &CalendarData) -> HashSet<&str> {
    data.events.iter().map(|e| e.id.as_str()).collect()
}

fn task_ids(data: &CalendarData) -> HashSet<&str> {
    data.tasks.iter().map(|t| t.id.as_str()).collect()
}

fn calendar_ids(data: &CalendarData) -> HashSet<&str> {
    data.calendars.iter().map(|c| c.id.as_str()).collect()
}

// ── Events ──────────────────────────────────────────────────────────────────

/// Insert `event`, minting an id and defaulting its calendar. The caller's `id`
/// is ignored — the store owns identity.
fn create_event_at(path: &Path, mut event: CalendarEvent) -> Result<CalendarEvent, String> {
    let mut data = read_data(path)?;
    event.id = fresh_id(&event_ids(&data));
    if event.calendar_id.is_empty() {
        event.calendar_id = DEFAULT_CALENDAR_ID.to_string();
    }
    data.events.push(event.clone());
    data.normalize();
    write_data(path, &data)?;
    Ok(event)
}

/// Replace the event with `event.id` wholesale.
fn update_event_at(path: &Path, event: CalendarEvent) -> Result<CalendarEvent, String> {
    let mut data = read_data(path)?;
    let slot = data
        .events
        .iter_mut()
        .find(|e| e.id == event.id)
        .ok_or_else(|| format!("event '{}' not found", event.id))?;
    *slot = event.clone();
    data.normalize();
    write_data(path, &data)?;
    Ok(event)
}

fn delete_event_at(path: &Path, id: &str) -> Result<(), String> {
    let mut data = read_data(path)?;
    let before = data.events.len();
    data.events.retain(|e| e.id != id);
    if data.events.len() == before {
        return Err(format!("event '{id}' not found"));
    }
    write_data(path, &data)
}

// ── Tasks ───────────────────────────────────────────────────────────────────

fn create_task_at(path: &Path, mut task: CalendarTask) -> Result<CalendarTask, String> {
    let mut data = read_data(path)?;
    task.id = fresh_id(&task_ids(&data));
    if task.calendar_id.is_empty() {
        task.calendar_id = DEFAULT_CALENDAR_ID.to_string();
    }
    data.tasks.push(task.clone());
    data.normalize();
    write_data(path, &data)?;
    Ok(task)
}

fn update_task_at(path: &Path, task: CalendarTask) -> Result<CalendarTask, String> {
    let mut data = read_data(path)?;
    let slot = data
        .tasks
        .iter_mut()
        .find(|t| t.id == task.id)
        .ok_or_else(|| format!("task '{}' not found", task.id))?;
    *slot = task.clone();
    data.normalize();
    write_data(path, &data)?;
    Ok(task)
}

fn delete_task_at(path: &Path, id: &str) -> Result<(), String> {
    let mut data = read_data(path)?;
    let before = data.tasks.len();
    data.tasks.retain(|t| t.id != id);
    if data.tasks.len() == before {
        return Err(format!("task '{id}' not found"));
    }
    write_data(path, &data)
}

// ── Calendars ───────────────────────────────────────────────────────────────

fn create_calendar_at(path: &Path, mut calendar: Calendar) -> Result<Calendar, String> {
    let mut data = read_data(path)?;
    calendar.id = fresh_id(&calendar_ids(&data));
    data.calendars.push(calendar.clone());
    write_data(path, &data)?;
    Ok(calendar)
}

fn update_calendar_at(path: &Path, calendar: Calendar) -> Result<Calendar, String> {
    let mut data = read_data(path)?;
    let slot = data
        .calendars
        .iter_mut()
        .find(|c| c.id == calendar.id)
        .ok_or_else(|| format!("calendar '{}' not found", calendar.id))?;
    *slot = calendar.clone();
    write_data(path, &data)?;
    Ok(calendar)
}

/// Delete a calendar **and everything filed under it** — the destructive choice,
/// matching what Thunderbird's "Remove calendar" does. Refusing to delete the last
/// calendar keeps `normalize()`'s "at least one calendar" invariant meaningful
/// (otherwise the next read would silently resurrect a default).
fn delete_calendar_at(path: &Path, id: &str) -> Result<(), String> {
    let mut data = read_data(path)?;
    if data.calendars.len() <= 1 {
        return Err("cannot delete the last calendar".to_string());
    }
    let before = data.calendars.len();
    data.calendars.retain(|c| c.id != id);
    if data.calendars.len() == before {
        return Err(format!("calendar '{id}' not found"));
    }
    data.events.retain(|e| e.calendar_id != id);
    data.tasks.retain(|t| t.calendar_id != id);
    write_data(path, &data)
}

// ── ICS file I/O ────────────────────────────────────────────────────────────
//
// Import/export need to touch a path *outside* any project — wherever the user
// pointed the file dialog. The general-purpose `fs::read_file_text` /
// `write_file_text` commands deliberately refuse that: they confine every path to
// the current project's roots, precisely so a compromised renderer cannot read
// `~/.ssh/id_rsa` or overwrite arbitrary files (Security #1). That confinement is
// worth keeping, so instead of widening it these two commands open a much narrower
// door: an iCalendar file, and nothing else.
//
// The guards are the door's width — an extension allowlist (so the path cannot
// name a key, a config, or a document) and a size cap (so a "calendar" cannot be
// used to slurp a huge file into the renderer). Parsing itself stays in the
// frontend (`src/lib/ics.ts`), where it is unit-tested; these only move bytes.

/// Extensions an ICS path may carry. Anything else is refused outright.
const ICS_EXTENSIONS: [&str; 3] = ["ics", "ical", "ifb"];

/// Size cap for an imported/exported calendar (8 MiB — a decade of events is a
/// few hundred KiB, so this is generous while still bounding the read).
const MAX_ICS_BYTES: u64 = 8 * 1024 * 1024;

fn check_ics_path(path: &Path) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !ICS_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "not a calendar file: expected one of {}, got '{}'",
            ICS_EXTENSIONS.join(", "),
            if ext.is_empty() { "no extension" } else { &ext }
        ));
    }
    Ok(())
}

/// Read an `.ics` file the user picked, for the frontend parser.
#[tauri::command]
pub fn calendar_read_ics(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    check_ics_path(&p)?;

    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    if meta.len() > MAX_ICS_BYTES {
        return Err(format!(
            "calendar file too large ({} bytes; limit {MAX_ICS_BYTES})",
            meta.len()
        ));
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

/// Write an `.ics` file to the path the user picked.
#[tauri::command]
pub fn calendar_write_ics(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    check_ics_path(&p)?;
    if content.len() as u64 > MAX_ICS_BYTES {
        return Err("calendar export too large".to_string());
    }
    std::fs::write(&p, content).map_err(|e| e.to_string())
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn calendar_load() -> Result<CalendarData, String> {
    read_data(&calendar_path())
}

/// Replace the whole store. Used by ICS import, which rewrites in bulk.
#[tauri::command]
pub fn calendar_save(data: CalendarData) -> Result<(), String> {
    let mut data = data;
    data.normalize();
    write_data(&calendar_path(), &data)
}

#[tauri::command]
pub fn create_event(event: CalendarEvent) -> Result<CalendarEvent, String> {
    create_event_at(&calendar_path(), event)
}

#[tauri::command]
pub fn update_event(event: CalendarEvent) -> Result<CalendarEvent, String> {
    update_event_at(&calendar_path(), event)
}

#[tauri::command]
pub fn delete_event(id: String) -> Result<(), String> {
    delete_event_at(&calendar_path(), &id)
}

#[tauri::command]
pub fn create_task(task: CalendarTask) -> Result<CalendarTask, String> {
    create_task_at(&calendar_path(), task)
}

#[tauri::command]
pub fn update_task(task: CalendarTask) -> Result<CalendarTask, String> {
    update_task_at(&calendar_path(), task)
}

#[tauri::command]
pub fn delete_task(id: String) -> Result<(), String> {
    delete_task_at(&calendar_path(), &id)
}

#[tauri::command]
pub fn create_calendar(calendar: Calendar) -> Result<Calendar, String> {
    create_calendar_at(&calendar_path(), calendar)
}

#[tauri::command]
pub fn update_calendar(calendar: Calendar) -> Result<Calendar, String> {
    update_calendar_at(&calendar_path(), calendar)
}

#[tauri::command]
pub fn delete_calendar(id: String) -> Result<(), String> {
    delete_calendar_at(&calendar_path(), &id)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("calendar.json");
        (dir, path)
    }

    fn event(title: &str, start: &str, end: &str) -> CalendarEvent {
        CalendarEvent {
            title: title.into(),
            start: start.into(),
            end: end.into(),
            ..Default::default()
        }
    }

    #[test]
    fn read_missing_file_is_an_empty_default_calendar() {
        let (_dir, path) = tmp_path();
        let data = read_data(&path).unwrap();
        assert!(data.events.is_empty());
        assert!(data.tasks.is_empty());
        assert_eq!(data.calendars.len(), 1, "a default calendar always exists");
    }

    #[test]
    fn create_then_read_roundtrips() {
        let (_dir, path) = tmp_path();
        let ev = create_event_at(
            &path,
            event("standup", "2026-07-08T09:00", "2026-07-08T09:15"),
        )
        .unwrap();
        assert!(!ev.id.is_empty());

        let data = read_data(&path).unwrap();
        assert_eq!(data.events.len(), 1);
        assert_eq!(data.events[0].title, "standup");
        assert_eq!(data.events[0].start, "2026-07-08T09:00");
        assert_eq!(data.events[0].end, "2026-07-08T09:15");
        assert_eq!(data.events[0].calendar_id, DEFAULT_CALENDAR_ID);
    }

    #[test]
    fn create_mints_unique_ids_and_ignores_caller_id() {
        let (_dir, path) = tmp_path();
        let mut forged = event("a", "2026-07-08T09:00", "2026-07-08T10:00");
        forged.id = "forged".into();
        let a = create_event_at(&path, forged).unwrap();
        let b = create_event_at(&path, event("b", "2026-07-08T11:00", "2026-07-08T12:00")).unwrap();
        assert_ne!(a.id, "forged", "the store owns identity");
        assert_ne!(a.id, b.id);
        assert_eq!(read_data(&path).unwrap().events.len(), 2);
    }

    #[test]
    fn update_replaces_the_event() {
        let (_dir, path) = tmp_path();
        let ev = create_event_at(&path, event("old", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();

        let mut edited = ev.clone();
        edited.title = "new".into();
        edited.start = "2026-07-09T10:30".into();
        edited.end = "2026-07-09T11:30".into();
        edited.location = "room 2".into();
        let out = update_event_at(&path, edited).unwrap();

        assert_eq!(out.title, "new");
        let data = read_data(&path).unwrap();
        assert_eq!(data.events.len(), 1);
        assert_eq!(data.events[0].title, "new");
        assert_eq!(data.events[0].start, "2026-07-09T10:30");
        assert_eq!(data.events[0].location, "room 2");
    }

    #[test]
    fn update_missing_id_errors() {
        let (_dir, path) = tmp_path();
        let mut ghost = event("x", "2026-07-08T09:00", "2026-07-08T10:00");
        ghost.id = "nope".into();
        assert!(update_event_at(&path, ghost).is_err());
    }

    #[test]
    fn delete_removes_the_event() {
        let (_dir, path) = tmp_path();
        let ev = create_event_at(&path, event("x", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();
        delete_event_at(&path, &ev.id).unwrap();
        assert!(read_data(&path).unwrap().events.is_empty());
    }

    #[test]
    fn delete_missing_id_errors() {
        let (_dir, path) = tmp_path();
        assert!(delete_event_at(&path, "nope").is_err());
    }

    #[test]
    fn task_crud_roundtrips() {
        let (_dir, path) = tmp_path();
        let t = create_task_at(
            &path,
            CalendarTask {
                title: "write plan".into(),
                due: Some("2026-07-10".into()),
                priority: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!t.id.is_empty());

        let mut done = t.clone();
        done.percent = 100;
        done.completed = Some("2026-07-09T12:00".into());
        update_task_at(&path, done).unwrap();

        let data = read_data(&path).unwrap();
        assert_eq!(data.tasks.len(), 1);
        assert_eq!(data.tasks[0].percent, 100);
        assert_eq!(data.tasks[0].completed.as_deref(), Some("2026-07-09T12:00"));

        delete_task_at(&path, &t.id).unwrap();
        assert!(read_data(&path).unwrap().tasks.is_empty());
    }

    #[test]
    fn calendar_crud_roundtrips() {
        let (_dir, path) = tmp_path();
        let cal = create_calendar_at(
            &path,
            Calendar {
                id: String::new(),
                name: "Work".into(),
                color: "#ff0000".into(),
                visible: true,
                readonly: false,
                extra: Default::default(),
            },
        )
        .unwrap();

        let data = read_data(&path).unwrap();
        assert_eq!(data.calendars.len(), 2, "default + Work");

        let mut hidden = cal.clone();
        hidden.visible = false;
        update_calendar_at(&path, hidden).unwrap();
        let data = read_data(&path).unwrap();
        assert!(!data.calendars.iter().find(|c| c.id == cal.id).unwrap().visible);
    }

    #[test]
    fn deleting_a_calendar_takes_its_events_and_tasks_with_it() {
        let (_dir, path) = tmp_path();
        let cal = create_calendar_at(
            &path,
            Calendar {
                id: String::new(),
                name: "Work".into(),
                color: "#ff0000".into(),
                visible: true,
                readonly: false,
                extra: Default::default(),
            },
        )
        .unwrap();

        let mut in_work = event("meeting", "2026-07-08T09:00", "2026-07-08T10:00");
        in_work.calendar_id = cal.id.clone();
        create_event_at(&path, in_work).unwrap();
        create_event_at(&path, event("personal", "2026-07-08T18:00", "2026-07-08T19:00")).unwrap();

        delete_calendar_at(&path, &cal.id).unwrap();

        let data = read_data(&path).unwrap();
        assert_eq!(data.calendars.len(), 1);
        assert_eq!(data.events.len(), 1, "only the Work event is gone");
        assert_eq!(data.events[0].title, "personal");
    }

    #[test]
    fn cannot_delete_the_last_calendar() {
        let (_dir, path) = tmp_path();
        let data = read_data(&path).unwrap();
        let only = data.calendars[0].id.clone();
        // Writing first, so the file exists with exactly one calendar.
        write_data(&path, &data).unwrap();
        assert!(delete_calendar_at(&path, &only).is_err());
    }

    #[test]
    fn legacy_file_migrates_on_read() {
        let (_dir, path) = tmp_path();
        std::fs::write(
            &path,
            r#"[
                {"id":"a","date":"2026-07-08","time":"09:00","title":"standup","notes":"daily"},
                {"id":"b","date":"2026-07-09","time":"","title":"holiday"}
            ]"#,
        )
        .unwrap();

        let data = read_data(&path).unwrap();
        assert_eq!(data.events.len(), 2);

        let standup = data.events.iter().find(|e| e.title == "standup").unwrap();
        assert_eq!(standup.start, "2026-07-08T09:00");
        assert_eq!(standup.end, "2026-07-08T10:00");
        assert!(!standup.all_day);
        assert_eq!(standup.notes, "daily");

        let holiday = data.events.iter().find(|e| e.title == "holiday").unwrap();
        assert!(holiday.all_day);
        assert_eq!(holiday.start, "2026-07-09");
        assert_eq!(holiday.end, "2026-07-10");
    }

    #[test]
    fn legacy_file_is_rewritten_in_the_current_shape() {
        let (_dir, path) = tmp_path();
        std::fs::write(
            &path,
            r#"[{"id":"a","date":"2026-07-08","time":"09:00","title":"standup"}]"#,
        )
        .unwrap();

        // Any write path (here: adding an event) upgrades the file on disk.
        create_event_at(&path, event("new", "2026-07-10T09:00", "2026-07-10T10:00")).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"version\""), "upgraded file carries a version: {raw}");
        let data = read_data(&path).unwrap();
        assert_eq!(data.events.len(), 2, "the migrated event survives the write");
    }

    #[test]
    fn ics_path_guard_accepts_calendar_extensions() {
        for ok in ["a.ics", "a.ical", "a.ifb", "A.ICS"] {
            assert!(check_ics_path(Path::new(ok)).is_ok(), "{ok} should be accepted");
        }
    }

    #[test]
    fn ics_path_guard_refuses_anything_else() {
        // The whole point of the guard: an ICS command must not become a
        // read-any-file primitive.
        for bad in ["id_rsa", "/home/u/.ssh/id_rsa", "notes.txt", "a.ics.txt", "config.toml"] {
            assert!(check_ics_path(Path::new(bad)).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn read_ics_refuses_a_non_ics_path() {
        let (dir, _) = tmp_path();
        let secret = dir.path().join("id_rsa");
        std::fs::write(&secret, "PRIVATE KEY").unwrap();
        let err = calendar_read_ics(secret.to_string_lossy().into_owned());
        assert!(err.is_err(), "a non-.ics path must be refused");
    }

    #[test]
    fn read_ics_roundtrips_a_calendar_file() {
        let (dir, _) = tmp_path();
        let ics = dir.path().join("cal.ics");
        std::fs::write(&ics, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n").unwrap();
        let text = calendar_read_ics(ics.to_string_lossy().into_owned()).unwrap();
        assert!(text.contains("VCALENDAR"));
    }

    #[test]
    fn write_ics_refuses_a_non_ics_path() {
        let (dir, _) = tmp_path();
        let target = dir.path().join("important.conf");
        assert!(calendar_write_ics(
            target.to_string_lossy().into_owned(),
            "x".into()
        )
        .is_err());
        assert!(!target.exists(), "the refused write must not have happened");
    }

    #[test]
    fn empty_optional_fields_are_omitted_from_the_file() {
        let (_dir, path) = tmp_path();
        create_event_at(&path, event("x", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("\"notes\""), "empty notes must be skipped: {raw}");
        assert!(!raw.contains("\"location\""), "empty location must be skipped: {raw}");
        assert!(!raw.contains("\"rrule\""), "absent rrule must be skipped: {raw}");
    }
}
