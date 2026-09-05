//! Project-scoped prompt collection (`agent_prompts.json`), the tab-free half
//! of scheduled agent prompts. Kept beside, not inside, `agent_tasks.json`: a
//! prompt has no target, no claims and no receipts, and the schedule file's
//! version/orphan-sweep semantics must not grow a second shape. Lives in the
//! state dir, never in the project tree.

use std::sync::{Mutex, OnceLock};

use crate::{
    schema::agent_prompts::{
        AgentPromptsFile, ProjectAgentPrompt, ProjectAgentPromptInput, PromptLink, PromptLinkInput,
        RecordedAgentPromptInput, SentAgentPrompt, SentAgentPromptInput,
    },
    services::{
        agent_tasks::{
            sanitize_message, validate_id, validate_preface_command, MAX_MESSAGE_BYTES,
            MAX_PREFACE_COMMANDS,
        },
        prompt_blame::{self, RepoHead, MAX_BLAME_FILES},
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
/// Tags are labels, not sentences: a handful per prompt, each a short token.
/// The frontend's `lib/agentPromptTags` normalizes the same way and truncates
/// at 32 characters, so the byte cap here is the guard, not the editor.
pub const MAX_TAGS_PER_PROMPT: usize = 16;
pub const MAX_TAG_BYTES: usize = 64;
const MAX_BLAME_PATH_BYTES: usize = 1024;
/// The delivery outcomes a history entry may carry, mirroring the frontend's
/// `ScheduleResult`. Anything else is refused rather than stored as a word the
/// UI has no pill for.
const RESULTS: [&str; 3] = ["delivered", "missed", "failed"];
const LINK_KINDS: [&str; 2] = ["related", "after"];
const MAX_LINKS_PER_PROJECT: usize = 256;

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

/// One tag as it is stored: trimmed, without a leading `#`, lowercase, and
/// with inner whitespace folded to `-` so a tag is always one token. Empty
/// after that means "no tag", which the caller drops rather than stores.
pub fn normalize_tag(raw: &str) -> String {
    let clean = sanitize_message(raw);
    let trimmed = clean.trim().trim_start_matches('#').trim();
    trimmed
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase()
}

/// Normalize, drop empties, dedupe in order, and refuse a list or a tag the
/// file has no business holding.
pub fn validate_tags(tags: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in tags {
        let tag = normalize_tag(raw);
        if tag.is_empty() || out.contains(&tag) {
            continue;
        }
        if tag.len() > MAX_TAG_BYTES {
            return Err(format!("a tag may be at most {MAX_TAG_BYTES} bytes"));
        }
        out.push(tag);
    }
    if out.len() > MAX_TAGS_PER_PROMPT {
        return Err(format!(
            "a prompt may carry at most {MAX_TAGS_PER_PROMPT} tags"
        ));
    }
    Ok(out)
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
    let tags = match &input.tags {
        Some(tags) => Some(validate_tags(tags)?),
        None => None,
    };
    Ok(ProjectAgentPromptInput {
        id: input.id,
        message,
        tags,
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
            // `None` is an editor that did not speak about tags (the phone),
            // not one that cleared them.
            if let Some(tags) = input.tags {
                prompts[index].tags = tags;
            }
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
                tags: input.tags.unwrap_or_default(),
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
        sanitize_message(agent)
            .replace('\n', " ")
            .trim()
            .to_string()
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
    head: Option<&RepoHead>,
    now: &str,
) -> Option<SentAgentPrompt> {
    let prompt = file
        .projects
        .get(project_id)
        .and_then(|prompts| prompts.iter().find(|item| item.id == prompt_id))
        .cloned()?;
    // This is a move, not a deletion: keep links alive while the endpoint
    // crosses from `projects` to `history`, then prune against the final file.
    if let Some(prompts) = file.projects.get_mut(project_id) {
        prompts.retain(|item| item.id != prompt_id);
    }
    file.projects.retain(|_, prompts| !prompts.is_empty());
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
        tags: prompt.tags,
        commit: head.map(|head| head.commit.clone()),
        branch: head.and_then(|head| head.branch.clone()),
        files: Vec::new(),
        files_at: None,
    };
    push_history(file, project_id, sent.clone());
    prune_links(file, project_id);
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
    head: Option<&RepoHead>,
    now: &str,
) -> SentAgentPrompt {
    // The row this delivery updates, if the send already wrote one. What the
    // collected prompt brought with it — its collection time and its tags —
    // is the send's to keep, not the delivery's to drop.
    let existing = file
        .history
        .get(project_id)
        .and_then(|history| history.iter().find(|item| item.id == entry.id))
        .cloned();
    let created_at = entry
        .created_at
        .clone()
        .or_else(|| existing.as_ref().map(|item| item.created_at.clone()))
        .unwrap_or_else(|| now.to_string());
    // The delivery is when the agent actually started from the tree, so its
    // HEAD is the one that counts; the queue-time stamp stands in only when
    // the delivery could not read one.
    let (commit, branch) = match head {
        Some(head) => (Some(head.commit.clone()), head.branch.clone()),
        None => existing
            .as_ref()
            .map(|item| (item.commit.clone(), item.branch.clone()))
            .unwrap_or_default(),
    };
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
        tags: existing
            .as_ref()
            .map(|item| item.tags.clone())
            .unwrap_or_default(),
        commit,
        branch,
        files: existing
            .as_ref()
            .map(|item| item.files.clone())
            .unwrap_or_default(),
        files_at: existing.and_then(|item| item.files_at),
    };
    push_history(file, project_id, sent.clone());
    sent
}

/// Write the files a delivered prompt touched onto its history row. Pure core
/// of `blame`, so what is recorded is testable without git. `None` when the
/// row is gone — the agent finished, but the user cleared the history first.
fn apply_blame(
    file: &mut AgentPromptsFile,
    project_id: &str,
    entry_id: &str,
    files: Vec<String>,
    now: &str,
) -> Option<SentAgentPrompt> {
    let entry = file
        .history
        .get_mut(project_id)?
        .iter_mut()
        .find(|item| item.id == entry_id)?;
    entry.files = files;
    entry.files_at = Some(now.to_string());
    Some(entry.clone())
}

/// Put a project's collected prompts into the order the caller names.
///
/// The list is an ordered one — the prompt to send first belongs at the top —
/// and the order is the file's own, so a drag has to be written down somewhere
/// to survive a reload.
///
/// Ids the project does not have are ignored, and prompts the caller did not
/// name keep their relative order at the END: the caller reordered the list it
/// had, and a prompt collected (or arriving from another window) between that
/// read and this write must not be dropped just because the drag never saw it.
fn apply_reorder(
    file: &mut AgentPromptsFile,
    project_id: &str,
    ids: &[String],
) -> Vec<ProjectAgentPrompt> {
    let Some(prompts) = file.projects.get_mut(project_id) else {
        return Vec::new();
    };
    let mut ordered: Vec<ProjectAgentPrompt> = Vec::with_capacity(prompts.len());
    for id in ids {
        if ordered.iter().any(|item| &item.id == id) {
            continue;
        }
        if let Some(found) = prompts.iter().find(|item| &item.id == id) {
            ordered.push(found.clone());
        }
    }
    for prompt in prompts.iter() {
        if !ordered.iter().any(|item| item.id == prompt.id) {
            ordered.push(prompt.clone());
        }
    }
    *prompts = ordered;
    prompts.clone()
}

fn endpoint_ids(file: &AgentPromptsFile, project_id: &str) -> std::collections::HashSet<String> {
    file.projects
        .get(project_id)
        .into_iter()
        .flatten()
        .map(|item| item.id.clone())
        .chain(
            file.history
                .get(project_id)
                .into_iter()
                .flatten()
                .map(|item| item.id.clone()),
        )
        .collect()
}

fn prune_links(file: &mut AgentPromptsFile, project_id: &str) {
    let endpoints = endpoint_ids(file, project_id);
    if let Some(links) = file.links.get_mut(project_id) {
        links.retain(|link| endpoints.contains(&link.from) && endpoints.contains(&link.to));
    }
    file.links.retain(|_, links| !links.is_empty());
}

fn apply_delete(file: &mut AgentPromptsFile, project_id: &str, prompt_id: &str) {
    if let Some(prompts) = file.projects.get_mut(project_id) {
        prompts.retain(|item| item.id != prompt_id);
    }
    file.projects.retain(|_, prompts| !prompts.is_empty());
    prune_links(file, project_id);
}

fn validate_link(input: PromptLinkInput) -> Result<PromptLink, String> {
    validate_id("link id", &input.id)?;
    validate_id("link source", &input.from)?;
    validate_id("link target", &input.to)?;
    if input.from == input.to {
        return Err("a prompt link cannot point to itself".into());
    }
    if !LINK_KINDS.contains(&input.kind.as_str()) {
        return Err(format!("invalid prompt link kind: {}", input.kind));
    }
    if let Some(target) = &input.target {
        validate_id("schedule target", target)?;
    }
    Ok(PromptLink {
        id: input.id,
        from: input.from,
        to: input.to,
        kind: input.kind,
        target: input.target,
    })
}

fn apply_link_upsert(
    file: &mut AgentPromptsFile,
    project_id: &str,
    link: PromptLink,
) -> Result<Vec<PromptLink>, String> {
    let endpoints = endpoint_ids(file, project_id);
    if !endpoints.contains(&link.from) || !endpoints.contains(&link.to) {
        return Err("prompt link endpoint not found".into());
    }
    let links = file.links.entry(project_id.to_string()).or_default();
    if let Some(index) = links.iter().position(|item| item.id == link.id) {
        links[index] = link;
    } else {
        if links.len() >= MAX_LINKS_PER_PROJECT {
            return Err(format!(
                "a project may carry at most {MAX_LINKS_PER_PROJECT} prompt links"
            ));
        }
        links.push(link);
    }
    Ok(links.clone())
}

fn apply_link_delete(
    file: &mut AgentPromptsFile,
    project_id: &str,
    link_id: &str,
) -> Vec<PromptLink> {
    if let Some(links) = file.links.get_mut(project_id) {
        links.retain(|link| link.id != link_id);
    }
    file.links.retain(|_, links| !links.is_empty());
    file.links.get(project_id).cloned().unwrap_or_default()
}

pub fn list(project_id: &str) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    let _guard = lock();
    Ok(read()?
        .projects
        .get(project_id)
        .cloned()
        .unwrap_or_default())
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

pub fn links(project_id: &str) -> Result<Vec<PromptLink>, String> {
    validate_id("project id", project_id)?;
    let _guard = lock();
    let mut file = read()?;
    prune_links(&mut file, project_id);
    Ok(file.links.get(project_id).cloned().unwrap_or_default())
}

pub fn link_upsert(project_id: &str, input: PromptLinkInput) -> Result<Vec<PromptLink>, String> {
    validate_id("project id", project_id)?;
    let link = validate_link(input)?;
    let _guard = lock();
    let mut file = read()?;
    prune_links(&mut file, project_id);
    let result = apply_link_upsert(&mut file, project_id, link)?;
    write(&file)?;
    Ok(result)
}

pub fn link_delete(project_id: &str, link_id: &str) -> Result<Vec<PromptLink>, String> {
    validate_id("project id", project_id)?;
    validate_id("link id", link_id)?;
    let _guard = lock();
    let mut file = read()?;
    let result = apply_link_delete(&mut file, project_id, link_id);
    write(&file)?;
    Ok(result)
}

/// Persist a new order for a project's collected prompts. Every id is
/// validated before anything is written, so a malformed list is refused rather
/// than half-applied.
pub fn reorder(project_id: &str, ids: Vec<String>) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    for id in &ids {
        validate_id("prompt id", id)?;
    }
    let _guard = lock();
    let mut file = read()?;
    let result = apply_reorder(&mut file, project_id, &ids);
    write(&file)?;
    Ok(result)
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
    // Read before the lock: it spawns git (local projects only), and nothing
    // in the file depends on it.
    let head = prompt_blame::head(project_id);
    let _guard = lock();
    let mut file = read()?;
    apply_archive(
        &mut file,
        project_id,
        prompt_id,
        &input,
        head.as_ref(),
        &storage::iso_now(),
    );
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
    let entry = RecordedAgentPromptInput { message, ..entry };
    let head = prompt_blame::head(project_id);
    let _guard = lock();
    let mut file = read()?;
    apply_record(
        &mut file,
        project_id,
        &entry,
        &input,
        head.as_ref(),
        &storage::iso_now(),
    );
    write(&file)?;
    Ok(file.history.get(project_id).cloned().unwrap_or_default())
}

/// Record which files a delivered prompt touched, from the delivery (or
/// `since`, when the caller knows the moment the text was submitted better
/// than the row's `sent_at`) until now. Called once, when the scheduler sees
/// the tab idle again. Git runs OUTSIDE the lock — it is the slow part — and
/// the row is re-read afterwards, so a history cleared in between is not
/// resurrected. Returns the project's history.
pub fn blame(
    project_id: &str,
    entry_id: &str,
    since: Option<&str>,
) -> Result<Vec<SentAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("history entry id", entry_id)?;
    let (commit, sent_at) = {
        let _guard = lock();
        let file = read()?;
        let entry = file
            .history
            .get(project_id)
            .and_then(|history| history.iter().find(|item| item.id == entry_id))
            .ok_or_else(|| "history entry not found".to_string())?;
        (entry.commit.clone(), entry.sent_at.clone())
    };
    let since = match since {
        Some(value) if prompt_blame::iso_to_epoch(value).is_some() => value.to_string(),
        _ => sent_at,
    };
    let files = prompt_blame::files_touched(project_id, commit.as_deref(), &since);
    let files = files
        .into_iter()
        .filter(|path| path.len() <= MAX_BLAME_PATH_BYTES && !path.chars().any(char::is_control))
        .take(MAX_BLAME_FILES)
        .collect();
    let _guard = lock();
    let mut file = read()?;
    if apply_blame(&mut file, project_id, entry_id, files, &storage::iso_now()).is_some() {
        write(&file)?;
    }
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
    prune_links(&mut file, project_id);
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
            tags: None,
        }
    }

    fn tagged(id: &str, message: &str, tags: &[&str]) -> ProjectAgentPromptInput {
        ProjectAgentPromptInput {
            tags: Some(tags.iter().map(|t| t.to_string()).collect()),
            ..input(id, message)
        }
    }

    fn link(id: &str, from: &str, to: &str, kind: &str) -> PromptLinkInput {
        PromptLinkInput {
            id: id.into(),
            from: from.into(),
            to: to.into(),
            kind: kind.into(),
            target: Some("target-1".into()),
        }
    }

    fn head(commit: &str, branch: Option<&str>) -> RepoHead {
        RepoHead {
            commit: commit.into(),
            branch: branch.map(str::to_string),
        }
    }

    #[test]
    fn tags_are_normalized_deduped_and_capped() {
        let tags = validate_tags(&[
            " #Refactor ".into(),
            "unit tests".into(),
            "refactor".into(),
            "".into(),
            "#".into(),
        ])
        .unwrap();
        assert_eq!(tags, vec!["refactor", "unit-tests"]);
        assert!(validate_tags(&["x".repeat(MAX_TAG_BYTES + 1)]).is_err());
        let many: Vec<String> = (0..MAX_TAGS_PER_PROMPT + 1)
            .map(|i| format!("t{i}"))
            .collect();
        assert!(validate_tags(&many).is_err());
        assert!(validate_tags(&many[..MAX_TAGS_PER_PROMPT]).is_ok());
    }

    #[test]
    fn upsert_keeps_tags_unless_the_editor_names_them() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", tagged("a", "one", &["paper", "tex"]), "t1").unwrap();
        // The phone edits the text and says nothing about tags: they stay.
        let prompts = apply_upsert(&mut file, "p", input("a", "two"), "t2").unwrap();
        assert_eq!(prompts[0].tags, vec!["paper", "tex"]);
        // An editor that names an empty list clears them.
        let prompts = apply_upsert(&mut file, "p", tagged("a", "two", &[]), "t3").unwrap();
        assert!(prompts[0].tags.is_empty());
        // A new prompt without tags starts untagged.
        let prompts = apply_upsert(&mut file, "p", input("b", "x"), "t4").unwrap();
        assert!(prompts[1].tags.is_empty());
    }

    #[test]
    fn prompt_links_validate_upsert_and_prune_with_endpoints() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", input("a", "one"), "t1").unwrap();
        apply_upsert(&mut file, "p", input("b", "two"), "t1").unwrap();
        let stored = apply_link_upsert(
            &mut file,
            "p",
            validate_link(link("l", "a", "b", "after")).unwrap(),
        )
        .unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].target.as_deref(), Some("target-1"));
        assert!(validate_link(link("x", "a", "a", "related")).is_err());
        assert!(validate_link(link("x", "a", "b", "unknown")).is_err());
        apply_delete(&mut file, "p", "b");
        assert!(!file.links.contains_key("p"));
    }

    #[test]
    fn archive_keeps_a_link_when_the_endpoint_moves_to_history() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", input("a", "one"), "t1").unwrap();
        apply_upsert(&mut file, "p", input("b", "two"), "t1").unwrap();
        apply_link_upsert(
            &mut file,
            "p",
            validate_link(link("l", "a", "b", "after")).unwrap(),
        )
        .unwrap();
        apply_archive(&mut file, "p", "a", &sent("Claude"), None, "t2").unwrap();
        assert_eq!(file.links["p"].len(), 1);
    }

    #[test]
    fn archive_carries_tags_and_stamps_the_head() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", tagged("a", "one", &["paper"]), "t1").unwrap();
        let moved = apply_archive(
            &mut file,
            "p",
            "a",
            &sent("Claude"),
            Some(&head("abcdef0123456789", Some("develop"))),
            "t2",
        )
        .unwrap();
        assert_eq!(moved.tags, vec!["paper"]);
        assert_eq!(moved.commit.as_deref(), Some("abcdef0123456789"));
        assert_eq!(moved.branch.as_deref(), Some("develop"));
        assert!(moved.files.is_empty());
        // Without a repo there is no blame, and no fake one either.
        apply_upsert(&mut file, "p", input("b", "two"), "t3").unwrap();
        let plain = apply_archive(&mut file, "p", "b", &sent("Claude"), None, "t4").unwrap();
        assert!(plain.commit.is_none() && plain.branch.is_none());
    }

    #[test]
    fn a_delivery_keeps_the_send_row_tags_and_takes_the_fresher_head() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", tagged("a", "one", &["paper"]), "t1").unwrap();
        apply_archive(
            &mut file,
            "p",
            "a",
            &sent("Claude"),
            Some(&head("1111111", Some("main"))),
            "t2",
        )
        .unwrap();
        let entry = recorded("a", "one", "delivered");
        // Delivered from a later commit: that is the one the agent started from.
        let row = apply_record(
            &mut file,
            "p",
            &entry,
            &entry.sent,
            Some(&head("2222222", None)),
            "t3",
        );
        assert_eq!(row.tags, vec!["paper"]);
        assert_eq!(row.commit.as_deref(), Some("2222222"));
        assert!(row.branch.is_none());
        // A delivery that could not read HEAD keeps what the send stamped.
        let row = apply_record(&mut file, "p", &entry, &entry.sent, None, "t4");
        assert_eq!(row.commit.as_deref(), Some("2222222"));
        // The blame lands on the row and survives a later re-record.
        let blamed = apply_blame(&mut file, "p", "a", vec!["src/a.rs".into()], "t5").unwrap();
        assert_eq!(blamed.files, vec!["src/a.rs"]);
        assert_eq!(blamed.files_at.as_deref(), Some("t5"));
        let row = apply_record(&mut file, "p", &entry, &entry.sent, None, "t6");
        assert_eq!(row.files, vec!["src/a.rs"]);
        // A row that is gone records nothing.
        assert!(apply_blame(&mut file, "p", "missing", vec![], "t7").is_none());
        assert_eq!(file.history["p"].len(), 1, "still one prompt, one row");
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

    #[test]
    fn reorder_follows_the_named_order_and_keeps_the_rest() {
        let mut file = AgentPromptsFile::default();
        for id in ["a", "b", "c"] {
            apply_upsert(&mut file, "p", input(id, id), "t").unwrap();
        }
        // A drag that moved `c` to the top, named against the list as read.
        let prompts = apply_reorder(&mut file, "p", &["c".into(), "a".into(), "b".into()]);
        assert_eq!(
            prompts.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["c", "a", "b"]
        );
        // An unknown id is ignored, and a prompt the caller never saw — one
        // collected between its read and this write — survives at the end.
        apply_upsert(&mut file, "p", input("d", "d"), "t").unwrap();
        let prompts = apply_reorder(&mut file, "p", &["b".into(), "gone".into(), "b".into()]);
        assert_eq!(
            prompts.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["b", "c", "a", "d"]
        );
        // Another project is untouched, and an unknown one is not created.
        assert!(apply_reorder(&mut file, "q", &["a".into()]).is_empty());
        assert!(!file.projects.contains_key("q"));
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
        let moved = apply_archive(&mut file, "p", "a", &sent("Claude"), None, "t2").unwrap();
        assert_eq!(moved.created_at, "t1");
        assert_eq!(moved.sent_at, "t2");
        assert_eq!(moved.tab_label, "Claude");
        assert_eq!(moved.session_id.as_deref(), Some("session-1"));
        assert!(!file.projects.contains_key("p"));
        assert_eq!(file.history["p"].len(), 1);
        // A prompt that is already gone records nothing and does not panic.
        assert!(apply_archive(&mut file, "p", "a", &sent("Claude"), None, "t3").is_none());
    }

    #[test]
    fn history_is_capped_oldest_first() {
        let mut file = AgentPromptsFile::default();
        for index in 0..MAX_HISTORY_PER_PROJECT + 3 {
            let id = format!("id-{index}");
            apply_upsert(&mut file, "p", input(&id, "x"), "t").unwrap();
            apply_archive(&mut file, "p", &id, &sent("Claude"), None, "t").unwrap();
        }
        let history = &file.history["p"];
        assert_eq!(history.len(), MAX_HISTORY_PER_PROJECT);
        assert_eq!(history[0].id, "id-3");
        assert_eq!(
            history[history.len() - 1].id,
            format!("id-{}", MAX_HISTORY_PER_PROJECT + 2)
        );
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
        apply_archive(&mut file, "p", "a", &sent("Claude"), None, "t2").unwrap();
        // Queued: on the history, with no outcome yet.
        assert_eq!(file.history["p"].len(), 1);
        assert!(file.history["p"][0].result.is_none());

        let entry = recorded("a", "one", "delivered");
        let recorded = apply_record(&mut file, "p", &entry, &entry.sent, None, "t3");
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
        apply_record(&mut file, "p", &first, &first.sent, None, "t1");
        let second = recorded("s1@2026-09-03T09:00", "daily standup", "missed");
        apply_record(&mut file, "p", &second, &second.sent, None, "t2");
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
