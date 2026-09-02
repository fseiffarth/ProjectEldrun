//! Project-scoped prompt collection (`agent_prompts.json`), the tab-free half
//! of scheduled agent prompts. Kept beside, not inside, `agent_tasks.json`: a
//! prompt has no target, no claims and no receipts, and the schedule file's
//! version/orphan-sweep semantics must not grow a second shape. Lives in the
//! state dir, never in the project tree.

use std::sync::{Mutex, OnceLock};

use crate::{
    schema::agent_prompts::{
        AgentPromptsFile, ProjectAgentPrompt, ProjectAgentPromptInput, RecordedAgentPromptInput,
        SentAgentPrompt, SentAgentPromptInput,
    },
    services::agent_tasks::{
        sanitize_message, validate_id, validate_preface_command, MAX_MESSAGE_BYTES,
        MAX_PREFACE_COMMANDS,
    },
    storage,
};

const FILE_NAME: &str = "agent_prompts.json";
pub const MAX_PROMPTS_PER_PROJECT: usize = 64;
/// The history is a record, not an archive: it answers "what did I last send
/// where", so it is bounded and the oldest entries fall off rather than growing
/// this file without limit.
pub const MAX_HISTORY_PER_PROJECT: usize = 200;
const MAX_TAB_LABEL_BYTES: usize = 256;
const MAX_AGENT_BYTES: usize = 256;
/// The delivery outcomes a history entry may carry, mirroring the frontend's
/// `ScheduleResult`. Anything else is refused rather than stored as a word the
/// UI has no pill for.
const RESULTS: [&str; 3] = ["delivered", "missed", "failed"];

static LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

fn path() -> std::path::PathBuf {
    storage::state_dir().join(FILE_NAME)
}

fn read() -> Result<AgentPromptsFile, String> {
    let path = path();
    if !path.exists() {
        return Ok(AgentPromptsFile::default());
    }
    storage::read_json(&path).map_err(|e| format!("read {FILE_NAME}: {e}"))
}

fn write(file: &AgentPromptsFile) -> Result<(), String> {
    std::fs::create_dir_all(storage::state_dir())
        .map_err(|e| format!("create state directory: {e}"))?;
    storage::write_json_atomic(&path(), file).map_err(|e| format!("write {FILE_NAME}: {e}"))
}

fn validate_input(input: ProjectAgentPromptInput) -> Result<ProjectAgentPromptInput, String> {
    validate_id("prompt id", &input.id)?;
    let message = sanitize_message(&input.message);
    if message.trim().is_empty() {
        return Err("prompt is empty".into());
    }
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(format!("prompt exceeds {MAX_MESSAGE_BYTES} bytes"));
    }
    Ok(ProjectAgentPromptInput {
        id: input.id,
        message,
    })
}

/// Pure core of `upsert`, so the cap and the timestamp rules are testable
/// without a state dir.
fn apply_upsert(
    file: &mut AgentPromptsFile,
    project_id: &str,
    input: ProjectAgentPromptInput,
    now: &str,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    let prompts = file.projects.entry(project_id.to_string()).or_default();
    match prompts.iter().position(|item| item.id == input.id) {
        Some(index) => {
            prompts[index].message = input.message;
            prompts[index].updated_at = now.to_string();
        }
        None => {
            if prompts.len() >= MAX_PROMPTS_PER_PROJECT {
                return Err(format!(
                    "a project may collect at most {MAX_PROMPTS_PER_PROJECT} prompts"
                ));
            }
            prompts.push(ProjectAgentPrompt {
                id: input.id,
                message: input.message,
                created_at: now.to_string(),
                updated_at: now.to_string(),
            });
        }
    }
    Ok(prompts.clone())
}

fn validate_sent(input: SentAgentPromptInput) -> Result<SentAgentPromptInput, String> {
    let tab_label = sanitize_message(&input.tab_label).replace('\n', " ");
    let tab_label = tab_label.trim().to_string();
    if tab_label.is_empty() || tab_label.len() > MAX_TAB_LABEL_BYTES {
        return Err("invalid target tab label".into());
    }
    if let Some(session_id) = &input.session_id {
        validate_id("session id", session_id)?;
    }
    let agent = input.agent.as_ref().map(|agent| {
        sanitize_message(agent).replace('\n', " ").trim().to_string()
    });
    let agent = match agent {
        Some(agent) if agent.is_empty() || agent.len() > MAX_AGENT_BYTES => {
            return Err("invalid agent command".into())
        }
        other => other,
    };
    if let Some(result) = &input.result {
        if !RESULTS.contains(&result.as_str()) {
            return Err(format!("invalid delivery result: {result}"));
        }
    }
    if let Some(scheduled_for) = &input.scheduled_for {
        validate_id("scheduled occurrence", scheduled_for)?;
    }
    if input.preface.len() > MAX_PREFACE_COMMANDS {
        return Err(format!(
            "a prompt may carry at most {MAX_PREFACE_COMMANDS} prefix commands"
        ));
    }
    let preface = input
        .preface
        .iter()
        .map(|command| validate_preface_command(command))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SentAgentPromptInput {
        tab_label,
        session_id: input.session_id,
        preface,
        agent,
        result: input.result,
        scheduled_for: input.scheduled_for,
    })
}

/// Push one entry onto a project's history, replacing an entry with the same
/// id rather than adding a second one — the scheduler records a send-now
/// prompt the collected list already archived under that id, and a delivery
/// must update that record, not duplicate it. The cap drops the oldest.
fn push_history(file: &mut AgentPromptsFile, project_id: &str, sent: SentAgentPrompt) {
    let history = file.history.entry(project_id.to_string()).or_default();
    match history.iter().position(|item| item.id == sent.id) {
        Some(index) => {
            // Ordering is by when it happened, so an entry that just became a
            // delivery moves to the end with the other recent ones.
            history.remove(index);
            history.push(sent);
        }
        None => history.push(sent),
    }
    if history.len() > MAX_HISTORY_PER_PROJECT {
        let drop = history.len() - MAX_HISTORY_PER_PROJECT;
        history.drain(0..drop);
    }
}

/// Move one collected prompt out of the active list and onto the project's
/// history. Pure core so the move, the cap and the ordering are testable.
///
/// A prompt the caller no longer finds is NOT an error: the send already
/// happened by the time this runs, and failing here would leave the user with a
/// delivered prompt and an error dialog. It records what it can and returns.
fn apply_archive(
    file: &mut AgentPromptsFile,
    project_id: &str,
    prompt_id: &str,
    input: &SentAgentPromptInput,
    now: &str,
) -> Option<SentAgentPrompt> {
    let prompt = file
        .projects
        .get(project_id)
        .and_then(|prompts| prompts.iter().find(|item| item.id == prompt_id))
        .cloned()?;
    apply_delete(file, project_id, prompt_id);
    let sent = SentAgentPrompt {
        id: prompt.id,
        message: prompt.message,
        created_at: prompt.created_at,
        sent_at: now.to_string(),
        tab_label: input.tab_label.clone(),
        session_id: input.session_id.clone(),
        preface: input.preface.clone(),
        agent: input.agent.clone(),
        result: input.result.clone(),
        scheduled_for: input.scheduled_for.clone(),
    };
    push_history(file, project_id, sent.clone());
    Some(sent)
}

/// Write one delivery onto the history. Unlike `apply_archive` there is no
/// collected prompt to retire: a schedule's text lives on the rule, and the
/// entry the history keeps is the only place it is written down once the rule
/// is retired. An entry already there under this id (the send-now prompt the
/// collected list archived at queue time) is updated in place, so a prompt is
/// listed once with the outcome it ended up having.
fn apply_record(
    file: &mut AgentPromptsFile,
    project_id: &str,
    entry: &RecordedAgentPromptInput,
    input: &SentAgentPromptInput,
    now: &str,
) -> SentAgentPrompt {
    let created_at = entry
        .created_at
        .clone()
        .or_else(|| {
            file.history
                .get(project_id)
                .and_then(|history| history.iter().find(|item| item.id == entry.id))
                .map(|item| item.created_at.clone())
        })
        .unwrap_or_else(|| now.to_string());
    let sent = SentAgentPrompt {
        id: entry.id.clone(),
        message: entry.message.clone(),
        created_at,
        sent_at: now.to_string(),
        tab_label: input.tab_label.clone(),
        session_id: input.session_id.clone(),
        preface: input.preface.clone(),
        agent: input.agent.clone(),
        result: input.result.clone(),
        scheduled_for: input.scheduled_for.clone(),
    };
    push_history(file, project_id, sent.clone());
    sent
}

fn apply_delete(file: &mut AgentPromptsFile, project_id: &str, prompt_id: &str) {
    if let Some(prompts) = file.projects.get_mut(project_id) {
        prompts.retain(|item| item.id != prompt_id);
    }
    file.projects.retain(|_, prompts| !prompts.is_empty());
}

pub fn list(project_id: &str) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    let _guard = lock();
    Ok(read()?.projects.get(project_id).cloned().unwrap_or_default())
}

pub fn upsert(
    project_id: &str,
    input: ProjectAgentPromptInput,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    let input = validate_input(input)?;
    let _guard = lock();
    let mut file = read()?;
    let result = apply_upsert(&mut file, project_id, input, &storage::iso_now())?;
    write(&file)?;
    Ok(result)
}

pub fn delete(project_id: &str, prompt_id: &str) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("prompt id", prompt_id)?;
    let _guard = lock();
    let mut file = read()?;
    apply_delete(&mut file, project_id, prompt_id);
    write(&file)?;
    Ok(file.projects.get(project_id).cloned().unwrap_or_default())
}

pub fn history(project_id: &str) -> Result<Vec<SentAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    let _guard = lock();
    Ok(read()?.history.get(project_id).cloned().unwrap_or_default())
}

/// Retire a collected prompt to the history. Returns the remaining active
/// prompts, matching `delete` — the caller reloads the history separately.
pub fn archive(
    project_id: &str,
    prompt_id: &str,
    input: SentAgentPromptInput,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("prompt id", prompt_id)?;
    let input = validate_sent(input)?;
    let _guard = lock();
    let mut file = read()?;
    apply_archive(&mut file, project_id, prompt_id, &input, &storage::iso_now());
    write(&file)?;
    Ok(file.projects.get(project_id).cloned().unwrap_or_default())
}

/// Record one delivery straight onto the history. Returns the project's
/// history, since — unlike `archive` — nothing on the active list moved.
pub fn record(
    project_id: &str,
    entry: RecordedAgentPromptInput,
) -> Result<Vec<SentAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("history entry id", &entry.id)?;
    let message = sanitize_message(&entry.message);
    if message.trim().is_empty() {
        return Err("prompt is empty".into());
    }
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(format!("prompt exceeds {MAX_MESSAGE_BYTES} bytes"));
    }
    let input = validate_sent(entry.sent.clone())?;
    let entry = RecordedAgentPromptInput {
        message,
        ..entry
    };
    let _guard = lock();
    let mut file = read()?;
    apply_record(&mut file, project_id, &entry, &input, &storage::iso_now());
    write(&file)?;
    Ok(file.history.get(project_id).cloned().unwrap_or_default())
}

/// Drop one history entry, or the whole project's history when `entry_id` is
/// `None`.
pub fn clear_history(
    project_id: &str,
    entry_id: Option<&str>,
) -> Result<Vec<SentAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    let _guard = lock();
    let mut file = read()?;
    match entry_id {
        Some(entry_id) => {
            validate_id("history entry id", entry_id)?;
            if let Some(history) = file.history.get_mut(project_id) {
                history.retain(|item| item.id != entry_id);
            }
        }
        None => {
            file.history.remove(project_id);
        }
    }
    file.history.retain(|_, history| !history.is_empty());
    write(&file)?;
    Ok(file.history.get(project_id).cloned().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(id: &str, message: &str) -> ProjectAgentPromptInput {
        ProjectAgentPromptInput {
            id: id.into(),
            message: message.into(),
        }
    }

    #[test]
    fn upsert_keeps_created_at_and_moves_updated_at() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", input("a", "one"), "t1").unwrap();
        let prompts = apply_upsert(&mut file, "p", input("a", "two"), "t2").unwrap();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].message, "two");
        assert_eq!(prompts[0].created_at, "t1");
        assert_eq!(prompts[0].updated_at, "t2");
    }

    #[test]
    fn projects_are_isolated_and_capped() {
        let mut file = AgentPromptsFile::default();
        for index in 0..MAX_PROMPTS_PER_PROJECT {
            apply_upsert(&mut file, "p", input(&format!("id-{index}"), "x"), "t").unwrap();
        }
        assert!(apply_upsert(&mut file, "p", input("overflow", "x"), "t").is_err());
        // Another project starts at zero.
        assert_eq!(
            apply_upsert(&mut file, "q", input("first", "x"), "t")
                .unwrap()
                .len(),
            1
        );
        apply_delete(&mut file, "q", "first");
        assert!(!file.projects.contains_key("q"));
        assert_eq!(file.projects["p"].len(), MAX_PROMPTS_PER_PROJECT);
    }

    fn sent(label: &str) -> SentAgentPromptInput {
        SentAgentPromptInput {
            tab_label: label.into(),
            session_id: Some("session-1".into()),
            preface: vec!["/clear".into()],
            agent: Some("claude".into()),
            result: None,
            scheduled_for: None,
        }
    }

    #[test]
    fn archive_moves_the_prompt_and_keeps_its_created_at() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", input("a", "one"), "t1").unwrap();
        let moved = apply_archive(&mut file, "p", "a", &sent("Claude"), "t2").unwrap();
        assert_eq!(moved.created_at, "t1");
        assert_eq!(moved.sent_at, "t2");
        assert_eq!(moved.tab_label, "Claude");
        assert_eq!(moved.session_id.as_deref(), Some("session-1"));
        assert!(!file.projects.contains_key("p"));
        assert_eq!(file.history["p"].len(), 1);
        // A prompt that is already gone records nothing and does not panic.
        assert!(apply_archive(&mut file, "p", "a", &sent("Claude"), "t3").is_none());
    }

    #[test]
    fn history_is_capped_oldest_first() {
        let mut file = AgentPromptsFile::default();
        for index in 0..MAX_HISTORY_PER_PROJECT + 3 {
            let id = format!("id-{index}");
            apply_upsert(&mut file, "p", input(&id, "x"), "t").unwrap();
            apply_archive(&mut file, "p", &id, &sent("Claude"), "t").unwrap();
        }
        let history = &file.history["p"];
        assert_eq!(history.len(), MAX_HISTORY_PER_PROJECT);
        assert_eq!(history[0].id, "id-3");
        assert_eq!(history[history.len() - 1].id, format!("id-{}", MAX_HISTORY_PER_PROJECT + 2));
    }

    fn recorded(id: &str, message: &str, result: &str) -> RecordedAgentPromptInput {
        RecordedAgentPromptInput {
            id: id.into(),
            message: message.into(),
            created_at: None,
            sent: SentAgentPromptInput {
                result: Some(result.into()),
                scheduled_for: Some("2026-09-02T09:00".into()),
                ..sent("Claude")
            },
        }
    }

    #[test]
    fn a_delivery_updates_the_entry_its_send_already_wrote() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", input("a", "one"), "t1").unwrap();
        apply_archive(&mut file, "p", "a", &sent("Claude"), "t2").unwrap();
        // Queued: on the history, with no outcome yet.
        assert_eq!(file.history["p"].len(), 1);
        assert!(file.history["p"][0].result.is_none());

        let entry = recorded("a", "one", "delivered");
        let recorded = apply_record(&mut file, "p", &entry, &entry.sent, "t3");
        assert_eq!(file.history["p"].len(), 1, "one prompt, one row");
        assert_eq!(recorded.result.as_deref(), Some("delivered"));
        assert_eq!(recorded.sent_at, "t3");
        // The collection time survives the update; the send time moves.
        assert_eq!(recorded.created_at, "t1");
        assert_eq!(recorded.scheduled_for.as_deref(), Some("2026-09-02T09:00"));
        assert_eq!(recorded.agent.as_deref(), Some("claude"));
    }

    #[test]
    fn a_schedule_that_was_never_collected_records_a_new_row() {
        let mut file = AgentPromptsFile::default();
        let first = recorded("s1@2026-09-02T09:00", "daily standup", "delivered");
        apply_record(&mut file, "p", &first, &first.sent, "t1");
        let second = recorded("s1@2026-09-03T09:00", "daily standup", "missed");
        apply_record(&mut file, "p", &second, &second.sent, "t2");
        let history = &file.history["p"];
        assert_eq!(history.len(), 2, "each occurrence is its own row");
        assert_eq!(history[1].result.as_deref(), Some("missed"));
        assert!(file.projects.is_empty(), "nothing was collected");
    }

    #[test]
    fn send_facts_are_validated() {
        assert!(validate_sent(SentAgentPromptInput {
            tab_label: "   ".into(),
            ..sent("x")
        })
        .is_err());
        assert!(validate_sent(SentAgentPromptInput {
            tab_label: "Claude".into(),
            preface: vec!["clear".into()],
            ..sent("x")
        })
        .is_err());
        // A result the UI has no pill for is refused rather than stored.
        assert!(validate_sent(SentAgentPromptInput {
            result: Some("queued".into()),
            ..sent("Claude")
        })
        .is_err());
        assert!(validate_sent(SentAgentPromptInput {
            result: Some("delivered".into()),
            ..sent("Claude")
        })
        .is_ok());
        let clean = validate_sent(SentAgentPromptInput {
            tab_label: "Claude\u{1b}[31m".into(),
            session_id: None,
            preface: vec!["  /clear ".into()],
            ..sent("x")
        })
        .unwrap();
        assert_eq!(clean.tab_label, "Claude[31m");
        assert_eq!(clean.preface, vec!["/clear".to_string()]);
    }

    #[test]
    fn validation_sanitizes_and_rejects_empty_or_oversized() {
        assert!(validate_input(input("a", "  \r\n ")).is_err());
        assert!(validate_input(input("", "hello")).is_err());
        assert!(validate_input(input("a", &"x".repeat(MAX_MESSAGE_BYTES + 1))).is_err());
        let clean = validate_input(input("a", "one\r\ntwo\u{1b}[31m  ")).unwrap();
        assert_eq!(clean.message, "one\ntwo[31m");
    }
}
