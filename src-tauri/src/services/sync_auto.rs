//! Auto-sync reconcile engine for remote (SSH) projects.
//!
//! Sits on top of the manual selective-sync core (`services::remote_sync`,
//! `commands::sync`): when the user marks a file/folder **auto-sync**
//! (`SyncEntry::auto_sync`, set via `sync_set_auto`), a per-project background
//! task keeps it in sync bidirectionally without a click. It reuses every
//! `remote_sync` primitive (`walk_host_files`, `walk_mirror_files`, `divergence`,
//! `push_decision`, `pull_file`, `push_file_atomic`, `record_*`, `save_manifest`)
//! — this module only adds the *trigger* (a mirror filesystem watcher + an
//! interval) and the *policy* (act on the safe direction; never auto-touch an
//! amber/orange conflict).
//!
//! Lifecycle: `start` is called after a successful `remote_connect` and `stop`
//! from `remote_disconnect`; `stop_all` runs at app exit. One task per project,
//! so reconcile passes never overlap; cross-task safety (vs. manual sync
//! commands) comes from the single-writer `SyncManifestState` mutex.
//!
//! Safe-direction policy per file, judged by `remote_sync::divergence` against
//! the recorded bases:
//!   - host moved, local unchanged  → PULL host→local
//!   - local moved, host unchanged  → PUSH local→host (guarded by `push_decision`)
//!   - both moved (AMBER/orange)    → SKIP, left for manual resolution
//!   - neither moved (green)        → no-op
//! Deletions are intentionally NOT propagated in v1 (a gone host side reads as
//! "couldn't check" and a gone local side's push errors out and is skipped) —
//! the conservative "never destructive automatically" stance.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::time::MissedTickBehavior;

use crate::services::remote::{pooled_sftp, remote_target_for, RemotePoolState, RemoteTarget};
use crate::services::remote_sync::{
    self, ensure_loaded, mirror_dir, mirror_local_path, Manifest, PushDecision, SyncManifestState,
};
use crate::services::sftp;

/// Host re-stat cadence: how often a connected project's auto paths are checked
/// for incoming host changes (the local side is also caught near-instantly by the
/// mirror watcher).
const AUTO_INTERVAL: Duration = Duration::from_secs(25);
/// Coalesce a burst of mirror writes into one pass: after the first watcher event
/// we wait this long, absorbing further events, before reconciling.
const DEBOUNCE: Duration = Duration::from_millis(1500);

/// One running auto-sync task: its cancel signal, its join handle, and the mirror
/// watcher whose lifetime is tied to the task (dropping it unwatches).
pub struct AutoSyncTask {
    cancel: Arc<Notify>,
    join: tokio::task::JoinHandle<()>,
    /// When set, `reconcile_pass` early-returns so a git checkout (`services::
    /// git_peer`) can rewrite the mirror without those writes being pulled/pushed.
    /// `git_peer` re-stamps the file-sync bases before clearing this, so the next
    /// pass reads the rewritten tracked files as green rather than as local edits.
    paused: Arc<AtomicBool>,
    /// Kept alive for the task's lifetime; dropped on `stop` → unwatch.
    _watcher: notify::RecommendedWatcher,
}

/// Tauri-managed registry of per-project auto-sync tasks, keyed by project id.
pub type AutoSyncState = Arc<Mutex<HashMap<String, AutoSyncTask>>>;

/// Build a fresh, empty registry for `tauri::Builder::manage`.
pub fn new_state() -> AutoSyncState {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Payload of the `auto-sync` event, emitted after a pass that transferred
/// anything so the frontend can refresh its sync status (and optionally surface a
/// "N synced, M conflicts" hint).
#[derive(Clone, Serialize)]
struct AutoSyncEvent {
    project_id: String,
    pulled: usize,
    pushed: usize,
    skipped_amber: usize,
}

/// Start the per-project auto-sync task (idempotent; no-op for a local project).
/// Spawns a recursive filesystem watcher on the local mirror plus the reconcile
/// loop. Called after `remote_connect` succeeds.
pub async fn start(
    app: AppHandle,
    pool: RemotePoolState,
    manifest: SyncManifestState,
    state: &AutoSyncState,
    project_id: &str,
) {
    // Only remote projects have a host to sync against.
    let Some(target) = remote_target_for(project_id) else {
        return;
    };
    let mut guard = state.lock().await;
    if guard.contains_key(project_id) {
        return; // already running
    }

    // Mirror watcher → mpsc into the loop (debounced there). The mirror must
    // exist for the recursive watch to attach (connect() already creates it, but
    // be defensive for a first-ever run).
    let mirror = mirror_dir(project_id);
    let _ = std::fs::create_dir_all(&mirror);
    let (tx, rx) = mpsc::unbounded_channel::<()>();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = tx.send(());
        }
    }) {
        Ok(w) => w,
        Err(_) => return, // no watcher → skip auto-sync for this project
    };
    if watcher.watch(&mirror, RecursiveMode::Recursive).is_err() {
        return;
    }

    let cancel = Arc::new(Notify::new());
    let paused = Arc::new(AtomicBool::new(false));
    let join = tokio::spawn(run_loop(
        app,
        pool,
        manifest,
        target,
        project_id.to_string(),
        rx,
        cancel.clone(),
        paused.clone(),
    ));
    guard.insert(
        project_id.to_string(),
        AutoSyncTask {
            cancel,
            join,
            paused,
            _watcher: watcher,
        },
    );
}

/// Pause the project's auto-sync reconcile passes (no-op if no task). Used by
/// `services::git_peer` around a coordinated checkout so the checkout's mirror
/// writes are neither pulled nor pushed. Idempotent.
pub async fn pause(state: &AutoSyncState, project_id: &str) {
    if let Some(t) = state.lock().await.get(project_id) {
        t.paused.store(true, Ordering::SeqCst);
    }
}

/// Resume the project's auto-sync reconcile passes (no-op if no task). The caller
/// must have re-stamped any checkout-rewritten tracked-file bases first, else the
/// next pass will treat them as local edits. Idempotent.
pub async fn resume(state: &AutoSyncState, project_id: &str) {
    if let Some(t) = state.lock().await.get(project_id) {
        t.paused.store(false, Ordering::SeqCst);
    }
}

/// Stop the project's auto-sync task (no-op if none). Drops the watcher (unwatch),
/// cancels the loop, and awaits its join under a bounded timeout so a stuck pass
/// can't hang disconnect.
pub async fn stop(state: &AutoSyncState, project_id: &str) {
    let task = state.lock().await.remove(project_id);
    if let Some(t) = task {
        t.cancel.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(5), t.join).await;
    }
}

/// Stop every auto-sync task. Used at app exit before tearing down the pool.
pub async fn stop_all(state: &AutoSyncState) {
    let tasks: Vec<AutoSyncTask> = state.lock().await.drain().map(|(_, t)| t).collect();
    for t in tasks {
        t.cancel.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(5), t.join).await;
    }
}

/// The per-project loop: reconcile on a fixed interval (host changes) and shortly
/// after any mirror write (local changes), until cancelled. A single task ⇒ passes
/// are serialized and never overlap.
async fn run_loop(
    app: AppHandle,
    pool: RemotePoolState,
    manifest: SyncManifestState,
    target: RemoteTarget,
    project_id: String,
    mut rx: mpsc::UnboundedReceiver<()>,
    cancel: Arc<Notify>,
    paused: Arc<AtomicBool>,
) {
    let mut interval = tokio::time::interval(AUTO_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = cancel.notified() => break,
            _ = interval.tick() => {
                if paused.load(Ordering::SeqCst) { continue; }
                reconcile_pass(&app, &pool, &manifest, &target, &project_id).await;
            }
            res = rx.recv() => {
                if res.is_none() { break; } // watcher gone → stop
                // Debounce: absorb the rest of the burst before reconciling.
                loop {
                    tokio::select! {
                        _ = cancel.notified() => return,
                        _ = tokio::time::sleep(DEBOUNCE) => break,
                        res = rx.recv() => { if res.is_none() { return; } }
                    }
                }
                // Skip the pass while a checkout is rewriting the mirror; the writes
                // that queued these watcher events are re-based by git_peer before
                // resume, so dropping this pass loses nothing.
                if paused.load(Ordering::SeqCst) { continue; }
                reconcile_pass(&app, &pool, &manifest, &target, &project_id).await;
            }
        }
    }
}

/// One reconcile pass over the project's auto-sync paths. Bails gracefully if the
/// pool is cold/dead. Reuses the `remote_sync` primitives throughout.
async fn reconcile_pass(
    app: &AppHandle,
    pool: &RemotePoolState,
    manifest: &SyncManifestState,
    target: &RemoteTarget,
    project_id: &str,
) {
    // Bail if the connection is cold or the ssh child died (keepalive evicted it).
    let Some(sftp) = pooled_sftp(pool, project_id).await else {
        return;
    };

    // Snapshot the manifest and collect the auto markers under the lock.
    let (snapshot, auto_dirs, auto_files): (Manifest, Vec<String>, Vec<String>) = {
        let mut g = manifest.lock().await;
        let m = ensure_loaded(&mut g, project_id);
        let dirs = m
            .iter()
            .filter(|(_, e)| e.auto_sync && e.is_dir)
            .map(|(k, _)| k.clone())
            .collect();
        let files = m
            .iter()
            .filter(|(_, e)| e.auto_sync && !e.is_dir)
            .map(|(k, _)| k.clone())
            .collect();
        (m.clone(), dirs, files)
    };
    if auto_dirs.is_empty() && auto_files.is_empty() {
        return;
    }

    // Candidate files = auto single-file entries ∪ host walk of each auto dir ∪
    // mirror walk of each auto dir (so new files on EITHER side are picked up).
    // An auto dir may be the project root (""), i.e. project-wide auto-sync-all,
    // in which case the walks cover the whole tree.
    let mut candidates: BTreeSet<String> = auto_files.into_iter().collect();
    for d in &auto_dirs {
        match remote_sync::walk_host_files(&sftp, &target.spec.remote_path, d).await {
            Ok(files) => candidates.extend(files.into_iter().map(|f| f.rel)),
            Err(_) => return, // connection dropped mid-walk → abandon this pass
        }
        if let Ok(local) = remote_sync::walk_mirror_files(project_id, d) {
            candidates.extend(local);
        }
    }
    // Drop paths carved out by a local OFF override (an `auto_off` on the file or a
    // nearer directory marker): the reconcile only touches paths whose *effective*
    // auto-sync is on, so a project-wide auto can still exclude individual subtrees.
    candidates.retain(|rel| remote_sync::is_auto(&snapshot, rel));

    let mut pulled = 0usize;
    let mut pushed = 0usize;
    let mut skipped = 0usize;
    for rel in candidates {
        let host_abs = remote_sync::join_remote(&target.spec.remote_path, &rel);
        // `Option`, distinguishing a gone host path (None) from an empty file —
        // the same input `push_decision`/`divergence` expect (matches sync_push).
        let host = sftp::metadata_on(&sftp, &host_abs).await.ok();
        let local_path = mirror_local_path(project_id, &rel);
        let local = std::fs::metadata(&local_path)
            .ok()
            .map(|m| remote_sync::local_meta(&m));
        let entry = snapshot.get(&rel).cloned().unwrap_or_default();

        match remote_sync::divergence(&entry, host, local) {
            (false, false) => {} // green
            (true, false) => {
                // Host changed only → pull. `host` is Some here (divergence only
                // flags the host side from a real stat).
                if let Some((hsize, _)) = host {
                    match remote_sync::pull_file(&sftp, &host_abs, hsize, &local_path).await {
                        Ok((ls, lm)) => {
                            let (hs, hm) = host.unwrap_or((hsize, None));
                            let mut g = manifest.lock().await;
                            let m = ensure_loaded(&mut g, project_id);
                            remote_sync::record_pull(m, &rel, hs, hm, ls, lm);
                            let _ = remote_sync::save_manifest(project_id, m);
                            pulled += 1;
                        }
                        Err(e) => eprintln!("auto-sync: pull skip '{rel}': {e}"),
                    }
                }
            }
            (false, true) => {
                // Local changed only → push, but only if the host still matches the
                // recorded base (never clobber a racing host change).
                if remote_sync::push_decision(&entry, host) == PushDecision::Safe {
                    match remote_sync::push_file_atomic(&sftp, &local_path, &host_abs).await {
                        Ok((hs, hm)) => {
                            let (ls, lm) =
                                remote_sync::local_size_mtime(std::fs::metadata(&local_path).ok());
                            let mut g = manifest.lock().await;
                            let m = ensure_loaded(&mut g, project_id);
                            remote_sync::record_push(m, &rel, hs, hm, ls, lm);
                            let _ = remote_sync::save_manifest(project_id, m);
                            pushed += 1;
                        }
                        Err(e) => eprintln!("auto-sync: push skip '{rel}': {e}"),
                    }
                } else {
                    skipped += 1; // host raced → treat as a conflict, leave for manual
                }
            }
            (true, true) => skipped += 1, // AMBER/orange → never auto-synced
        }
    }

    if pulled + pushed > 0 {
        let _ = app.emit(
            "auto-sync",
            AutoSyncEvent {
                project_id: project_id.to_string(),
                pulled,
                pushed,
                skipped_amber: skipped,
            },
        );
    }
}
