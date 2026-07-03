//! Native calendar — a single global, local event store.
//!
//! Events live in their own sibling file `~/.local/share/eldrun/calendar.json`
//! (like `boxes.json`), read/written through the shared `storage` helpers. The
//! CRUD logic is factored onto a `&Path` so the `#[tauri::command]` wrappers stay
//! thin (they just pass `calendar_path()`) and the tests can drive a tempdir.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::commands::projects::uuid_v4;
use crate::schema::calendar::{CalendarEvent, CalendarStore};
use crate::storage;

fn calendar_path() -> PathBuf {
    storage::state_dir().join("calendar.json")
}

fn read_events(path: &Path) -> Result<CalendarStore, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    storage::read_json(path).map_err(|e| e.to_string())
}

fn write_events(path: &Path, events: &CalendarStore) -> Result<(), String> {
    storage::write_json(path, events).map_err(|e| e.to_string())
}

/// Mint an id not already present in `events` (guards against back-to-back
/// time-based `uuid_v4` collisions, mirroring `create_box`).
fn fresh_id(events: &CalendarStore) -> String {
    let existing: HashSet<&str> = events.iter().map(|e| e.id.as_str()).collect();
    let mut id = uuid_v4();
    while existing.contains(id.as_str()) {
        id = uuid_v4();
    }
    id
}

fn create_event_at(
    path: &Path,
    date: String,
    time: String,
    title: String,
    notes: String,
) -> Result<CalendarEvent, String> {
    let mut events = read_events(path)?;
    let event = CalendarEvent {
        id: fresh_id(&events),
        date,
        time,
        title,
        notes,
        extra: Default::default(),
    };
    events.push(event.clone());
    write_events(path, &events)?;
    Ok(event)
}

fn update_event_at(
    path: &Path,
    id: String,
    date: String,
    time: String,
    title: String,
    notes: String,
) -> Result<CalendarEvent, String> {
    let mut events = read_events(path)?;
    let target = events
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("event '{id}' not found"))?;
    target.date = date;
    target.time = time;
    target.title = title;
    target.notes = notes;
    let updated = target.clone();
    write_events(path, &events)?;
    Ok(updated)
}

fn delete_event_at(path: &Path, id: String) -> Result<(), String> {
    let mut events = read_events(path)?;
    let before = events.len();
    events.retain(|e| e.id != id);
    if events.len() == before {
        return Err(format!("event '{id}' not found"));
    }
    write_events(path, &events)
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_events() -> Result<CalendarStore, String> {
    read_events(&calendar_path())
}

#[tauri::command]
pub fn save_events(events: CalendarStore) -> Result<(), String> {
    write_events(&calendar_path(), &events)
}

#[tauri::command]
pub fn create_event(
    date: String,
    time: String,
    title: String,
    notes: String,
) -> Result<CalendarEvent, String> {
    create_event_at(&calendar_path(), date, time, title, notes)
}

#[tauri::command]
pub fn update_event(
    id: String,
    date: String,
    time: String,
    title: String,
    notes: String,
) -> Result<CalendarEvent, String> {
    update_event_at(&calendar_path(), id, date, time, title, notes)
}

#[tauri::command]
pub fn delete_event(id: String) -> Result<(), String> {
    delete_event_at(&calendar_path(), id)
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("calendar.json");
        (dir, path)
    }

    #[test]
    fn read_missing_file_is_empty() {
        let (_dir, path) = tmp_path();
        assert_eq!(read_events(&path).unwrap(), Vec::<CalendarEvent>::new());
    }

    #[test]
    fn create_then_read_roundtrips() {
        let (_dir, path) = tmp_path();
        let ev = create_event_at(
            &path,
            "2026-07-08".into(),
            "09:00".into(),
            "standup".into(),
            String::new(),
        )
        .unwrap();
        assert!(!ev.id.is_empty());
        let all = read_events(&path).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title, "standup");
        assert_eq!(all[0].date, "2026-07-08");
        assert_eq!(all[0].time, "09:00");
    }

    #[test]
    fn create_mints_unique_ids() {
        let (_dir, path) = tmp_path();
        let a = create_event_at(&path, "2026-07-08".into(), String::new(), "a".into(), String::new()).unwrap();
        let b = create_event_at(&path, "2026-07-08".into(), String::new(), "b".into(), String::new()).unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(read_events(&path).unwrap().len(), 2);
    }

    #[test]
    fn update_changes_fields() {
        let (_dir, path) = tmp_path();
        let ev = create_event_at(&path, "2026-07-08".into(), "09:00".into(), "old".into(), String::new()).unwrap();
        let up = update_event_at(
            &path,
            ev.id.clone(),
            "2026-07-09".into(),
            "10:30".into(),
            "new".into(),
            "note".into(),
        )
        .unwrap();
        assert_eq!(up.title, "new");
        assert_eq!(up.date, "2026-07-09");
        assert_eq!(up.time, "10:30");
        assert_eq!(up.notes, "note");
        let all = read_events(&path).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title, "new");
    }

    #[test]
    fn update_missing_id_errors() {
        let (_dir, path) = tmp_path();
        let err = update_event_at(&path, "nope".into(), "d".into(), String::new(), "t".into(), String::new());
        assert!(err.is_err());
    }

    #[test]
    fn delete_removes_event() {
        let (_dir, path) = tmp_path();
        let ev = create_event_at(&path, "2026-07-08".into(), String::new(), "x".into(), String::new()).unwrap();
        delete_event_at(&path, ev.id.clone()).unwrap();
        assert_eq!(read_events(&path).unwrap().len(), 0);
    }

    #[test]
    fn delete_missing_id_errors() {
        let (_dir, path) = tmp_path();
        assert!(delete_event_at(&path, "nope".into()).is_err());
    }

    #[test]
    fn empty_notes_omitted_from_file() {
        let (_dir, path) = tmp_path();
        create_event_at(&path, "2026-07-08".into(), String::new(), "x".into(), String::new()).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("notes"), "empty notes must be skipped: {raw}");
    }
}
