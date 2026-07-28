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

use serde::Deserialize;

use crate::commands::projects::uuid_v4;
use crate::schema::calendar::{
    Calendar, CalendarData, CalendarEvent, CalendarFile, CalendarTask, TaskColumn,
    DEFAULT_CALENDAR_ID, RANK_EPSILON, RANK_GAP,
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

/// Write the store **atomically** (temp file + rename), not in place.
///
/// `write_json` truncates the target before writing, so a crash mid-write loses
/// the whole calendar rather than the one edit. That was a narrow window while
/// this file was only touched by a calendar dialog; the todo board writes it on
/// every drag, from a second window as well, which is exactly the situation
/// `write_json_atomic`'s own doc describes.
fn write_data(path: &Path, data: &CalendarData) -> Result<(), String> {
    storage::write_json_atomic(path, data).map_err(|e| e.to_string())
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

/// Pull a task back out of the normalized store.
///
/// Both writers below return **this**, not the caller's record: `normalize` files
/// a new card into a column, mints its rank, and reconciles a completed one into
/// the Done column, so the caller's pre-normalize copy is a different task from
/// the one now on disk. Returning it would leave the frontend holding a card with
/// no column (which does not render) or in the column it just left.
fn normalized_task(data: &CalendarData, id: &str) -> Result<CalendarTask, String> {
    data.tasks
        .iter()
        .find(|t| t.id == id)
        .cloned()
        .ok_or_else(|| format!("task '{id}' vanished during normalize"))
}

fn create_task_at(path: &Path, mut task: CalendarTask) -> Result<CalendarTask, String> {
    let mut data = read_data(path)?;
    task.id = fresh_id(&task_ids(&data));
    if task.calendar_id.is_empty() {
        task.calendar_id = DEFAULT_CALENDAR_ID.to_string();
    }
    let id = task.id.clone();
    data.tasks.push(task);
    data.normalize();
    write_data(path, &data)?;
    normalized_task(&data, &id)
}

fn update_task_at(path: &Path, task: CalendarTask) -> Result<CalendarTask, String> {
    let mut data = read_data(path)?;
    let id = task.id.clone();
    let slot = data
        .tasks
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("task '{id}' not found"))?;
    *slot = task;
    data.normalize();
    write_data(path, &data)?;
    normalized_task(&data, &id)
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

// ── Todo board ──────────────────────────────────────────────────────────────
//
// The board is the calendar's tasks seen as cards; everything it needs to *read*
// it gets from `calendar_load`, and everything it needs to *edit one card* it
// gets from `create_task`/`update_task`/`delete_task`. Only two gestures need
// their own command, and for the same reason in both cases: they change several
// records at once, and doing that as N round trips over a file that is rewritten
// in full each time would let a concurrent edit land in the middle.

/// One card's target position after a drag.
#[derive(Debug, Clone, Deserialize)]
pub struct TaskPlacement {
    pub id: String,
    /// Target column id. An unknown one is refiled by `normalize` rather than
    /// refused — a drag that reports success and does nothing is worse than one
    /// that lands somewhere predictable.
    pub column: String,
    /// 0-based position within `column` **after** the move, counting only the
    /// cards that end up there. Anything past the end appends.
    pub index: u32,
    /// Local wall-clock stamp to use when this move *completes* the task, minted
    /// by the frontend exactly as the Tasks view's checkbox already mints one
    /// (this crate has no clock that speaks local time). Ignored when the target
    /// is not the done column, or when the task already carries a stamp.
    #[serde(default)]
    pub completed_stamp: Option<String>,
}

/// Order the cards of one column as the board shows them: by rank ascending,
/// with `id` as the tie-break so a hand-edited file with duplicate ranks is
/// stable rather than shuffling on every read.
fn column_order(data: &CalendarData, column: &str, exclude: &str) -> Vec<(String, f64)> {
    let mut rows: Vec<(String, f64)> = data
        .tasks
        .iter()
        .filter(|t| t.column == column && t.id != exclude)
        .map(|t| (t.id.clone(), t.rank.unwrap_or(f64::MAX)))
        .collect();
    rows.sort_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    rows
}

/// Apply a drag: one file write, whatever it moved.
///
/// The frontend sends an **index**, never a rank. That keeps the rank algebra —
/// bisect, the too-close-to-split guard, the whole-column reindex — in one tested
/// place, and it makes the command idempotent: replaying the same placements is a
/// no-op, because a card already at the requested index keeps the rank it has.
///
/// Returns every task whose `column`, `rank`, `percent` or `completed` changed,
/// which is a superset of `moves` whenever a reindex fired or the done coupling
/// completed a card. The frontend merges those into its store rather than
/// reloading the whole calendar.
fn move_tasks_at(path: &Path, moves: Vec<TaskPlacement>) -> Result<Vec<CalendarTask>, String> {
    let mut data = read_data(path)?;
    // The first drag is what creates the board — a *read* deliberately never
    // does, so a calendar-only user's file never grows board state.
    data.ensure_board();
    data.normalize();
    let before: Vec<CalendarTask> = data.tasks.clone();

    let done_col: Option<String> = data
        .task_columns
        .iter()
        .find(|c| c.done)
        .map(|c| c.id.clone());
    let mut touched: Vec<String> = Vec::new();

    for placement in moves {
        let Some(current) = data.tasks.iter().find(|t| t.id == placement.id) else {
            return Err(format!("task '{}' not found", placement.id));
        };
        let from_column = current.column.clone();
        let target = placement.column.clone();

        let siblings = column_order(&data, &target, &placement.id);
        let index = (placement.index as usize).min(siblings.len());

        // Where the card sits in the target column *today*, if it is already
        // there — the check that makes a replay a no-op.
        let settled = from_column == target && {
            let full = column_order(&data, &target, "");
            full.iter().position(|(id, _)| id == &placement.id) == Some(index)
        };

        let new_rank = if settled {
            None
        } else {
            let before_rank = index.checked_sub(1).and_then(|i| siblings.get(i)).map(|s| s.1);
            let after_rank = siblings.get(index).map(|s| s.1);
            Some(match (before_rank, after_rank) {
                (None, None) => RANK_GAP,
                (Some(b), None) => b + RANK_GAP,
                (None, Some(a)) => a - RANK_GAP,
                (Some(b), Some(a)) => (b + a) / 2.0,
            })
        };

        let Some(task) = data.tasks.iter_mut().find(|t| t.id == placement.id) else {
            unreachable!("presence checked above");
        };
        task.column = target.clone();
        if let Some(rank) = new_rank {
            task.rank = Some(rank);
        }

        // The done coupling, applied here so the record hits disk consistent —
        // `normalize` would otherwise see a card in Done with percent 0 and move
        // it straight back out.
        if let Some(done_id) = &done_col {
            if &target == done_id {
                task.percent = 100;
                if task.completed.is_none() {
                    task.completed = placement.completed_stamp.clone();
                }
            } else if &from_column == done_id && task.percent >= 100 {
                // Not `percent = 99`: the Tasks view derives done from
                // `percent >= 100`, so leaving the stamp would show the card as
                // done in the calendar and in progress on the board.
                task.percent = 0;
                task.completed = None;
            }
        }

        for col in [from_column, target] {
            if !touched.contains(&col) {
                touched.push(col);
            }
        }
    }

    // Reindex any column whose ranks got too close to split again. Normally free
    // (nothing is close), and cheap even when it fires: every write rewrites the
    // whole file, so N changed ranks cost what one costs.
    for col in touched {
        let order = column_order(&data, &col, "");
        let collapsed = order
            .windows(2)
            .any(|w| (w[1].1 - w[0].1).abs() < RANK_EPSILON);
        if !collapsed {
            continue;
        }
        for (i, (id, _)) in order.iter().enumerate() {
            if let Some(task) = data.tasks.iter_mut().find(|t| &t.id == id) {
                task.rank = Some((i + 1) as f64 * RANK_GAP);
            }
        }
    }

    data.normalize();
    write_data(path, &data)?;

    let changed: Vec<CalendarTask> = data
        .tasks
        .iter()
        .filter(|now| {
            before
                .iter()
                .find(|was| was.id == now.id)
                .is_none_or(|was| {
                    was.column != now.column
                        || was.rank != now.rank
                        || was.percent != now.percent
                        || was.completed != now.completed
                })
        })
        .cloned()
        .collect();
    Ok(changed)
}

/// Replace the board's column list: add, rename, recolor, reorder, delete.
///
/// Wholesale rather than a create/update/delete triple, because a *reorder* is the
/// common edit and would otherwise be N round trips over a file rewritten in full
/// each time — and because deleting a column has to refile its cards in the same
/// write, which a generic `delete_column(id)` cannot express.
///
/// `fallback_column` receives the cards of every column that disappeared. `None`
/// clears their placement instead and lets `normalize` file them, which is the
/// better default: a *completed* card then lands in Done rather than being dumped
/// into the leftmost column with its checkbox still ticked.
fn columns_set_at(
    path: &Path,
    columns: Vec<TaskColumn>,
    fallback_column: Option<String>,
) -> Result<CalendarData, String> {
    if columns.is_empty() {
        // The twin of "cannot delete the last calendar": with no columns there is
        // nowhere to put a card, and the next read would silently resurrect the
        // default set — which reads as "my board reset itself".
        return Err("cannot delete the last column".to_string());
    }
    let mut data = read_data(path)?;
    data.ensure_board();

    let mut seen: HashSet<String> = HashSet::new();
    let mut columns = columns;
    for col in columns.iter_mut() {
        if col.id.is_empty() || seen.contains(&col.id) {
            let taken: HashSet<&str> = seen.iter().map(|s| s.as_str()).collect();
            col.id = fresh_id(&taken);
        }
        seen.insert(col.id.clone());
    }

    let fallback = fallback_column.filter(|id| seen.contains(id));
    for task in data.tasks.iter_mut() {
        if !task.column.is_empty() && !seen.contains(&task.column) {
            task.column = fallback.clone().unwrap_or_default();
            task.rank = None;
        }
    }
    data.task_columns = columns;

    data.normalize();
    write_data(path, &data)?;
    Ok(data)
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

/// Apply a board drag. See [`move_tasks_at`].
#[tauri::command]
pub fn todo_move_tasks(moves: Vec<TaskPlacement>) -> Result<Vec<CalendarTask>, String> {
    move_tasks_at(&calendar_path(), moves)
}

/// Replace the board's columns. See [`columns_set_at`].
#[tauri::command]
pub fn todo_columns_set(
    columns: Vec<TaskColumn>,
    fallback_column: Option<String>,
) -> Result<CalendarData, String> {
    columns_set_at(&calendar_path(), columns, fallback_column)
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
        assert!(!raw.contains("\"column\""), "board fields must be skipped: {raw}");
        assert!(!raw.contains("\"task_columns\""), "unused board must be skipped: {raw}");
    }

    // ── Todo board ──────────────────────────────────────────────────────────

    /// Give the store a board, as the first drag or column edit would. Creating a
    /// task deliberately does *not* — `create_task` is also the calendar Tasks
    /// view's write path, and a plain to-do must not conjure a board.
    fn seed_board(path: &Path) {
        let mut data = read_data(path).unwrap();
        data.ensure_board();
        data.normalize();
        write_data(path, &data).unwrap();
    }

    fn card(path: &Path, title: &str) -> CalendarTask {
        seed_board(path);
        create_task_at(
            path,
            CalendarTask {
                title: title.into(),
                ..Default::default()
            },
        )
        .unwrap()
    }

    fn place(id: &str, column: &str, index: u32) -> TaskPlacement {
        TaskPlacement {
            id: id.into(),
            column: column.into(),
            index,
            completed_stamp: Some("2026-07-28T12:00".into()),
        }
    }

    /// The ids of one column, top to bottom, as the board would draw them.
    fn order_of(path: &Path, column: &str) -> Vec<String> {
        let data = read_data(path).unwrap();
        column_order(&data, column, "")
            .into_iter()
            .map(|(id, _)| id)
            .collect()
    }

    #[test]
    fn create_task_returns_the_normalized_record() {
        let (_dir, path) = tmp_path();
        let t = card(&path, "fresh");
        assert_eq!(t.column, "backlog", "a new card must come back placed");
        assert!(t.rank.is_some(), "a new card must come back ranked");
    }

    #[test]
    fn update_task_returns_the_reconciled_record() {
        let (_dir, path) = tmp_path();
        let t = card(&path, "t");
        let out = update_task_at(
            &path,
            CalendarTask {
                percent: 100,
                ..t
            },
        )
        .unwrap();
        assert_eq!(out.column, "done", "ticking must return the moved card");
    }

    #[test]
    fn move_places_at_the_requested_index() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        let b = card(&path, "b");
        let c = card(&path, "c");
        assert_eq!(order_of(&path, "backlog"), vec![a.id.clone(), b.id.clone(), c.id.clone()]);

        // c to the top.
        move_tasks_at(&path, vec![place(&c.id, "backlog", 0)]).unwrap();
        assert_eq!(order_of(&path, "backlog"), vec![c.id.clone(), a.id.clone(), b.id.clone()]);

        // a to the middle.
        move_tasks_at(&path, vec![place(&a.id, "backlog", 1)]).unwrap();
        assert_eq!(order_of(&path, "backlog"), vec![c.id.clone(), a.id.clone(), b.id.clone()]);

        // c past the end appends.
        move_tasks_at(&path, vec![place(&c.id, "backlog", 999)]).unwrap();
        assert_eq!(order_of(&path, "backlog"), vec![a.id, b.id, c.id]);
    }

    #[test]
    fn move_across_columns_is_one_write() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        let b = card(&path, "b");
        let changed = move_tasks_at(
            &path,
            vec![place(&a.id, "doing", 0), place(&b.id, "doing", 0)],
        )
        .unwrap();
        assert_eq!(changed.len(), 2);
        assert_eq!(order_of(&path, "doing"), vec![b.id, a.id]);
        assert!(order_of(&path, "backlog").is_empty());
    }

    #[test]
    fn move_is_idempotent() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        let b = card(&path, "b");
        move_tasks_at(&path, vec![place(&b.id, "doing", 0)]).unwrap();
        let after_first = read_data(&path).unwrap();

        let changed = move_tasks_at(&path, vec![place(&b.id, "doing", 0)]).unwrap();
        assert!(changed.is_empty(), "a replayed placement changes nothing");
        assert_eq!(read_data(&path).unwrap(), after_first);
        assert_eq!(order_of(&path, "backlog"), vec![a.id]);
    }

    #[test]
    fn move_reindexes_when_ranks_collide() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        let b = card(&path, "b");
        // Force two ranks too close to split.
        let mut data = read_data(&path).unwrap();
        for t in data.tasks.iter_mut() {
            t.rank = Some(if t.id == a.id { 1.0 } else { 1.0 + 1e-9 });
        }
        write_data(&path, &data).unwrap();

        let c = card(&path, "c");
        move_tasks_at(&path, vec![place(&c.id, "backlog", 1)]).unwrap();

        let data = read_data(&path).unwrap();
        for t in data.tasks.iter() {
            let rank = t.rank.unwrap();
            assert_eq!(
                rank % RANK_GAP,
                0.0,
                "a collapsed column is reindexed to clean multiples, got {rank}"
            );
        }
        assert_eq!(order_of(&path, "backlog"), vec![a.id, c.id, b.id]);
    }

    #[test]
    fn dropping_on_done_completes_and_dragging_out_uncompletes() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");

        move_tasks_at(&path, vec![place(&a.id, "done", 0)]).unwrap();
        let data = read_data(&path).unwrap();
        assert_eq!(data.tasks[0].percent, 100);
        assert_eq!(data.tasks[0].completed.as_deref(), Some("2026-07-28T12:00"));

        move_tasks_at(&path, vec![place(&a.id, "doing", 0)]).unwrap();
        let data = read_data(&path).unwrap();
        assert_eq!(data.tasks[0].percent, 0);
        assert_eq!(data.tasks[0].completed, None, "the stamp must go too");
        assert_eq!(data.tasks[0].column, "doing");
    }

    #[test]
    fn move_returns_every_changed_task_not_just_the_dragged_one() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        let b = card(&path, "b");
        let mut data = read_data(&path).unwrap();
        for t in data.tasks.iter_mut() {
            t.rank = Some(if t.id == a.id { 1.0 } else { 1.0 + 1e-9 });
        }
        write_data(&path, &data).unwrap();

        let c = card(&path, "c");
        let changed = move_tasks_at(&path, vec![place(&c.id, "backlog", 1)]).unwrap();
        let ids: HashSet<&str> = changed.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(a.id.as_str()) && ids.contains(b.id.as_str()));
    }

    #[test]
    fn move_refiles_an_unknown_target_column_rather_than_refusing() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        move_tasks_at(&path, vec![place(&a.id, "no-such-column", 0)]).unwrap();
        assert_eq!(read_data(&path).unwrap().tasks[0].column, "backlog");
    }

    #[test]
    fn columns_set_refiles_the_cards_of_a_deleted_column() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        move_tasks_at(&path, vec![place(&a.id, "doing", 0)]).unwrap();

        let kept: Vec<TaskColumn> = read_data(&path)
            .unwrap()
            .task_columns
            .into_iter()
            .filter(|c| c.id != "doing")
            .collect();
        let data = columns_set_at(&path, kept, None).unwrap();
        assert_eq!(data.tasks[0].column, "backlog");
        assert!(!data.task_columns.iter().any(|c| c.id == "doing"));
    }

    #[test]
    fn columns_set_honours_an_explicit_fallback() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        move_tasks_at(&path, vec![place(&a.id, "doing", 0)]).unwrap();
        let kept: Vec<TaskColumn> = read_data(&path)
            .unwrap()
            .task_columns
            .into_iter()
            .filter(|c| c.id != "doing")
            .collect();
        let data = columns_set_at(&path, kept, Some("today".into())).unwrap();
        assert_eq!(data.tasks[0].column, "today");
    }

    #[test]
    fn columns_set_refuses_an_empty_list() {
        let (_dir, path) = tmp_path();
        card(&path, "a");
        assert!(columns_set_at(&path, Vec::new(), None).is_err());
        assert_eq!(
            read_data(&path).unwrap().task_columns.len(),
            4,
            "the refused edit must leave the board alone"
        );
    }

    /// The other half of the lazy-seeding rule, at the command layer: a to-do
    /// created from the calendar's Tasks view must not grow board state.
    #[test]
    fn creating_a_task_does_not_create_a_board() {
        let (_dir, path) = tmp_path();
        create_task_at(
            &path,
            CalendarTask {
                title: "plain".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let data = read_data(&path).unwrap();
        assert!(data.task_columns.is_empty());
        assert!(data.tasks[0].column.is_empty());
    }

    #[test]
    fn columns_set_preserves_a_renamed_columns_cards() {
        let (_dir, path) = tmp_path();
        let a = card(&path, "a");
        move_tasks_at(&path, vec![place(&a.id, "doing", 0)]).unwrap();

        let renamed: Vec<TaskColumn> = read_data(&path)
            .unwrap()
            .task_columns
            .into_iter()
            .map(|mut c| {
                if c.id == "doing" {
                    c.name = "In flight".into();
                }
                c
            })
            .collect();
        let data = columns_set_at(&path, renamed, None).unwrap();
        assert_eq!(data.tasks[0].column, "doing", "a rename must not move a card");
        assert!(data.task_columns.iter().any(|c| c.name == "In flight"));
    }

    #[test]
    fn columns_set_mints_ids_for_new_columns() {
        let (_dir, path) = tmp_path();
        let mut columns = read_data(&path).unwrap().task_columns;
        columns.push(TaskColumn {
            id: String::new(),
            name: "Blocked".into(),
            position: 9,
            ..Default::default()
        });
        let data = columns_set_at(&path, columns, None).unwrap();
        let added = data.task_columns.iter().find(|c| c.name == "Blocked").unwrap();
        assert!(!added.id.is_empty(), "a new column must be given an id");
    }

    /// The mail tripwire, mirrored: no board command may take a filesystem path.
    /// The two ICS commands are the documented exception — they exist precisely
    /// to open a narrow, extension-checked door to a user-picked file.
    #[test]
    fn no_todo_command_takes_a_path() {
        let src = include_str!("calendar.rs");
        for line in src.lines() {
            let line = line.trim();
            if !line.starts_with("pub fn todo_") {
                continue;
            }
            assert!(
                !line.contains("path"),
                "a todo command must not take a path: {line}"
            );
        }
    }
}
