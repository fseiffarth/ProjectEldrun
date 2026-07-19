//! Selective local↔remote sync commands for remote (SSH) projects.
//!
//! SSH-sync Phase 1 (`docs/ssh_sync_plan.md`). The user marks files/folders in
//! the remote file view to mirror locally; nothing syncs automatically. These
//! commands orchestrate the `services::remote_sync` core: they resolve the pooled
//! SFTP session, walk + pull the chosen subtree into the mirror, and update the
//! single-writer manifest. Pull progress is streamed as `sync-progress` events so
//! the file tree can show a spinner row (mirroring `fs_watch`'s `fs-change`).
//!
//! Every command requires the project's pooled connection to be live (the whole
//! remote surface is gated on `ssh == connected`); a cold pool errors cleanly
//! rather than opening a one-shot session, since bulk transfers must ride the
//! shared ControlMaster.

use std::sync::Arc;

use futures_util::{stream, StreamExt};
use openssh_sftp_client::Sftp;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::schema::net_usage;
use crate::services::local_loss;
use crate::services::remote::{remote_target_for, pooled_sftp, RemotePoolState, RemoteTarget};
use crate::services::remote_sync::{
    self, ensure_loaded, join_remote, local_meta, local_size_mtime, mirror_local_path, Manifest,
    PushDecision, SyncManifestState, SyncState,
};
use crate::services::sftp;

/// Max concurrent host re-stats during a `sync_status` refresh. The SFTP client
/// pipelines these over the one pooled channel; this bounds the in-flight count
/// so a large selection can't flood it.
const STAT_CONCURRENCY: usize = 16;

/// Size cutoff for content-verifying an amber verdict during a `sync_status`
/// refresh. Size+mtime is only a *heuristic* for divergence — a re-save with the
/// same bytes, or a bare `touch`, moves the mtime while the content is unchanged,
/// so the file paints amber with nothing actually to resolve. For files at or
/// below this size we confirm the amber against the actual bytes and downgrade a
/// byte-identical pair to green (re-recording the base so it *stays* green). Files
/// ABOVE this keep the pure metadata heuristic — reading them over SFTP on every
/// refresh is exactly the cost the heuristic exists to avoid.
const CONTENT_VERIFY_MAX_BYTES: u64 = 1024 * 1024; // 1 MiB

/// A rebase captured when an amber file proves byte-identical: the host + local
/// `(size, mtime)` to stamp as the new sync base so the file goes (and stays)
/// green instead of re-reading its bytes on every refresh.
struct ContentRebase {
    rel: String,
    host_size: u64,
    host_mtime: Option<u64>,
    local_size: u64,
    local_mtime: Option<u64>,
}

/// Confirm an amber verdict against the actual bytes, for a file small enough to
/// be worth reading. Returns `Some(rebase)` only when both sides exist, are the
/// same size, sit within [`CONTENT_VERIFY_MAX_BYTES`], and hold identical bytes —
/// i.e. the divergence was metadata-only. Returns `None` (stay amber) otherwise,
/// including on any read error: an unreadable side keeps the conservative amber.
async fn verify_amber_identical(
    sftp: &Sftp,
    host_abs: &str,
    mirror_path: &std::path::Path,
    rel: &str,
    host: (u64, Option<u64>),
    local: (u64, Option<u64>),
) -> Option<ContentRebase> {
    let (host_size, host_mtime) = host;
    let (local_size, local_mtime) = local;
    // Gate the read on the pure heuristic-vs-content policy (both sides present,
    // same size, within the cutoff — large files keep the metadata heuristic).
    if !remote_sync::content_verify_worth_it(host, local, CONTENT_VERIFY_MAX_BYTES) {
        return None;
    }
    let host_bytes = sftp::read_file_on(sftp, host_abs).await.ok()?;
    let local_bytes = std::fs::read(mirror_path).ok()?;
    (host_bytes == local_bytes).then_some(ContentRebase {
        rel: rel.to_string(),
        host_size,
        host_mtime,
        local_size,
        local_mtime,
    })
}

/// One row of sync status for the file-tree overlay.
#[derive(Debug, Clone, Serialize)]
pub struct SyncStatusEntry {
    /// Project-relative path (forward slashes).
    pub rel_path: String,
    pub is_dir: bool,
    pub selected: bool,
    /// `green` | `amber` | `none`.
    pub state: SyncState,
    /// Effective auto-sync: this path's own entry or an ancestor auto folder
    /// marker (`remote_sync::is_auto`). Drives the file-tree/viewer auto glyph.
    pub auto_sync: bool,
}

/// Progress payload for the `sync-progress` event (one per transferred file plus
/// start/done bookends), keyed by project so the frontend can ignore other
/// projects' transfers.
#[derive(Debug, Clone, Serialize)]
struct SyncProgress {
    project_id: String,
    /// `start` | `file` | `done`.
    phase: String,
    /// The file just transferred (`phase == "file"`), else the synced root.
    rel_path: String,
    done: usize,
    total: usize,
}

/// Resolve the remote target + live pooled SFTP session for `project_id`, erroring
/// if the project is local or its connection is cold (reconnect first).
async fn resolve(
    project_id: &str,
    pool: &RemotePoolState,
) -> Result<(RemoteTarget, Arc<Sftp>), String> {
    let target = remote_target_for(project_id)
        .ok_or_else(|| "not a remote project".to_string())?;
    let sftp = pooled_sftp(pool, project_id)
        .await
        .ok_or_else(|| "remote project not connected — reconnect first".to_string())?;
    Ok((target, sftp))
}

/// Pull a single file or a whole folder subtree from the host into the local
/// mirror, marking each pulled file selected and recording its base. `rel_path`
/// is project-relative (`""` = the whole project root). Returns the number of
/// files transferred. Streams `sync-progress` as it goes.
#[tauri::command]
pub async fn sync_pull(
    app: AppHandle,
    project_id: String,
    rel_path: String,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<usize, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    pull_subtree(&app, &project_id, &target, &sftp, &rel_path, manifest.inner()).await
}

/// Pull the entire project tree into the mirror (the one-click "sync whole
/// project"). Equivalent to `sync_pull` with an empty `rel_path`.
#[tauri::command]
pub async fn sync_whole_project(
    app: AppHandle,
    project_id: String,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<usize, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    pull_subtree(&app, &project_id, &target, &sftp, "", manifest.inner()).await
}

/// Re-pull every currently-selected file (the "sync now" reconcile): brings the
/// mirror back in step with the host and clears amber → green. Returns the number
/// of files re-pulled.
#[tauri::command]
pub async fn sync_now(
    app: AppHandle,
    project_id: String,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<usize, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    // Snapshot the selected file paths under the lock, then transfer outside it.
    let selected: Vec<String> = {
        let mut guard = manifest.lock().await;
        let m = ensure_loaded(&mut guard, &project_id);
        m.iter()
            .filter(|(_, e)| e.selected && !e.is_dir)
            .map(|(k, _)| k.clone())
            .collect()
    };
    // #28q: "clears amber → green" means the host wins every file that moved on both
    // sides. Name the local edits that costs before overwriting them.
    let doomed = unsynced_local_edits(&project_id, manifest.inner(), &selected).await;
    warn_overwritten(&project_id, "Sync now (re-pulled every selected file)", doomed);

    let total = selected.len();
    emit(&app, &project_id, "start", "", 0, total);
    let mut done = 0usize;
    for rel in selected {
        let host_abs = join_remote(&target.spec.remote_path, &rel);
        let (size, mtime) = remote_sync::stat_or_zero(&sftp, &host_abs).await;
        let local = mirror_local_path(&project_id, &rel);
        if remote_sync::pull_file(&sftp, &host_abs, size, &local).await.is_ok() {
            let local_meta = std::fs::metadata(&local).ok();
            let (ls, lm) = local_size_mtime(local_meta);
            let mut guard = manifest.lock().await;
            let m = ensure_loaded(&mut guard, &project_id);
            remote_sync::record_pull(m, &rel, size, mtime, ls, lm);
            let _ = remote_sync::save_manifest(&project_id, m);
            net_usage::record_files(&project_id, 1, 0);
        }
        done += 1;
        emit(&app, &project_id, "file", &rel, done, total);
    }
    emit(&app, &project_id, "done", "", done, total);
    Ok(done)
}

/// Toggle the `selected` flag for one or more project-relative paths WITHOUT
/// transferring anything (e.g. deselecting to stop tracking). Selecting a path
/// the user then wants mirrored is followed by `sync_pull`; selecting alone just
/// records intent. Mirror bytes are left in place on deselect.
#[tauri::command]
pub async fn sync_mark_selected(
    project_id: String,
    rel_paths: Vec<String>,
    selected: bool,
    is_dir: bool,
    manifest: State<'_, SyncManifestState>,
) -> Result<(), String> {
    let mut guard = manifest.lock().await;
    let m = ensure_loaded(&mut guard, &project_id);
    for rel in &rel_paths {
        let entry = m.entry(rel.clone()).or_default();
        entry.selected = selected;
        if is_dir {
            entry.is_dir = true;
        }
    }
    remote_sync::save_manifest(&project_id, m)
}

/// Toggle auto-sync for one or more project-relative paths. Turning it ON sets
/// `auto_sync` (and implies `selected = true`, clearing any exclusion). On a
/// directory the marker covers the whole subtree (resolved by
/// `remote_sync::is_auto`); the empty path `""` is the project-wide "auto-sync
/// all" root marker. Turning it OFF records an explicit `auto_off` EXCLUSION
/// (clearing `auto_sync`) so a path can be carved out of an ancestor's — or the
/// project-wide — auto-sync; `selected` is left as-is (manual tracking continues),
/// matching the deselect-leaves-bytes convention. No bytes transfer here — the
/// background reconcile engine (`services::sync_auto`) acts on its next pass.
#[tauri::command]
pub async fn sync_set_auto(
    project_id: String,
    rel_paths: Vec<String>,
    auto: bool,
    is_dir: bool,
    manifest: State<'_, SyncManifestState>,
) -> Result<(), String> {
    let mut guard = manifest.lock().await;
    let m = ensure_loaded(&mut guard, &project_id);
    for rel in &rel_paths {
        let entry = m.entry(rel.clone()).or_default();
        entry.auto_sync = auto;
        // OFF writes an explicit exclusion (overrides an ancestor/project-wide
        // auto); ON clears any prior exclusion and marks the path tracked.
        entry.auto_off = !auto;
        if auto {
            entry.selected = true;
        }
        if is_dir {
            entry.is_dir = true;
        }
    }
    remote_sync::save_manifest(&project_id, m)
}

/// What turning auto-sync ON over a host subtree would start pulling.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSyncPreview {
    pub files: usize,
    pub bytes: u64,
}

/// Cost preview for `sync_set_auto(auto = true)` on a directory. Read-only.
///
/// Byte-sync's scope is an explicit opt-in manifest and it does **not** read
/// `.gitignore` — the two systems have different notions of what is in scope. So
/// marking a host folder auto is the one click that can start hauling a tree the
/// user deliberately keeps host-side (experiment output, checkpoints: gitignored,
/// therefore also invisible to lockstep) into the local mirror. The frontend calls
/// this first and confirms when the answer is large, so the pull is a decision
/// rather than a surprise.
///
/// Walks the **host** because that is the side that holds the bytes in the case
/// worth warning about; a `rel` that is a file (not a directory) fails the walk
/// and reports a single entry, which is never large enough to warn on anyway.
#[tauri::command]
pub async fn sync_auto_preview(
    project_id: String,
    rel_path: String,
    pool: State<'_, RemotePoolState>,
) -> Result<AutoSyncPreview, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    let files = remote_sync::walk_host_files(&sftp, &target.spec.remote_path, &rel_path).await?;
    Ok(AutoSyncPreview {
        files: files.len(),
        bytes: files.iter().map(|f| f.size).sum(),
    })
}

/// Return the sync status of every tracked path, re-stat'ing each selected FILE
/// on the host so the green/amber state is fresh (amber = host moved since the
/// last fetch). Directories report their stored selection (no re-stat). This is
/// the explicit "refresh" the plan calls out — there is no live watcher.
#[tauri::command]
pub async fn sync_status(
    project_id: String,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<Vec<SyncStatusEntry>, String> {
    // A local project has no sync; return empty rather than erroring (callers may
    // probe indiscriminately).
    let Some(target) = remote_target_for(&project_id) else {
        return Ok(Vec::new());
    };
    // Snapshot the whole manifest under the lock; re-stat outside it. The full
    // snapshot (not just the (k,v) list) lets `is_auto` walk ancestor folder
    // markers to resolve each row's effective auto-sync flag.
    let snapshot: Manifest = {
        let mut guard = manifest.lock().await;
        ensure_loaded(&mut guard, &project_id).clone()
    };
    let entries: Vec<(String, crate::services::remote_sync::SyncEntry)> =
        snapshot.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    // Re-stat selected files when the pool is live; if cold, fall back to the
    // stored base (green for selected) rather than erroring out the whole panel.
    let sftp = pooled_sftp(pool.inner(), &project_id).await;
    let mut out = Vec::with_capacity(entries.len());
    // Partition without any network first: only selected FILES against a live
    // pool need a host re-stat. Everything else (unselected → none, directories →
    // green, cold pool → last-known-good green) resolves immediately.
    let mut to_stat: Vec<(String, crate::services::remote_sync::SyncEntry, bool)> = Vec::new();
    for (rel, entry) in entries {
        // Effective auto-sync resolves against the whole manifest (ancestor folder
        // markers), so compute it before `rel` is moved into the row.
        let auto = remote_sync::is_auto(&snapshot, &rel);
        if !entry.selected {
            out.push(SyncStatusEntry {
                rel_path: rel,
                is_dir: entry.is_dir,
                selected: false,
                state: SyncState::None,
                auto_sync: false, // auto implies selected, so unselected is never auto
            });
        } else if entry.is_dir {
            out.push(SyncStatusEntry {
                rel_path: rel,
                is_dir: true,
                selected: true,
                state: SyncState::Green,
                auto_sync: auto,
            });
        } else if sftp.is_some() {
            to_stat.push((rel, entry, auto));
        } else {
            // Cold pool: the host can't be re-stat'd, but the local mirror still
            // can (no network) — so a local-only edit made while disconnected
            // still surfaces as amber instead of a stale green.
            let local = std::fs::metadata(mirror_local_path(&project_id, &rel))
                .ok()
                .map(|m| local_meta(&m));
            let state = remote_sync::compute_state(&entry, None, local);
            out.push(SyncStatusEntry {
                rel_path: rel,
                is_dir: false,
                selected: true,
                state,
                auto_sync: auto,
            });
        }
    }
    // Re-stat the selected files concurrently over the pooled SFTP session. The
    // client multiplexes many in-flight requests over the one channel, so a large
    // selection is latency-bound (~one round-trip worth) instead of N sequential
    // round-trips. `buffer_unordered` caps the in-flight count so a huge selection
    // can't flood the channel; order is irrelevant (the frontend keys status by
    // `rel_path`). The stat/compare rule itself is unchanged.
    if let Some(sftp) = &sftp {
        let statted = stream::iter(to_stat.into_iter().map(|(rel, entry, auto)| {
            let sftp = Arc::clone(sftp);
            let root = target.spec.remote_path.clone();
            let project_id = project_id.clone();
            async move {
                let host_abs = join_remote(&root, &rel);
                let (size, mtime) = remote_sync::stat_or_zero(&sftp, &host_abs).await;
                // Also re-stat the local mirror so a local-only edit flips to amber
                // (symmetric divergence — the host may be unchanged).
                let mirror_path = mirror_local_path(&project_id, &rel);
                let local = std::fs::metadata(&mirror_path).ok().map(|m| local_meta(&m));
                let mut state = remote_sync::compute_state(&entry, Some((size, mtime)), local);
                // A metadata-only amber (same bytes, drifted mtime/size-vs-base) is a
                // false positive: for a small file, confirm against the actual bytes
                // and downgrade an identical pair to green, capturing the rebase so it
                // is re-recorded and stays green. Large files keep the heuristic.
                let mut rebase = None;
                if state == SyncState::Amber {
                    if let Some(local_vals) = local {
                        if let Some(rb) = verify_amber_identical(
                            &sftp, &host_abs, &mirror_path, &rel, (size, mtime), local_vals,
                        )
                        .await
                        {
                            state = SyncState::Green;
                            rebase = Some(rb);
                        }
                    }
                }
                (
                    SyncStatusEntry {
                        rel_path: rel,
                        is_dir: false,
                        selected: true,
                        state,
                        auto_sync: auto,
                    },
                    rebase,
                )
            }
        }))
        .buffer_unordered(STAT_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
        // Split the rows from the content-verified rebases: the rows go straight to
        // the response, the rebases are stamped into the manifest under the single-
        // writer lock and persisted once (only when at least one file self-healed).
        let mut rebases = Vec::new();
        for (row, rb) in statted {
            if let Some(rb) = rb {
                rebases.push(rb);
            }
            out.push(row);
        }
        if !rebases.is_empty() {
            let mut guard = manifest.lock().await;
            let m = ensure_loaded(&mut guard, &project_id);
            for rb in &rebases {
                remote_sync::record_pull(
                    m, &rb.rel, rb.host_size, rb.host_mtime, rb.local_size, rb.local_mtime,
                );
            }
            let _ = remote_sync::save_manifest(&project_id, m);
        }
    }
    Ok(out)
}

/// One side (local mirror OR host) of a tracked file, for the amber "resolve"
/// popup. `exists` is false when that side has no such file (deleted/never
/// created); `size`/`mtime` are then zero/None.
#[derive(Debug, Clone, Serialize)]
pub struct SideMeta {
    pub exists: bool,
    pub size: u64,
    /// Unix seconds, when the side reports one.
    pub mtime: Option<u64>,
}

/// Local + host metadata for one tracked file, plus the recorded base — backs
/// the amber divergence popup (size/mtime on each side so the user can see what
/// changed before choosing "take local" or "take remote").
#[derive(Debug, Clone, Serialize)]
pub struct SyncFileMeta {
    pub rel_path: String,
    pub local: SideMeta,
    pub host: SideMeta,
    /// Host base (size + mtime) captured at the last pull/push — what the
    /// green/amber state is judged against.
    pub base_size: u64,
    pub base_mtime: Option<u64>,
}

/// Return the local-mirror and current-host metadata for one file so the amber
/// popup can show the concrete divergence (size + mtime, per side) alongside the
/// recorded base. Requires a live pooled connection to stat the host; a cold
/// pool errors via `resolve` (the popup only opens for a connected project).
#[tauri::command]
pub async fn sync_file_meta(
    project_id: String,
    rel_path: String,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<SyncFileMeta, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    let host_abs = join_remote(&target.spec.remote_path, &rel_path);
    let host = match sftp::metadata_on(&sftp, &host_abs).await {
        Ok((size, mtime)) => SideMeta { exists: true, size, mtime },
        Err(_) => SideMeta { exists: false, size: 0, mtime: None },
    };
    let local_path = mirror_local_path(&project_id, &rel_path);
    let local = match std::fs::metadata(&local_path) {
        Ok(m) => {
            let (size, mtime) = local_size_mtime(Some(m));
            SideMeta { exists: true, size, mtime }
        }
        Err(_) => SideMeta { exists: false, size: 0, mtime: None },
    };
    let (base_size, base_mtime) = {
        let mut guard = manifest.lock().await;
        let m = ensure_loaded(&mut guard, &project_id);
        m.get(&rel_path).map(|e| (e.host_size, e.host_mtime)).unwrap_or((0, None))
    };
    Ok(SyncFileMeta { rel_path, local, host, base_size, base_mtime })
}

/// Byte-for-byte check for one diverged (amber) file, run when the three-way
/// merge viewer opens it. If the local mirror and the current host copy hold
/// **identical bytes**, the divergence was metadata-only (a re-save with the same
/// content, a bare `touch`, or a stale base): re-record the sync base from both
/// sides' fresh `(size, mtime)` so the file clears amber → green — no transfer,
/// since the bytes already match — and return `true`. Returns `false` when the
/// sides genuinely differ, or when either side is missing/unreadable (a real
/// divergence the viewer must resolve). Requires a live pooled connection to read
/// the host over SFTP; a cold pool errors via `resolve`.
///
/// This is the same "amber is size+mtime, not content" self-heal that
/// [`verify_amber_identical`] applies during a `sync_status` refresh, but WITHOUT
/// that path's size cutoff: the user explicitly opened the viewer for this one
/// file, so reading it once — however large — is a decision, not the per-refresh
/// cost the heuristic exists to avoid.
#[tauri::command]
pub async fn sync_resolve_if_identical(
    project_id: String,
    rel_path: String,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<bool, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    let host_abs = join_remote(&target.spec.remote_path, &rel_path);
    // Read both sides fully. A side that can't be read (deleted on the host, never
    // pulled locally) is not "identical" — leave it amber for the merge viewer.
    let Ok(host_bytes) = sftp::read_file_on(&sftp, &host_abs).await else {
        return Ok(false);
    };
    let mirror_path = mirror_local_path(&project_id, &rel_path);
    let Ok(local_bytes) = std::fs::read(&mirror_path) else {
        return Ok(false);
    };
    if host_bytes != local_bytes {
        return Ok(false);
    }
    // Identical: stamp a fresh base from each side's current metadata so the file
    // goes (and stays) green without any byte transfer.
    let (host_size, host_mtime) = sftp::metadata_on(&sftp, &host_abs)
        .await
        .unwrap_or((host_bytes.len() as u64, None));
    let (ls, lm) = local_size_mtime(std::fs::metadata(&mirror_path).ok());
    let mut guard = manifest.lock().await;
    let m = ensure_loaded(&mut guard, &project_id);
    remote_sync::record_pull(m, &rel_path, host_size, host_mtime, ls, lm);
    remote_sync::save_manifest(&project_id, m)?;
    Ok(true)
}

/// Result of a local→remote push: how many files were written, and which
/// project-relative paths were blocked by a stale host base (only populated when
/// `force` is false — the frontend prompts per conflict and re-calls with the
/// user's choice).
#[derive(Debug, Clone, Serialize)]
pub struct SyncPushResult {
    pub pushed: usize,
    pub conflicts: Vec<String>,
}

/// Push a local mirror file or folder subtree to the host (the bidirectional
/// other half of `sync_pull`). For each file: re-stat the host and compare to the
/// manifest base. A file whose host base is unchanged (or that the host doesn't
/// have yet) is written atomically (temp + rename). A file whose host moved since
/// the last sync is BLOCKED and returned in `conflicts` — unless `force` is set
/// (the user chose "keep local"), which overwrites it. Never silently clobbers.
#[tauri::command]
pub async fn sync_push(
    app: AppHandle,
    project_id: String,
    rel_path: String,
    force: bool,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<SyncPushResult, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    let files = remote_sync::walk_mirror_files(&project_id, &rel_path)?;
    let total = files.len();
    emit(&app, &project_id, "start", &rel_path, 0, total);
    let mut pushed = 0usize;
    let mut conflicts = Vec::new();
    let mut done = 0usize;
    for rel in files {
        let host_abs = join_remote(&target.spec.remote_path, &rel);
        let host = sftp::metadata_on(&sftp, &host_abs).await.ok();
        // Snapshot the base under the lock (released before the transfer).
        let base = {
            let mut guard = manifest.lock().await;
            let m = ensure_loaded(&mut guard, &project_id);
            m.get(&rel).cloned().unwrap_or_default()
        };
        if remote_sync::push_decision(&base, host) == PushDecision::Stale && !force {
            conflicts.push(rel.clone());
            done += 1;
            emit(&app, &project_id, "file", &rel, done, total);
            continue;
        }
        let local = mirror_local_path(&project_id, &rel);
        match remote_sync::push_file_atomic(&sftp, &local, &host_abs).await {
            Ok((hs, hm)) => {
                let (ls, lm) = local_size_mtime(std::fs::metadata(&local).ok());
                let mut guard = manifest.lock().await;
                let m = ensure_loaded(&mut guard, &project_id);
                remote_sync::record_push(m, &rel, hs, hm, ls, lm);
                let _ = remote_sync::save_manifest(&project_id, m);
                net_usage::record_files(&project_id, 0, 1);
                pushed += 1;
            }
            Err(e) => eprintln!("sync_push: skip '{rel}': {e}"),
        }
        done += 1;
        emit(&app, &project_id, "file", &rel, done, total);
    }
    emit(&app, &project_id, "done", &rel_path, done, total);
    Ok(SyncPushResult { pushed, conflicts })
}

/// Unified diff of the local mirror copy (old / "local") against the current host
/// copy (new / "host") for one file. Backs the file-tree's diverged (amber) diff
/// button: the host moved past our mirrored base, so this shows exactly what
/// changed on the host before the user re-syncs. Requires a live pooled
/// connection (reads the host over SFTP); a cold pool errors via `resolve`.
#[tauri::command]
pub async fn sync_diff(
    project_id: String,
    rel_path: String,
    pool: State<'_, RemotePoolState>,
) -> Result<String, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    let host_abs = join_remote(&target.spec.remote_path, &rel_path);
    // Host bytes now (empty if the host no longer has the file → shown as a full
    // deletion by the diff).
    let host_bytes = sftp::read_file_on(&sftp, &host_abs).await.unwrap_or_default();
    let mirror_path = mirror_local_path(&project_id, &rel_path);
    // Compute the diff LOCALLY (never over SSH — the mirror is on disk and the
    // host bytes are already in memory). Off the async thread: git spawns a
    // subprocess.
    let rel = rel_path.clone();
    tokio::task::spawn_blocking(move || diff_mirror_vs_host(&mirror_path, &host_bytes, &rel))
        .await
        .map_err(|e| format!("sync_diff task failed: {e}"))?
}

// ── Internals ──────────────────────────────────────────────────────────────

/// The paths, among `rels`, whose mirror copy holds edits that exist **nowhere else**,
/// and which the pull about to run will therefore overwrite and lose (#28q).
///
/// A pull is the one byte-sync operation that destroys something: it writes the host's
/// bytes over the mirror's, and `sync_now`'s whole job — "clears amber → green" — is to
/// do exactly that to files that moved on *both* sides. Which reads as bringing things
/// in step, and is also, silently, choosing the host and discarding the local edit. The
/// auto-sync engine never does this (it skips an amber file rather than pick a winner);
/// only the manual commands do, and only because the user asked. So: not blocked, but
/// no longer silent.
///
/// A path qualifies only when we can be sure there was something to lose: it has a
/// recorded base (byte-sync has synced it before — so the base is a real "as of" mark,
/// not a zeroed default), its mirror file is still there (a pull that *creates* a file
/// destroys nothing), and its current size/mtime differ from that base. That is the same
/// local-divergence rule the file tree already paints amber, so the warning names
/// exactly the files the user was already being shown as locally changed.
async fn unsynced_local_edits(
    project_id: &str,
    manifest: &SyncManifestState,
    rels: &[String],
) -> Vec<String> {
    let mut guard = manifest.lock().await;
    let m = ensure_loaded(&mut guard, project_id);
    rels.iter()
        .filter(|rel| {
            let Some(entry) = m.get(rel.as_str()) else {
                return false; // never synced → no base to have diverged from
            };
            if entry.last_pull_ts.is_none() && entry.last_push_ts.is_none() {
                return false;
            }
            let Some(meta) = std::fs::metadata(mirror_local_path(project_id, rel)).ok() else {
                return false; // no mirror file → the pull only creates
            };
            let (_, local_changed) = remote_sync::divergence(entry, None, Some(local_meta(&meta)));
            local_changed
        })
        .cloned()
        .collect()
}

/// File the warning for the local edits a pull just overwrote. Called with the list
/// captured *before* the transfer — afterwards the evidence is, by definition, gone.
fn warn_overwritten(project_id: &str, op: &str, paths: Vec<String>) {
    local_loss::record_paths(
        project_id,
        local_loss::LossSource::Sync,
        local_loss::LossKind::Overwritten,
        op,
        paths,
        None, // the edits were only ever in the mirror — there is nowhere to get them back from
    );
}

/// Pull `rel` (a single file OR a whole folder subtree) from the host into the
/// mirror, recording each file's base in the manifest. Shared by `sync_pull` and
/// `sync_whole_project`.
///
/// For a directory, the bulk transfer prefers the rsync fast-path (delta +
/// single connection, riding the ControlMaster) when rsync is present on BOTH
/// ends, falling back to the SFTP-native per-file walker (the floor) when it is
/// missing or rsync fails. Either way the manifest bases come from the host walk
/// (metadata only — no extra byte transfer) plus a local stat.
async fn pull_subtree(
    app: &AppHandle,
    project_id: &str,
    target: &RemoteTarget,
    sftp: &Sftp,
    rel: &str,
    manifest: &SyncManifestState,
) -> Result<usize, String> {
    // Determine whether `rel` is a directory (walkable) or a single file.
    let (files, is_dir) = match remote_sync::walk_host_files(sftp, &target.spec.remote_path, rel).await
    {
        Ok(f) => (f, true),
        Err(_) => {
            // Not a directory — treat `rel` as a single file (stat it).
            let host_abs = join_remote(&target.spec.remote_path, rel);
            let (size, mtime) = crate::services::sftp::metadata_on(sftp, &host_abs).await?;
            (
                vec![remote_sync::HostFile { rel: rel.to_string(), size, mtime }],
                false,
            )
        }
    };
    let total = files.len();
    emit(app, project_id, "start", rel, 0, total);

    // #28q: whichever transport wins below, a pull writes the host's bytes over the
    // mirror's. Name the local edits that destroys before either of them runs — after the
    // transfer the evidence is gone (rsync's fast path in particular leaves nothing to
    // compare a base against).
    let rels: Vec<String> = files.iter().map(|f| f.rel.clone()).collect();
    let doomed = unsynced_local_edits(project_id, manifest, &rels).await;
    warn_overwritten(project_id, "Pull from the host", doomed);

    // rsync fast-path for a directory pull: transfer the bytes in one shot, then
    // fall through to the manifest-recording loop (which only re-stats locally —
    // the bytes are already on disk, so `pull_file` would be a wasteful re-read).
    let rsynced = is_dir && try_rsync_pull(target, rel).await;

    let mut done = 0usize;
    for file in files {
        let host_abs = join_remote(&target.spec.remote_path, &file.rel);
        let local = mirror_local_path(project_id, &file.rel);
        // rsync already wrote the bytes; only stat locally to capture the base.
        // Otherwise pull the file over SFTP.
        let local_base = if rsynced {
            std::fs::metadata(&local).ok().map(|m| local_meta(&m))
        } else {
            remote_sync::pull_file(sftp, &host_abs, file.size, &local).await.ok()
        };
        match local_base {
            Some((ls, lm)) => {
                let mut guard = manifest.lock().await;
                let m = ensure_loaded(&mut guard, project_id);
                remote_sync::record_pull(m, &file.rel, file.size, file.mtime, ls, lm);
                let _ = remote_sync::save_manifest(project_id, m);
                net_usage::record_files(project_id, 1, 0);
            }
            None => {
                // A single oversized/unreadable file shouldn't abort the whole
                // folder sync; report it and carry on.
                eprintln!("sync_pull: skip '{}'", file.rel);
            }
        }
        done += 1;
        emit(app, project_id, "file", &file.rel, done, total);
    }
    emit(app, project_id, "done", rel, done, total);
    Ok(done)
}

/// Attempt the rsync fast-path for a directory pull of `rel`: probe rsync on both
/// ends, and if present run `rsync_pull_dir` on a blocking thread. Returns `true`
/// when rsync actually transferred (the caller then just stats locally); `false`
/// to fall back to the SFTP walker. Best-effort — any probe/transfer failure
/// returns `false`.
async fn try_rsync_pull(target: &RemoteTarget, rel: &str) -> bool {
    if !remote_sync::rsync_available_local() {
        return false;
    }
    let spec = target.spec.clone();
    let project_id = target.project_id.clone();
    let host_src = join_remote(&spec.remote_path, rel);
    let local_dest = mirror_local_path(&project_id, rel);
    tokio::task::spawn_blocking(move || {
        if !remote_sync::rsync_available_host(&spec) {
            return false;
        }
        remote_sync::rsync_pull_dir(&spec.user, &spec.host, spec.port, &host_src, &local_dest).is_ok()
    })
    .await
    .unwrap_or(false)
}

/// Produce a unified diff of `mirror_path` (old / "local") vs `host_bytes`
/// (new / "host") using local `git diff --no-index`. `git` is a hard dependency
/// and `--no-index` works outside any repo, exiting non-zero when the files
/// differ (the normal case) — so non-empty stdout is treated as success,
/// mirroring `git_diff_file_blocking`. The host bytes are staged in a temp file;
/// an absent mirror (never pulled) diffs against an empty temp file so it shows
/// as all-additions. The temp/abs paths in the header lines are rewritten to
/// friendly `local/<rel>` / `host/<rel>` labels. Returns "" when identical.
fn diff_mirror_vs_host(
    mirror_path: &std::path::Path,
    host_bytes: &[u8],
    rel: &str,
) -> Result<String, String> {
    use std::io::Write;
    let mut host_tmp = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    host_tmp.write_all(host_bytes).map_err(|e| e.to_string())?;
    host_tmp.flush().map_err(|e| e.to_string())?;
    let host_tmp_path = host_tmp.path().to_string_lossy().into_owned();

    // Old side: the mirror file if present, else an empty temp stand-in for
    // /dev/null (portable across platforms). Both temps stay alive until the git
    // call returns below.
    let empty_tmp = if mirror_path.exists() {
        None
    } else {
        Some(tempfile::NamedTempFile::new().map_err(|e| e.to_string())?)
    };
    let mirror_arg = match &empty_tmp {
        Some(t) => t.path().to_string_lossy().into_owned(),
        None => mirror_path.to_string_lossy().into_owned(),
    };

    let out = crate::paths::command_no_window("git")
        .args(["diff", "--no-index", "--", &mirror_arg, &host_tmp_path])
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if stdout.is_empty() {
        // Zero exit + no output = identical. Non-zero + no output = a real error.
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
        return Ok(String::new());
    }
    Ok(rewrite_diff_labels(&stdout, rel))
}

/// Rewrite the temp/abs paths in a `git diff --no-index` output to friendly
/// `a/local/<rel>` and `b/host/<rel>` header labels. Operates on the header LINES
/// (not raw substrings): git formats an absolute path as `a/tmp/…` — the leading
/// `/` folds into the `a/` prefix, so a naive path replacement would eat the
/// prefix. The frontend's diff parser strips the `a/`/`b/` prefixes, leaving a
/// clean `local/<rel>` / `host/<rel>` shown in the diff header.
fn rewrite_diff_labels(diff: &str, rel: &str) -> String {
    let local = format!("local/{rel}");
    let host = format!("host/{rel}");
    let mut out = String::with_capacity(diff.len());
    for line in diff.split_inclusive('\n') {
        let trimmed = line.strip_suffix('\n').unwrap_or(line);
        let nl = if line.ends_with('\n') { "\n" } else { "" };
        if trimmed.starts_with("diff --git ") {
            out.push_str(&format!("diff --git a/{local} b/{host}{nl}"));
        } else if trimmed.starts_with("--- ") {
            out.push_str(&format!("--- a/{local}{nl}"));
        } else if trimmed.starts_with("+++ ") {
            out.push_str(&format!("+++ b/{host}{nl}"));
        } else if trimmed.starts_with("Binary files ") {
            out.push_str(&format!("Binary files a/{local} and b/{host} differ{nl}"));
        } else {
            out.push_str(line);
        }
    }
    out
}

/// Emit one `sync-progress` event (best-effort).
fn emit(app: &AppHandle, project_id: &str, phase: &str, rel_path: &str, done: usize, total: usize) {
    let _ = app.emit(
        "sync-progress",
        SyncProgress {
            project_id: project_id.to_string(),
            phase: phase.to_string(),
            rel_path: rel_path.to_string(),
            done,
            total,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::rewrite_diff_labels;

    #[test]
    fn rewrite_diff_labels_relabels_both_sides() {
        // Real `git diff --no-index` output for two absolute temp paths: git folds
        // the leading `/` into the `a/`/`b/` prefix (`a/tmp/.mirrorAAA`).
        let raw = "\
diff --git a/tmp/.mirrorAAA b/tmp/.hostBBB
index 3367afd..3e75765 100644
--- a/tmp/.mirrorAAA
+++ b/tmp/.hostBBB
@@ -1 +1 @@
-old
+new
";
        let out = rewrite_diff_labels(raw, "src/main.rs");
        // Header lines carry friendly labels; the parser strips git's a/ b/
        // prefixes, leaving `local/…` / `host/…`. Body/hunk lines are untouched.
        assert!(out.contains("diff --git a/local/src/main.rs b/host/src/main.rs"), "got: {out}");
        assert!(out.contains("--- a/local/src/main.rs"), "got: {out}");
        assert!(out.contains("+++ b/host/src/main.rs"), "got: {out}");
        assert!(out.contains("-old"), "got: {out}");
        assert!(out.contains("+new"), "got: {out}");
        assert!(!out.contains(".mirrorAAA"));
        assert!(!out.contains(".hostBBB"));
    }

    #[test]
    fn rewrite_diff_labels_handles_binary() {
        let raw = "diff --git a/tmp/x b/tmp/y\nBinary files a/tmp/x and b/tmp/y differ\n";
        let out = rewrite_diff_labels(raw, "data/img.png");
        assert!(out.contains("Binary files a/local/data/img.png and b/host/data/img.png differ"), "got: {out}");
    }
}
