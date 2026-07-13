//! Pooled remote-connection commands (Phase 0 of mount-free remote).
//!
//! The frontend calls these fire-and-forget on project activation/deactivation
//! to open and close the single persistent SSH/SFTP connection per active remote
//! project (see `services::remote`). Opening it once is what gives single
//! sign-on: the master authenticates here and every later channel (file browse /
//! I-O, agent tabs, git over ssh) rides it.

use tauri::{AppHandle, State};

use crate::services::git_peer::{self, GitPeerRegistry};
use crate::services::remote::{self, RemotePoolState};
use crate::services::remote_sync::SyncManifestState;
use crate::services::sync_auto::{self, AutoSyncState};

/// Open (idempotently) the pooled SSH/SFTP connection for a remote project,
/// authenticating once. A no-op for a local project or one already connected.
/// `password` is used only for password-auth hosts (never stored); `None` →
/// key/agent auth. Returned errors are logged by the caller, never blocking
/// activation.
///
/// On a successful connect the per-project auto-sync task is launched (idempotent;
/// itself a no-op for a local project), so any paths the user marked auto-sync
/// start reconciling in the background.
#[tauri::command]
pub async fn remote_connect(
    app: AppHandle,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
    auto: State<'_, AutoSyncState>,
    git_peer_reg: State<'_, GitPeerRegistry>,
    project_id: String,
    password: Option<String>,
) -> Result<(), String> {
    remote::connect(pool.inner(), &project_id, password.as_deref()).await?;
    // The connect succeeded; record whether it needed a password at all. No password
    // passed *and* none in the keychain means the host authenticated via key/agent —
    // the only way the UI can tell a passwordless host is auto-connect-eligible,
    // since such a host has no keychain entry to look for. Best effort.
    if let Some(target) = remote::remote_target_for(&project_id) {
        let spec = &target.spec;
        let saved = crate::services::remote_credentials::has(
            &crate::services::remote_credentials::ssh_account(&spec.user, &spec.host, spec.port),
        );
        let key_auth = password.is_none() && !saved;
        if let Err(e) = crate::commands::projects::record_remote_key_auth(&project_id, key_auth) {
            eprintln!("record auth mode for '{project_id}' failed: {e}");
        }
    }
    sync_auto::start(
        app.clone(),
        pool.inner().clone(),
        manifest.inner().clone(),
        auto.inner(),
        &project_id,
    )
    .await;
    // Launch git lockstep only when the project has opted in (start() itself no-ops
    // otherwise); it attaches the .git watcher + host poll and reconciles once.
    git_peer::start(
        app,
        pool.inner().clone(),
        manifest.inner().clone(),
        auto.inner().clone(),
        git_peer_reg.inner(),
        &project_id,
    )
    .await;
    Ok(())
}

/// Close and drop the pooled connection for a remote project (on deactivation).
/// Stops the auto-sync task first (cancel + unwatch), then tears down the pool.
/// No-op if nothing is pooled for it.
#[tauri::command]
pub async fn remote_disconnect(
    pool: State<'_, RemotePoolState>,
    auto: State<'_, AutoSyncState>,
    git_peer_reg: State<'_, GitPeerRegistry>,
    project_id: String,
) -> Result<(), String> {
    git_peer::stop(git_peer_reg.inner(), &project_id).await;
    sync_auto::stop(auto.inner(), &project_id).await;
    remote::disconnect(pool.inner(), &project_id).await;
    Ok(())
}
