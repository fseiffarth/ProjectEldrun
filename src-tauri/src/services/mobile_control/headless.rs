//! Answers for the phone with no desktop window open (headless owner plan,
//! H0).
//!
//! The persisted-state request kinds — the to-do board, a calendar month, a
//! tab's schedules, a project's collected prompts and an agent transcript —
//! are read straight from the state dir and shaped exactly as the desktop's
//! `MobileBridgeHost` shapes them, opaque ids included (same host key, same
//! domains), so a phone that read a board through the window and reads it
//! again through this module sees the same ids. `host.rs` reaches for these
//! only once the desktop's control socket reported the window closed.
//!
//! Read-only by construction: nothing here writes a state file, so the
//! sidecar never becomes a second writer of `calendar.json` or
//! `agent_tasks.json`.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use chrono::{DateTime, Local};

use super::discovery::{key_id, ResolvedTab};
use super::protocol::{
    MobileCalendarEvent, MobileCalendarInfo, MobileCalendarSnapshot, TodoBoardSnapshot,
    TodoCalendar, TodoCard, TodoColumn, TodoProject, TodoSubtask,
};
use crate::schema::agent_prompts::ProjectAgentPrompt;
use crate::schema::agent_tasks::{AgentScheduleRule, ScheduledAgentPrompt};
use crate::schema::calendar::{Calendar, CalendarData};
use crate::services::agent_transcript::{self, AgentTranscript, DEFAULT_LIMIT};
use crate::services::calendar_recurrence::{expand_events, month_window};
use crate::services::todo_board::{board_columns, column_of, fallback_column_id};
use crate::services::{agent_prompts, agent_tasks, schedule_mcp};
use crate::storage;

/// The desktop's cap on one month answer (`MOBILE_CALENDAR_EVENTS`).
const MOBILE_CALENDAR_EVENTS: usize = 80;

/// The category keys with a colour of their own (`calendarCategories.ts`).
const CATEGORY_KEYS: &[&str] = &["work", "personal", "meeting", "travel", "birthday", "holiday", "important"];

fn calendar_data(state_dir: &Path) -> Result<CalendarData, String> {
    crate::commands::calendar::read_data(&state_dir.join("calendar.json"))
}

/// `boundedText`: at most `max_bytes`, cut on a character boundary.
fn bounded(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn extra_string(extra: &std::collections::HashMap<String, serde_json::Value>, key: &str) -> bool {
    extra.get(key).and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty())
}

/// `eventColor` over `calendarColor`: a known category's own swatch, else the
/// calendar's colour, else the accent.
fn event_color(category: &str, calendars: &[Calendar], calendar_id: &str) -> String {
    if CATEGORY_KEYS.contains(&category) {
        return format!("var(--cal-cat-{category})");
    }
    calendars
        .iter()
        .find(|c| c.id == calendar_id)
        .map(|c| c.color.clone())
        .unwrap_or_else(|| "var(--accent)".to_string())
}

// ── To-do board ─────────────────────────────────────────────────────────────

/// The board as `todoSnapshot` publishes it. `today` is the desktop-local
/// `"YYYY-MM-DD"` (or a full stamp) the date columns are read against.
pub fn todo_board(state_dir: &Path, host_key: &[u8], today: &str) -> Result<TodoBoardSnapshot, String> {
    let data = calendar_data(state_dir)?;
    let columns = board_columns(&data.task_columns);
    let intake = fallback_column_id(&columns);
    let id = |domain: &str, value: &str| key_id(host_key, domain, &[value]);
    Ok(TodoBoardSnapshot {
        columns: columns
            .iter()
            .map(|column| TodoColumn {
                id: column.id.clone(),
                name: column.name.clone(),
                position: column.position,
                done: column.done,
                archived: column.archived,
                intake: column.id == intake,
                overdue: column.overdue,
                due_today: column.due_today,
                color: (!column.color.is_empty()).then(|| column.color.clone()),
            })
            .collect(),
        tasks: data
            .tasks
            .iter()
            .map(|task| TodoCard {
                id: id("task", &task.id),
                title: task.title.clone(),
                column: column_of(task, &columns, today),
                done: task.percent >= 100,
                due: task.due.clone().filter(|d| !d.is_empty()),
                notes: Some(task.notes.clone()),
                priority: task.priority,
                percent: task.percent,
                rank: task.rank,
                calendar_id: id("calendar", &task.calendar_id),
                project_id: (!task.project_id.is_empty()).then(|| id("project", &task.project_id)),
                tags: task.tags.clone(),
                subtasks: task
                    .subtasks
                    .iter()
                    .map(|step| TodoSubtask { id: id("subtask", &step.id), title: step.title.clone(), done: step.done })
                    .collect(),
            })
            .collect(),
        calendars: data
            .calendars
            .iter()
            .map(|entry| TodoCalendar { id: id("calendar", &entry.id), name: entry.name.clone() })
            .collect(),
        projects: project_names(state_dir)
            .into_iter()
            .map(|(raw, name)| TodoProject { id: id("project", &raw), name })
            .collect(),
    })
}

/// Every registered project's `(id, name)`, in registry order — what the
/// board's project chips resolve against. Tolerant of any registry shape:
/// an entry without both strings is simply not offered.
fn project_names(state_dir: &Path) -> Vec<(String, String)> {
    let Ok(bytes) = std::fs::read(state_dir.join("projects.json")) else {
        return Vec::new();
    };
    let Ok(rows) = serde_json::from_slice::<Vec<serde_json::Value>>(&bytes) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?;
            let name = row.get("name")?.as_str()?;
            Some((id.to_string(), name.to_string()))
        })
        .collect()
}

// ── Calendar month ──────────────────────────────────────────────────────────

/// A validated `YYYY-MM` as `(year, month)`.
fn parse_month(month: &str) -> Option<(i32, u32)> {
    if month.len() != 7 || !month.is_ascii() {
        return None;
    }
    let (year, mon) = month.split_once('-')?;
    let year: i32 = year.parse().ok()?;
    let mon: u32 = mon.parse().ok()?;
    ((1000..=9999).contains(&year) && (1..=12).contains(&mon)).then_some((year, mon))
}

/// The month as `calendarSnapshot` publishes it: the six-week grid's window,
/// visible calendars only, recurrence expanded, at most
/// [`MOBILE_CALENDAR_EVENTS`] occurrences.
pub fn calendar_month(state_dir: &Path, host_key: &[u8], month: &str) -> Result<MobileCalendarSnapshot, String> {
    let (year, mon) = parse_month(month).ok_or_else(|| "invalid_month".to_string())?;
    let data = calendar_data(state_dir)?;
    let week_start = calendar_week_start(state_dir);
    let (window_start, window_end) = month_window(year, mon, u32::from(week_start), 6);
    let visible: HashSet<String> = data.calendars.iter().filter(|c| c.visible).map(|c| c.id.clone()).collect();
    let occurrences = expand_events(&data.events, &window_start, &window_end, Some(&visible));
    let shown = &occurrences[..occurrences.len().min(MOBILE_CALENDAR_EVENTS)];
    let id = |domain: &str, value: &str| key_id(host_key, domain, &[value]);
    let optional = |value: &str, max: usize| (!value.is_empty()).then(|| bounded(value, max));
    Ok(MobileCalendarSnapshot {
        month: month.to_string(),
        week_start,
        calendars: data
            .calendars
            .iter()
            .map(|entry| MobileCalendarInfo {
                id: id("calendar", &entry.id),
                name: bounded(&entry.name, 160),
                color: bounded(&entry.color, 64),
                visible: entry.visible,
                readonly: entry.readonly,
                // Only the fact: a feed URL routinely embeds a private token.
                subscribed: extra_string(&entry.extra, "source_url"),
                caldav: extra_string(&entry.extra, "caldav_account_id"),
            })
            .collect(),
        truncated: occurrences.len() > shown.len(),
        events: shown
            .iter()
            .map(|occurrence| {
                let color = bounded(&event_color(&occurrence.category, &data.calendars, &occurrence.calendar_id), 32);
                MobileCalendarEvent {
                    id: id("event", &occurrence.event_id),
                    calendar_id: id("calendar", &occurrence.calendar_id),
                    occurrence_start: bounded(&occurrence.occurrence_start, 32),
                    start: bounded(&occurrence.start, 32),
                    end: bounded(&occurrence.end, 32),
                    all_day: occurrence.all_day,
                    title: bounded(&occurrence.title, 240),
                    location: optional(&occurrence.location, 160),
                    notes: optional(&occurrence.notes, 16 * 1024),
                    conference: optional(&occurrence.conference, 2_000),
                    category: optional(&occurrence.category, 80),
                    color: if color.is_empty() { "#7c6cff".to_string() } else { color },
                    status: (occurrence.status == "cancelled").then(|| "cancelled".to_string()),
                    recurring: occurrence.recurring,
                }
            })
            .collect(),
    })
}

/// The desktop's week-start preference: 0 = Sunday, otherwise Monday.
fn calendar_week_start(state_dir: &Path) -> u8 {
    let settings: Option<crate::schema::Settings> = storage::read_json(&state_dir.join("settings.json")).ok();
    match settings.and_then(|s| s.calendar_week_start) {
        Some(0) => 0,
        _ => 1,
    }
}

// ── Schedules and prompts ───────────────────────────────────────────────────

/// One tab's schedules as the desktop answers `Schedules`.
#[derive(Debug, Clone)]
pub struct TabSchedules {
    pub schedules: Vec<ScheduledAgentPrompt>,
    pub time_zone: String,
    pub next_runs: BTreeMap<String, String>,
}

/// `schedulesFor` off the file: the rows filed under the tab's binding, with
/// each enabled rule's next desktop-local occurrence.
pub fn schedules(
    state_dir: &Path,
    project_id: &str,
    schedule_target_id: &str,
    now: DateTime<Local>,
) -> Result<TabSchedules, String> {
    let schedules = agent_tasks::list_at(state_dir, project_id, schedule_target_id)?;
    let next_runs = schedules
        .iter()
        .filter_map(|schedule| next_run_key(schedule, now).map(|key| (schedule.id.clone(), key)))
        .collect();
    Ok(TabSchedules { schedules, time_zone: local_time_zone(), next_runs })
}

/// `nextScheduleOccurrence`'s key: a disabled rule has none, a one-time rule
/// that already ran has none, otherwise the next `YYYY-MM-DDTHH:MM` at or
/// after `now`.
pub fn next_run_key(schedule: &ScheduledAgentPrompt, now: DateTime<Local>) -> Option<String> {
    if !schedule.enabled {
        return None;
    }
    if let AgentScheduleRule::Once { at } = &schedule.rule {
        if schedule.last.is_some() {
            return None;
        }
        let wall = schedule_mcp::next_occurrence(&schedule.rule, now)?;
        return (wall >= now).then(|| at.clone());
    }
    schedule_mcp::next_occurrence(&schedule.rule, now).map(|at| at.format("%Y-%m-%dT%H:%M").to_string())
}

/// `promptsFor` off the file.
pub fn prompts(state_dir: &Path, project_id: &str) -> Result<Vec<ProjectAgentPrompt>, String> {
    agent_prompts::list_at(state_dir, project_id)
}

// ── Transcript ──────────────────────────────────────────────────────────────

/// The agents whose transcript Eldrun reads at all (`TRANSCRIPT_AGENTS`).
const TRANSCRIPT_AGENTS: &[&str] = &["claude", "codex", "opencode"];

/// `agentTranscriptFor` off the tab record: the same two "not yet" answers
/// (`no_session` for a transcript family whose hook has not recorded a
/// session yet, `unsupported` for the rest), then the CLI's own transcript.
/// Without a window there is no launch time, so an OpenCode tab reads its
/// folder's newest session.
pub fn transcript(
    project_id: &str,
    tab: &ResolvedTab,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: Option<usize>,
) -> AgentTranscript {
    let Some(session_id) = tab.session_id.as_deref().filter(|id| !id.is_empty()) else {
        let reason = if TRANSCRIPT_AGENTS.contains(&tab.cmd.as_str()) { "no_session" } else { "unsupported" };
        return AgentTranscript::unavailable(reason);
    };
    agent_transcript::agent_session_transcript(
        &tab.cmd,
        Some(project_id),
        Some(&tab.cwd),
        None,
        session_id,
        subagent,
        version,
        limit.unwrap_or(DEFAULT_LIMIT),
    )
}

// ── Time zone ───────────────────────────────────────────────────────────────

/// `desktopTimeZone` for a process with no `Intl`: the IANA name from `TZ`,
/// `/etc/timezone`, or the `/etc/localtime` link, else `"local"` — the
/// frontend's own fallback.
pub fn local_time_zone() -> String {
    if let Some(zone) = std::env::var("TZ").ok().and_then(|tz| zone_name(&tz)) {
        return zone;
    }
    #[cfg(unix)]
    {
        if let Some(zone) = std::fs::read_to_string("/etc/timezone").ok().and_then(|text| zone_name(text.trim())) {
            return zone;
        }
        if let Some(zone) = std::fs::read_link("/etc/localtime").ok().and_then(|target| zone_from_localtime_target(&target)) {
            return zone;
        }
    }
    "local".to_string()
}

/// An IANA `Area/City` name, or nothing: a POSIX rule string (`CET-1CEST`)
/// or a `:`-prefixed path is not one the phone can show.
fn zone_name(value: &str) -> Option<String> {
    let value = value.trim().trim_start_matches(':');
    let ok = !value.is_empty()
        && value.contains('/')
        && !value.starts_with('/')
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-' | b'+'));
    ok.then(|| value.to_string())
}

/// `…/zoneinfo/Europe/Berlin` → `Europe/Berlin`.
fn zone_from_localtime_target(target: &Path) -> Option<String> {
    let text = target.to_string_lossy();
    let (_, zone) = text.rsplit_once("zoneinfo/")?;
    zone_name(zone)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::calendar::{create_event_at, create_task_at};
    use crate::schema::calendar::{CalendarEvent, CalendarTask, Freq, Rrule};

    const KEY: [u8; 32] = [7u8; 32];

    fn state_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("state dir")
    }

    #[test]
    fn the_board_is_published_from_the_file_with_the_desktops_ids() {
        let dir = state_dir();
        std::fs::write(
            dir.path().join("projects.json"),
            r#"[{"id":"p1","name":"Thesis","status":"active","position":0,"local_file":"x"},{"id":"broken"}]"#,
        )
        .unwrap();
        let calendar = dir.path().join("calendar.json");
        let late = create_task_at(
            &calendar,
            CalendarTask {
                title: "late".into(),
                due: Some("2026-07-01".into()),
                project_id: "p1".into(),
                subtasks: vec![crate::schema::calendar::Subtask { id: "s1".into(), title: "step".into(), ..Default::default() }],
                ..Default::default()
            },
        )
        .unwrap();
        let done = create_task_at(&calendar, CalendarTask { title: "done".into(), percent: 100, ..Default::default() }).unwrap();

        let board = todo_board(dir.path(), &KEY, "2026-07-08").unwrap();
        let ids: Vec<&str> = board.columns.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["overdue", "today", "doing", "backlog", "done", "archived"], "a fresh file shows the default board");
        assert!(board.columns.iter().find(|c| c.id == "backlog").unwrap().intake);
        assert_eq!(board.projects.len(), 1, "an entry without both strings is not offered");
        assert_eq!(board.projects[0].id, key_id(&KEY, "project", &["p1"]));
        assert_eq!(board.projects[0].name, "Thesis");
        let card = board.tasks.iter().find(|t| t.title == "late").unwrap();
        assert_eq!(card.id, key_id(&KEY, "task", &[&late.id]), "the same opaque id the desktop mints");
        assert_eq!(card.column, "overdue", "routed by today's date");
        assert_eq!(card.project_id.as_deref(), Some(key_id(&KEY, "project", &["p1"]).as_str()));
        assert_eq!(card.subtasks[0].id, key_id(&KEY, "subtask", &["s1"]));
        assert!(!card.id.contains(&late.id), "raw ids never cross");
        let finished = board.tasks.iter().find(|t| t.title == "done").unwrap();
        assert!(finished.done);
        assert_eq!(finished.column, "done");
        assert_eq!(finished.id, key_id(&KEY, "task", &[&done.id]));
        assert_eq!(board.calendars.len(), 1);
    }

    #[test]
    fn a_missing_calendar_file_is_an_empty_board_not_an_error() {
        let dir = state_dir();
        let board = todo_board(dir.path(), &KEY, "2026-07-08").unwrap();
        assert!(board.tasks.is_empty());
        assert_eq!(board.columns.len(), 6);
        assert!(board.projects.is_empty());
    }

    #[test]
    fn the_month_is_expanded_over_visible_calendars_only() {
        let dir = state_dir();
        std::fs::write(dir.path().join("settings.json"), r#"{"calendar_week_start":0}"#).unwrap();
        let calendar = dir.path().join("calendar.json");
        let standup = create_event_at(
            &calendar,
            CalendarEvent {
                title: "standup".into(),
                start: "2026-07-06T09:00".into(),
                end: "2026-07-06T09:15".into(),
                category: "work".into(),
                rrule: Some(Rrule { freq: Freq::Weekly, interval: 1, ..Default::default() }),
                ..Default::default()
            },
        )
        .unwrap();
        let hidden = crate::commands::calendar::create_calendar_at(
            &calendar,
            Calendar { id: String::new(), name: "Hidden".into(), color: "#000".into(), visible: false, readonly: false, rev: 0, extra: Default::default() },
        )
        .unwrap();
        create_event_at(
            &calendar,
            CalendarEvent { title: "secret".into(), calendar_id: hidden.id.clone(), start: "2026-07-10".into(), end: "2026-07-11".into(), all_day: true, ..Default::default() },
        )
        .unwrap();

        let month = calendar_month(dir.path(), &KEY, "2026-07").unwrap();
        assert_eq!(month.week_start, 0, "the desktop's preference");
        assert_eq!(month.month, "2026-07");
        assert!(!month.truncated);
        let titles: Vec<&str> = month.events.iter().map(|e| e.title.as_str()).collect();
        assert!(titles.iter().all(|t| *t == "standup"), "{titles:?}");
        // A Sunday-start six-week grid for July 2026 runs Jun 28 – Aug 8; the
        // series begins Jul 6, so five Mondays fall in it.
        assert_eq!(month.events.len(), 5);
        assert_eq!(month.events[0].start, "2026-07-06T09:00");
        assert_eq!(month.events[0].id, key_id(&KEY, "event", &[&standup.id]));
        assert_eq!(month.events[0].color, "var(--cal-cat-work)");
        assert!(month.events[0].recurring);
        let hidden_row = month.calendars.iter().find(|c| c.name == "Hidden").unwrap();
        assert!(!hidden_row.visible);
        assert_eq!(hidden_row.id, key_id(&KEY, "calendar", &[&hidden.id]));
        assert_eq!(calendar_month(dir.path(), &KEY, "2026-13").unwrap_err(), "invalid_month");
    }

    #[test]
    fn schedules_and_prompts_come_off_their_files_with_next_runs() {
        let dir = state_dir();
        std::fs::write(
            dir.path().join("agent_tasks.json"),
            r#"{"version":1,"projects":{"p1":{"tgt":{"schedules":[
                {"id":"daily","enabled":true,"message":"tick","rule":{"type":"daily","time":"09:00"}},
                {"id":"off","enabled":false,"message":"never","rule":{"type":"daily","time":"09:00"}},
                {"id":"done","enabled":true,"message":"ran","rule":{"type":"once","at":"2026-07-01T09:00"},"last":{"occurrence":"2026-07-01T09:00","result":"delivered","at":"2026-07-01T09:00:00Z"}}
            ]}}}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("agent_prompts.json"),
            r#"{"version":1,"projects":{"p1":[{"id":"pr1","message":"write the intro","created_at":"2026-07-01T09:00:00Z","updated_at":"2026-07-01T09:00:00Z"}]}}"#,
        )
        .unwrap();
        let now = Local.with_ymd_and_hms(2026, 7, 8, 10, 0, 0).unwrap();
        let listed = schedules(dir.path(), "p1", "tgt", now).unwrap();
        assert_eq!(listed.schedules.len(), 3);
        assert_eq!(listed.next_runs.get("daily").map(String::as_str), Some("2026-07-09T09:00"));
        assert!(!listed.next_runs.contains_key("off"), "a disabled rule has no next run");
        assert!(!listed.next_runs.contains_key("done"), "a one-time rule that ran has none");
        assert!(!listed.time_zone.is_empty());
        assert!(schedules(dir.path(), "p1", "other", now).unwrap().schedules.is_empty());
        assert_eq!(prompts(dir.path(), "p1").unwrap()[0].message, "write the intro");
        assert!(prompts(dir.path(), "p2").unwrap().is_empty());
        // Nothing was written back.
        assert!(std::fs::read_to_string(dir.path().join("agent_tasks.json")).unwrap().contains("\"never\""));
    }

    use chrono::TimeZone;

    fn tab(cmd: &str, session_id: Option<&str>) -> ResolvedTab {
        ResolvedTab {
            public: super::super::discovery::PublicTab {
                id: "t".into(),
                label: "tab".into(),
                kind: "agent".into(),
                agent_label: None,
                agent_status: None,
                agent_model: None,
                agent_plan: false,
                agent_goal: false,
                working_at: None,
                done_at: None,
                schedules: None,
                prompts: Vec::new(),
                available: false,
                viewer_busy: false,
                last_activity: None,
                color: None,
                sign_in: false,
            },
            tmux_name: concat!(crate::app_slug!(), "-x").into(),
            session_id: session_id.map(str::to_string),
            schedule_target_id: None,
            cmd: cmd.into(),
            cwd: "/nowhere".into(),
        }
    }

    #[test]
    fn a_transcript_answers_the_same_not_yet_reasons_as_the_window() {
        assert_eq!(transcript("p1", &tab("claude", None), None, None, None).reason.as_deref(), Some("no_session"));
        assert_eq!(transcript("p1", &tab("bash", None), None, None, None).reason.as_deref(), Some("unsupported"));
        let unread = transcript("p1", &tab("claude", Some("no-such-session")), None, None, Some(5));
        assert!(!unread.available);
        assert!(unread.reason.is_some());
    }

    #[test]
    fn time_zone_names_are_iana_or_local() {
        assert_eq!(zone_name("Europe/Berlin").as_deref(), Some("Europe/Berlin"));
        assert_eq!(zone_name(":America/New_York").as_deref(), Some("America/New_York"));
        assert_eq!(zone_name("CET-1CEST,M3.5.0,M10.5.0/3"), None, "a POSIX rule is not a name");
        assert_eq!(zone_name("/etc/x"), None);
        assert_eq!(zone_from_localtime_target(Path::new("/usr/share/zoneinfo/Europe/Berlin")).as_deref(), Some("Europe/Berlin"));
        assert_eq!(zone_from_localtime_target(Path::new("../usr/share/zoneinfo/Etc/UTC")).as_deref(), Some("Etc/UTC"));
        assert_eq!(zone_from_localtime_target(Path::new("/etc/localtime.bak")), None);
        assert!(!local_time_zone().is_empty());
    }
}
