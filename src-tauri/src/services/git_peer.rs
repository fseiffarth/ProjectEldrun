//! Git-aware local↔remote lockstep sync for SSH remote projects (TODO #28n, Phase 1).
//!
//! A remote project has **two real git working trees**: the local mirror
//! ([`remote_sync::mirror_dir`]) and the host tree at `spec.remote_path` (git run
//! over the shared ControlMaster via [`ssh_exec::run_git_remote`]). The selective/
//! auto file-sync (`services::sync_auto`) mirrors *bytes* and has no concept of git
//! branches, so a branch switch on either side rewrites many tracked files and would
//! be misread as edits and pushed. This module keeps the two repos in step
//! **semantically**: it transfers commits/refs with `git bundle` (which carries only
//! objects + the named refs — never `config`/hooks/reflogs/index/remotes/stashes/
//! worktree metadata) moved over the pooled SFTP session, then runs `git checkout`
//! on each side so each git materializes its own working tree.
//!
//! Phase 1 scope (this file): opt-in per project; bidirectional **fast-forward-only**
//! ref/commit transfer + missing-ref creation; coordinated checkout that pauses file
//! auto-sync and re-stamps its bases so checkout writes don't become false conflicts;
//! and **detection + display** of a desynchronized state (diverged history / dirty
//! peer). Full Use-local/Use-remote resolution with `refs/eldrun/backup/*` and messy
//! initial-pairing authority are deferred to Phase 2/3.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::time::MissedTickBehavior;

use crate::schema::project::RemoteSpec;
use crate::services::remote::{remote_target_for, RemotePoolState};
use crate::services::remote_sync::{self, mirror_dir, mirror_local_path, SyncManifestState};
use crate::services::sftp;
use crate::services::ssh_exec;
use crate::services::sync_auto::AutoSyncState;

/// Host re-probe cadence while connected (the local side is caught near-instantly by
/// the `.git` watcher). A remote CLI checkout is picked up within this window.
const GIT_POLL_INTERVAL: Duration = Duration::from_secs(12);
/// Coalesce a burst of `.git` writes (a checkout touches HEAD + refs) into one pass.
const GIT_DEBOUNCE: Duration = Duration::from_millis(800);

// ── Types ───────────────────────────────────────────────────────────────────

/// A peer's HEAD: on a named branch, on a detached commit, or unborn (fresh repo).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HeadRef {
    Branch { name: String, sha: String },
    Detached { sha: String },
    Unborn,
}

/// A `refs/heads/*` or `refs/tags/*` entry: short name + object sha.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefEntry {
    pub name: String,
    pub sha: String,
}

/// A snapshot of one peer's git state (the inputs to `plan`/`decide`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerSnapshot {
    pub is_repo: bool,
    pub head: Option<HeadRef>,
    pub branches: Vec<RefEntry>,
    pub tags: Vec<RefEntry>,
    /// True only for staged/unstaged **tracked** changes (blocks a clean checkout);
    /// untracked/ignored files never count (they remain file-sync's domain).
    pub dirty_tracked: bool,
    /// True when the repo check could not be *executed* over an existing tree
    /// (git missing / spawn failure), as opposed to a clean "not a repo" answer.
    /// A side with `probe_error` must never be treated as an empty pairing dest —
    /// a transient failure must not license a `reset --hard` that wipes a real repo.
    pub probe_error: bool,
}

/// Overall lockstep status for a project.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncStatus {
    Synchronized,
    Syncing,
    Desynchronized,
}

/// Persisted per-project lockstep state (`git_peer.json`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPeerState {
    /// Opt-in toggle; when false the watcher/poll tasks never run.
    pub enabled: bool,
    pub status: SyncStatus,
    /// Human-readable reason when `status == Desynchronized`.
    pub detail: Option<String>,
    pub local_head: Option<HeadRef>,
    pub remote_head: Option<HeadRef>,
    pub last_sync_ts: Option<u64>,
}

impl Default for GitPeerState {
    fn default() -> Self {
        GitPeerState {
            enabled: false,
            status: SyncStatus::Synchronized,
            detail: None,
            local_head: None,
            remote_head: None,
            last_sync_ts: None,
        }
    }
}

/// The fast-forward classification for one branch that both peers know.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefAction {
    /// Same sha on both sides.
    InSync,
    /// Dest lacks the branch entirely → create it (a trivial fast-forward).
    CreateOnDest,
    /// Dest's sha is an ancestor of the source's → dest can fast-forward.
    FastForwardDest,
    /// Source's sha is an ancestor of dest's → dest is ahead (the other direction handles it).
    DestAhead,
    /// Neither is an ancestor of the other → real divergence; never auto-applied.
    Diverged,
}

/// A tracked file changed by a checkout (`git diff --name-status <old> <new>`),
/// used to re-stamp the file-sync bases so the rewrite isn't seen as a conflict.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackedChange {
    pub path: String,
    pub deleted: bool,
}

/// Which peer a git command runs against.
pub enum Peer {
    Local(PathBuf),
    Remote(RemoteSpec),
}

impl Peer {
    /// Run `git <args>` against this peer, returning the captured output (parsed
    /// byte-identically for both, exactly like `commands::git::run_git`).
    pub fn run(&self, args: &[&str]) -> Result<Output, String> {
        match self {
            Peer::Local(dir) => crate::paths::command_no_window("git")
                .args(args)
                .current_dir(dir)
                .output()
                .map_err(|e| e.to_string()),
            Peer::Remote(spec) => {
                let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
                ssh_exec::run_git_remote(spec, &owned)
            }
        }
    }
}

// ── Pure parsers (unit-tested; zero I/O) ────────────────────────────────────

/// Parse `git for-each-ref --format='%(objectname) %(refname:short)'` output into
/// `(short-name, sha)` entries. Blank/short lines are skipped.
pub fn parse_refs(stdout: &str) -> Vec<RefEntry> {
    stdout
        .lines()
        .filter_map(|line| {
            let (sha, name) = line.split_once(' ')?;
            let name = name.trim();
            if sha.is_empty() || name.is_empty() {
                return None;
            }
            Some(RefEntry {
                name: name.to_string(),
                sha: sha.to_string(),
            })
        })
        .collect()
}

/// Combine `git symbolic-ref --quiet --short HEAD` (branch, empty when detached)
/// and `git rev-parse HEAD` (sha, fails on an unborn HEAD) into a [`HeadRef`].
pub fn parse_head(symbolic: &str, rev: &str) -> HeadRef {
    let branch = symbolic.trim();
    let sha = rev.trim();
    if sha.is_empty() {
        HeadRef::Unborn
    } else if branch.is_empty() {
        HeadRef::Detached {
            sha: sha.to_string(),
        }
    } else {
        HeadRef::Branch {
            name: branch.to_string(),
            sha: sha.to_string(),
        }
    }
}

/// Whether `git status --porcelain` reports any **tracked** change. Untracked
/// entries (`??`) are ignored — they never block a checkout and belong to the
/// selective/auto file-sync engine.
pub fn is_dirty_tracked(porcelain: &str) -> bool {
    porcelain.lines().any(|line| {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.len() < 2 {
            return false;
        }
        &line[..2] != "??"
    })
}

/// Classify how `dest` should move toward `source` for one branch, given the two
/// `merge-base --is-ancestor` bits computed on the side that has both commits.
/// `dest_sha == None` means the dest lacks the branch entirely.
pub fn decide(
    dest_sha: Option<&str>,
    source_sha: &str,
    dest_is_ancestor_of_source: bool,
    source_is_ancestor_of_dest: bool,
) -> RefAction {
    match dest_sha {
        None => RefAction::CreateOnDest,
        Some(d) if d == source_sha => RefAction::InSync,
        Some(_) => {
            if dest_is_ancestor_of_source {
                RefAction::FastForwardDest
            } else if source_is_ancestor_of_dest {
                RefAction::DestAhead
            } else {
                RefAction::Diverged
            }
        }
    }
}

/// Build `git bundle create <path> <positives...> [--not <excludes...>]`.
///
/// `positives` are the refs/shas to include (`--branches`/`--tags`/an explicit sha).
/// `excludes` are shas the receiver already has, making a thin delta bundle. We
/// **never** pass `--all` (which could rope in odd refs); the shape is asserted in
/// tests, and a bundle inherently carries only objects + the named refs — so
/// `config`/hooks/reflogs/remotes/stashes never travel.
pub fn bundle_create_args(path: &str, positives: &[&str], excludes: &[String]) -> Vec<String> {
    let mut v = vec!["bundle".to_string(), "create".to_string(), path.to_string()];
    v.extend(positives.iter().map(|s| s.to_string()));
    if !excludes.is_empty() {
        v.push("--not".to_string());
        v.extend(excludes.iter().cloned());
    }
    v
}

/// The two refspecs that import a bundle's refs into the receiver's isolated
/// `refs/eldrun/incoming/*` namespace — never touching real `refs/heads`/`refs/tags`.
pub fn incoming_fetch_refspecs() -> [String; 2] {
    [
        "refs/heads/*:refs/eldrun/incoming/heads/*".to_string(),
        "refs/tags/*:refs/eldrun/incoming/tags/*".to_string(),
    ]
}

/// Parse `git diff --name-status <old> <new>` into per-file [`TrackedChange`]s.
/// Handles rename lines (`R100\told\tnew`) by taking the new path.
pub fn changed_tracked_paths(name_status: &str) -> Vec<TrackedChange> {
    name_status
        .lines()
        .filter_map(|line| {
            let mut cols = line.split('\t');
            let status = cols.next()?.trim();
            if status.is_empty() {
                return None;
            }
            let code = status.chars().next().unwrap_or(' ');
            // Renames/copies carry two paths; the last column is the current path.
            let path = cols.last()?.trim();
            if path.is_empty() {
                return None;
            }
            Some(TrackedChange {
                path: path.to_string(),
                deleted: code == 'D',
            })
        })
        .collect()
}

/// A timestamped safety-ref name for a to-be-overwritten branch (Phase 2 uses it to
/// back up the losing side before a reset; Phase 1 only names it).
pub fn backup_ref_name(branch_short: &str, now_secs: u64) -> String {
    format!("refs/eldrun/backup/{now_secs}/{branch_short}")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── State persistence ───────────────────────────────────────────────────────

/// `<state_dir>/remote-projects/<id>/git_peer.json` (sibling of `sync.json`).
pub fn state_path(project_id: &str) -> PathBuf {
    crate::storage::state_dir()
        .join("remote-projects")
        .join(project_id)
        .join("git_peer.json")
}

/// Load a project's persisted lockstep state (default/disabled if absent).
pub fn load_state(project_id: &str) -> GitPeerState {
    crate::storage::read_json(&state_path(project_id)).unwrap_or_default()
}

/// Persist a project's lockstep state.
pub fn save_state(project_id: &str, state: &GitPeerState) -> Result<(), String> {
    crate::storage::write_json(&state_path(project_id), state).map_err(|e| e.to_string())
}

// ── Probing ─────────────────────────────────────────────────────────────────

/// Read a peer's git state (HEAD, branches, tags, tracked-dirty). A non-repo or any
/// probe failure yields `is_repo == false` so the caller degrades gracefully.
pub fn probe(peer: &Peer) -> PeerSnapshot {
    let res = peer.run(&["rev-parse", "--is-inside-work-tree"]);
    let is_repo = res.as_ref().map(|o| o.status.success()).unwrap_or(false);
    if !is_repo {
        // Distinguish a clean "not a repo" (git ran, said no — a legitimately empty
        // side we may safely initialize) from a probe that could not run at all. A
        // missing local dir is *not* an error: there is no repo there to destroy, so
        // pairing may create the mirror. But an execution failure over an existing
        // tree must NOT read as "empty" — that would let a `reset --hard` wipe a real
        // repo on a transient git hiccup. `remote_target_for`-side connection drops
        // surface as a non-zero ssh exit (Ok), so only a true spawn error flags here.
        let probe_error = match peer {
            Peer::Local(dir) => dir.exists() && res.is_err(),
            Peer::Remote(_) => res.is_err(),
        };
        return PeerSnapshot {
            probe_error,
            ..Default::default()
        };
    }

    let symbolic = peer
        .run(&["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let rev = peer
        .run(&["rev-parse", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let head = Some(parse_head(&symbolic, &rev));

    let branches = peer
        .run(&[
            "for-each-ref",
            "--format=%(objectname) %(refname:short)",
            "refs/heads",
        ])
        .map(|o| parse_refs(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    let tags = peer
        .run(&[
            "for-each-ref",
            "--format=%(objectname) %(refname:short)",
            "refs/tags",
        ])
        .map(|o| parse_refs(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    let dirty_tracked = peer
        .run(&["status", "--porcelain"])
        .map(|o| is_dirty_tracked(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(false);

    PeerSnapshot {
        is_repo: true,
        head,
        branches,
        tags,
        dirty_tracked,
        probe_error: false,
    }
}

// ── Transport + apply ───────────────────────────────────────────────────────

/// Transient bundle file paths (inside `.git`, so file-sync/status never see them).
fn local_bundle_path(project_id: &str) -> PathBuf {
    mirror_dir(project_id).join(".git").join("eldrun-lockstep.bundle")
}
fn remote_bundle_path(spec: &RemoteSpec) -> String {
    remote_sync::join_remote(&spec.remote_path, ".git/eldrun-lockstep.bundle")
}

fn sha_of<'a>(snap: &'a PeerSnapshot, kind: RefKind, name: &str) -> Option<&'a str> {
    let list = match kind {
        RefKind::Head => &snap.branches,
        RefKind::Tag => &snap.tags,
    };
    list.iter().find(|r| r.name == name).map(|r| r.sha.as_str())
}

#[derive(Clone, Copy)]
enum RefKind {
    Head,
    Tag,
}

/// One direction of a reconcile: bundle `source`'s heads+tags (delta-excluding what
/// `dest` already has), move the bundle to the dest's fs, `git fetch` it, then apply
/// the safe (create / fast-forward) updates on `dest`. Returns branch names that
/// diverged (never auto-applied) and whether a needed fast-forward was blocked by a
/// dirty dest. Objects only — `.git` internals never cross (see [`bundle_create_args`]).
///
/// When `force` is set (the Use-local/Use-remote resolution, #28n Phase 2), `source`
/// is the user-chosen authority: a diverged branch or one where `dest` is *ahead* is
/// reset to `source`'s sha after saving the overwritten tip to a timestamped
/// `refs/eldrun/backup/*` safety ref (a checked-out loser branch is `reset --hard`,
/// moving ref + working tree). Tags conflicting on sha are likewise force-moved with
/// a backup. `force` never widens what history *transfers*, only how `dest` applies it.
async fn transfer_and_apply(
    pool: &RemotePoolState,
    project_id: &str,
    spec: &RemoteSpec,
    to_remote: bool,
    source: &PeerSnapshot,
    dest: &PeerSnapshot,
    force: bool,
) -> Result<TransferResult, String> {
    let mut result = TransferResult::default();
    if !source.is_repo {
        return Ok(result);
    }

    // Delta-exclude every sha the dest already has (thin bundle). A brand-new dest
    // has no shas → full bundle.
    let mut excludes: Vec<String> = dest
        .branches
        .iter()
        .chain(dest.tags.iter())
        .map(|r| r.sha.clone())
        .collect();
    excludes.sort();
    excludes.dedup();

    let (src_peer, dst_peer) = if to_remote {
        (Peer::Local(mirror_dir(project_id)), Peer::Remote(spec.clone()))
    } else {
        (Peer::Remote(spec.clone()), Peer::Local(mirror_dir(project_id)))
    };

    // 1. Create the bundle on the source's own fs.
    let (src_bundle, dst_bundle) = if to_remote {
        (
            local_bundle_path(project_id).to_string_lossy().to_string(),
            remote_bundle_path(spec),
        )
    } else {
        (
            remote_bundle_path(spec),
            local_bundle_path(project_id).to_string_lossy().to_string(),
        )
    };
    let create = bundle_create_args(&src_bundle, &["--branches", "--tags"], &excludes);
    let create_ref: Vec<&str> = create.iter().map(|s| s.as_str()).collect();
    let out = src_peer.run(&create_ref)?;
    if !out.status.success() {
        // Nothing to bundle (e.g. dest already has everything) is reported by git as
        // an error on an empty rev range — treat as a no-op transfer.
        return Ok(result);
    }

    // 2. Move the bundle across via the pooled SFTP session.
    move_bundle(pool, project_id, to_remote, &src_bundle, &dst_bundle).await?;

    // 3. Import objects into the dest's isolated incoming namespace.
    let specs = incoming_fetch_refspecs();
    let fetch: Vec<&str> = vec!["fetch", &dst_bundle, &specs[0], &specs[1]];
    let _ = dst_peer.run(&fetch); // fetch failure → apply below simply finds nothing

    // 4. Apply safe updates per branch. One shared timestamp so every safety ref this
    //    forced pass creates sorts under the same `refs/eldrun/backup/<ts>/` batch.
    let head_branch = match &dest.head {
        Some(HeadRef::Branch { name, .. }) => Some(name.clone()),
        _ => None,
    };
    let ts = now_secs();
    for src_ref in &source.branches {
        let dst_sha = sha_of(dest, RefKind::Head, &src_ref.name);
        let (fwd, back) = if dst_sha.is_some() {
            (
                is_ancestor(&dst_peer, dst_sha.unwrap(), &src_ref.sha),
                is_ancestor(&dst_peer, &src_ref.sha, dst_sha.unwrap()),
            )
        } else {
            (false, false)
        };
        let is_head = head_branch.as_deref() == Some(src_ref.name.as_str());
        match decide(dst_sha, &src_ref.sha, fwd, back) {
            RefAction::InSync => {}
            RefAction::DestAhead => {
                // Under a resolution the authority wins even where the dest is ahead:
                // discard the dest's extra commits (backed up) and reset to source.
                if force {
                    force_reset_branch(&dst_peer, &src_ref.name, &src_ref.sha, dst_sha.unwrap(), is_head, ts);
                    result.applied += 1;
                }
            }
            RefAction::CreateOnDest => {
                let _ = dst_peer.run(&[
                    "update-ref",
                    &format!("refs/heads/{}", src_ref.name),
                    &src_ref.sha,
                ]);
                result.applied += 1;
            }
            RefAction::FastForwardDest => {
                if is_head {
                    // Checked-out branch: move ref + working tree, refusing on a dirty tree.
                    let out = dst_peer.run(&["merge", "--ff-only", &src_ref.sha]);
                    match out {
                        Ok(o) if o.status.success() => result.applied += 1,
                        _ => result.dirty_blocked = true,
                    }
                } else {
                    let _ = dst_peer.run(&[
                        "update-ref",
                        &format!("refs/heads/{}", src_ref.name),
                        &src_ref.sha,
                        dst_sha.unwrap(),
                    ]);
                    result.applied += 1;
                }
            }
            RefAction::Diverged => {
                if force {
                    force_reset_branch(&dst_peer, &src_ref.name, &src_ref.sha, dst_sha.unwrap(), is_head, ts);
                    result.applied += 1;
                } else {
                    result.diverged.push(src_ref.name.clone());
                }
            }
        }
    }

    // Tags: create missing ones; a same-name/different-sha tag is a conflict we
    // surface (and, under a resolution, force-move after a backup — never otherwise).
    for src_tag in &source.tags {
        match sha_of(dest, RefKind::Tag, &src_tag.name) {
            None => {
                let _ = dst_peer.run(&[
                    "update-ref",
                    &format!("refs/tags/{}", src_tag.name),
                    &src_tag.sha,
                ]);
                result.applied += 1;
            }
            Some(d) if d != src_tag.sha => {
                if force {
                    let backup = backup_ref_name(&format!("tags/{}", src_tag.name), ts);
                    let _ = dst_peer.run(&["update-ref", &backup, d]);
                    let _ = dst_peer.run(&[
                        "update-ref",
                        &format!("refs/tags/{}", src_tag.name),
                        &src_tag.sha,
                    ]);
                    result.applied += 1;
                } else {
                    result.diverged.push(format!("tag:{}", src_tag.name));
                }
            }
            Some(_) => {}
        }
    }

    // 5. Cleanup: drop the incoming namespace + bundle files on both ends.
    cleanup_incoming(&dst_peer);
    cleanup_bundles(pool, project_id, spec, &src_peer, &dst_peer, to_remote).await;

    Ok(result)
}

#[derive(Default)]
struct TransferResult {
    applied: usize,
    diverged: Vec<String>,
    dirty_blocked: bool,
}

/// `git merge-base --is-ancestor <a> <b>` → true iff exit 0 (a is an ancestor of b).
fn is_ancestor(peer: &Peer, a: &str, b: &str) -> bool {
    peer.run(&["merge-base", "--is-ancestor", a, b])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Force-move `dest`'s `branch` from `dst_sha` to the authority's `src_sha` during a
/// resolution, after saving the overwritten tip to a timestamped `refs/eldrun/backup/*`
/// safety ref so nothing is lost. When the branch is the dest's checked-out HEAD, a
/// `reset --hard` moves the ref *and* the working tree; otherwise the ref is force-set
/// with `update-ref`'s old-value guard. Best-effort (each step ignores its own error;
/// a stale backup is harmless).
fn force_reset_branch(
    dst_peer: &Peer,
    branch: &str,
    src_sha: &str,
    dst_sha: &str,
    is_head: bool,
    ts: u64,
) {
    let backup = backup_ref_name(branch, ts);
    let _ = dst_peer.run(&["update-ref", &backup, dst_sha]);
    if is_head {
        let _ = dst_peer.run(&["reset", "--hard", src_sha]);
    } else {
        let _ = dst_peer.run(&[
            "update-ref",
            &format!("refs/heads/{branch}"),
            src_sha,
            dst_sha,
        ]);
    }
}

/// Copy the bundle file between the two machines over the pooled SFTP session.
/// Streamed in bounded chunks (#28n Phase 3) so an initial-pairing bundle carrying
/// a project's whole history never has to fit in memory on either end.
async fn move_bundle(
    pool: &RemotePoolState,
    project_id: &str,
    to_remote: bool,
    src_bundle: &str,
    dst_bundle: &str,
) -> Result<(), String> {
    let sftp = crate::services::remote::pooled_sftp(pool, project_id)
        .await
        .ok_or("remote not connected")?;
    if to_remote {
        sftp::upload_file_streaming_on(&sftp, Path::new(src_bundle), dst_bundle).await
    } else {
        sftp::download_file_streaming_on(&sftp, src_bundle, Path::new(dst_bundle)).await
    }
}

/// Delete the `refs/eldrun/incoming/*` tracking refs on a peer after applying.
fn cleanup_incoming(peer: &Peer) {
    // `for-each-ref` then delete each; best-effort.
    if let Ok(out) = peer.run(&[
        "for-each-ref",
        "--format=%(refname)",
        "refs/eldrun/incoming",
    ]) {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let r = line.trim();
            if !r.is_empty() {
                let _ = peer.run(&["update-ref", "-d", r]);
            }
        }
    }
}

async fn cleanup_bundles(
    pool: &RemotePoolState,
    project_id: &str,
    spec: &RemoteSpec,
    _src_peer: &Peer,
    _dst_peer: &Peer,
    _to_remote: bool,
) {
    let _ = std::fs::remove_file(local_bundle_path(project_id));
    if let Some(sftp) = crate::services::remote::pooled_sftp(pool, project_id).await {
        let _ = sftp::remove_file_on(&sftp, &remote_bundle_path(spec)).await;
    }
}

// ── Initial pairing ─────────────────────────────────────────────────────────

/// Bring an unpaired side up: `git init` the empty peer, transfer every ref from the
/// `source` (authority) peer, then position the new HEAD + working tree to match the
/// source (#28n Phase 3). `source_is_local` picks the direction — the empty side is
/// always the peer that is *not* the source. Files already physically present on the
/// empty side (selective/auto file-sync mirrored them) become the tracked tree; a
/// `reset --hard`/detached checkout materializes any that git manages but are missing,
/// and untracked files are left untouched (they stay file-sync's domain).
async fn init_pairing(
    pool: &RemotePoolState,
    project_id: &str,
    spec: &RemoteSpec,
    source_is_local: bool,
    source: &PeerSnapshot,
) -> Result<(), String> {
    let (dest_peer, to_remote) = if source_is_local {
        (Peer::Remote(spec.clone()), true)
    } else {
        (Peer::Local(mirror_dir(project_id)), false)
    };
    if let Peer::Local(dir) = &dest_peer {
        let _ = std::fs::create_dir_all(dir);
    }

    // Defense-in-depth: init_pairing's contract is that `dest` is the *empty* side.
    // If a misprobe/race routed us here with a dest that actually already holds
    // commits, back every existing branch tip up to `refs/eldrun/backup/*` BEFORE the
    // `reset --hard` below can move them — so an unexpected non-empty dest is always
    // recoverable rather than silently wiped. Truly-empty dests probe clean and skip.
    let pre = probe(&dest_peer);
    if !pre.branches.is_empty() {
        let ts = now_secs();
        for b in &pre.branches {
            let backup = backup_ref_name(&b.name, ts);
            let _ = dest_peer.run(&["update-ref", &backup, &b.sha]);
        }
    }

    // `git init` the empty side (idempotent on an existing repo, but we only reach
    // here when the dest is not yet a repo).
    let out = dest_peer.run(&["init"])?;
    if !out.status.success() {
        return Err(format!(
            "git init on {} failed: {}",
            if source_is_local { "remote host" } else { "local mirror" },
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    // Transfer every ref from the authority into the freshly-init'd (empty) dest;
    // with no dest shas this is a full bundle and every branch/tag is a create.
    let dest = probe(&dest_peer);
    let _ = transfer_and_apply(pool, project_id, spec, to_remote, source, &dest, false).await;

    // Position HEAD + populate the working tree to match the source's HEAD.
    match &source.head {
        Some(HeadRef::Branch { name, sha }) => {
            let _ = dest_peer.run(&["symbolic-ref", "HEAD", &format!("refs/heads/{name}")]);
            let _ = dest_peer.run(&["reset", "--hard", sha]);
        }
        Some(HeadRef::Detached { sha }) => {
            let _ = dest_peer.run(&["checkout", sha]);
        }
        // Unborn/None source → nothing committed yet; leave the empty repo unborn too.
        _ => {}
    }
    Ok(())
}

// ── Reconcile + status ──────────────────────────────────────────────────────

/// Probe both peers, transfer + fast-forward in both directions, and compute the new
/// [`GitPeerState`]. Diverged branches / a dirty peer blocking a needed fast-forward
/// → `Desynchronized` (surfaced for Use-local/Use-remote resolution). Persists +
/// returns the state. `enabled` is preserved from the prior persisted state.
///
/// When exactly one side is a git repo, this performs **initial pairing** (#28n
/// Phase 3): the repo side is the authority and the empty side is `git init`-ed and
/// populated from it (remote import → mirror from remote; extend-local → remote from
/// local). If *both* already exist and diverge, no side is guessed — that is the
/// normal diverged→`Desynchronized` path, resolved by the explicit authority choice.
pub async fn reconcile(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    project_id: &str,
    spec: &RemoteSpec,
) -> GitPeerState {
    let prior = load_state(project_id);
    let local = probe(&Peer::Local(mirror_dir(project_id)));
    let remote = probe(&Peer::Remote(spec.clone()));

    let mut diverged: Vec<String> = Vec::new();
    let mut dirty_blocked = false;
    // Set when we deliberately refuse to auto-pair because the local side (the one
    // that would be `git init`+`reset --hard`ed) couldn't be read — forces a
    // Desynchronized state instead of a wipe (checked first in the status decision).
    let mut pairing_blocked: Option<String> = None;

    if local.is_repo && remote.is_repo {
        // Local → remote, then remote → local (each catches the side that is ahead).
        if let Ok(r) =
            transfer_and_apply(pool, project_id, spec, true, &local, &remote, false).await
        {
            diverged.extend(r.diverged);
            dirty_blocked |= r.dirty_blocked;
        }
        // Re-probe the remote so the reverse pass sees any ref we just moved.
        let remote2 = probe(&Peer::Remote(spec.clone()));
        if let Ok(r) =
            transfer_and_apply(pool, project_id, spec, false, &remote2, &local, false).await
        {
            for d in r.diverged {
                if !diverged.contains(&d) {
                    diverged.push(d);
                }
            }
            dirty_blocked |= r.dirty_blocked;
        }
    } else if local.is_repo != remote.is_repo {
        // Exactly one side is a repo → initialize the other from it (initial pairing).
        let source_is_local = local.is_repo;
        if !source_is_local && local.probe_error {
            // The local mirror would be the side we `git init` + `reset --hard`, but
            // its probe *errored* (dir exists, yet git couldn't confirm a repo). Refuse
            // to treat it as empty: a transient local-git failure must never license a
            // wipe of a real local repo. Surface it for the user to retry/resolve.
            pairing_blocked = Some(
                "Local repository could not be read; refusing to auto-initialize it \
                 from the host. Retry once local git is reachable."
                    .to_string(),
            );
        } else {
            let source = if source_is_local { &local } else { &remote };
            if init_pairing(pool, project_id, spec, source_is_local, source)
                .await
                .is_ok()
            {
                // Pairing just materialized both sides to the same HEAD, so every
                // tracked file is byte-identical across host and mirror. Seed the
                // selective-sync manifest for them so the file tree shows them green
                // (in sync) rather than red (untracked by SFTP sync) — there is
                // nothing to transfer. This branch only fires at the pairing moment
                // (exactly one side a repo), so it runs once and never re-selects a
                // file the user later deselects.
                seed_manifest_after_pairing(pool, manifest, project_id, spec).await;
            }
        }
    }

    let final_local = probe(&Peer::Local(mirror_dir(project_id)));
    let final_remote = probe(&Peer::Remote(spec.clone()));

    let (status, detail) = if let Some(msg) = pairing_blocked {
        // We refused to auto-initialize an unreadable local side — report it (must be
        // checked before the "one side has no repo" branch, which would mask it).
        (SyncStatus::Desynchronized, Some(msg))
    } else if !final_local.is_repo || !final_remote.is_repo {
        // Still one side without a repo (source was unborn, or init failed) — nothing
        // to lock-step yet.
        (SyncStatus::Synchronized, None)
    } else if !diverged.is_empty() {
        (
            SyncStatus::Desynchronized,
            Some(format!("Diverged: {}", diverged.join(", "))),
        )
    } else if dirty_blocked {
        (
            SyncStatus::Desynchronized,
            Some("A peer has uncommitted changes blocking a fast-forward".to_string()),
        )
    } else {
        (SyncStatus::Synchronized, None)
    };

    let state = GitPeerState {
        enabled: prior.enabled,
        status,
        detail,
        local_head: final_local.head,
        remote_head: final_remote.head,
        last_sync_ts: Some(now_secs()),
    };
    let _ = save_state(project_id, &state);
    state
}

/// The head sha of a peer, if any (branch or detached).
fn head_sha(snap: &PeerSnapshot) -> Option<String> {
    match &snap.head {
        Some(HeadRef::Branch { sha, .. }) | Some(HeadRef::Detached { sha }) => Some(sha.clone()),
        _ => None,
    }
}

/// Re-stamp the file-sync manifest bases for the tracked files a checkout rewrote
/// (between `old_sha` and the current HEAD on the local mirror), so the resumed auto
/// file-sync reads them green instead of as false local edits. Deleted tracked files
/// drop their manifest entry. Best-effort; needs the pooled SFTP for host stats.
async fn restamp_after_checkout(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    project_id: &str,
    spec: &RemoteSpec,
    old_sha: &str,
) {
    let local = Peer::Local(mirror_dir(project_id));
    let new_sha = match head_sha(&probe(&local)) {
        Some(s) => s,
        None => return,
    };
    if old_sha == new_sha {
        return;
    }
    let changes = local
        .run(&["diff", "--name-status", old_sha, &new_sha])
        .map(|o| changed_tracked_paths(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    if changes.is_empty() {
        return;
    }
    let sftp = crate::services::remote::pooled_sftp(pool, project_id).await;

    let mut g = manifest.lock().await;
    let m = remote_sync::ensure_loaded(&mut g, project_id);
    for ch in changes {
        if ch.deleted {
            m.remove(&ch.path);
            continue;
        }
        let local_path = mirror_local_path(project_id, &ch.path);
        let (ls, lm) = remote_sync::local_size_mtime(std::fs::metadata(&local_path).ok());
        let (hs, hm) = match &sftp {
            Some(s) => {
                let host_abs = remote_sync::join_remote(&spec.remote_path, &ch.path);
                sftp::metadata_on(s, &host_abs).await.unwrap_or((ls, lm))
            }
            None => (ls, lm),
        };
        remote_sync::record_pull(m, &ch.path, hs, hm, ls, lm);
    }
    let _ = remote_sync::save_manifest(project_id, m);
}

/// Seed the file-sync manifest for every git-tracked file right after an INITIAL
/// PAIRING materialized both peers to the same HEAD (so each tracked path is now
/// byte-identical across host and mirror). Marks each path selected and stamps its
/// host + local bases, so `compute_state` reads them green (in sync) instead of the
/// red "not tracked by selective sync" a freshly-extended/imported project would
/// otherwise show — there is nothing to transfer. This mirrors what
/// `restamp_after_checkout` does for a checkout, applied to the pairing moment.
/// Best-effort; needs the pooled SFTP for host stats (falls back to the local base
/// when the host can't be stat'd, matching `restamp_after_checkout`).
async fn seed_manifest_after_pairing(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    project_id: &str,
    spec: &RemoteSpec,
) {
    let local = Peer::Local(mirror_dir(project_id));
    // NUL-delimited so paths with spaces/quotes survive verbatim (no core.quotePath
    // escaping). `.git` is never listed by ls-files; a gitignored `.eldrun` won't be
    // either — both stay out of byte-sync, as elsewhere.
    let tracked = match local.run(&["ls-files", "-z"]) {
        Ok(o) if o.status.success() => o.stdout,
        _ => return,
    };
    let paths: Vec<String> = tracked
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).replace('\\', "/"))
        .collect();
    if paths.is_empty() {
        return;
    }
    let sftp = crate::services::remote::pooled_sftp(pool, project_id).await;

    let mut g = manifest.lock().await;
    let m = remote_sync::ensure_loaded(&mut g, project_id);
    for rel in paths {
        let local_path = mirror_local_path(project_id, &rel);
        let (ls, lm) = remote_sync::local_size_mtime(std::fs::metadata(&local_path).ok());
        let (hs, hm) = match &sftp {
            Some(s) => {
                let host_abs = remote_sync::join_remote(&spec.remote_path, &rel);
                sftp::metadata_on(s, &host_abs).await.unwrap_or((ls, lm))
            }
            None => (ls, lm),
        };
        remote_sync::record_pull(m, &rel, hs, hm, ls, lm);
    }
    let _ = remote_sync::save_manifest(project_id, m);
}

/// Coordinated checkout: pause file auto-sync, check the target out on the initiating
/// side (unless already done), reconcile so the peer has the commits, check the same
/// target out on the peer (a **guarded** checkout — never `-f`), re-stamp file-sync
/// bases, and resume. `initiating_side` is `"local"` or `"remote"`.
pub async fn checkout_lockstep(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    auto: &crate::services::sync_auto::AutoSyncState,
    project_id: &str,
    spec: &RemoteSpec,
    target: &str,
    initiating_side: &str,
    already_checked_out: bool,
) -> Result<GitPeerState, String> {
    crate::services::sync_auto::pause(auto, project_id).await;
    // Guarantee resume even on an early error.
    let result =
        checkout_lockstep_inner(pool, manifest, project_id, spec, target, initiating_side, already_checked_out)
            .await;
    crate::services::sync_auto::resume(auto, project_id).await;
    result
}

async fn checkout_lockstep_inner(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    project_id: &str,
    spec: &RemoteSpec,
    target: &str,
    initiating_side: &str,
    already_checked_out: bool,
) -> Result<GitPeerState, String> {
    let local = Peer::Local(mirror_dir(project_id));
    let remote = Peer::Remote(spec.clone());

    // Old local HEAD (for the post-checkout restamp diff).
    let old_local_sha = head_sha(&probe(&local)).unwrap_or_default();

    // 1. Check out on the initiating side if the caller hasn't already.
    if !already_checked_out {
        let init_peer = if initiating_side == "remote" { &remote } else { &local };
        let out = init_peer.run(&["checkout", target])?;
        if !out.status.success() {
            return Ok(desync_state(
                project_id,
                spec,
                &format!(
                    "Checkout on {initiating_side} failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ),
            ));
        }
    }

    // 2. Bring commits/refs into step so the peer has the target commit.
    let mut state = reconcile(pool, manifest, project_id, spec).await;

    // 3. Guarded checkout on the peer (the side that did NOT initiate).
    let peer = if initiating_side == "remote" { &local } else { &remote };
    let peer_name = if initiating_side == "remote" { "local" } else { "remote" };
    let out = peer.run(&["checkout", target])?;
    if !out.status.success() {
        state = desync_state(
            project_id,
            spec,
            &format!(
                "Peer ({peer_name}) checkout blocked (uncommitted changes?): {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        );
    }

    // 4. Re-stamp file-sync bases for what the checkout rewrote in the mirror
    //    (both directions ultimately rewrite the local mirror tree).
    restamp_after_checkout(pool, manifest, project_id, spec, &old_local_sha).await;

    Ok(state)
}

/// Normalize a resolution authority string to whether the **local** side wins
/// (anything but `"remote"` is treated as local — the safer default of "keep my
/// working copy" for an unexpected value).
pub fn winner_is_local(authority: &str) -> bool {
    authority != "remote"
}

/// Explicit **Use local / Use remote** divergence resolution (#28n Phase 2). The
/// chosen `authority` (`"local"` or `"remote"`) becomes the source of truth: every
/// diverged branch — and every branch where the *losing* side is ahead — is reset to
/// the winner's commit, after the overwritten tip is saved to a timestamped
/// `refs/eldrun/backup/*` safety ref so nothing is discarded irrecoverably. Conflicting
/// tags are force-moved the same way. File auto-sync is paused for the duration and its
/// tracked-file bases are re-stamped afterward (a losing local branch is `reset --hard`,
/// rewriting the mirror tree), then a normal reconcile recomputes the (now
/// `Synchronized`) status. A no-op reconcile is returned if either side lacks a repo.
pub async fn resolve(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    auto: &crate::services::sync_auto::AutoSyncState,
    project_id: &str,
    spec: &RemoteSpec,
    authority: &str,
) -> Result<GitPeerState, String> {
    crate::services::sync_auto::pause(auto, project_id).await;
    let result = resolve_inner(pool, manifest, project_id, spec, authority).await;
    crate::services::sync_auto::resume(auto, project_id).await;
    result
}

async fn resolve_inner(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    project_id: &str,
    spec: &RemoteSpec,
    authority: &str,
) -> Result<GitPeerState, String> {
    let local = probe(&Peer::Local(mirror_dir(project_id)));
    let remote = probe(&Peer::Remote(spec.clone()));
    if !local.is_repo || !remote.is_repo {
        // Nothing paired to resolve; a plain reconcile may still initial-pair.
        return Ok(reconcile(pool, manifest, project_id, spec).await);
    }

    let old_local_sha = head_sha(&local).unwrap_or_default();
    let winner_local = winner_is_local(authority);
    // Force in the winner→loser direction: winner local ⇒ push to the remote loser.
    let to_remote = winner_local;
    let (source, dest) = if winner_local {
        (&local, &remote)
    } else {
        (&remote, &local)
    };
    transfer_and_apply(pool, project_id, spec, to_remote, source, dest, true).await?;

    // A losing local branch was `reset --hard`, rewriting mirror tracked files — refresh
    // the file-sync bases so the resumed auto-sync reads them green (no-op when the
    // remote was the loser, since the mirror tree is unchanged).
    restamp_after_checkout(pool, manifest, project_id, spec, &old_local_sha).await;

    // Recompute status; the forced side is now in sync, so this should read Synchronized.
    Ok(reconcile(pool, manifest, project_id, spec).await)
}

/// Build + persist a `Desynchronized` state with a message (probes current heads).
fn desync_state(project_id: &str, spec: &RemoteSpec, detail: &str) -> GitPeerState {
    let prior = load_state(project_id);
    let local = probe(&Peer::Local(mirror_dir(project_id)));
    let remote = probe(&Peer::Remote(spec.clone()));
    let state = GitPeerState {
        enabled: prior.enabled,
        status: SyncStatus::Desynchronized,
        detail: Some(detail.to_string()),
        local_head: local.head,
        remote_head: remote.head,
        last_sync_ts: Some(now_secs()),
    };
    let _ = save_state(project_id, &state);
    state
}

// ── Detection loop + registry ───────────────────────────────────────────────

/// One running git-peer lockstep task: its cancel signal, join handle, and the
/// `.git` watcher whose lifetime is tied to the task (dropping it unwatches).
pub struct GitPeerTask {
    cancel: Arc<Notify>,
    join: tokio::task::JoinHandle<()>,
    _watcher: Option<notify::RecommendedWatcher>,
}

/// Tauri-managed registry of per-project lockstep tasks, keyed by project id.
pub type GitPeerRegistry = Arc<Mutex<HashMap<String, GitPeerTask>>>;

/// Build a fresh, empty registry for `tauri::Builder::manage`.
pub fn new_registry() -> GitPeerRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

/// The `git-peer-status` event payload (camelCase).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    project_id: String,
    state: GitPeerState,
}

/// Emit the current lockstep state to the frontend.
pub fn emit_status(app: &AppHandle, project_id: &str, state: &GitPeerState) {
    let _ = app.emit(
        "git-peer-status",
        StatusEvent {
            project_id: project_id.to_string(),
            state: state.clone(),
        },
    );
}

/// Start the per-project lockstep task (idempotent; no-op for a local project or a
/// project whose lockstep toggle is off). Attaches a narrowly-scoped `.git` watcher
/// on the local mirror and spawns the host-poll loop. Runs one reconcile immediately.
pub async fn start(
    app: AppHandle,
    pool: RemotePoolState,
    manifest: SyncManifestState,
    auto: AutoSyncState,
    reg: &GitPeerRegistry,
    project_id: &str,
) {
    let Some(target) = remote_target_for(project_id) else {
        return;
    };
    if !load_state(project_id).enabled {
        return;
    }
    let mut guard = reg.lock().await;
    if guard.contains_key(project_id) {
        return;
    }

    let (tx, rx) = mpsc::unbounded_channel::<()>();
    // Watch only `.git` (HEAD/refs/packed-refs live here) so we don't double-fire
    // with the mirror-wide auto-sync watcher on ordinary file edits.
    let gitdir = mirror_dir(project_id).join(".git");
    let watcher = if gitdir.exists() {
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if res.is_ok() {
                let _ = tx.send(());
            }
        }) {
            Ok(mut w) => {
                let _ = w.watch(&gitdir, RecursiveMode::Recursive);
                Some(w)
            }
            Err(_) => None,
        }
    } else {
        None
    };

    let cancel = Arc::new(Notify::new());
    let join = tokio::spawn(poll_loop(
        app,
        pool,
        manifest,
        auto,
        target.spec,
        project_id.to_string(),
        rx,
        cancel.clone(),
    ));
    guard.insert(
        project_id.to_string(),
        GitPeerTask {
            cancel,
            join,
            _watcher: watcher,
        },
    );
}

/// Stop the project's lockstep task (no-op if none).
pub async fn stop(reg: &GitPeerRegistry, project_id: &str) {
    let task = reg.lock().await.remove(project_id);
    if let Some(t) = task {
        t.cancel.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(5), t.join).await;
    }
}

/// Stop every lockstep task (app exit).
pub async fn stop_all(reg: &GitPeerRegistry) {
    let tasks: Vec<GitPeerTask> = reg.lock().await.drain().map(|(_, t)| t).collect();
    for t in tasks {
        t.cancel.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(5), t.join).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn poll_loop(
    app: AppHandle,
    pool: RemotePoolState,
    manifest: SyncManifestState,
    auto: AutoSyncState,
    spec: RemoteSpec,
    project_id: String,
    mut rx: mpsc::UnboundedReceiver<()>,
    cancel: Arc<Notify>,
) {
    // Initial reconcile so both sides start in step.
    let s = detect_and_sync(&pool, &manifest, &auto, &project_id, &spec).await;
    emit_status(&app, &project_id, &s);

    let mut interval = tokio::time::interval(GIT_POLL_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = cancel.notified() => break,
            _ = interval.tick() => {
                let s = detect_and_sync(&pool, &manifest, &auto, &project_id, &spec).await;
                emit_status(&app, &project_id, &s);
            }
            res = rx.recv() => {
                if res.is_none() { break; }
                loop {
                    tokio::select! {
                        _ = cancel.notified() => return,
                        _ = tokio::time::sleep(GIT_DEBOUNCE) => break,
                        res = rx.recv() => { if res.is_none() { return; } }
                    }
                }
                let s = detect_and_sync(&pool, &manifest, &auto, &project_id, &spec).await;
                emit_status(&app, &project_id, &s);
            }
        }
    }
}

/// The target (branch name or detached sha) a HEAD points at, if any.
fn target_of(head: &Option<HeadRef>) -> Option<String> {
    match head {
        Some(HeadRef::Branch { name, .. }) => Some(name.clone()),
        Some(HeadRef::Detached { sha }) => Some(sha.clone()),
        _ => None,
    }
}

/// One detection pass: if either side's HEAD moved since the last observed state,
/// treat it as a checkout on that side and lock the peer to the same target;
/// otherwise just fast-forward-reconcile refs. Persists + returns the new state.
pub async fn detect_and_sync(
    pool: &RemotePoolState,
    manifest: &SyncManifestState,
    auto: &AutoSyncState,
    project_id: &str,
    spec: &RemoteSpec,
) -> GitPeerState {
    let prior = load_state(project_id);
    let local = probe(&Peer::Local(mirror_dir(project_id)));
    let remote = probe(&Peer::Remote(spec.clone()));

    // A HEAD move is only actionable once we have a prior observation to compare to
    // (the first pass just records heads via reconcile).
    let local_moved = prior.local_head.is_some() && prior.local_head != local.head;
    let remote_moved = prior.remote_head.is_some() && prior.remote_head != remote.head;

    if local_moved {
        if let Some(t) = target_of(&local.head) {
            if let Ok(s) = checkout_lockstep(
                pool, manifest, auto, project_id, spec, &t, "local", true,
            )
            .await
            {
                return s;
            }
        }
    } else if remote_moved {
        if let Some(t) = target_of(&remote.head) {
            if let Ok(s) = checkout_lockstep(
                pool, manifest, auto, project_id, spec, &t, "remote", true,
            )
            .await
            {
                return s;
            }
        }
    }
    reconcile(pool, manifest, project_id, spec).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Returns true when `git` is on PATH; probe tests skip gracefully otherwise.
    fn git_available() -> bool {
        crate::paths::command_no_window("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn probe_missing_local_dir_is_clean_empty_not_error() {
        // A local dir that does not exist is a legitimately-empty side (nothing to
        // destroy) — it must NOT flag `probe_error`, so pairing can still create it.
        let missing = std::path::PathBuf::from("/definitely/not/a/real/eldrun/dir/xyz");
        let snap = probe(&Peer::Local(missing));
        assert!(!snap.is_repo);
        assert!(!snap.probe_error, "missing dir must read as clean-empty");
    }

    #[test]
    fn probe_existing_non_repo_dir_is_clean_empty() {
        if !git_available() {
            eprintln!("git not on PATH — skipping probe_existing_non_repo_dir_is_clean_empty");
            return;
        }
        // An existing directory that is not a git repo: git runs and cleanly says
        // "no" → is_repo=false, but probe_error=false (safe to initialize).
        let tmp = tempfile::tempdir().expect("tempdir");
        let snap = probe(&Peer::Local(tmp.path().to_path_buf()));
        assert!(!snap.is_repo);
        assert!(
            !snap.probe_error,
            "an existing non-repo dir must be a clean-empty, not a probe error"
        );
    }

    #[test]
    fn parse_refs_reads_sha_and_short_name() {
        let out = "abc123 main\ndef456 feature/x\n\n  \n";
        let refs = parse_refs(out);
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0], RefEntry { name: "main".into(), sha: "abc123".into() });
        assert_eq!(refs[1].name, "feature/x");
    }

    #[test]
    fn parse_head_branch_detached_unborn() {
        assert_eq!(
            parse_head("main\n", "abc\n"),
            HeadRef::Branch { name: "main".into(), sha: "abc".into() }
        );
        assert_eq!(parse_head("", "abc\n"), HeadRef::Detached { sha: "abc".into() });
        assert_eq!(parse_head("", ""), HeadRef::Unborn);
    }

    #[test]
    fn is_dirty_tracked_ignores_untracked() {
        assert!(!is_dirty_tracked("?? newfile.txt\n?? other\n"));
        assert!(is_dirty_tracked(" M tracked.rs\n"));
        assert!(is_dirty_tracked("M  staged.rs\n"));
        assert!(is_dirty_tracked("?? a\n M b\n")); // any tracked line
        assert!(!is_dirty_tracked(""));
    }

    #[test]
    fn decide_truth_table() {
        assert_eq!(decide(None, "a", false, false), RefAction::CreateOnDest);
        assert_eq!(decide(Some("a"), "a", false, false), RefAction::InSync);
        assert_eq!(decide(Some("old"), "new", true, false), RefAction::FastForwardDest);
        assert_eq!(decide(Some("new"), "old", false, true), RefAction::DestAhead);
        assert_eq!(decide(Some("x"), "y", false, false), RefAction::Diverged);
    }

    #[test]
    fn bundle_create_args_shape_never_all() {
        let excl = vec!["r1".to_string(), "r2".to_string()];
        let args = bundle_create_args("/tmp/b.bundle", &["--branches", "--tags"], &excl);
        assert_eq!(&args[..3], &["bundle", "create", "/tmp/b.bundle"]);
        assert!(args.iter().any(|a| a == "--branches"));
        assert!(args.iter().any(|a| a == "--tags"));
        assert!(args.iter().any(|a| a == "--not"));
        assert!(args.iter().position(|a| a == "--not").unwrap() < args.iter().position(|a| a == "r1").unwrap());
        // Guardrail: never `--all` (could pull odd refs), and no config/hook words.
        assert!(!args.iter().any(|a| a == "--all"));
        assert!(!args.iter().any(|a| a.contains("config") || a.contains("hooks") || a.contains("remotes")));
    }

    #[test]
    fn bundle_create_args_full_when_no_excludes() {
        let args = bundle_create_args("/tmp/b", &["--branches", "--tags"], &[]);
        assert!(!args.iter().any(|a| a == "--not"));
    }

    #[test]
    fn incoming_refspecs_are_namespaced() {
        let specs = incoming_fetch_refspecs();
        assert!(specs[0].ends_with(":refs/eldrun/incoming/heads/*"));
        assert!(specs[1].ends_with(":refs/eldrun/incoming/tags/*"));
        // Never target real refs/heads or refs/remotes on the receiver.
        assert!(specs.iter().all(|s| {
            let dst = s.split(':').nth(1).unwrap();
            dst.starts_with("refs/eldrun/incoming/") && !dst.contains("refs/remotes")
        }));
    }

    #[test]
    fn changed_tracked_paths_handles_deletions_and_renames() {
        let ns = "M\tsrc/a.rs\nD\tsrc/gone.rs\nR100\told/name.rs\tnew/name.rs\nA\tadded.rs\n";
        let ch = changed_tracked_paths(ns);
        assert_eq!(ch.len(), 4);
        assert_eq!(ch[0], TrackedChange { path: "src/a.rs".into(), deleted: false });
        assert_eq!(ch[1], TrackedChange { path: "src/gone.rs".into(), deleted: true });
        assert_eq!(ch[2], TrackedChange { path: "new/name.rs".into(), deleted: false });
        assert!(!ch[3].deleted);
    }

    #[test]
    fn backup_ref_name_format() {
        assert_eq!(
            backup_ref_name("feature/x", 1735689600),
            "refs/eldrun/backup/1735689600/feature/x"
        );
        // Tag conflicts back up under a `tags/` prefix so a branch and a same-named tag
        // never collide in the safety-ref namespace.
        assert_eq!(
            backup_ref_name("tags/v1", 1735689600),
            "refs/eldrun/backup/1735689600/tags/v1"
        );
    }

    #[test]
    fn winner_is_local_defaults_to_local() {
        assert!(winner_is_local("local"));
        assert!(!winner_is_local("remote"));
        // Anything unexpected keeps the safer "my working copy wins" default.
        assert!(winner_is_local(""));
        assert!(winner_is_local("garbage"));
    }

    #[test]
    fn decide_under_force_targets_diverged_and_dest_ahead() {
        // The resolution force path acts exactly on the two actions that a normal
        // reconcile leaves for the user: a real divergence, and the loser being ahead.
        // (`force_reset_branch` is IO; this pins which classifications route into it.)
        assert_eq!(decide(Some("x"), "y", false, false), RefAction::Diverged);
        assert_eq!(decide(Some("new"), "old", false, true), RefAction::DestAhead);
        // Fast-forwardable / create / in-sync never need forcing (no data loss).
        assert_eq!(decide(Some("old"), "new", true, false), RefAction::FastForwardDest);
        assert_eq!(decide(None, "a", false, false), RefAction::CreateOnDest);
        assert_eq!(decide(Some("a"), "a", false, false), RefAction::InSync);
    }

    #[test]
    fn state_default_is_disabled_and_synchronized() {
        let s = GitPeerState::default();
        assert!(!s.enabled);
        assert_eq!(s.status, SyncStatus::Synchronized);
    }

    #[test]
    fn state_roundtrips_camelcase() {
        let s = GitPeerState {
            enabled: true,
            status: SyncStatus::Desynchronized,
            detail: Some("Diverged: main".into()),
            local_head: Some(HeadRef::Branch { name: "main".into(), sha: "a".into() }),
            remote_head: Some(HeadRef::Detached { sha: "b".into() }),
            last_sync_ts: Some(42),
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"lastSyncTs\":42"));
        assert!(json.contains("\"localHead\""));
        assert!(json.contains("\"kind\":\"branch\""));
        assert!(json.contains("\"desynchronized\""));
        let back: GitPeerState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.status, SyncStatus::Desynchronized);
        assert_eq!(back.remote_head, Some(HeadRef::Detached { sha: "b".into() }));
    }
}
