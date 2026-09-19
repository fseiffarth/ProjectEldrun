use std::{
    collections::{BTreeMap, HashSet},
    sync::{Mutex, OnceLock},
};

use crate::{
    schema::agent_tasks::{
        AgentPromptTarget, AgentScheduleLastRun, AgentScheduleResult, AgentScheduleRule,
        AgentScheduleTargetBinding, AgentTasksFile, ScheduledAgentPrompt,
    },
    storage,
};

const FILE_NAME: &str = "agent_tasks.json";
const MAX_SCHEDULES: usize = 32;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;
/// A preface is a short list of the agent's own slash commands, not a second
/// message channel: each entry is one line, must be a command, and there are
/// only ever a handful. The caps are here rather than in the UI because the
/// mobile sidecar writes the same file.
pub const MAX_PREFACE_COMMANDS: usize = 6;
pub const MAX_PREFACE_BYTES: usize = 256;
const MAX_ID_BYTES: usize = 256;
const SCHEDULE_TARGET_KEY: &str = "scheduleTargetId";

static LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

fn path() -> std::path::PathBuf {
    storage::state_dir().join(FILE_NAME)
}

fn read() -> Result<AgentTasksFile, String> {
    let path = path();
    if !path.exists() {
        return Ok(AgentTasksFile::default());
    }
    storage::read_json(&path).map_err(|e| format!("read {FILE_NAME}: {e}"))
}

fn write(file: &AgentTasksFile) -> Result<(), String> {
    std::fs::create_dir_all(storage::state_dir())
        .map_err(|e| format!("create state directory: {e}"))?;
    storage::write_json_atomic(&path(), file).map_err(|e| format!("write {FILE_NAME}: {e}"))
}

pub(crate) fn validate_id(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_ID_BYTES || value.chars().any(char::is_control) {
        return Err(format!("invalid {label}"));
    }
    Ok(())
}

fn parse_date_time(value: &str) -> Option<(i32, u32, u32, u32, u32)> {
    if value.len() != 16
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
        || value.as_bytes().get(10) != Some(&b'T')
        || value.as_bytes().get(13) != Some(&b':')
    {
        return None;
    }
    let year = value[0..4].parse().ok()?;
    let month = value[5..7].parse().ok()?;
    let day = value[8..10].parse().ok()?;
    let hour = value[11..13].parse().ok()?;
    let minute = value[14..16].parse().ok()?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    (day >= 1 && day <= days && hour <= 23 && minute <= 59)
        .then_some((year, month, day, hour, minute))
}

fn valid_time(value: &str) -> bool {
    value.len() == 5
        && value.as_bytes().get(2) == Some(&b':')
        && value[0..2].parse::<u8>().is_ok_and(|v| v <= 23)
        && value[3..5].parse::<u8>().is_ok_and(|v| v <= 59)
}

fn validate_rule(rule: &AgentScheduleRule) -> Result<(), String> {
    match rule {
        AgentScheduleRule::Once { at } if parse_date_time(at).is_none() => {
            Err("invalid one-time date/time".into())
        }
        AgentScheduleRule::Daily { time } if !valid_time(time) => Err("invalid time".into()),
        AgentScheduleRule::Weekdays { weekdays, time } => {
            if !valid_time(time)
                || weekdays.is_empty()
                || weekdays.len() > 7
                || weekdays.iter().any(|day| !(1..=7).contains(day))
                || weekdays.iter().collect::<HashSet<_>>().len() != weekdays.len()
            {
                return Err("invalid weekday schedule".into());
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

pub(crate) fn sanitize_message(message: &str) -> String {
    let normalized = message.replace("\r\n", "\n").replace('\r', "\n");
    normalized
        .chars()
        .filter(|ch| *ch == '\n' || (!ch.is_control() && *ch != '\u{7f}'))
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// One preface entry, sanitized. A slash command occupies its whole line, so an
/// entry carrying a newline is a composition error rather than something to
/// silently join; requiring the leading `/` is what keeps the preface a list of
/// *commands* the agent interprets and not a back door for extra prompt text
/// submitted outside the message the user reviewed.
pub(crate) fn validate_preface_command(command: &str) -> Result<String, String> {
    let clean = sanitize_message(command);
    let clean = clean.trim().to_string();
    if clean.is_empty() {
        return Err("prefix command is empty".into());
    }
    if clean.contains('\n') {
        return Err("a prefix command must be a single line".into());
    }
    if !clean.starts_with('/') {
        return Err("a prefix command must start with \"/\"".into());
    }
    if clean.len() > MAX_PREFACE_BYTES {
        return Err(format!(
            "prefix command exceeds {MAX_PREFACE_BYTES} bytes"
        ));
    }
    Ok(clean)
}

pub(crate) fn validate_preface(preface: Vec<String>) -> Result<Vec<String>, String> {
    if preface.len() > MAX_PREFACE_COMMANDS {
        return Err(format!(
            "a prompt may carry at most {MAX_PREFACE_COMMANDS} prefix commands"
        ));
    }
    preface
        .iter()
        .map(|command| validate_preface_command(command))
        .collect()
}

fn validate_prompt(mut prompt: ScheduledAgentPrompt) -> Result<ScheduledAgentPrompt, String> {
    validate_id("schedule id", &prompt.id)?;
    validate_rule(&prompt.rule)?;
    prompt.preface = validate_preface(std::mem::take(&mut prompt.preface))?;
    prompt.message = sanitize_message(&prompt.message);
    if prompt.message.trim().is_empty() {
        return Err("scheduled prompt is empty".into());
    }
    if prompt.message.len() > MAX_MESSAGE_BYTES {
        return Err(format!(
            "scheduled prompt exceeds {MAX_MESSAGE_BYTES} bytes"
        ));
    }
    if let Some(last) = &prompt.last {
        if parse_date_time(&last.occurrence).is_none() {
            return Err("invalid last occurrence".into());
        }
    }
    Ok(prompt)
}

fn target_mut<'a>(
    file: &'a mut AgentTasksFile,
    project_id: &str,
    target_id: &str,
) -> &'a mut AgentPromptTarget {
    file.projects
        .entry(project_id.to_string())
        .or_default()
        .entry(target_id.to_string())
        .or_default()
}

pub fn list(project_id: &str, target_id: &str) -> Result<Vec<ScheduledAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("schedule target id", target_id)?;
    let _guard = lock();
    Ok(read()?
        .projects
        .get(project_id)
        .and_then(|project| project.get(target_id))
        .map(|target| target.schedules.clone())
        .unwrap_or_default())
}

/// The refusal an edit of an existing rule gets when the rule it was drawn
/// from is no longer there to edit: the id is gone, or it is a one-time rule
/// that has already been delivered. Exact strings — the frontend matches them.
pub const SCHEDULE_GONE_ERROR: &str = "schedule_gone";
/// The refusal when a delivery of the rule is claimed and not yet complete.
pub const SCHEDULE_BUSY_ERROR: &str = "schedule_busy";

/// Whether `schedule_id` on `target_id` is still a rule an editor may move or
/// drop. An editor holds the rule as it was when it was drawn, and the
/// scheduler may have delivered and retired it since: re-creating it then
/// makes a fresh, unclaimed rule under the same id, and the prompt goes out a
/// second time. A recurring rule with a receipt is still live — only a
/// one-time rule is finished by its receipt — but no rule is while a claim on
/// it is outstanding, because `claim` is the only at-most-once check there is.
fn check_live(
    file: &AgentTasksFile,
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
) -> Result<(), String> {
    let Some(target) = file
        .projects
        .get(project_id)
        .and_then(|project| project.get(target_id))
    else {
        return Err(SCHEDULE_GONE_ERROR.into());
    };
    let Some(rule) = target.schedules.iter().find(|item| item.id == schedule_id) else {
        return Err(SCHEDULE_GONE_ERROR.into());
    };
    if matches!(rule.rule, AgentScheduleRule::Once { .. }) && rule.last.is_some() {
        return Err(SCHEDULE_GONE_ERROR.into());
    }
    if target.claims.contains_key(schedule_id) {
        return Err(SCHEDULE_BUSY_ERROR.into());
    }
    Ok(())
}

/// Pure core of [`upsert`]. `expect_existing_on` names the target the edited
/// rule must still be live on ([`check_live`]); the write itself goes to
/// `target_id`, which differs from it when a rule moves to another tab.
fn apply_upsert(
    file: &mut AgentTasksFile,
    project_id: &str,
    target_id: &str,
    prompt: ScheduledAgentPrompt,
    expect_existing_on: Option<&str>,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    if let Some(source) = expect_existing_on {
        check_live(file, project_id, source, &prompt.id)?;
    }
    let target = target_mut(file, project_id, target_id);
    match target
        .schedules
        .iter()
        .position(|item| item.id == prompt.id)
    {
        Some(index) => {
            // Receipts are runner-owned; an editor may change the rule/message
            // but cannot erase at-most-once history by omitting `last`.
            let mut next = prompt;
            next.last = target.schedules[index].last.clone();
            target.schedules[index] = next;
        }
        None => {
            if target.schedules.len() >= MAX_SCHEDULES {
                return Err(format!("a tab may have at most {MAX_SCHEDULES} schedules"));
            }
            target.schedules.push(prompt);
        }
    }
    Ok(target.schedules.clone())
}

/// Write a rule. With `expect_existing_on` set, an edit of an existing rule is
/// refused with [`SCHEDULE_GONE_ERROR`] or [`SCHEDULE_BUSY_ERROR`] instead of
/// re-creating a rule the scheduler already delivered or is delivering; the
/// phone and every plain create pass `None` and behave as before.
pub fn upsert(
    project_id: &str,
    target_id: &str,
    mut prompt: ScheduledAgentPrompt,
    expect_existing_on: Option<&str>,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("schedule target id", target_id)?;
    if let Some(source) = expect_existing_on {
        validate_id("schedule target id", source)?;
    }
    // Delivery receipts belong exclusively to claim/complete. Neither a new
    // schedule nor an editor request may manufacture one at the CRUD boundary.
    prompt.last = None;
    let prompt = validate_prompt(prompt)?;
    let _guard = lock();
    let mut file = read()?;
    let result = apply_upsert(&mut file, project_id, target_id, prompt, expect_existing_on)?;
    write(&file)?;
    Ok(result)
}

/// Pure core of [`delete`]; `expect_undelivered` refuses as [`check_live`] does.
fn apply_delete(
    file: &mut AgentTasksFile,
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
    expect_undelivered: bool,
) -> Result<(), String> {
    if expect_undelivered {
        check_live(file, project_id, target_id, schedule_id)?;
    }
    if let Some(target) = file
        .projects
        .get_mut(project_id)
        .and_then(|project| project.get_mut(target_id))
    {
        target.schedules.retain(|item| item.id != schedule_id);
        target.claims.remove(schedule_id);
    }
    prune_empty(file);
    Ok(())
}

pub fn delete(
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
    expect_undelivered: bool,
) -> Result<(), String> {
    validate_id("project id", project_id)?;
    validate_id("schedule target id", target_id)?;
    validate_id("schedule id", schedule_id)?;
    let _guard = lock();
    let mut file = read()?;
    apply_delete(&mut file, project_id, target_id, schedule_id, expect_undelivered)?;
    write(&file)
}

pub fn delete_target(project_id: &str, target_id: &str) -> Result<(), String> {
    validate_id("project id", project_id)?;
    validate_id("schedule target id", target_id)?;
    let _guard = lock();
    let mut file = read()?;
    if let Some(project) = file.projects.get_mut(project_id) {
        project.remove(target_id);
    }
    prune_empty(&mut file);
    write(&file)
}

pub fn claim(
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
    occurrence: &str,
) -> Result<bool, String> {
    validate_id("project id", project_id)?;
    validate_id("schedule target id", target_id)?;
    validate_id("schedule id", schedule_id)?;
    if parse_date_time(occurrence).is_none() {
        return Err("invalid occurrence".into());
    }
    let _guard = lock();
    let mut file = read()?;
    let Some(target) = file
        .projects
        .get_mut(project_id)
        .and_then(|project| project.get_mut(target_id))
    else {
        return Ok(false);
    };
    let Some(prompt) = target.schedules.iter().find(|item| item.id == schedule_id) else {
        return Ok(false);
    };
    if !prompt.enabled
        || prompt
            .last
            .as_ref()
            .is_some_and(|last| last.occurrence.as_str() >= occurrence)
        || target
            .claims
            .get(schedule_id)
            .is_some_and(|value| value == occurrence)
    {
        return Ok(false);
    }
    target
        .claims
        .insert(schedule_id.to_string(), occurrence.to_string());
    write(&file)?;
    Ok(true)
}

pub fn complete(
    project_id: &str,
    target_id: &str,
    schedule_id: &str,
    occurrence: &str,
    result: AgentScheduleResult,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("schedule target id", target_id)?;
    validate_id("schedule id", schedule_id)?;
    if parse_date_time(occurrence).is_none() {
        return Err("invalid occurrence".into());
    }
    let _guard = lock();
    let mut file = read()?;
    let target = file
        .projects
        .get_mut(project_id)
        .and_then(|project| project.get_mut(target_id))
        .ok_or_else(|| "scheduled prompt target no longer exists".to_string())?;
    if target.claims.get(schedule_id).map(String::as_str) != Some(occurrence) {
        return Err("scheduled occurrence was not claimed".into());
    }
    let prompt = target
        .schedules
        .iter_mut()
        .find(|item| item.id == schedule_id)
        .ok_or_else(|| "scheduled prompt no longer exists".to_string())?;
    prompt.last = Some(AgentScheduleLastRun {
        occurrence: occurrence.to_string(),
        result,
        at: storage::iso_now(),
    });
    target.claims.remove(schedule_id);
    let schedules = target.schedules.clone();
    write(&file)?;
    Ok(schedules)
}

fn prune_empty(file: &mut AgentTasksFile) {
    for project in file.projects.values_mut() {
        project.retain(|_, target| !target.schedules.is_empty() || !target.claims.is_empty());
    }
    file.projects.retain(|_, project| !project.is_empty());
}

fn saved_bindings(file: &AgentTasksFile) -> HashSet<(String, String)> {
    let mut result = HashSet::new();
    for project_id in file.projects.keys() {
        let session = crate::services::terminal_service::load_terminal_session(project_id);
        // project-tree-read: ok — this loader is keyed by project id and reads
        // only the authoritative state-dir session copy, never the project export.
        for tab in session.tab_layout {
            let Some(target_id) = tab
                .extra
                .get(SCHEDULE_TARGET_KEY)
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            let kind = tab.extra.get("kind").and_then(serde_json::Value::as_str);
            let resumable = tab.session_id.is_some()
                || tab
                    .extra
                    .get("resumeArgs")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|args| !args.is_empty());
            if matches!(kind, Some("agent") | Some("local_agent")) && resumable {
                result.insert((project_id.clone(), target_id.to_string()));
            }
        }
    }
    result
}

pub fn cleanup_orphans(live: &[AgentScheduleTargetBinding]) -> Result<usize, String> {
    let _guard = lock();
    let mut file = read()?;
    let mut keep = saved_bindings(&file);
    keep.extend(
        live.iter()
            .map(|item| (item.project_id.clone(), item.schedule_target_id.clone())),
    );
    let before: usize = file.projects.values().map(BTreeMap::len).sum();
    for (project_id, project) in &mut file.projects {
        project.retain(|target_id, _| keep.contains(&(project_id.clone(), target_id.clone())));
    }
    prune_empty(&mut file);
    let after: usize = file.projects.values().map(BTreeMap::len).sum();
    if after != before {
        write(&file)?;
    }
    Ok(before - after)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizer_preserves_newlines_and_drops_terminal_controls() {
        assert_eq!(
            sanitize_message("one\r\ntwo\u{1b}[31m\u{7f}"),
            "one\ntwo[31m"
        );
    }

    #[test]
    fn strict_rules_reject_duplicate_or_out_of_range_weekdays() {
        assert!(validate_rule(&AgentScheduleRule::Weekdays {
            weekdays: vec![1, 1],
            time: "09:00".into(),
        })
        .is_err());
        assert!(validate_rule(&AgentScheduleRule::Weekdays {
            weekdays: vec![1, 7],
            time: "23:59".into(),
        })
        .is_ok());
    }

    #[test]
    fn preface_entries_must_be_single_line_slash_commands() {
        assert_eq!(validate_preface_command("  /clear  ").unwrap(), "/clear");
        assert_eq!(
            validate_preface_command("/model opus\u{1b}[31m").unwrap(),
            "/model opus[31m"
        );
        assert!(validate_preface_command("clear").is_err());
        assert!(validate_preface_command("/clear\nrm -rf /").is_err());
        assert!(validate_preface_command("   ").is_err());
        assert!(validate_preface_command(&format!("/{}", "x".repeat(MAX_PREFACE_BYTES))).is_err());
        assert!(validate_preface(vec!["/clear".into(); MAX_PREFACE_COMMANDS + 1]).is_err());
    }

    fn rule(id: &str, rule: AgentScheduleRule) -> ScheduledAgentPrompt {
        ScheduledAgentPrompt {
            id: id.into(),
            enabled: true,
            message: "go".into(),
            rule,
            preface: Vec::new(),
            last: None,
        }
    }

    fn once(id: &str) -> ScheduledAgentPrompt {
        rule(id, AgentScheduleRule::Once { at: "2026-09-04T13:00".into() })
    }

    fn daily(id: &str) -> ScheduledAgentPrompt {
        rule(id, AgentScheduleRule::Daily { time: "08:00".into() })
    }

    fn receipt() -> Option<AgentScheduleLastRun> {
        Some(AgentScheduleLastRun {
            occurrence: "2026-09-04T08:00".into(),
            result: AgentScheduleResult::Delivered,
            at: "2026-09-04T08:00:03+00:00".into(),
        })
    }

    /// One tab holding a live one-time rule, a delivered one, a recurring rule
    /// that has run before, and a one-time rule whose delivery is claimed.
    fn seeded() -> AgentTasksFile {
        let mut file = AgentTasksFile::default();
        let target = target_mut(&mut file, "p", "t1");
        target.schedules.push(once("live"));
        target.schedules.push(ScheduledAgentPrompt { last: receipt(), ..once("done") });
        target.schedules.push(ScheduledAgentPrompt { last: receipt(), ..daily("daily") });
        target.schedules.push(once("claimed"));
        target
            .claims
            .insert("claimed".into(), "2026-09-04T13:00".into());
        file
    }

    fn snapshot(file: &AgentTasksFile) -> String {
        serde_json::to_string(file).unwrap()
    }

    #[test]
    fn an_unguarded_write_behaves_as_before() {
        let mut file = seeded();
        // An editor cannot erase a receipt by omitting it…
        let stored = apply_upsert(&mut file, "p", "t1", once("done"), None).unwrap();
        assert_eq!(stored.iter().find(|item| item.id == "done").unwrap().last, receipt());
        // …a missing id is simply created, and a delete drops the claim too.
        let stored = apply_upsert(&mut file, "p", "t1", once("new"), None).unwrap();
        assert!(stored.iter().any(|item| item.id == "new"));
        apply_delete(&mut file, "p", "t1", "claimed", false).unwrap();
        assert!(!file.projects["p"]["t1"].claims.contains_key("claimed"));
        assert!(apply_delete(&mut file, "p", "t9", "nothing", false).is_ok());
    }

    #[test]
    fn a_guarded_edit_refuses_a_rule_that_was_delivered_or_is_being_delivered() {
        let mut file = seeded();
        let before = snapshot(&file);
        for (id, error) in [
            ("gone", SCHEDULE_GONE_ERROR),
            ("done", SCHEDULE_GONE_ERROR),
            ("claimed", SCHEDULE_BUSY_ERROR),
        ] {
            assert_eq!(
                apply_upsert(&mut file, "p", "t1", once(id), Some("t1")),
                Err(error.to_string()),
                "upsert {id}",
            );
            assert_eq!(
                apply_delete(&mut file, "p", "t1", id, true),
                Err(error.to_string()),
                "delete {id}",
            );
        }
        // A target that does not hold the id at all is gone too, even when
        // another tab does.
        assert_eq!(
            apply_upsert(&mut file, "p", "t1", once("live"), Some("t2")),
            Err(SCHEDULE_GONE_ERROR.to_string()),
        );
        assert_eq!(snapshot(&file), before, "a refusal writes nothing");
    }

    #[test]
    fn a_guarded_edit_still_moves_a_live_rule() {
        let mut file = seeded();
        let retimed = rule("live", AgentScheduleRule::Once { at: "2026-09-04T14:00".into() });
        let stored = apply_upsert(&mut file, "p", "t1", retimed, Some("t1")).unwrap();
        assert_eq!(
            stored.iter().find(|item| item.id == "live").unwrap().rule,
            AgentScheduleRule::Once { at: "2026-09-04T14:00".into() },
        );
        // A recurring rule that has run before is still a plan, and keeps its receipt.
        let stored = apply_upsert(&mut file, "p", "t1", daily("daily"), Some("t1")).unwrap();
        assert_eq!(stored.iter().find(|item| item.id == "daily").unwrap().last, receipt());
        // A move to another tab names the tab the rule came from.
        let stored = apply_upsert(&mut file, "p", "t2", once("live"), Some("t1")).unwrap();
        assert_eq!(stored.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), ["live"]);
        apply_delete(&mut file, "p", "t1", "live", true).unwrap();
        assert!(!file.projects["p"]["t1"].schedules.iter().any(|item| item.id == "live"));
    }

    #[test]
    fn civil_date_validation_handles_leap_years() {
        assert!(parse_date_time("2028-02-29T12:00").is_some());
        assert!(parse_date_time("2027-02-29T12:00").is_none());
    }
}
