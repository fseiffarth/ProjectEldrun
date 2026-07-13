//! Local mirror + selective bidirectional sync for remote (SSH) projects.
//!
//! SSH-sync Phase 1 (`docs/ssh_sync_plan.md`). Every remote project has a local
//! paired **mirror** — by default a `<name>` subfolder of the top-level
//! `eldrun/projects-ssh/` root
//! (legacy/fallback: `<state_dir>/remote-projects/<id>/mirror/`), relocatable per
//! project via `extra["mirror"]` (see [`mirror_dir`]) — that starts empty and is
//! populated only by **explicit, user-chosen** sync. This module is
//! the `AppHandle`-free core: the manifest type + its on-disk IO, the lstat-typed
//! recursive host walker (G3 — never follows host symlinks), the per-file pull
//! primitive, and the pure 3-way (base/host/local) state compare. The Tauri
//! commands that orchestrate these (`commands::sync`) own the SFTP session and the
//! progress events.
//!
//! ## Source of truth
//! - The **manifest** (`<state_dir>/remote-projects/<id>/sync.json`) records, per
//!   project-relative path, the host base (size+mtime) captured at the last pull
//!   and the local base after writing it. All divergence is judged base-vs-host
//!   and base-vs-local (never host-mtime directly vs local-mtime — clock skew).
//! - The manifest is a single-writer structure: a Tauri-managed
//!   [`SyncManifestState`] serializes every mutation (G7), and SFTP transfers run
//!   with the lock released.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::services::sftp::{self, SyncKind};

/// Largest single file the sync will transfer (64 MiB). `read_file_on` buffers a
/// whole file in RAM and holds the SFTP channel (G8), so a giant artifact is
/// skipped with an error rather than stalling the connection / OOMing.
pub const MAX_SYNC_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// One manifest record for a project-relative path. The host/local size+mtime are
/// the **bases** captured at the last successful pull/push — the reference the
/// green/amber UI state and the (Phase 2) stale-base conflict check compare a
/// fresh re-stat against.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncEntry {
    /// Whether the user has marked this path to track. Selecting a path is the
    /// consent to mirror it; deselecting stops tracking (the mirror bytes stay).
    pub selected: bool,
    /// `true` when this path is a directory (selection marker, no bytes mirrored
    /// for the dir itself).
    #[serde(default)]
    pub is_dir: bool,
    /// Host size (bytes) at the last pull. `0` for a dir / absent.
    #[serde(default)]
    pub host_size: u64,
    /// Host mtime (unix secs) at the last pull, when reported.
    #[serde(default)]
    pub host_mtime: Option<u64>,
    /// Local mirror size (bytes) after the last pull/push.
    #[serde(default)]
    pub local_size: u64,
    /// Local mirror mtime (unix secs) after the last pull/push.
    #[serde(default)]
    pub local_mtime: Option<u64>,
    /// When this path was last pulled host→local (unix secs).
    #[serde(default)]
    pub last_pull_ts: Option<u64>,
    /// When this path was last pushed local→host (unix secs; Phase 2).
    #[serde(default)]
    pub last_push_ts: Option<u64>,
    /// Whether this path auto-syncs (bidirectional, safe-direction-only — the
    /// background reconcile engine keeps it in sync without a click). Implies
    /// `selected`. On a **directory** marker it applies to the whole subtree; the
    /// per-file entries the engine creates on transfer are NOT stamped (auto-ness
    /// is derived from the nearest marker by `is_auto`), so a file synced under a
    /// manually-selected folder stays non-auto. The project root (`""`) carries
    /// this flag as the project-wide "auto-sync all" toggle.
    #[serde(default)]
    pub auto_sync: bool,
    /// Explicit auto-sync EXCLUSION. Set when the user turns auto **off** for a
    /// path that would otherwise inherit it from an ancestor marker (a folder or
    /// the project-wide root). It overrides an ancestor's `auto_sync` for this
    /// path and its subtree — the "local toggles win" override — so a project-wide
    /// auto-sync can carve out individual files/folders. Nearest marker wins
    /// (`is_auto`); a plain off with no ancestor auto is a harmless no-op marker.
    #[serde(default)]
    pub auto_off: bool,
}

/// A project's manifest: project-relative path → record.
pub type Manifest = HashMap<String, SyncEntry>;

/// The green/amber/none UI state for a path (see the plan's "UI state").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    /// In the mirror and the manifest base still matches the host.
    Green,
    /// Host moved since the last fetch (detected on an explicit re-stat).
    Amber,
    /// Not synced (no mirror copy / not selected).
    None,
}

/// Tauri-managed, single-writer cache of per-project manifests (G7). Every mutate
/// path locks this, so a push-on-save / a "sync now" / two tabs saving can never
/// clobber `sync.json`. `tokio::sync::Mutex` because the commands are async.
pub type SyncManifestState = Arc<Mutex<HashMap<String, Manifest>>>;

/// Build a fresh, empty manifest cache for `tauri::Builder::manage`.
pub fn new_manifest_state() -> SyncManifestState {
    Arc::new(Mutex::new(HashMap::new()))
}

// ── Paths ───────────────────────────────────────────────────────────────────

/// The local per-project state dir for a remote project (mirrors
/// `commands::projects::remote_project_state_dir`, kept here to stay
/// command-layer-free).
fn state_dir(project_id: &str) -> PathBuf {
    crate::storage::state_dir()
        .join("remote-projects")
        .join(project_id)
}

/// The DEFAULT local mirror root for a remote project when it carries no explicit
/// override: `<state_dir>/.../<id>/mirror`. This remains the fallback so remote
/// projects created before configurable mirrors keep their existing location.
fn default_mirror_dir(project_id: &str) -> PathBuf {
    state_dir(project_id).join("mirror")
}

/// A remote project's explicitly-chosen mirror root, read from the always-local
/// `projects.json` entry's flattened `extra["mirror"]` (written at import — where
/// it defaults to a `<name>` subfolder of the top-level `eldrun/projects-ssh/` root — and rewritten
/// when the user relocates a deleted mirror). `None` when unset. Read from the
/// global list rather than the per-project `project.json` for the same reason as
/// `remote::remote_target_for`: the global list is always on the local disk.
fn mirror_override(project_id: &str) -> Option<PathBuf> {
    let list_path = crate::storage::state_dir().join("projects.json");
    let list: crate::schema::projects::ProjectsList = crate::storage::read_json(&list_path).ok()?;
    let entry = list.iter().find(|e| e.id == project_id)?;
    let raw = entry.extra.get("mirror")?.as_str()?.trim();
    (!raw.is_empty()).then(|| PathBuf::from(raw))
}

/// The local mirror root for a remote project. An explicit per-project override
/// (`extra["mirror"]`) wins; otherwise the default under the state dir. Every
/// path-prefix routing helper below (`is_under_mirror`, `mirror_local_path`)
/// resolves through here, so relocating the mirror moves all of them together.
pub fn mirror_dir(project_id: &str) -> PathBuf {
    mirror_override(project_id).unwrap_or_else(|| default_mirror_dir(project_id))
}

/// The manifest file path: `<state_dir>/.../<id>/sync.json`.
pub fn manifest_path(project_id: &str) -> PathBuf {
    state_dir(project_id).join("sync.json")
}

/// Whether `abs_path` lies inside the project's local mirror. Used by the file
/// readers (G2 path-prefix routing): a path under the mirror is read/written on
/// the LOCAL fs even though the project is remote, so the local source view and
/// local-on-remote tabs see mirrored bytes instead of round-tripping SFTP.
pub fn is_under_mirror(project_id: &str, abs_path: &str) -> bool {
    let mirror = mirror_dir(project_id);
    // Compare on canonicalized prefixes where possible so a symlinked state dir
    // still matches; fall back to the literal path when it doesn't exist yet.
    let candidate = Path::new(abs_path);
    let mirror_norm = mirror.canonicalize().unwrap_or(mirror);
    let cand_norm = candidate.canonicalize().unwrap_or_else(|_| candidate.to_path_buf());
    cand_norm.starts_with(&mirror_norm)
}

/// Map a project-relative path to its absolute path inside the local mirror.
pub fn mirror_local_path(project_id: &str, rel: &str) -> PathBuf {
    let clean = rel.trim_start_matches('/');
    mirror_dir(project_id).join(clean)
}

// ── Manifest IO ───────────────────────────────────────────────────────────

/// Load a project's manifest from disk, or an empty one if absent/unparseable.
pub fn load_manifest(project_id: &str) -> Manifest {
    let path = manifest_path(project_id);
    if !path.exists() {
        return Manifest::new();
    }
    crate::storage::read_json(&path).unwrap_or_default()
}

/// Persist a project's manifest to disk (creates the state dir if needed).
pub fn save_manifest(project_id: &str, manifest: &Manifest) -> Result<(), String> {
    let path = manifest_path(project_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::storage::write_json(&path, manifest).map_err(|e| e.to_string())
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/// Current wall-clock time as whole seconds since the Unix epoch.
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The green/amber state for a SELECTED file, judged SYMMETRICALLY against both
/// bases: amber when the host moved from its recorded base (`host` re-stat differs
/// from `entry.host_*`) OR the local mirror moved from its recorded base (`local`
/// re-stat differs from `entry.local_*`); green only when neither side diverged.
/// `host` is `None` when the host wasn't stat'd (cold pool) — then only the local
/// side is judged (no network needed). `local` is `None` when the mirror file is
/// gone; a missing mirror we had previously synced counts as diverged (deleted
/// locally). Pure, unit-tested.
pub fn compute_state(
    entry: &SyncEntry,
    host: Option<(u64, Option<u64>)>,
    local: Option<(u64, Option<u64>)>,
) -> SyncState {
    if !entry.selected {
        return SyncState::None;
    }
    let (host_diverged, local_diverged) = divergence(entry, host, local);
    if host_diverged || local_diverged {
        SyncState::Amber
    } else {
        SyncState::Green
    }
}

/// `(host_diverged, local_diverged)` vs the recorded bases — the same rule
/// `compute_state` collapses into green/amber, but kept as two distinct booleans
/// so the auto-sync engine can pick the SAFE direction (pull when only the host
/// moved, push when only the local moved, skip when both = amber/conflict).
/// `host` is `None` when the host wasn't stat'd (cold pool) → host side not
/// flagged. `local` is `None` when the mirror file is gone; a missing mirror we
/// had previously synced counts as diverged (deleted locally). Pure, unit-tested.
pub fn divergence(
    entry: &SyncEntry,
    host: Option<(u64, Option<u64>)>,
    local: Option<(u64, Option<u64>)>,
) -> (bool, bool) {
    let host_diverged = match host {
        Some((size, mtime)) => entry.host_size != size || entry.host_mtime != mtime,
        None => false, // couldn't check the host → don't flag host divergence
    };
    let local_diverged = match local {
        Some((size, mtime)) => entry.local_size != size || entry.local_mtime != mtime,
        // Mirror gone but we had synced it before → deleted locally = diverged.
        None => entry.last_pull_ts.is_some() || entry.last_push_ts.is_some(),
    };
    (host_diverged, local_diverged)
}

/// Whether `rel` auto-syncs, by **nearest explicit marker wins**. A marker is an
/// entry carrying `auto_sync` (on) or `auto_off` (excluded). We consult, closest
/// first: the path's own entry, then each ancestor **directory** marker, ending at
/// the project root (`""`) — whose marker is the project-wide "auto-sync all"
/// toggle. The first explicit decision found wins, so a per-file/folder toggle
/// overrides an ancestor (including project-wide) in either direction. A folder
/// marker only applies to descendants when it is `is_dir`. Pure.
pub fn is_auto(manifest: &Manifest, rel: &str) -> bool {
    // The path's own entry decides for itself regardless of is_dir.
    if let Some(e) = manifest.get(rel) {
        if e.auto_off {
            return false;
        }
        if e.auto_sync {
            return true;
        }
    }
    // Ancestor directory markers, nearest first, finally the root "" marker (which
    // `rfind('/')` never reaches on its own).
    let mut cur = rel;
    loop {
        cur = match cur.rfind('/') {
            Some(idx) => &cur[..idx],
            None if !cur.is_empty() => "", // consult the project root last
            None => return false,          // consumed the root: no decision
        };
        if let Some(e) = manifest.get(cur) {
            if e.is_dir {
                if e.auto_off {
                    return false;
                }
                if e.auto_sync {
                    return true;
                }
            }
        }
    }
}

/// Borrow (loading from disk on first touch) the project's manifest from the
/// single-writer cache. Shared by the command layer and the auto-sync engine.
pub fn ensure_loaded<'a>(
    cache: &'a mut HashMap<String, Manifest>,
    project_id: &str,
) -> &'a mut Manifest {
    cache
        .entry(project_id.to_string())
        .or_insert_with(|| load_manifest(project_id))
}

/// `(size, mtime)` from a local file's metadata (mtime as unix secs).
pub fn local_meta(m: &std::fs::Metadata) -> (u64, Option<u64>) {
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    (m.len(), mtime)
}

/// `(size, mtime)` of a local file's metadata, defaulting to `(0, None)`.
pub fn local_size_mtime(meta: Option<std::fs::Metadata>) -> (u64, Option<u64>) {
    match meta {
        Some(m) => local_meta(&m),
        None => (0, None),
    }
}

/// Join a remote project root with a project-relative path (mirrors
/// `commands::fs::join_remote_dir`). Pure.
pub fn join_remote(remote_root: &str, rel: &str) -> String {
    let base = remote_root.trim_end_matches('/');
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() {
        if base.is_empty() { "/".to_string() } else { base.to_string() }
    } else if base.is_empty() {
        format!("/{rel}")
    } else {
        format!("{base}/{rel}")
    }
}

/// Append a child segment to a project-relative path (`""`+`a` → `a`, `a`+`b` →
/// `a/b`). Pure.
fn join_rel(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_string()
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), child)
    }
}

// ── Host walk + pull (async; SFTP) ─────────────────────────────────────────

/// One regular file discovered by the host walk: its project-relative path and
/// the host base (size + mtime) captured at walk time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostFile {
    pub rel: String,
    pub size: u64,
    pub mtime: Option<u64>,
}

/// Recursively collect the regular FILES under `rel` on the host, lstat-typed so
/// symlinks and special files are SKIPPED, never followed (G3). `remote_root` is
/// the project's `remote_path`; `rel` is project-relative (`""` walks the root).
/// Directories recurse; symlinks/sockets/etc. are ignored. Bounded by the host
/// tree; a hostile `link -> /etc` is skipped rather than mirrored.
pub async fn walk_host_files(
    sftp: &openssh_sftp_client::Sftp,
    remote_root: &str,
    rel: &str,
) -> Result<Vec<HostFile>, String> {
    let mut out = Vec::new();
    walk_inner(sftp, remote_root, rel, &mut out).await?;
    Ok(out)
}

async fn walk_inner(
    sftp: &openssh_sftp_client::Sftp,
    remote_root: &str,
    rel: &str,
    out: &mut Vec<HostFile>,
) -> Result<(), String> {
    let abs = join_remote(remote_root, rel);
    let entries = sftp::list_dir_raw_on(sftp, &abs).await?;
    for entry in entries {
        // Skip Eldrun's internal runtime dir, mirroring the local/remote listers.
        // `.git` is likewise never byte-mirrored: git state is kept in step
        // *semantically* by `services::git_peer` (lockstep), so copying its bytes
        // would fight that layer and risk corrupting a repo mid-write.
        if entry.name == ".eldrun" || entry.name == ".git" {
            continue;
        }
        let child_rel = join_rel(rel, &entry.name);
        match entry.kind {
            SyncKind::Dir => {
                Box::pin(walk_inner(sftp, remote_root, &child_rel, out)).await?;
            }
            SyncKind::File => out.push(HostFile {
                rel: child_rel,
                size: entry.size,
                mtime: entry.modified_secs,
            }),
            // G3: symlinks and special files are never mirrored.
            SyncKind::Symlink | SyncKind::Other => {}
        }
    }
    Ok(())
}

/// Pull one host file into the mirror: read it over SFTP (size-guarded, G8) and
/// write it locally, creating parent dirs. Returns the local (size, mtime) base
/// captured after the write. The host `abs` path must already be confined by the
/// caller; `local` is the mirror destination.
pub async fn pull_file(
    sftp: &openssh_sftp_client::Sftp,
    host_abs: &str,
    host_size: u64,
    local: &Path,
) -> Result<(u64, Option<u64>), String> {
    if host_size > MAX_SYNC_FILE_BYTES {
        return Err(format!(
            "'{host_abs}' is too large to sync ({host_size} bytes; limit {MAX_SYNC_FILE_BYTES})"
        ));
    }
    let bytes = sftp::read_file_on(sftp, host_abs).await?;
    if bytes.len() as u64 > MAX_SYNC_FILE_BYTES {
        return Err(format!(
            "'{host_abs}' is too large to sync ({} bytes; limit {MAX_SYNC_FILE_BYTES})",
            bytes.len()
        ));
    }
    if let Some(parent) = local.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(local, &bytes).map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(local).map_err(|e| e.to_string())?;
    let local_size = meta.len();
    let local_mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    Ok((local_size, local_mtime))
}

/// Re-stat a host path over SFTP, returning `(size, mtime)` or `(0, None)` when
/// the path is gone/unreadable — the input to [`compute_state`] for the amber
/// refresh.
pub async fn stat_or_zero(
    sftp: &openssh_sftp_client::Sftp,
    host_abs: &str,
) -> (u64, Option<u64>) {
    sftp::metadata_on(sftp, host_abs).await.unwrap_or((0, None))
}

/// Record a freshly-pulled file in the manifest: mark it selected and stamp the
/// host + local bases and the pull timestamp. Mutates `manifest` in place; the
/// caller persists under the single-writer lock.
pub fn record_pull(
    manifest: &mut Manifest,
    rel: &str,
    host_size: u64,
    host_mtime: Option<u64>,
    local_size: u64,
    local_mtime: Option<u64>,
) {
    let entry = manifest.entry(rel.to_string()).or_default();
    entry.selected = true;
    entry.is_dir = false;
    entry.host_size = host_size;
    entry.host_mtime = host_mtime;
    entry.local_size = local_size;
    entry.local_mtime = local_mtime;
    entry.last_pull_ts = Some(now_secs());
}

// ── rsync fast-path (Phase 3) ──────────────────────────────────────────────
//
// rsync gives delta transfer + a single connection for BULK (folder / whole-
// project) PULLS, riding the existing ControlMaster so it never re-authenticates.
// It is a pure-optimisation fast-path over the SFTP-native walker, which remains
// the floor (used whenever rsync is missing on either end, and on any rsync
// failure). Only PULLS use rsync: a push must honour the per-file block-on-stale
// guard (product decision 5 — never clobber), which a bulk rsync would bypass, so
// pushes stay on the guarded SFTP path.

/// SSH keepalive options threaded into rsync's `-e` ssh transport (matches the
/// pooled-session keepalive so a dropped link fails fast rather than hanging).
const RSYNC_SSH_KEEPALIVE: &[&str] = &[
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "BatchMode=yes",
];

/// Whether the bulk rsync fast-path applies: rsync present on BOTH ends and the
/// transfer is a directory (single files just use SFTP). Pure, unit-tested.
pub fn should_use_rsync(rsync_local: bool, rsync_host: bool, is_dir: bool) -> bool {
    rsync_local && rsync_host && is_dir
}

/// Build the `ssh …` string for rsync's `-e` so the transfer rides the shared
/// `cm-%C` ControlMaster (no second auth) with `ControlMaster=no` (use, don't
/// create). Includes the port and keepalive. Pure (the control dir is a stable
/// per-user path), unit-tested for the ControlPath wiring.
pub fn rsync_ssh_transport(port: Option<u16>) -> String {
    let control_path = crate::services::ssh_exec::control_dir().join("cm-%C");
    let mut parts: Vec<String> = vec![
        "ssh".to_string(),
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        format!("ControlPath={}", control_path.to_string_lossy()),
    ];
    for a in RSYNC_SSH_KEEPALIVE {
        parts.push((*a).to_string());
    }
    if let Some(p) = port {
        parts.push("-p".to_string());
        parts.push(p.to_string());
    }
    parts.join(" ")
}

/// Build the full rsync argv for a host→local PULL: archive mode (`-a`), checksum
/// basis (`-c`, the correctness/conflict basis where available), the
/// ControlMaster-riding `-e` transport, then `[user@]host:host_src` → `local_dest`.
/// The caller adds trailing slashes to copy a directory's CONTENTS. Pure,
/// unit-tested (it never touches the network).
pub fn rsync_pull_args(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    host_src: &str,
    local_dest: &str,
) -> Vec<String> {
    let target = match user {
        Some(u) => format!("{u}@{host}:{host_src}"),
        None => format!("{host}:{host_src}"),
    };
    vec![
        "-a".to_string(),
        "-c".to_string(),
        "-e".to_string(),
        rsync_ssh_transport(port),
        target,
        local_dest.to_string(),
    ]
}

/// Whether `rsync` is on the LOCAL `PATH`.
pub fn rsync_available_local() -> bool {
    which_on_path("rsync")
}

/// Whether `rsync` is present on the HOST (`command -v rsync` over SSH, riding the
/// master). Best-effort: any ssh/probe failure → `false` (fall back to SFTP).
/// Blocking; call from `spawn_blocking`.
pub fn rsync_available_host(spec: &crate::schema::project::RemoteSpec) -> bool {
    match crate::services::ssh_exec::run_remote_shell(
        spec,
        "command -v rsync >/dev/null 2>&1 && echo eldrun-rsync-yes",
    ) {
        Ok(out) => String::from_utf8_lossy(&out.stdout).contains("eldrun-rsync-yes"),
        Err(_) => false,
    }
}

/// Cross-platform `command -v` check for a binary on `PATH`.
fn which_on_path(bin: &str) -> bool {
    let probe = if cfg!(windows) { "where" } else { "which" };
    crate::paths::command_no_window(probe)
        .arg(bin)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Run a bulk rsync host→local PULL of `host_src_dir` (absolute host dir) into
/// `local_dest_dir`. Both get a trailing slash so the source's CONTENTS land in
/// dest. Best-effort fast-path: returns `Err` on any failure so the caller falls
/// back to the SFTP walker. Blocking shell-out, so call from `spawn_blocking`.
pub fn rsync_pull_dir(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    host_src_dir: &str,
    local_dest_dir: &std::path::Path,
) -> Result<(), String> {
    std::fs::create_dir_all(local_dest_dir).map_err(|e| e.to_string())?;
    let src = format!("{}/", host_src_dir.trim_end_matches('/'));
    let dest = format!("{}/", local_dest_dir.to_string_lossy().trim_end_matches(['/', '\\']));
    let args = rsync_pull_args(user, host, port, &src, &dest);
    let out = crate::paths::command_no_window("rsync")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to launch rsync: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// ── Push (local→remote), block-on-stale (Phase 2) ──────────────────────────

/// The decision for pushing one local file to the host, judged by re-stat'ing the
/// host and comparing to the manifest base (NEVER host-mtime vs local-mtime).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushDecision {
    /// The host still matches the base we recorded (or this path was created
    /// locally and never existed on the host) — safe to write.
    Safe,
    /// The host moved since the last sync, or a never-synced host file already
    /// exists — block and let the user resolve (keep local / take host / skip).
    Stale,
}

/// Decide whether pushing `entry`'s local file is safe given a fresh host re-stat
/// (`None` = the host path is gone). Conservative: anything that isn't provably
/// unchanged-since-base is `Stale`, so a push never silently clobbers a host
/// change. Pure, unit-tested.
///
/// (A content-hash tie-break to distinguish a real host edit from a bare `touch`
/// — the plan's optional `sha256sum` refinement — would need a base hash captured
/// at pull time; it is deferred. The conservative rule here never clobbers, it
/// only over-reports the touch case as a conflict the user clears with "keep
/// local".)
pub fn push_decision(entry: &SyncEntry, host: Option<(u64, Option<u64>)>) -> PushDecision {
    let ever_synced = entry.last_pull_ts.is_some() || entry.last_push_ts.is_some();
    match host {
        // Host gone: a change (deletion) if we'd synced it before; a plain create
        // otherwise.
        None => {
            if ever_synced {
                PushDecision::Stale
            } else {
                PushDecision::Safe
            }
        }
        Some((size, mtime)) => {
            if !ever_synced {
                // Never synced, yet the host already has this path → don't clobber.
                PushDecision::Stale
            } else if size == entry.host_size && mtime == entry.host_mtime {
                PushDecision::Safe
            } else {
                PushDecision::Stale
            }
        }
    }
}

/// Push one local mirror file to the host atomically: write the bytes to a temp
/// path beside the target, then `rename_on` over it (so a reader never sees a
/// half-written file). The caller has already decided this is `Safe`. Returns the
/// host (size, mtime) base captured after the write. Size-guarded (G8).
pub async fn push_file_atomic(
    sftp: &openssh_sftp_client::Sftp,
    local: &Path,
    host_abs: &str,
) -> Result<(u64, Option<u64>), String> {
    let meta = std::fs::metadata(local).map_err(|e| e.to_string())?;
    if meta.len() > MAX_SYNC_FILE_BYTES {
        return Err(format!(
            "'{}' is too large to sync ({} bytes; limit {MAX_SYNC_FILE_BYTES})",
            local.display(),
            meta.len()
        ));
    }
    let bytes = std::fs::read(local).map_err(|e| e.to_string())?;
    // Temp path beside the target (same dir → same filesystem → atomic rename).
    // The single-writer manifest lock serializes pushes per project, so a fixed
    // suffix can't collide with a concurrent push of the same file.
    let tmp = format!("{host_abs}.eldrun-sync-tmp");
    sftp::write_file_on(sftp, &tmp, &bytes).await?;
    sftp::rename_on(sftp, &tmp, host_abs).await?;
    // Re-stat the host to capture the new base (mtime is the host's, post-write).
    let (h_size, h_mtime) = sftp::metadata_on(sftp, host_abs).await.unwrap_or((bytes.len() as u64, None));
    Ok((h_size, h_mtime))
}

/// Record a freshly-pushed file in the manifest: keep it selected and stamp the
/// new host + local bases and the push timestamp.
pub fn record_push(
    manifest: &mut Manifest,
    rel: &str,
    host_size: u64,
    host_mtime: Option<u64>,
    local_size: u64,
    local_mtime: Option<u64>,
) {
    let entry = manifest.entry(rel.to_string()).or_default();
    entry.selected = true;
    entry.is_dir = false;
    entry.host_size = host_size;
    entry.host_mtime = host_mtime;
    entry.local_size = local_size;
    entry.local_mtime = local_mtime;
    entry.last_push_ts = Some(now_secs());
}

/// Recursively collect the project-relative paths of regular FILES in the local
/// mirror under `rel` (lstat-typed; symlinks skipped, mirroring the host walker's
/// G3 stance). `rel` "" walks the whole mirror. Returns paths relative to the
/// mirror root with forward slashes.
pub fn walk_mirror_files(project_id: &str, rel: &str) -> Result<Vec<String>, String> {
    let root = mirror_dir(project_id);
    let start = mirror_local_path(project_id, rel);
    let mut out = Vec::new();
    // A single file selected directly.
    let lmeta = std::fs::symlink_metadata(&start);
    match lmeta {
        Ok(m) if m.file_type().is_file() => {
            if let Some(r) = rel_under(&root, &start) {
                out.push(r);
            }
            return Ok(out);
        }
        Ok(m) if m.file_type().is_dir() => {
            walk_mirror_inner(&root, &start, &mut out)?;
            Ok(out)
        }
        // Missing / symlink / special → nothing to push.
        _ => Ok(out),
    }
}

fn walk_mirror_inner(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue; // G3: never follow symlinks out of the mirror
        }
        // `.git`/`.eldrun` are never byte-mirrored (git is kept in step semantically
        // by `services::git_peer`; `.eldrun` is Eldrun's own runtime dir).
        if entry.file_name() == *".git" || entry.file_name() == *".eldrun" {
            continue;
        }
        if ft.is_dir() {
            walk_mirror_inner(root, &path, out)?;
        } else if ft.is_file() {
            if let Some(r) = rel_under(root, &path) {
                out.push(r);
            }
        }
    }
    Ok(())
}

/// The forward-slash path of `path` relative to `root`, or `None` if not inside.
fn rel_under(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_decision_safe_when_host_matches_base() {
        let e = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            last_pull_ts: Some(1),
            ..Default::default()
        };
        assert_eq!(push_decision(&e, Some((10, Some(100)))), PushDecision::Safe);
    }

    #[test]
    fn push_decision_stale_when_host_moved() {
        let e = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            last_pull_ts: Some(1),
            ..Default::default()
        };
        assert_eq!(push_decision(&e, Some((11, Some(100)))), PushDecision::Stale);
        assert_eq!(push_decision(&e, Some((10, Some(200)))), PushDecision::Stale);
    }

    #[test]
    fn push_decision_create_safe_when_never_synced_and_host_absent() {
        let e = SyncEntry { selected: true, ..Default::default() };
        assert_eq!(push_decision(&e, None), PushDecision::Safe);
    }

    #[test]
    fn push_decision_stale_when_never_synced_but_host_exists() {
        // A local file the user wants to push, but the host already has an
        // unsynced file there — don't clobber blindly.
        let e = SyncEntry { selected: true, ..Default::default() };
        assert_eq!(push_decision(&e, Some((5, Some(3)))), PushDecision::Stale);
    }

    #[test]
    fn push_decision_stale_when_host_deleted_after_sync() {
        let e = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            last_pull_ts: Some(1),
            ..Default::default()
        };
        assert_eq!(push_decision(&e, None), PushDecision::Stale);
    }

    #[test]
    fn should_use_rsync_requires_both_ends_and_a_dir() {
        assert!(should_use_rsync(true, true, true));
        assert!(!should_use_rsync(true, true, false)); // single file → SFTP
        assert!(!should_use_rsync(false, true, true)); // missing locally
        assert!(!should_use_rsync(true, false, true)); // missing on host
    }

    #[test]
    fn rsync_transport_rides_controlmaster() {
        let e = rsync_ssh_transport(None);
        assert!(e.starts_with("ssh "));
        assert!(e.contains("ControlMaster=no"));
        assert!(e.contains("ControlPath="));
        assert!(e.contains("cm-%C"));
        // Port absent → no -p.
        assert!(!e.contains(" -p "));
    }

    #[test]
    fn rsync_transport_includes_port() {
        let e = rsync_ssh_transport(Some(2222));
        assert!(e.contains(" -p 2222"));
    }

    #[test]
    fn rsync_pull_args_build_target_and_flags() {
        let args = rsync_pull_args(
            &Some("alice".to_string()),
            "host.example",
            None,
            "/srv/p/",
            "/local/mirror/",
        );
        assert_eq!(args[0], "-a");
        assert_eq!(args[1], "-c");
        assert_eq!(args[2], "-e");
        assert!(args[3].contains("ControlPath="));
        assert_eq!(args[4], "alice@host.example:/srv/p/");
        assert_eq!(args[5], "/local/mirror/");
    }

    #[test]
    fn rsync_pull_args_omit_user_when_absent() {
        let args = rsync_pull_args(&None, "host.example", None, "/srv/p/", "/m/");
        assert_eq!(args[4], "host.example:/srv/p/");
    }

    #[test]
    fn join_remote_handles_root_and_rel() {
        assert_eq!(join_remote("/srv/p", ""), "/srv/p");
        assert_eq!(join_remote("/srv/p/", "a/b"), "/srv/p/a/b");
        assert_eq!(join_remote("/srv/p", "/a"), "/srv/p/a");
        assert_eq!(join_remote("", "a"), "/a");
        assert_eq!(join_remote("", ""), "/");
    }

    #[test]
    fn join_rel_appends_segments() {
        assert_eq!(join_rel("", "a"), "a");
        assert_eq!(join_rel("a", "b"), "a/b");
        assert_eq!(join_rel("a/b/", "c"), "a/b/c");
    }

    #[test]
    fn compute_state_green_when_base_matches() {
        let e = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            local_size: 10,
            local_mtime: Some(50),
            ..Default::default()
        };
        // Both host and local match their recorded bases → green.
        assert_eq!(
            compute_state(&e, Some((10, Some(100))), Some((10, Some(50)))),
            SyncState::Green,
        );
    }

    #[test]
    fn compute_state_amber_when_host_moved() {
        let e = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            local_size: 10,
            local_mtime: Some(50),
            ..Default::default()
        };
        // Host size changed (local unchanged).
        assert_eq!(
            compute_state(&e, Some((12, Some(100))), Some((10, Some(50)))),
            SyncState::Amber,
        );
        // Host mtime changed (local unchanged).
        assert_eq!(
            compute_state(&e, Some((10, Some(200))), Some((10, Some(50)))),
            SyncState::Amber,
        );
    }

    #[test]
    fn compute_state_amber_when_local_moved() {
        let e = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            local_size: 10,
            local_mtime: Some(50),
            last_pull_ts: Some(1),
            ..Default::default()
        };
        // Host still matches its base, but the local mirror mtime moved → amber.
        assert_eq!(
            compute_state(&e, Some((10, Some(100))), Some((10, Some(80)))),
            SyncState::Amber,
        );
        // Also amber offline (host not stat'd) when the local size moved.
        assert_eq!(compute_state(&e, None, Some((12, Some(50)))), SyncState::Amber);
        // Mirror deleted after a prior sync → diverged.
        assert_eq!(compute_state(&e, Some((10, Some(100))), None), SyncState::Amber);
    }

    #[test]
    fn compute_state_none_when_unselected() {
        let e = SyncEntry { selected: false, ..Default::default() };
        assert_eq!(compute_state(&e, Some((0, None)), None), SyncState::None);
    }

    #[test]
    fn record_pull_marks_selected_and_stamps_bases() {
        let mut m = Manifest::new();
        record_pull(&mut m, "src/main.rs", 42, Some(7), 42, Some(9));
        let e = m.get("src/main.rs").unwrap();
        assert!(e.selected);
        assert_eq!(e.host_size, 42);
        assert_eq!(e.host_mtime, Some(7));
        assert_eq!(e.local_size, 42);
        assert_eq!(e.local_mtime, Some(9));
        assert!(e.last_pull_ts.is_some());
    }

    #[test]
    fn mirror_path_joins_under_mirror() {
        let p = mirror_local_path("pid", "a/b.txt");
        assert!(p.ends_with("remote-projects/pid/mirror/a/b.txt"));
    }

    #[test]
    fn divergence_splits_the_two_sides() {
        let e = SyncEntry {
            selected: true,
            host_size: 10,
            host_mtime: Some(100),
            local_size: 10,
            local_mtime: Some(50),
            last_pull_ts: Some(1),
            ..Default::default()
        };
        // Neither side moved → (false, false).
        assert_eq!(
            divergence(&e, Some((10, Some(100))), Some((10, Some(50)))),
            (false, false)
        );
        // Host moved only → (true, false): the auto engine pulls.
        assert_eq!(
            divergence(&e, Some((12, Some(100))), Some((10, Some(50)))),
            (true, false)
        );
        // Local moved only → (false, true): the auto engine pushes.
        assert_eq!(
            divergence(&e, Some((10, Some(100))), Some((10, Some(80)))),
            (false, true)
        );
        // Both moved → (true, true): amber, skipped by the auto engine.
        assert_eq!(
            divergence(&e, Some((12, Some(100))), Some((10, Some(80)))),
            (true, true)
        );
        // Host not stat'd (cold) → host side never flagged.
        assert_eq!(divergence(&e, None, Some((10, Some(50)))), (false, false));
    }

    #[test]
    fn is_auto_follows_own_entry_and_ancestor_folder_markers() {
        let mut m = Manifest::new();
        // A file with its own auto flag.
        m.insert(
            "solo.txt".to_string(),
            SyncEntry { selected: true, auto_sync: true, ..Default::default() },
        );
        // An auto folder marker; its descendants inherit auto even with no entry.
        m.insert(
            "src".to_string(),
            SyncEntry { selected: true, is_dir: true, auto_sync: true, ..Default::default() },
        );
        // A NON-auto folder marker; its descendants are not auto.
        m.insert(
            "vendor".to_string(),
            SyncEntry { selected: true, is_dir: true, ..Default::default() },
        );

        assert!(is_auto(&m, "solo.txt"));
        assert!(is_auto(&m, "src/main.rs")); // inherits from src/
        assert!(is_auto(&m, "src/a/b/deep.rs")); // any depth under an auto folder
        assert!(!is_auto(&m, "vendor/lib.rs")); // ancestor folder not auto
        assert!(!is_auto(&m, "other.txt")); // no entry, no auto ancestor

        // A plain FILE entry named like a dir must not act as a folder marker.
        m.insert(
            "notadir".to_string(),
            SyncEntry { selected: true, auto_sync: true, is_dir: false, ..Default::default() },
        );
        assert!(!is_auto(&m, "notadir/child.rs"));
    }

    #[test]
    fn is_auto_project_wide_root_marker_and_exclusions() {
        let mut m = Manifest::new();
        // Project-wide "auto-sync all": the root "" directory marker.
        m.insert(
            "".to_string(),
            SyncEntry { selected: true, is_dir: true, auto_sync: true, ..Default::default() },
        );
        // Everything is auto under the project-wide marker, at any depth and for
        // top-level files (which `rfind('/')` never resolves to the root).
        assert!(is_auto(&m, "README.md"));
        assert!(is_auto(&m, "src/main.rs"));
        assert!(is_auto(&m, "a/b/c/deep.rs"));

        // A local OFF override carves a subtree out of the project-wide auto.
        m.insert(
            "vendor".to_string(),
            SyncEntry { selected: true, is_dir: true, auto_off: true, ..Default::default() },
        );
        assert!(!is_auto(&m, "vendor/lib.rs"));
        assert!(!is_auto(&m, "vendor")); // the folder itself
        assert!(is_auto(&m, "src/main.rs")); // siblings unaffected

        // A single excluded file under an otherwise-auto tree.
        m.insert(
            "src/secret.rs".to_string(),
            SyncEntry { selected: true, auto_off: true, ..Default::default() },
        );
        assert!(!is_auto(&m, "src/secret.rs"));
        assert!(is_auto(&m, "src/other.rs"));

        // A local ON override wins over an ancestor exclusion (nearest marker).
        m.insert(
            "vendor/keep".to_string(),
            SyncEntry { selected: true, is_dir: true, auto_sync: true, ..Default::default() },
        );
        assert!(is_auto(&m, "vendor/keep/x.rs"));
        assert!(!is_auto(&m, "vendor/other/y.rs")); // still excluded

        // Project-wide OFF (root auto_off): nothing auto except explicit ON paths.
        m.insert(
            "".to_string(),
            SyncEntry { selected: true, is_dir: true, auto_off: true, ..Default::default() },
        );
        assert!(!is_auto(&m, "README.md"));
        assert!(is_auto(&m, "vendor/keep/x.rs")); // explicit ON still wins
    }

    /// Why `commands::projects::clear_host_bound_state` must exist.
    ///
    /// A manifest entry is a claim about **one specific host**. Point the project at a
    /// different one — detach, then extend to a corrected path, which is the normal way to
    /// fix a wrong `remote_path` — and every base in it becomes a lie. The state dir is
    /// keyed by project *id*, which detach preserves, so without an explicit purge the new
    /// pairing inherits the old host's manifest wholesale.
    ///
    /// The two pure functions below then disagree about the same file in the worst
    /// possible way, and this test pins both halves so the purge can never be quietly
    /// dropped:
    ///   * `push_decision` sees `ever_synced` + a missing host file and calls it `Stale` —
    ///     a deletion to be resolved, not a file to send. So it **refuses to push**.
    ///   * `divergence` maps the same failed host stat to "couldn't check → don't flag",
    ///     so with the mirror untouched the file reads `(false, false)` — **green**.
    ///
    /// A file the tree reports as fully in sync, on a host that has never had it, which
    /// byte-sync will never send. It would look like the sync simply worked.
    #[test]
    fn a_stale_manifest_against_a_fresh_host_is_a_false_green() {
        // Synced against the OLD host, and untouched locally since.
        let stale = SyncEntry {
            selected: true,
            auto_sync: true,
            host_size: 10,
            host_mtime: Some(100),
            local_size: 10,
            local_mtime: Some(100),
            last_pull_ts: Some(1),
            ..Default::default()
        };
        let local_unchanged = Some((10u64, Some(100u64)));

        // The new host has never heard of this file.
        assert_eq!(
            push_decision(&stale, None),
            PushDecision::Stale,
            "refuses to push: it reads the absence as a host-side DELETION, not a new host"
        );
        assert_eq!(
            divergence(&stale, None, local_unchanged),
            (false, false),
            "…and paints it green while doing so"
        );

        // Cleared (as a fresh pairing must be), the very same file behaves correctly: it
        // is simply a local file the host lacks, so it gets created there.
        let fresh = SyncEntry { selected: true, auto_sync: true, ..Default::default() };
        assert_eq!(push_decision(&fresh, None), PushDecision::Safe);
        assert_eq!(
            divergence(&fresh, None, local_unchanged),
            (false, true),
            "local-only change → push, which is exactly the seed a new host needs"
        );
    }
}
