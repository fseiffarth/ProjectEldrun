use tauri::{AppHandle, Emitter};

use crate::{
    schema::agent_prompts::{
        ProjectAgentPrompt, ProjectAgentPromptInput, PromptLink, PromptLinkInput,
        RecordedAgentPromptInput, SentAgentPrompt, SentAgentPromptInput,
    },
    services::agent_prompts,
};

use super::git::run_off_thread;

const CHANGED_EVENT: &str = "agent-prompts-changed";

fn changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
}

#[tauri::command]
pub fn agent_prompts_list(project_id: String) -> Result<Vec<ProjectAgentPrompt>, String> {
    agent_prompts::list(&project_id)
}

#[tauri::command]
pub fn agent_prompt_links_list(project_id: String) -> Result<Vec<PromptLink>, String> {
    agent_prompts::links(&project_id)
}

#[tauri::command]
pub fn agent_prompt_link_upsert(
    app: AppHandle,
    project_id: String,
    link: PromptLinkInput,
) -> Result<Vec<PromptLink>, String> {
    let result = agent_prompts::link_upsert(&project_id, link)?;
    changed(&app);
    Ok(result)
}

#[tauri::command]
pub fn agent_prompt_link_delete(
    app: AppHandle,
    project_id: String,
    link_id: String,
) -> Result<Vec<PromptLink>, String> {
    let result = agent_prompts::link_delete(&project_id, &link_id)?;
    changed(&app);
    Ok(result)
}

#[tauri::command]
pub fn agent_prompt_upsert(
    app: AppHandle,
    project_id: String,
    prompt: ProjectAgentPromptInput,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    let result = agent_prompts::upsert(&project_id, prompt)?;
    changed(&app);
    Ok(result)
}

#[tauri::command]
pub fn agent_prompt_delete(
    app: AppHandle,
    project_id: String,
    prompt_id: String,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    let result = agent_prompts::delete(&project_id, &prompt_id)?;
    changed(&app);
    Ok(result)
}

/// Reorder a project's collected prompts — the order a drag left them in. The
/// caller sends the ids in their new order; anything it did not name keeps its
/// relative place after them.
#[tauri::command]
pub fn agent_prompt_reorder(
    app: AppHandle,
    project_id: String,
    ids: Vec<String>,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    let result = agent_prompts::reorder(&project_id, ids)?;
    changed(&app);
    Ok(result)
}

#[tauri::command]
pub fn agent_prompt_history_list(project_id: String) -> Result<Vec<SentAgentPrompt>, String> {
    agent_prompts::history(&project_id)
}

/// Retire a collected prompt to the history after it has been aimed at a tab.
/// Returns the remaining active prompts; the history is reloaded separately.
///
/// Off-thread, like the git commands: the row is stamped with the project's
/// HEAD (`services::prompt_blame`), which spawns git for a local project.
#[tauri::command]
pub async fn agent_prompt_archive(
    app: AppHandle,
    project_id: String,
    prompt_id: String,
    sent: SentAgentPromptInput,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    let result =
        run_off_thread(move || agent_prompts::archive(&project_id, &prompt_id, sent)).await?;
    changed(&app);
    Ok(result)
}

/// Record a delivery the scheduler made. Nothing was collected, so this
/// returns the history rather than the active list; an entry already written
/// under this id (a send-now prompt archived when it was queued) is updated in
/// place with the outcome.
#[tauri::command]
pub async fn agent_prompt_record(
    app: AppHandle,
    project_id: String,
    entry: RecordedAgentPromptInput,
) -> Result<Vec<SentAgentPrompt>, String> {
    let result = run_off_thread(move || agent_prompts::record(&project_id, entry)).await?;
    changed(&app);
    Ok(result)
}

/// Prompt blame: record on one history row the files that changed between
/// its delivery (or `since`, the moment the scheduler submitted the text) and
/// now. The scheduler calls it once, when it sees the tab idle again after a
/// delivery. Returns the project's history.
#[tauri::command]
pub async fn agent_prompt_blame(
    app: AppHandle,
    project_id: String,
    entry_id: String,
    since: Option<String>,
) -> Result<Vec<SentAgentPrompt>, String> {
    let result =
        run_off_thread(move || agent_prompts::blame(&project_id, &entry_id, since.as_deref()))
            .await?;
    changed(&app);
    Ok(result)
}

#[tauri::command]
pub fn agent_prompt_history_clear(
    app: AppHandle,
    project_id: String,
    entry_id: Option<String>,
) -> Result<Vec<SentAgentPrompt>, String> {
    let result = agent_prompts::clear_history(&project_id, entry_id.as_deref())?;
    changed(&app);
    Ok(result)
}
