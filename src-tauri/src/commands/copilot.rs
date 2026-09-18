//! Thin commands over `services::copilot`. The project's directory and
//! remoteness always come from `services::remote`, never from the payload, and
//! the consent policy is re-applied on every call that can reach the server.
use crate::schema::settings::CompletionProjectPolicy;
use crate::schema::Settings;
use crate::services::copilot::documents::Position;
use crate::services::copilot::policy::{self, PolicyError};
use crate::services::copilot::session::{sessions, CompletionRequest, DeviceCode, Session};
use crate::services::copilot::process;
use crate::services::remote;
use crate::storage;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn settings_path() -> PathBuf {
    storage::state_dir().join("settings.json")
}

fn policy_code(error: PolicyError) -> String {
    match error {
        PolicyError::Disabled => "copilot_disabled",
        PolicyError::Remote => "copilot_remote_project",
        PolicyError::NoConsent => "copilot_no_consent",
        PolicyError::LocalOnly => "copilot_local_only",
        PolicyError::InvalidPath => "copilot_invalid_path",
        PolicyError::OutsideProject => "copilot_outside_project",
    }
    .into()
}

fn authorize(project_id: &str) -> Result<PathBuf, String> {
    let path = settings_path();
    let settings: Settings = if path.exists() {
        storage::read_json(&path).map_err(|_| "copilot_disabled")?
    } else {
        Settings::default()
    };
    let directory = remote::project_directory(project_id).ok_or("copilot_no_consent")?;
    let is_remote = remote::remote_target_for(project_id).is_some();
    policy::authorize_project(&settings, project_id, Path::new(&directory), is_remote).map_err(policy_code)
}

/// A refusal is also a revocation: whatever was running for the project stops.
async fn session(project_id: &str) -> Result<(Arc<Session>, PathBuf), String> {
    match authorize(project_id) {
        Ok(root) => Ok((sessions().get_or_start(project_id, &root).await?, root)),
        Err(error) => {
            sessions().stop(project_id).await;
            Err(error)
        }
    }
}

/// Editors are per window: one window can never cancel, close or report
/// feedback for another's documents.
fn editor_key(window: &tauri::Window, editor: &str) -> Result<String, String> {
    if editor.is_empty() || editor.len() > 64 {
        return Err("copilot_document_limit".into());
    }
    Ok(format!("{}:{editor}", window.label()))
}

#[tauri::command]
pub fn copilot_setup() -> Value {
    let installed = process::server_path(&process::install_directory()).is_ok();
    json!({
        "supported": process::supported(),
        "installed": installed,
        "installCommand": process::install_command().ok(),
    })
}

#[tauri::command]
pub fn copilot_project_policy(project_id: String) -> Value {
    let settings: Settings = storage::read_json(&settings_path()).unwrap_or_default();
    let policy = settings.completion_project_policies.as_ref().and_then(|p| p.get(&project_id));
    json!({
        "copilot": policy.is_some_and(|p| p.copilot),
        "localOnly": policy.is_some_and(|p| p.local_only),
        "remote": remote::remote_target_for(&project_id).is_some(),
        "authorized": authorize(&project_id).is_ok(),
    })
}

/// Consent binds the project id to the directory the backend resolves now.
/// Returns the settings that won, like `patch_settings`, for the sender to
/// broadcast.
#[tauri::command]
pub async fn copilot_set_project_policy(project_id: String, copilot: bool, local_only: bool) -> Result<Settings, String> {
    let directory = remote::project_directory(&project_id).ok_or("copilot_invalid_path")?;
    if copilot && remote::remote_target_for(&project_id).is_some() {
        return Err("copilot_remote_project".into());
    }
    let directory = Path::new(&directory).canonicalize().map_err(|_| "copilot_invalid_path")?;
    let saved = storage::patch_json(&settings_path(), Settings::default(), |settings| {
        let policies = settings.completion_project_policies.get_or_insert_with(Default::default);
        let extra = policies.remove(&project_id).map(|old| old.extra).unwrap_or_default();
        policies.insert(project_id.clone(), CompletionProjectPolicy {
            directory: directory.to_string_lossy().into_owned(), copilot, local_only, extra,
        });
        Ok(settings.clone())
    })?;
    if !copilot || local_only {
        sessions().stop(&project_id).await;
    }
    Ok(saved)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn copilot_complete(
    window: tauri::Window,
    project_id: String,
    path: String,
    editor: String,
    version: u64,
    text: String,
    language: String,
    position: Position,
    automatic: bool,
    tab_size: u32,
    insert_spaces: bool,
) -> Result<Vec<Value>, String> {
    let editor = editor_key(&window, &editor)?;
    let (session, root) = session(&project_id).await?;
    let file = policy::authorize_document(&root, Path::new(&path)).map_err(policy_code)?;
    let uri = url::Url::from_file_path(&file).map_err(|_| "copilot_invalid_path")?;
    session.complete(CompletionRequest {
        uri: uri.as_str(), editor: &editor, client_version: version, text: &text, language: &language,
        position, automatic, tab_size: tab_size.clamp(1, 16), insert_spaces,
    }).await
}

#[tauri::command]
pub async fn copilot_cancel(window: tauri::Window, project_id: String, editor: String) -> Result<(), String> {
    let editor = editor_key(&window, &editor)?;
    if let Some(session) = sessions().existing(&project_id).await {
        session.cancel(&editor).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn copilot_close_editor(window: tauri::Window, project_id: String, editor: String) -> Result<(), String> {
    let editor = editor_key(&window, &editor)?;
    if let Some(session) = sessions().existing(&project_id).await {
        session.close_editor(&editor).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn copilot_shown(window: tauri::Window, project_id: String, editor: String, candidate: String) -> Result<(), String> {
    let editor = editor_key(&window, &editor)?;
    match sessions().existing(&project_id).await {
        Some(session) => session.shown(&editor, &candidate).await,
        None => Ok(()),
    }
}

/// `accepted_length` omitted is the full acceptance.
#[tauri::command]
pub async fn copilot_accepted(
    window: tauri::Window,
    project_id: String,
    editor: String,
    candidate: String,
    accepted_length: Option<u32>,
) -> Result<(), String> {
    let editor = editor_key(&window, &editor)?;
    match sessions().existing(&project_id).await {
        Some(session) => session.accepted(&editor, &candidate, accepted_length).await,
        None => Ok(()),
    }
}

/// Never starts a server: a status read must not be what sends a project's
/// workspace to a subprocess.
#[tauri::command]
pub async fn copilot_account(project_id: String) -> Result<Value, String> {
    let Some(session) = sessions().existing(&project_id).await.filter(|session| session.alive()) else {
        return Ok(json!({"running": false}));
    };
    let account = session.account().await.ok();
    Ok(json!({"running": true, "status": session.status(), "account": account}))
}

#[tauri::command]
pub async fn copilot_sign_in(project_id: String) -> Result<Option<DeviceCode>, String> {
    session(&project_id).await?.0.sign_in().await
}

#[tauri::command]
pub async fn copilot_finish_sign_in(project_id: String) -> Result<(), String> {
    session(&project_id).await?.0.finish_sign_in().await
}

#[tauri::command]
pub async fn copilot_sign_out(project_id: String) -> Result<(), String> {
    match sessions().existing(&project_id).await {
        Some(session) => session.sign_out().await,
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn copilot_stop(project_id: String) {
    sessions().stop(&project_id).await;
}

/// `RunEvent::Exit`: no language server outlives Eldrun.
pub async fn stop_all_for_exit() {
    sessions().stop_all().await;
}
