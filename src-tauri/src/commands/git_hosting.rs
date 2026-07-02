//! Per-project git-hosting overrides (profile URL + access token) that take
//! precedence over the global `settings.json` values when set.
//!
//! The non-secret profile URL is persisted in the project's `project.json`
//! (mirrored into `projects.json` so the pill can read it without loading the
//! per-project file). The secret token lives only in the OS keyring
//! (`services::git_credentials`), keyed by project id — never on disk in our JSON
//! state. `git_push` / `publish_project` resolve the *effective* credentials via
//! [`effective_git_creds`]: the per-project value if present, else the global one.

use std::path::PathBuf;

use serde_json::Value;

use crate::schema::project::Project;
use crate::schema::projects::ProjectsList;
use crate::schema::settings::Settings;
use crate::services::git_credentials;
use crate::storage;

/// What the frontend gets back about a project's git hosting. The token itself is
/// never returned — only whether one is stored — so the secret stays out of the
/// renderer.
#[derive(serde::Serialize)]
pub struct GitHostingInfo {
    /// Per-project profile URL override, if any.
    pub profile_url: Option<String>,
    /// Whether a per-project token is stored in the keyring.
    pub has_token: bool,
    /// The global fallback profile URL (from settings.json), shown as the
    /// placeholder/inherited value in the editor.
    pub global_profile_url: Option<String>,
    /// Whether a global token exists to fall back on.
    pub has_global_token: bool,
}

/// Read effective hosting config for the project-settings editor.
#[tauri::command]
pub fn get_project_git_hosting(project_id: String) -> Result<GitHostingInfo, String> {
    let project = project_for(&project_id)?;
    let settings = read_settings();
    Ok(GitHostingInfo {
        profile_url: project.git_profile_url.filter(|s| !s.is_empty()),
        has_token: git_credentials::has_token(&project_id),
        global_profile_url: settings
            .as_ref()
            .and_then(|s| s.git_profile_url.clone())
            .filter(|s| !s.is_empty()),
        has_global_token: settings
            .as_ref()
            .and_then(|s| s.git_token.clone())
            .map(|t| !t.is_empty())
            .unwrap_or(false),
    })
}

/// Write the per-project hosting override. `profile_url` is stored in
/// project.json + projects.json (cleared when blank). The token is stored in the
/// keyring when `token` is `Some`; when `clear_token` is true the stored token is
/// removed. A `token` of `None` with `clear_token` false leaves the token as-is
/// (so saving just the URL doesn't wipe an existing secret).
#[tauri::command]
pub fn set_project_git_hosting(
    project_id: String,
    profile_url: Option<String>,
    token: Option<String>,
    clear_token: bool,
) -> Result<GitHostingInfo, String> {
    let cleaned_url = profile_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // project.json — authoritative per-project store for the URL.
    let (idx, mut list) = find_entry(&project_id)?;
    let local_file = list[idx].local_file.clone();
    let proj_path = PathBuf::from(&local_file);
    if proj_path.exists() {
        if let Ok(mut project) = storage::read_json::<Project>(&proj_path) {
            project.git_profile_url = cleaned_url.clone();
            storage::write_json(&proj_path, &project).map_err(|e| e.to_string())?;
        }
    }

    // projects.json — mirror into the pill list entry's flattened `extra` so the
    // frontend sees it without reading project.json (kept consistent with how
    // `git_type`/`description` are mirrored).
    match &cleaned_url {
        Some(url) => {
            list[idx]
                .extra
                .insert("git_profile_url".to_string(), Value::String(url.clone()));
        }
        None => {
            list[idx].extra.remove("git_profile_url");
        }
    }
    storage::write_json(&storage::state_dir().join("projects.json"), &list)
        .map_err(|e| e.to_string())?;

    // Token → keyring. Only touch it when explicitly provided/cleared.
    if clear_token {
        git_credentials::set_token(&project_id, None)?;
    } else if token.is_some() {
        git_credentials::set_token(&project_id, token.as_deref())?;
    }

    get_project_git_hosting(project_id)
}

/// The credentials to actually use for a project's push/publish: the per-project
/// override if present, otherwise the global `settings.json` value. Returns
/// `(profile_url, token)`. Used by `git::git_push` and `git_publish::publish_project`.
pub fn effective_git_creds(project_id: &str) -> (Option<String>, Option<String>) {
    let settings = read_settings();
    let project = project_for(project_id).ok();

    let profile_url = project
        .as_ref()
        .and_then(|p| p.git_profile_url.clone())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            settings
                .as_ref()
                .and_then(|s| s.git_profile_url.clone())
                .filter(|s| !s.is_empty())
        });

    // Per-project token (keyring) wins; else the global token from settings.json.
    let token = git_credentials::get_token(project_id).or_else(|| {
        settings
            .as_ref()
            .and_then(|s| s.git_token.clone())
            .filter(|s| !s.is_empty())
    });

    (profile_url, token)
}

fn read_settings() -> Option<Settings> {
    let path = storage::state_dir().join("settings.json");
    if path.exists() {
        storage::read_json::<Settings>(&path).ok()
    } else {
        None
    }
}

/// Read a project's `project.json` by id (via its `local_file` in projects.json).
fn project_for(project_id: &str) -> Result<Project, String> {
    let (idx, list) = find_entry(project_id)?;
    let local_file = list[idx].local_file.clone();
    storage::read_json::<Project>(&PathBuf::from(&local_file)).map_err(|e| e.to_string())
}

/// Find a project entry by id, returning its index and the owned list so the
/// caller can mutate + persist it. (Mirrors the helper in `commands::git_publish`.)
fn find_entry(project_id: &str) -> Result<(usize, ProjectsList), String> {
    let list_path = storage::state_dir().join("projects.json");
    let list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let idx = list
        .iter()
        .position(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    Ok((idx, list))
}
