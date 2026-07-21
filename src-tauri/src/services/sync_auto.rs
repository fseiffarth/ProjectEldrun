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

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::time::MissedTickBehavior;

use crate::schema::net_usage;
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
    //
    // The watcher itself is attached by the loop, not here, and only once the
    // manifest actually marks something for auto-sync — see `attach_watcher`.
    let mirror = mirror_dir(project_id);
    let _ = std::fs::create_dir_all(&mirror);
    let (tx, rx) = mpsc::unbounded_channel::<()>();

    let cancel = Arc::new(Notify::new());
    let paused = Arc::new(AtomicBool::new(false));
    let join = tokio::spawn(run_loop(
        app,
        pool,
        manifest,
        target,
        project_id.to_string(),
        mirror,
        tx,
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

/// Attach the mirror watcher, but only once the manifest marks *something* for
/// auto-sync. No-op if already attached, or if there is still nothing marked.
///
/// Byte-sync scope is opt-in per path (no marker ⇒ nothing crosses), so a remote
/// project that has never marked anything — the common case — used to pay for a
/// recursive watch it could not act on: `reconcile_pass` collects the `auto_sync`
/// entries and returns immediately when there are none, but the watch had already
/// cost one inotify watch per directory in the mirror (8017 on a measured project
/// with two virtualenvs), each event waking a thread to send on a channel whose
/// consumer would bail. Deferring the attach makes that cost follow the feature.
///
/// Re-checked on every interval tick rather than wired into `sync_set_auto`, which
/// deliberately transfers nothing and leaves the engine to act on its next pass —
/// so the marker and the watcher stay decoupled, and a manifest edited by any
/// route (command, import, hand-edited file) is picked up the same way.
async fn ensure_watcher(
    slot: &mut Option<notify::RecommendedWatcher>,
    manifest: &SyncManifestState,
    project_id: &str,
    mirror: &std::path::Path,
    tx: &mpsc::UnboundedSender<()>,
) {
    if slot.is_some() {
        return;
    }
    {
        let mut g = manifest.lock().await;
        let m = ensure_loaded(&mut g, project_id);
        if !m.values().any(|e| e.auto_sync) {
            return;
        }
    }
    let tx = tx.clone();
    let Ok(mut w) = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = tx.send(());
        }
    }) else {
        return; // no watcher → interval passes still run, just less promptly
    };
    if w.watch(mirror, RecursiveMode::Recursive).is_ok() {
        *slot = Some(w);
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
    mirror: std::path::PathBuf,
    tx: mpsc::UnboundedSender<()>,
    mut rx: mpsc::UnboundedReceiver<()>,
    cancel: Arc<Notify>,
    paused: Arc<AtomicBool>,
) {
    let mut interval = tokio::time::interval(AUTO_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // Dropped with the task (cancel/stop) → unwatch, exactly as the old field on
    // `AutoSyncTask` did. `None` until the manifest marks something; see below.
    let mut watcher: Option<notify::RecommendedWatcher> = None;
    ensure_watcher(&mut watcher, &manifest, &project_id, &mirror, &tx).await;
    loop {
        tokio::select! {
            _ = cancel.notified() => break,
            _ = interval.tick() => {
                if paused.load(Ordering::SeqCst) { continue; }
                // Cheap once attached; this is what picks up a `sync_set_auto` that
                // marked the first path after the task was already running.
                ensure_watcher(&mut watcher, &manifest, &project_id, &mirror, &tx).await;
                reconcile_pass(Some(&app), &pool, &manifest, &target, &project_id).await;
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
                reconcile_pass(Some(&app), &pool, &manifest, &target, &project_id).await;
            }
        }
    }
}

/// Run exactly one byte-sync reconcile pass, synchronously, with no watcher, no
/// interval, and no UI event. This is the same pass [`run_loop`] drives — the loop
/// contributes only the *when*.
///
/// Exists for the live-SSH lockstep driver (`examples/lockstep_drv.rs`), which walks
/// `docs/git_lockstep_case_matrix.md` against a real host: the byte-sync half of the
/// BS+LS cases has to be the real engine, or the matrix proves nothing about the code
/// that ships.
pub async fn reconcile_once(
    pool: &RemotePoolState,
    manifest: &SyncManifestState,
    target: &RemoteTarget,
    project_id: &str,
) {
    reconcile_pass(None, pool, manifest, target, project_id).await;
}

/// Subtract the git-tracked set from the byte-sync candidates when lockstep owns them
/// (#28p D1). A no-op when lockstep is off, so a project that never opted in keeps
/// exactly today's behaviour — including its behaviour for files git happens to track.
/// Pure.
pub fn drop_tracked(
    candidates: &mut BTreeSet<String>,
    tracked: &HashSet<String>,
    lockstep_enabled: bool,
) {
    if !lockstep_enabled || tracked.is_empty() {
        return;
    }
    candidates.retain(|rel| !tracked.contains(rel));
}

/// One reconcile pass over the project's auto-sync paths. Bails gracefully if the
/// pool is cold/dead. Reuses the `remote_sync` primitives throughout.
///
/// `app` is `None` when the pass is driven outside the app (see [`reconcile_once`]);
/// it is used for nothing but the completion event.
async fn reconcile_pass(
    app: Option<&AppHandle>,
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

    // #28p D1: with git lockstep on, the tracked tree belongs to lockstep — it delivers
    // those files as *commits*. Shipping them here as loose bytes first lands them on
    // the peer untracked, which then blocks the very fast-forward that would have
    // delivered them properly (git refuses to overwrite an untracked file even when it
    // is byte-identical). Which of those two happened used to be decided by a debounce
    // race between the two engines — nondeterministically wedging the project.
    drop_tracked(
        &mut candidates,
        &crate::services::git_peer::tracked_paths(project_id),
        crate::services::git_peer::load_state(project_id).enabled,
    );

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
                            net_usage::record_files(project_id, 1, 0);
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
                            net_usage::record_files(project_id, 0, 1);
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
        if let Some(app) = app {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }
    fn hset(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn tracked_files_are_left_to_lockstep_when_it_is_on() {
        // #28p D1: byte-sync must not ship a git-tracked file as loose bytes — landing
        // it untracked on the peer is what blocks the fast-forward that would have
        // delivered it as a commit.
        let mut c = set(&["src/a.rs", "notes.md", "build/out.bin"]);
        drop_tracked(&mut c, &hset(&["src/a.rs", "README.md"]), true);
        assert_eq!(c, set(&["notes.md", "build/out.bin"]));
    }

    #[test]
    fn lockstep_off_changes_nothing() {
        // A project that never opted in keeps exactly today's behaviour, tracked files
        // and all — this fix must not quietly stop syncing files for those projects.
        let mut c = set(&["src/a.rs", "notes.md"]);
        drop_tracked(&mut c, &hset(&["src/a.rs"]), false);
        assert_eq!(c, set(&["src/a.rs", "notes.md"]));

        // An empty tracked set (an unborn repo, or `git ls-files` failing) is likewise a
        // no-op: degrade to the old behaviour rather than syncing nothing at all.
        let mut c = set(&["src/a.rs"]);
        drop_tracked(&mut c, &HashSet::new(), true);
        assert_eq!(c, set(&["src/a.rs"]));
    }
}
