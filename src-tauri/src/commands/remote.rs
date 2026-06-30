//! Pooled remote-connection commands (Phase 0 of mount-free remote).
//!
//! The frontend calls these fire-and-forget on project activation/deactivation
//! to open and close the single persistent SSH/SFTP connection per active remote
//! project (see `services::remote`). Opening it once is what gives single
//! sign-on: the master authenticates here and every later channel (file browse /
//! I-O, agent tabs, git over ssh) rides it.

use tauri::State;

use crate::services::remote::{self, RemotePoolState};

/// Open (idempotently) the pooled SSH/SFTP connection for a remote project,
/// authenticating once. A no-op for a local project or one already connected.
/// `password` is used only for password-auth hosts (never stored); `None` →
/// key/agent auth. Returned errors are logged by the caller, never blocking
/// activation.
#[tauri::command]
pub async fn remote_connect(
    pool: State<'_, RemotePoolState>,
    project_id: String,
    password: Option<String>,
) -> Result<(), String> {
    remote::connect(pool.inner(), &project_id, password.as_deref()).await
}

/// Close and drop the pooled connection for a remote project (on deactivation).
/// No-op if nothing is pooled for it.
#[tauri::command]
pub async fn remote_disconnect(
    pool: State<'_, RemotePoolState>,
    project_id: String,
) -> Result<(), String> {
    remote::disconnect(pool.inner(), &project_id).await;
    Ok(())
}
