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
    worker_sync: State<'_, crate::services::worker_sync::WorkerSyncState>,
    project_id: String,
    host_id: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| remote::PRIMARY_HOST.to_string());
    remote::connect_host(pool.inner(), &project_id, &host_id, password.as_deref()).await?;

    // Best-effort "is this host already busy?" check, off the connect critical
    // path: it runs one extra SSH round trip (riding the same ControlMaster this
    // connect just opened), so it is spawned rather than awaited — a slow or
    // failing probe must never delay activation. Fires for ANY host (primary or a
    // multi-host `compute_hosts` worker) that just connected — the frontend's
    // warning dialog groups every connected host's report by `host_id` into one
    // combined view instead of only ever showing the primary's.
    if let Some(target) = remote::remote_target_for_host(&project_id, &host_id) {
        let app_for_usage = app.clone();
        let usage_spec = target.spec.clone();
        let usage_project_id = project_id.clone();
        let usage_host_id = host_id.clone();
        tauri::async_runtime::spawn(async move {
            let result = tauri::async_runtime::spawn_blocking(move || {
                crate::services::remote_usage::check_usage(&usage_spec)
            })
            .await;
            if let Ok(Ok(report)) = result {
                crate::services::remote_usage::emit_usage_report(
                    &app_for_usage,
                    &usage_project_id,
                    &usage_host_id,
                    &report,
                );
            }
        });
    }

    // A WORKER connect skips the bidirectional primary machinery (git lockstep +
    // byte-sync own the primary only) and instead kicks the push-only code fan-out
    // that brings the worker's tracked tree up to the source HEAD (plan §2/§3.3).
    // Exception: a SHARED-FILESYSTEM worker has no copy of its own — its tabs `cd`
    // straight into the primary's shared folder — so there is nothing to sync and
    // git must never run against that tree. Just leave the pool open.
    if host_id != remote::PRIMARY_HOST {
        let hosts = remote::compute_hosts_for(&project_id);
        let worker = hosts.iter().find(|h| h.id == host_id);
        let shared = worker.map(|h| h.shared_fs).unwrap_or(false);
        // Record whether this worker authenticated with no password at all
        // (key/agent auth) — the worker twin of the primary's key_auth recording
        // below. It is the only way the Connect dialog can mark a passwordless
        // worker auto-connect-eligible (it has nothing in the keychain to check),
        // so without it a shared-fs HPC worker's Auto-connect toggle never enables.
        if let Some(w) = worker {
            let saved = crate::services::remote_credentials::has(
                &crate::services::remote_credentials::ssh_account(
                    &w.spec.user,
                    &w.spec.host,
                    w.spec.port,
                ),
            );
            let key_auth = password.is_none() && !saved;
            if let Err(e) = crate::commands::projects::record_worker_key_auth(
                &project_id,
                &host_id,
                key_auth,
            ) {
                eprintln!("record worker auth mode for '{project_id}/{host_id}' failed: {e}");
            }
        }
        if !shared {
            crate::services::worker_sync::on_worker_connect(
                app.clone(),
                pool.inner().clone(),
                worker_sync.inner().clone(),
                &project_id,
                &host_id,
            )
            .await;
        }
        return Ok(());
    }

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
        worker_sync.inner().clone(),
        &project_id,
    )
    .await;
    Ok(())
}

/// The ids of every project whose pooled SSH connection is currently live —
/// the authoritative backend truth `remote::is_connected` already computes for
/// `network_ssh_link_snapshot`. Lets the frontend periodically reconcile
/// `useRemoteStatusStore` (which only ever moves on an explicit connect/
/// disconnect result) against reality: a pooled ssh child that exits on its own
/// — a network drop, a keepalive eviction, a VPN tunnel getting replaced out
/// from under it — is only ever noticed lazily, the next time some other
/// command happens to touch that project's pool entry. Until then the lamp and
/// the Connect dialog both keep reporting "connected" from stale frontend
/// state while every read that actually asks the pool (like the network-
/// traffic pane) correctly reports disconnected.
#[tauri::command]
pub async fn remote_connected_ids(pool: State<'_, RemotePoolState>) -> Result<Vec<String>, ()> {
    Ok(remote::connected_ids(pool.inner()).await)
}

/// Close and drop the pooled connection for a remote project host (on
/// deactivation, or a per-host lamp toggle). `host_id` defaults to the primary.
/// For the **primary**, stops the auto-sync + git-lockstep tasks first (cancel +
/// unwatch), then tears down the pool; a **worker** disconnect only drops its pool
/// entry (it owns no lockstep/sync). No-op if nothing is pooled for it.
#[tauri::command]
pub async fn remote_disconnect(
    pool: State<'_, RemotePoolState>,
    auto: State<'_, AutoSyncState>,
    git_peer_reg: State<'_, GitPeerRegistry>,
    project_id: String,
    host_id: Option<String>,
) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| remote::PRIMARY_HOST.to_string());
    if host_id == remote::PRIMARY_HOST {
        git_peer::stop(git_peer_reg.inner(), &project_id).await;
        sync_auto::stop(auto.inner(), &project_id).await;
    }
    remote::disconnect_host(pool.inner(), &project_id, &host_id).await;
    Ok(())
}

/// Disconnect **every** host of a remote project — primary and all workers — on
/// project deactivation. Stops the primary's lockstep/auto-sync, then tears down
/// all pooled entries for the project.
#[tauri::command]
pub async fn remote_disconnect_all_hosts(
    pool: State<'_, RemotePoolState>,
    auto: State<'_, AutoSyncState>,
    git_peer_reg: State<'_, GitPeerRegistry>,
    project_id: String,
) -> Result<(), String> {
    git_peer::stop(git_peer_reg.inner(), &project_id).await;
    sync_auto::stop(auto.inner(), &project_id).await;
    remote::disconnect_project(pool.inner(), &project_id).await;
    Ok(())
}

/// The `(project_id, host_id)` pairs whose pooled SSH connection is currently live
/// — the per-host granular form of [`remote_connected_ids`], for the frontend to
/// reconcile each host lamp against reality (see that command's rationale).
#[tauri::command]
pub async fn remote_connected_targets(
    pool: State<'_, RemotePoolState>,
) -> Result<Vec<(String, String)>, ()> {
    Ok(remote::connected_targets(pool.inner()).await)
}

/// Manually push the mirror's current HEAD to a remote project's worker host (the
/// pill's "Sync code now"). `force` re-pushes even when the worker is recorded as
/// already at HEAD. Emits a `worker-sync-report` and returns the same report.
#[tauri::command]
pub async fn worker_sync_now(
    pool: State<'_, RemotePoolState>,
    project_id: String,
    host_id: String,
) -> Result<crate::services::worker_sync::WorkerSyncReport, String> {
    let report =
        crate::services::worker_sync::sync_worker(pool.inner(), &project_id, &host_id, true).await;
    Ok(report)
}

/// Preview the size of a worker's pullable experiment outputs (its untracked
/// files) so the frontend can confirm before a large transfer (plan §4.4).
#[tauri::command]
pub async fn worker_outputs_preview(
    project_id: String,
    host_id: String,
) -> Result<crate::services::worker_sync::WorkerOutputsPreview, String> {
    crate::services::worker_sync::preview_outputs(&project_id, &host_id).await
}

/// Pull a worker's untracked outputs into a local `outputs/<label>/` folder — the
/// one, user-initiated worker→local byte path (plan §4.4/§8).
#[tauri::command]
pub async fn worker_pull_outputs(
    pool: State<'_, RemotePoolState>,
    project_id: String,
    host_id: String,
) -> Result<crate::services::worker_sync::WorkerPullReport, String> {
    crate::services::worker_sync::pull_outputs(pool.inner(), &project_id, &host_id).await
}

/// Upload a LOCAL file to a remote project's tree over the pooled SFTP, streaming
/// it in bounded chunks (so a large dataset never buffers whole). `dest_rel` is a
/// project-relative destination path (its parent dirs are created); the file lands
/// at `<remote_path>/<dest_rel>`. Used by the HPC pipeline wizard's "Load data"
/// step (`docs/quirky-knitting-umbrella` plan). Primary host only; the project must
/// already be connected (a cold pool errors rather than opening a second master).
///
/// `dest_rel` is sanitized to stay inside the project root: a leading `/` is
/// dropped and a `..` component is refused, so an upload can never escape the tree.
#[tauri::command]
pub async fn remote_upload_file(
    pool: State<'_, RemotePoolState>,
    project_id: String,
    local_path: String,
    dest_rel: String,
) -> Result<String, String> {
    let target = remote::remote_target_for(&project_id)
        .ok_or_else(|| "not a remote project".to_string())?;
    let rel = dest_rel.trim().trim_start_matches('/');
    if rel.is_empty() {
        return Err("no destination given".to_string());
    }
    if rel.split('/').any(|c| c == ".." || c == ".") {
        return Err(format!("invalid destination path '{dest_rel}'"));
    }
    let root = target.spec.remote_path.trim_end_matches('/');
    let dest = format!("{root}/{rel}");
    let sftp = remote::pooled_sftp(pool.inner(), &project_id)
        .await
        .ok_or_else(|| "remote project is not connected".to_string())?;
    crate::services::sftp::upload_file_streaming_on(&sftp, std::path::Path::new(&local_path), &dest)
        .await?;
    Ok(dest)
}

/// List the tmux sessions running on a remote project host (TODO #85), for the
/// Sessions view. Runs `tmux ls` over the pooled ControlMaster; an absent tmux or
/// a not-running server yields an **empty** list, never an error (see
/// `ssh_exec::parse_tmux_ls`). `host_id` defaults to the primary.
#[tauri::command]
pub async fn remote_tmux_list(
    project_id: String,
    host_id: Option<String>,
) -> Result<Vec<crate::services::ssh_exec::TmuxSession>, String> {
    let host_id = host_id.unwrap_or_else(|| remote::PRIMARY_HOST.to_string());
    let target = remote::remote_target_for_host(&project_id, &host_id)
        .ok_or_else(|| "not a remote project host".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = crate::services::ssh_exec::run_remote_script(
            &target.spec,
            crate::services::ssh_exec::tmux_ls_script(),
        )?;
        Ok(crate::services::ssh_exec::parse_tmux_ls(
            &String::from_utf8_lossy(&out.stdout),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Kill a tmux session on a remote project host (TODO #85) — the destructive
/// intent behind an **explicit** tab close of a persistent remote tab, and the
/// Sessions view's per-row Kill. Fired only on explicit close (an app-exit /
/// disconnect / respawn deliberately leaves the session alive). `host_id`
/// defaults to the primary; `session` is `shell_quote`d inside the script.
#[tauri::command]
pub async fn remote_tmux_kill(
    project_id: String,
    host_id: Option<String>,
    session: String,
) -> Result<(), String> {
    let host_id = host_id.unwrap_or_else(|| remote::PRIMARY_HOST.to_string());
    let target = remote::remote_target_for_host(&project_id, &host_id)
        .ok_or_else(|| "not a remote project host".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::ssh_exec::run_remote_script(
            &target.spec,
            &crate::services::ssh_exec::tmux_kill_session_script(&session),
        )
        .map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Rename a tmux session on a remote project host (TODO #85) — the Sessions
/// view's per-row Rename. `new_name` must be a safe tmux name
/// (`ssh_exec::valid_tmux_session_name`); the (possibly foreign) `session` source
/// name is only quoted. `host_id` defaults to the primary.
#[tauri::command]
pub async fn remote_tmux_rename(
    project_id: String,
    host_id: Option<String>,
    session: String,
    new_name: String,
) -> Result<(), String> {
    if !crate::services::ssh_exec::valid_tmux_session_name(&new_name) {
        return Err(
            "a session name may only contain letters, digits, '-' and '_'".to_string(),
        );
    }
    let host_id = host_id.unwrap_or_else(|| remote::PRIMARY_HOST.to_string());
    let target = remote::remote_target_for_host(&project_id, &host_id)
        .ok_or_else(|| "not a remote project host".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::ssh_exec::run_remote_script(
            &target.spec,
            &crate::services::ssh_exec::tmux_rename_session_script(&session, &new_name),
        )
        .map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// On-demand resource check for an already-connected remote project (the
/// warning dialog's "Recheck" action). Unlike the fire-and-forget check
/// `remote_connect` runs on connect, this one is awaited and its result
/// returned directly rather than pushed as an event. `host_id` defaults to the
/// primary; the combined usage dialog rechecks each host it currently shows.
#[tauri::command]
pub async fn remote_usage_check(
    project_id: String,
    host_id: Option<String>,
) -> Result<crate::services::remote_usage::RemoteUsageReport, String> {
    let host_id = host_id.unwrap_or_else(|| remote::PRIMARY_HOST.to_string());
    let target = remote::remote_target_for_host(&project_id, &host_id)
        .ok_or_else(|| "not a remote project host".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::remote_usage::check_usage(&target.spec)
    })
    .await
    .map_err(|e| e.to_string())?
}
