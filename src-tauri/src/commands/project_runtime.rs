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
/// Replaces the `switch_project_windows` round-trip: saves the previous
/// project snapshot, hides its windows, routes downloads, restores the next
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

    // Derive the download target directory.
    let root_dir_buf = storage::root_work_dir();
    let root_dir_str = root_dir_buf.to_string_lossy().into_owned();
    let next_project_dir: String = project_id.as_deref()
        .and_then(|id| projects.iter().find(|p| p.id == id))
        .map(|entry| {
            // Prefer the `directory` extra field; fall back to deriving from local_file.
            entry
                .extra
                .get("directory")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| {
                    if entry.local_file.ends_with("/project.json") {
                        entry.local_file[..entry.local_file.len() - "/project.json".len()].to_string()
                    } else {
                        entry.local_file.clone()
                    }
                })
        })
        .unwrap_or(root_dir_str);

    crate::services::project_runtime::switch(
        &app,
        workspace.inner(),
        win_registry.inner(),
        project_id.as_deref(),
        previous_project_id.as_deref(),
        previous_local_file.as_deref(),
        next_local_file.as_deref(),
        &next_project_dir,
        &previous_snapshot,
    )
}
