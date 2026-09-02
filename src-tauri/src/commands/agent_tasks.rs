use tauri::{AppHandle, Emitter};

use crate::{
    schema::{AgentScheduleResult, AgentScheduleTargetBinding, ScheduledAgentPrompt},
    services::agent_tasks,
};

const CHANGED_EVENT: &str = "agent-schedules-changed";

fn changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
}

#[tauri::command]
pub fn agent_schedules_list(
    project_id: String,
    schedule_target_id: String,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    agent_tasks::list(&project_id, &schedule_target_id)
}

#[tauri::command]
pub fn agent_schedule_upsert(
    app: AppHandle,
    project_id: String,
    schedule_target_id: String,
    schedule: ScheduledAgentPrompt,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    let result = agent_tasks::upsert(&project_id, &schedule_target_id, schedule)?;
    changed(&app);
    Ok(result)
}

#[tauri::command]
pub fn agent_schedule_delete(
    app: AppHandle,
    project_id: String,
    schedule_target_id: String,
    schedule_id: String,
) -> Result<(), String> {
    agent_tasks::delete(&project_id, &schedule_target_id, &schedule_id)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn agent_schedules_delete_target(
    app: AppHandle,
    project_id: String,
    schedule_target_id: String,
) -> Result<(), String> {
    agent_tasks::delete_target(&project_id, &schedule_target_id)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn agent_schedule_claim(
    project_id: String,
    schedule_target_id: String,
    schedule_id: String,
    occurrence: String,
) -> Result<bool, String> {
    agent_tasks::claim(&project_id, &schedule_target_id, &schedule_id, &occurrence)
}

#[tauri::command]
pub fn agent_schedule_complete(
    app: AppHandle,
    project_id: String,
    schedule_target_id: String,
    schedule_id: String,
    occurrence: String,
    result: AgentScheduleResult,
) -> Result<Vec<ScheduledAgentPrompt>, String> {
    let schedules = agent_tasks::complete(
        &project_id,
        &schedule_target_id,
        &schedule_id,
        &occurrence,
        result,
    )?;
    changed(&app);
    Ok(schedules)
}

#[tauri::command]
pub fn agent_schedules_cleanup_orphans(
    app: AppHandle,
    live: Vec<AgentScheduleTargetBinding>,
) -> Result<usize, String> {
    let removed = agent_tasks::cleanup_orphans(&live)?;
    if removed > 0 {
        changed(&app);
    }
    Ok(removed)
}
