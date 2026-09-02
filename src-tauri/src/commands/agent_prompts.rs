use tauri::{AppHandle, Emitter};

use crate::{
    schema::agent_prompts::{
        ProjectAgentPrompt, ProjectAgentPromptInput, RecordedAgentPromptInput, SentAgentPrompt,
        SentAgentPromptInput,
    },
    services::agent_prompts,
};

const CHANGED_EVENT: &str = "agent-prompts-changed";

fn changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
}

#[tauri::command]
pub fn agent_prompts_list(project_id: String) -> Result<Vec<ProjectAgentPrompt>, String> {
    agent_prompts::list(&project_id)
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

#[tauri::command]
pub fn agent_prompt_history_list(project_id: String) -> Result<Vec<SentAgentPrompt>, String> {
    agent_prompts::history(&project_id)
}

/// Retire a collected prompt to the history after it has been aimed at a tab.
/// Returns the remaining active prompts; the history is reloaded separately.
#[tauri::command]
pub fn agent_prompt_archive(
    app: AppHandle,
    project_id: String,
    prompt_id: String,
    sent: SentAgentPromptInput,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    let result = agent_prompts::archive(&project_id, &prompt_id, sent)?;
    changed(&app);
    Ok(result)
}

/// Record a delivery the scheduler made. Nothing was collected, so this
/// returns the history rather than the active list; an entry already written
/// under this id (a send-now prompt archived when it was queued) is updated in
/// place with the outcome.
#[tauri::command]
pub fn agent_prompt_record(
    app: AppHandle,
    project_id: String,
    entry: RecordedAgentPromptInput,
) -> Result<Vec<SentAgentPrompt>, String> {
    let result = agent_prompts::record(&project_id, entry)?;
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
