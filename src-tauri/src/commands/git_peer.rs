//! Tauri commands for git-aware local↔remote lockstep sync (TODO #28n, Phase 1).
//!
//! Thin wrappers over `services::git_peer`: toggle the per-project opt-in, read the
//! observed status, run a manual reconcile (Retry), and perform a coordinated
//! checkout. The heavy lifting (probe, bundle transport, fast-forward apply, checkout
//! lockstep, base re-stamping) lives in the service so it stays `AppHandle`-free and
//! unit-testable.

use tauri::{AppHandle, State};

use crate::services::git_peer::{self, GitPeerRegistry, GitPeerState};
use crate::services::remote::{remote_target_for, RemotePoolState};
use crate::services::remote_sync::SyncManifestState;
use crate::services::sync_auto::AutoSyncState;

/// Read a project's persisted lockstep state (disabled/synchronized default).
#[tauri::command]
pub async fn git_peer_status(project_id: String) -> Result<GitPeerState, String> {
    Ok(git_peer::load_state(&project_id))
}

/// Toggle the per-project opt-in. Enabling persists the flag, launches the detection
/// task (`.git` watcher + host poll), and reconciles once; disabling stops the task.
/// Returns the resulting state.
#[tauri::command]
pub async fn git_peer_set_enabled(
    app: AppHandle,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
    auto: State<'_, AutoSyncState>,
    reg: State<'_, GitPeerRegistry>,
    project_id: String,
    enabled: bool,
) -> Result<GitPeerState, String> {
    if remote_target_for(&project_id).is_none() {
        return Err("Git lockstep is only available for SSH remote projects".to_string());
    }
    let mut state = git_peer::load_state(&project_id);
    state.enabled = enabled;
    git_peer::save_state(&project_id, &state)?;

    if enabled {
        // start() reads the freshly-persisted `enabled`, attaches the watcher, and
        // runs an initial detect+emit in its loop.
        git_peer::start(
            app,
            pool.inner().clone(),
            manifest.inner().clone(),
            auto.inner().clone(),
            reg.inner(),
            &project_id,
        )
        .await;
    } else {
        git_peer::stop(reg.inner(), &project_id).await;
    }
    Ok(git_peer::load_state(&project_id))
}

/// Manually reconcile now (the Retry / "Sync git" action). Runs a detection pass and
/// emits the new status.
#[tauri::command]
pub async fn git_peer_sync_now(
    app: AppHandle,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
    auto: State<'_, AutoSyncState>,
    project_id: String,
) -> Result<GitPeerState, String> {
    let target = remote_target_for(&project_id)
        .ok_or("Git lockstep is only available for SSH remote projects")?;
    let state = git_peer::detect_and_sync(
        pool.inner(),
        manifest.inner(),
        auto.inner(),
        &project_id,
        &target.spec,
    )
    .await;
    git_peer::emit_status(&app, &project_id, &state);
    Ok(state)
}

/// Coordinated checkout: check `target` out on the initiating side, bring the peer in
/// step, and check the same target out there (guarded — never `-f`). `initiating_side`
/// is `"local"` or `"remote"` (default `"local"`; the frontend passes `initiatingSide`).
#[tauri::command]
pub async fn git_peer_checkout(
    app: AppHandle,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
    auto: State<'_, AutoSyncState>,
    project_id: String,
    target: String,
    initiating_side: Option<String>,
) -> Result<GitPeerState, String> {
    let rt = remote_target_for(&project_id)
        .ok_or("Git lockstep is only available for SSH remote projects")?;
    let side = initiating_side.unwrap_or_else(|| "local".to_string());
    let state = git_peer::checkout_lockstep(
        pool.inner(),
        manifest.inner(),
        auto.inner(),
        &project_id,
        &rt.spec,
        &target,
        &side,
        false,
    )
    .await?;
    git_peer::emit_status(&app, &project_id, &state);
    Ok(state)
}
