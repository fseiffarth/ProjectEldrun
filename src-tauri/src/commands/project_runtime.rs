//! Thin Tauri dispatch layer for project-runtime switching.
//! Business logic lives in `services::project_runtime`.

use tauri::{AppHandle, State};

use crate::commands::apps::WindowRegistryState;
use crate::commands::workspace::WorkspaceStateArc;
use crate::schema::projects::ProjectsList;
use crate::services::project_runtime::{
    PreviousProjectSnapshot, ProjectRuntimeSwitchedPayload,
};
use crate::storage;

/// Switch the active project runtime.
///
/// Saves the previous project snapshot, hides its windows, restores the next
/// project's apps and windows, and emits `project-runtime-switched`.
#[tauri::command]
pub fn switch_project_runtime(
    app: AppHandle,
    workspace: State<'_, WorkspaceStateArc>,
    win_registry: State<'_, WindowRegistryState>,
    project_id: Option<String>,
    previous_project_id: Option<String>,
    previous_snapshot: PreviousProjectSnapshot,
) -> Result<ProjectRuntimeSwitchedPayload, String> {
    // Look up local_file paths from the global project list.
    let list_path = storage::state_dir().join("projects.json");
    let projects: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).unwrap_or_default()
    } else {
        vec![]
    };

    let find_local_file = |id: &str| {
        projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.local_file.clone())
    };

    let previous_local_file = previous_project_id
        .as_deref()
        .and_then(find_local_file);
    let next_local_file = project_id.as_deref().and_then(find_local_file);

    crate::services::project_runtime::switch(
        &app,
        workspace.inner(),
        win_registry.inner(),
        project_id.as_deref(),
        previous_project_id.as_deref(),
        previous_local_file.as_deref(),
        next_local_file.as_deref(),
        &previous_snapshot,
    )
}
