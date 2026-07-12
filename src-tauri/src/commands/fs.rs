//! Filesystem command handlers: the file-tree browser, gitignore editing, MIME
//! detection, and the absolute-path file readers/writers backing the in-app
//! viewers. Extracted from `commands::projects` (Structure #1) so the
//! path-confinement security work (Security #1/#3) and MIME-laziness work
//! (Efficiency #15) have a dedicated, testable home alongside `fs_watch`.

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::schema::boxes::BoxesList;
use crate::schema::projects::{ProjectEntry, ProjectsList};
use crate::storage;

// ── File tree ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_secs: Option<u64>,
    pub created_secs: Option<u64>,
    pub extension: Option<String>,
    pub mime: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectPathEntry {
    pub path: String,
    pub is_dir: bool,
}

/// Resolve the extension's MIME type lazily. Efficiency #15: only call this when
/// a MIME is actually needed rather than eagerly for every listed file.
fn mime_for_ext(ext: &str) -> String {
    mime_guess::from_ext(ext.trim_start_matches('.'))
        .first_or_octet_stream()
        .to_string()
}

/// Build a [`FileEntry`] from a directory entry's path + metadata. Shared by the
/// project-confined lister ([`list_dir_local`]) and the unconfined downloads
/// scanner ([`list_recent_downloads`]) so both produce byte-identical shapes.
fn file_entry_from(path: &Path, meta: &fs::Metadata, name: String) -> FileEntry {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| format!(".{s}"));
    // Efficiency #15: compute the MIME lazily from the extension only when there
    // is one, instead of always producing octet-stream fallbacks.
    let mime = ext.as_deref().map(mime_for_ext);
    FileEntry {
        name,
        path: display_path(path),
        is_dir: meta.is_dir(),
        size: if meta.is_file() { meta.len() } else { 0 },
        modified_secs: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()),
        created_secs: meta
            .created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()),
        extension: ext,
        mime,
    }
}

/// List directory contents — project-aware (mount-free remote, Phase 2):
///
/// - **Remote project** → list the directory over SFTP, riding the pooled
///   session opened on activation (`services::remote`), or a one-shot session if
///   the pool is cold. Detected FIRST, before any local-fs touch, via
///   [`remote_target_for_dir`] (the `project_dir` the frontend passes is the
///   project's stored `directory`).
/// - **Local project** → `fs::read_dir`, validating the path stays inside the
///   project root. Byte-identical to the pre-Phase-2 behavior.
///
/// `pool` is Tauri-injected managed state; the frontend does not pass it.
#[tauri::command]
pub async fn list_dir(
    project_dir: String,
    rel_path: String,
    pool: tauri::State<'_, crate::services::remote::RemotePoolState>,
) -> Result<Vec<FileEntry>, String> {
    // Detect remote BEFORE any local-fs access (`canonical` would touch the fs).
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        return list_dir_remote(&target, &rel_path, pool.inner()).await;
    }
    list_dir_local(&project_dir, &rel_path)
}

/// Local-fs directory listing — the pre-Phase-2 behavior, byte-identical.
/// Split out of the `list_dir` command so it stays sync (no Tauri `State`) and
/// is directly unit/integration-testable.
pub fn list_dir_local(project_dir: &str, rel_path: &str) -> Result<Vec<FileEntry>, String> {
    let root = canonical(project_dir)?;
    let target = if rel_path.is_empty() {
        root.clone()
    } else {
        canonical(&root.join(rel_path).to_string_lossy().to_string())?
    };

    enforce_confinement(&root, &target)?;

    let entries = fs::read_dir(&target).map_err(|e| e.to_string())?;

    let mut result: Vec<FileEntry> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        // Always hide .eldrun/ — it is internal runtime storage, not user content.
        if name == ".eldrun" {
            continue;
        }
        result.push(file_entry_from(&path, &meta, name));
    }
    result.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(result)
}

/// Scan one or more download *source* folders and return their recently-modified
/// entries, merged and sorted newest-first. Backs the right-panel Downloads
/// section (fast-copy of freshly downloaded files into a project).
///
/// Unlike [`list_dir`], the `paths` are user-chosen source folders that live
/// OUTSIDE any project root, so path-confinement deliberately does not apply here
/// — this is a read-only scan the user explicitly configured. Missing/unreadable
/// folders are skipped rather than failing the whole call (a stale configured
/// path must not break the section). Dot-hidden entries are skipped; top-level
/// files and folders are included (a browser can drop a folder), no recursion.
///
/// `since_secs` (Unix seconds) keeps only entries modified at or after it; `None`
/// returns everything. Results are sorted by `modified_secs` descending, then by
/// name, so the most recent download is first.
#[tauri::command]
pub fn list_recent_downloads(
    paths: Vec<String>,
    since_secs: Option<u64>,
) -> Result<Vec<FileEntry>, String> {
    let mut result: Vec<FileEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for dir in &paths {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            // Missing/unreadable source dir — skip it, don't fail the whole scan.
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            // Skip dot-hidden entries (partial-download temp files, etc.).
            if name.starts_with('.') {
                continue;
            }
            let fe = file_entry_from(&path, &meta, name);
            if let Some(since) = since_secs {
                if !matches!(fe.modified_secs, Some(m) if m >= since) {
                    continue;
                }
            }
            // De-dupe when the same absolute path is reachable via two configured
            // source folders (e.g. a folder plus a symlink pointing into it).
            if seen.insert(fe.path.clone()) {
                result.push(fe);
            }
        }
    }
    result.sort_by(|a, b| {
        b.modified_secs
            .cmp(&a.modified_secs)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(result)
}

// ── Remote (SFTP) directory listing (mount-free remote, Phase 2) ────────────

/// List a remote project's directory over SFTP and map the entries into the same
/// `FileEntry` shape the local lister returns. Prefers the pooled session opened
/// on activation; if the project is not connected (cold pool / dropped link) it
/// falls back to a one-shot session so browsing still works. An unreachable host
/// surfaces as the `Err` from the SFTP layer (ConnectTimeout) rather than hanging.
async fn list_dir_remote(
    target: &crate::services::remote::RemoteTarget,
    rel_path: &str,
    pool: &crate::services::remote::RemotePoolState,
) -> Result<Vec<FileEntry>, String> {
    let spec = &target.spec;
    let remote_dir = join_remote_dir(&spec.remote_path, rel_path);

    let entries = match crate::services::remote::pooled_sftp(pool, &target.project_id).await {
        Some(sftp) => crate::services::sftp::list_dir_on(&sftp, &remote_dir).await?,
        // Cold pool: one-shot session (key/agent auth — no stored password). The
        // one-shot path uses ConnectTimeout so an unreachable host fails fast.
        None => {
            crate::services::sftp::list_dir(&spec.user, &spec.host, spec.port, None, &remote_dir)
                .await?
        }
    };

    Ok(entries
        .into_iter()
        // Always hide .eldrun/ — mirrors the local lister (internal runtime dir).
        .filter(|e| e.name != ".eldrun")
        .map(|e| remote_file_entry(&remote_dir, e))
        .collect())
}

/// Recursive byte size of a single directory — project-aware, mirroring
/// [`list_dir`]. Computed lazily by the file tree (one call per folder shown), so
/// it is kept off the listing hot path: the tree renders immediately and folder
/// sizes fill in as they resolve.
///
/// - **Remote project** → `du` on the host over SSH (`remote_dir_size`).
/// - **Local project** → walk the subtree on a blocking thread so a large folder
///   (e.g. `node_modules`) never stalls the async runtime.
///
/// A folder that can't be fully read yields the partial total rather than an
/// error, since this is a best-effort display aid.
#[tauri::command]
pub async fn dir_size(
    project_dir: String,
    rel_path: String,
    pool: tauri::State<'_, crate::services::remote::RemotePoolState>,
) -> Result<u64, String> {
    let _ = &pool; // remote path uses SSH exec, not the SFTP pool; keep the arg for symmetry
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let remote_dir = join_remote_dir(&target.spec.remote_path, &rel_path);
        let spec = target.spec.clone();
        return tokio::task::spawn_blocking(move || {
            crate::services::ssh_exec::remote_dir_size(&spec, &remote_dir)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    tokio::task::spawn_blocking(move || dir_size_local(&project_dir, &rel_path))
        .await
        .map_err(|e| e.to_string())?
}

/// Local-fs recursive directory size (bytes). Confinement-checked like the local
/// lister, then a symlink-skipping walk (so a symlink cycle can't loop forever).
pub fn dir_size_local(project_dir: &str, rel_path: &str) -> Result<u64, String> {
    let root = canonical(project_dir)?;
    let target = if rel_path.is_empty() {
        root.clone()
    } else {
        canonical(&root.join(rel_path).to_string_lossy().to_string())?
    };
    enforce_confinement(&root, &target)?;
    Ok(walk_dir_size(&target))
}

/// Sum file sizes under `dir`, recursing into subdirectories. Symlinks are never
/// followed (avoids cycles and double-counting); unreadable dirs/entries are
/// skipped, so the result is a best-effort total.
fn walk_dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = fs::read_dir(dir) else {
        return 0;
    };
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            total = total.saturating_add(walk_dir_size(&entry.path()));
        } else if ft.is_file() {
            if let Ok(m) = entry.metadata() {
                total = total.saturating_add(m.len());
            }
        }
    }
    total
}

/// Join a remote project root (`remote_path`) with a project-relative path,
/// mirroring `ssh_exec::remote_subdir`-style joining: trim a trailing '/', then
/// append the non-empty rel. Pure, so it is unit-tested without a live host.
fn join_remote_dir(remote_path: &str, rel: &str) -> String {
    let base = remote_path.trim_end_matches('/');
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() {
        if base.is_empty() { "/".to_string() } else { base.to_string() }
    } else if base.is_empty() {
        format!("/{rel}")
    } else {
        format!("{base}/{rel}")
    }
}

/// Map one SFTP [`Entry`](crate::services::sftp::Entry) into a `FileEntry`. The
/// `path` is the **absolute remote path** (`remote_dir`/name) so the frontend's
/// existing absolute-path model keeps working during the sshfs→SFTP transition.
/// `extension`/`mime` come from the file name (as the local lister does);
/// `created_secs` is unavailable over SFTP.
fn remote_file_entry(remote_dir: &str, e: crate::services::sftp::Entry) -> FileEntry {
    let path = format!("{}/{}", remote_dir.trim_end_matches('/'), e.name);
    let ext = Path::new(&e.name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{s}"));
    let mime = ext.as_deref().map(mime_for_ext);
    FileEntry {
        name: e.name,
        path,
        is_dir: e.is_dir,
        size: e.size,
        modified_secs: e.modified_secs,
        created_secs: None,
        extension: ext,
        mime,
    }
}

// ── Remote (SFTP) file I/O dispatch (mount-free remote, Phase 3) ────────────
//
// Each remote operation is pooled-session-first with a one-shot fallback — the
// I/O analogue of `list_dir_remote`. Confinement is the remote counterpart of
// the local `confine_abs`/`enforce_confinement`: a project-relative path is
// validated to stay under the project root (no `..`/absolute escape), and an
// absolute remote path must resolve at or under `spec.remote_path`.

type RemoteTarget = crate::services::remote::RemoteTarget;
type RemotePoolState = crate::services::remote::RemotePoolState;

/// Resolve a project-relative path under a remote project root, rejecting
/// `..`/absolute traversal — the remote analogue of `canonical` + relative
/// `enforce_confinement`. Reuses `normalize_project_rel_path` (which rejects
/// `..`/root components and strips a leading `/`), then joins onto the root.
pub(crate) fn remote_join_confined(remote_root: &str, rel_path: &str) -> Result<String, String> {
    let clean = normalize_project_rel_path(rel_path)?;
    Ok(join_remote_dir(remote_root, &clean))
}

/// Confine an **absolute** remote path to the project's remote root: reject any
/// parent-directory component and require the path to sit at or under
/// `remote_root` on a path boundary (so `/srv/proj-evil` is NOT inside
/// `/srv/proj`). The remote analogue of `confine_abs_within`. Pure, unit-tested.
fn confine_remote_abs(remote_root: &str, path: &str) -> Result<(), String> {
    if Path::new(path)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("remote path '{path}' contains a parent-directory component"));
    }
    let root = remote_root.trim_end_matches('/');
    let p = path.trim_end_matches('/');
    let inside = root.is_empty() // remote_path "/" → the whole remote fs is the root
        || p == root
        || p.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'));
    if inside {
        Ok(())
    } else {
        Err(format!(
            "remote path '{path}' is outside the project root '{remote_root}'"
        ))
    }
}

/// Clone the pooled SFTP session for the target's project, or `None` (cold pool).
async fn pooled(pool: &RemotePoolState, target: &RemoteTarget) -> Option<std::sync::Arc<openssh_sftp_client::Sftp>> {
    crate::services::remote::pooled_sftp(pool, &target.project_id).await
}

pub(crate) async fn remote_read(pool: &RemotePoolState, target: &RemoteTarget, path: &str) -> Result<Vec<u8>, String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::read_file_on(&sftp, path).await,
        None => crate::services::sftp::read_file(&s.user, &s.host, s.port, None, path).await,
    }
}

async fn remote_write(pool: &RemotePoolState, target: &RemoteTarget, path: &str, bytes: &[u8]) -> Result<(), String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::write_file_on(&sftp, path, bytes).await,
        None => crate::services::sftp::write_file(&s.user, &s.host, s.port, None, path, bytes).await,
    }
}

async fn remote_create_file(pool: &RemotePoolState, target: &RemoteTarget, path: &str) -> Result<(), String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::create_file_on(&sftp, path).await,
        None => crate::services::sftp::create_file(&s.user, &s.host, s.port, None, path).await,
    }
}

async fn remote_mkdir(pool: &RemotePoolState, target: &RemoteTarget, path: &str) -> Result<(), String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::mkdir_on(&sftp, path).await,
        None => crate::services::sftp::mkdir(&s.user, &s.host, s.port, None, path).await,
    }
}

async fn remote_remove_file(pool: &RemotePoolState, target: &RemoteTarget, path: &str) -> Result<(), String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::remove_file_on(&sftp, path).await,
        None => crate::services::sftp::remove_file(&s.user, &s.host, s.port, None, path).await,
    }
}

async fn remote_remove_dir(pool: &RemotePoolState, target: &RemoteTarget, path: &str) -> Result<(), String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::remove_dir_on(&sftp, path).await,
        None => crate::services::sftp::remove_dir(&s.user, &s.host, s.port, None, path).await,
    }
}

async fn remote_rename(pool: &RemotePoolState, target: &RemoteTarget, from: &str, to: &str) -> Result<(), String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::rename_on(&sftp, from, to).await,
        None => crate::services::sftp::rename(&s.user, &s.host, s.port, None, from, to).await,
    }
}

async fn remote_metadata(pool: &RemotePoolState, target: &RemoteTarget, path: &str) -> Result<(u64, Option<u64>), String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::metadata_on(&sftp, path).await,
        None => crate::services::sftp::metadata(&s.user, &s.host, s.port, None, path).await,
    }
}

#[tauri::command]
pub fn list_project_endings(project_dir: String) -> Result<Vec<String>, String> {
    let root = canonical(&project_dir)?;
    let mut endings = BTreeSet::new();
    collect_project_endings(&root, &root, 0, &mut endings)?;
    Ok(endings.into_iter().collect())
}

#[tauri::command]
pub fn list_project_paths(project_dir: String) -> Result<Vec<ProjectPathEntry>, String> {
    let root = canonical(&project_dir)?;
    let mut paths = Vec::new();
    collect_project_paths(&root, &root, "", 0, &mut paths)?;
    paths.sort_by_key(|entry| (!entry.is_dir, entry.path.to_lowercase()));
    Ok(paths)
}

/// Validate that `new_name` is a bare file name (no separators, not `.`/`..`),
/// returning the trimmed name. Shared by the local and remote rename paths.
fn validate_bare_name(new_name: &str) -> Result<String, String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return Err(format!("invalid file name '{trimmed}'"));
    }
    Ok(trimmed.to_string())
}

/// Rename a file or directory — path must stay inside the project root.
/// `new_name` must be a bare file name; renames never move entries between
/// directories. Remote projects (mount-free, Phase 3) rename over SFTP; local
/// projects keep the byte-identical local behavior.
#[tauri::command]
pub async fn rename_path(
    project_dir: String,
    old_rel: String,
    new_name: String,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    let name = validate_bare_name(&new_name)?;
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let from = remote_join_confined(&target.spec.remote_path, &old_rel)?;
        // Rename in place: keep `from`'s directory, swap the final component.
        let to = match from.rfind('/') {
            Some(i) => format!("{}/{}", &from[..i], name),
            None => name.clone(),
        };
        return remote_rename(pool.inner(), &target, &from, &to).await;
    }
    rename_path_local(&project_dir, &old_rel, &new_name)
}

/// Local-fs rename — the pre-Phase-3 body, byte-identical. Re-validates so it is
/// directly callable in tests.
pub fn rename_path_local(project_dir: &str, old_rel: &str, new_name: &str) -> Result<(), String> {
    let new_name = validate_bare_name(new_name)?;

    let root = canonical(project_dir)?;
    let old = canonical(&root.join(old_rel).to_string_lossy().to_string())?;
    enforce_confinement(&root, &old)?;

    let new = old.parent().ok_or("no parent")?.join(&new_name);
    // New path must also stay inside root.
    let new_c = canonical_or_new(&new);
    enforce_confinement(&root, &new_c)?;

    fs::rename(&old, &new).map_err(|e| e.to_string())
}

/// Delete a file — never a directory (safety: use trash or explicit confirm for dirs).
#[tauri::command]
pub async fn delete_file(
    project_dir: String,
    rel_path: String,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_remove_file(pool.inner(), &target, &full).await;
    }
    delete_file_local(&project_dir, &rel_path)
}

/// Local-fs file delete — byte-identical pre-Phase-3 body.
pub fn delete_file_local(project_dir: &str, rel_path: &str) -> Result<(), String> {
    let root = canonical(project_dir)?;
    let target = canonical(&root.join(rel_path).to_string_lossy().to_string())?;
    enforce_confinement(&root, &target)?;

    if target.is_dir() {
        return Err("use delete_dir for directories".to_string());
    }
    fs::remove_file(&target).map_err(|e| e.to_string())
}

/// Delete a directory tree inside the project root.
#[tauri::command]
pub async fn delete_dir(
    project_dir: String,
    rel_path: String,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let clean = normalize_project_rel_path(&rel_path)?;
        if clean.is_empty() {
            return Err("refusing to delete project root".to_string());
        }
        let full = join_remote_dir(&target.spec.remote_path, &clean);
        return remote_remove_dir(pool.inner(), &target, &full).await;
    }
    delete_dir_local(&project_dir, &rel_path)
}

/// Local-fs directory-tree delete — byte-identical pre-Phase-3 body.
pub fn delete_dir_local(project_dir: &str, rel_path: &str) -> Result<(), String> {
    let root = canonical(project_dir)?;
    let target = canonical(&root.join(rel_path).to_string_lossy().to_string())?;
    enforce_confinement(&root, &target)?;

    if target == root {
        return Err("refusing to delete project root".to_string());
    }
    if !target.is_dir() {
        return Err("use delete_file for files".to_string());
    }
    fs::remove_dir_all(&target).map_err(|e| e.to_string())
}

/// Create a new empty file inside the project.
#[tauri::command]
pub async fn create_file(
    project_dir: String,
    rel_path: String,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_create_file(pool.inner(), &target, &full).await;
    }
    create_file_local(&project_dir, &rel_path)
}

/// Local-fs empty-file create — byte-identical pre-Phase-3 body.
pub fn create_file_local(project_dir: &str, rel_path: &str) -> Result<(), String> {
    let root = canonical(project_dir)?;
    let target = root.join(rel_path);
    let target_c = canonical_or_new(&target);
    enforce_confinement(&root, &target_c)?;

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::File::create(&target)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Write a text file inside the project.
#[tauri::command]
pub async fn write_project_file(
    project_dir: String,
    rel_path: String,
    content: String,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_write(pool.inner(), &target, &full, content.as_bytes()).await;
    }
    write_project_file_local(&project_dir, &rel_path, &content)
}

/// Local-fs text write — byte-identical pre-Phase-3 body.
pub fn write_project_file_local(project_dir: &str, rel_path: &str, content: &str) -> Result<(), String> {
    let root = canonical(project_dir)?;
    let target = root.join(rel_path);
    let target_c = canonical_or_new(&target);
    enforce_confinement(&root, &target_c)?;

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&target, content).map_err(|e| e.to_string())
}

/// Write raw bytes to a file inside the project (used for drag-and-drop uploads).
#[tauri::command]
pub async fn write_project_file_bytes(
    project_dir: String,
    rel_path: String,
    content: Vec<u8>,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_write(pool.inner(), &target, &full, &content).await;
    }
    write_project_file_bytes_local(&project_dir, &rel_path, &content)
}

/// Local-fs byte write — byte-identical pre-Phase-3 body.
pub fn write_project_file_bytes_local(project_dir: &str, rel_path: &str, content: &[u8]) -> Result<(), String> {
    let root = canonical(project_dir)?;
    let target = root.join(rel_path);
    let target_c = canonical_or_new(&target);
    enforce_confinement(&root, &target_c)?;

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&target, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_gitignore_rule(
    project_dir: String,
    rel_path: String,
    is_dir: bool,
    action: String,
) -> Result<(), String> {
    let root = canonical(&project_dir)?;
    let clean_rel = normalize_project_rel_path(&rel_path)?;
    let target_c = canonical_or_new(&root.join(&clean_rel));
    enforce_confinement(&root, &target_c)?;

    let gitignore_path = root.join(".gitignore");
    let existing = fs::read_to_string(&gitignore_path).unwrap_or_default();
    let mut lines: Vec<String> = existing.lines().map(|line| line.to_string()).collect();
    let new_rules = match action.as_str() {
        "ignore" => gitignore_ignore_rules(&clean_rel, is_dir),
        "unignore" => gitignore_unignore_rules(&clean_rel, is_dir),
        other => return Err(format!("unknown gitignore action: {other}")),
    };
    let inverse_rules = match action.as_str() {
        "ignore" => gitignore_unignore_rules(&clean_rel, is_dir),
        "unignore" => gitignore_ignore_rules(&clean_rel, is_dir),
        _ => Vec::new(),
    };

    lines.retain(|line| {
        let trimmed = line.trim();
        !new_rules.iter().any(|rule| rule == trimmed)
            && !inverse_rules.iter().any(|rule| rule == trimmed)
    });
    if !lines.is_empty() && lines.last().is_some_and(|line| !line.trim().is_empty()) {
        lines.push(String::new());
    }
    lines.extend(new_rules);
    let mut next = lines.join("\n");
    if !next.is_empty() {
        next.push('\n');
    }
    fs::write(&gitignore_path, next).map_err(|e| e.to_string())
}

/// Create a new directory inside the project.
#[tauri::command]
pub async fn create_dir(
    project_dir: String,
    rel_path: String,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_mkdir(pool.inner(), &target, &full).await;
    }
    create_dir_local(&project_dir, &rel_path)
}

/// Local-fs directory create — byte-identical pre-Phase-3 body.
pub fn create_dir_local(project_dir: &str, rel_path: &str) -> Result<(), String> {
    let root = canonical(project_dir)?;
    let target = root.join(rel_path);
    let target_c = canonical_or_new(&target);
    enforce_confinement(&root, &target_c)?;
    fs::create_dir_all(&target).map_err(|e| e.to_string())
}

/// Copy a file or directory tree into another location. Both ends are confined
/// to their respective project roots (which may be the same project, enabling an
/// in-project copy/paste, or two box-co-accessible projects). The destination
/// must not already exist, and a directory may not be copied into itself.
#[tauri::command]
pub fn copy_path(
    src_project_dir: String,
    src_rel: String,
    dest_project_dir: String,
    dest_rel: String,
) -> Result<(), String> {
    let (src, dest) = resolve_transfer(&src_project_dir, &src_rel, &dest_project_dir, &dest_rel)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    copy_recursive(&src, &dest).map_err(|e| e.to_string())
}

/// Move (cut/paste) a file or directory tree into another location. Same
/// confinement and pre-conditions as [`copy_path`]. Falls back to copy+remove
/// when a plain rename is not possible (e.g. across filesystems/mountpoints).
#[tauri::command]
pub fn move_path(
    src_project_dir: String,
    src_rel: String,
    dest_project_dir: String,
    dest_rel: String,
) -> Result<(), String> {
    let (src, dest) = resolve_transfer(&src_project_dir, &src_rel, &dest_project_dir, &dest_rel)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if fs::rename(&src, &dest).is_ok() {
        return Ok(());
    }
    // Cross-device rename fails with EXDEV — copy then delete the original.
    copy_recursive(&src, &dest).map_err(|e| e.to_string())?;
    let remove = if src.is_dir() {
        fs::remove_dir_all(&src)
    } else {
        fs::remove_file(&src)
    };
    remove.map_err(|e| e.to_string())
}

/// Import an external file or directory (dropped onto the right panel from the
/// OS file manager) into the project. Unlike [`copy_path`], the SOURCE is an
/// arbitrary absolute path outside the project, so it is not confined; only the
/// DESTINATION is confined to the project root. `dest_rel` is the project-
/// relative folder to drop into (empty = project root). On a name collision,
/// `replace=false` appends " (n)" before the extension (keep both); `replace=
/// true` overwrites the existing entry. Returns the final project-relative path
/// of the imported copy. Callers prompt the user (see `project_path_exists`)
/// before passing `replace=true`.
#[tauri::command]
pub fn import_external_file(
    project_dir: String,
    source_path: String,
    dest_rel: String,
    replace: bool,
) -> Result<String, String> {
    let src = canonical(&source_path)?;
    let root = canonical(&project_dir)?;

    let rel_dir = normalize_project_rel_path(&dest_rel)?;
    let dest_dir = if rel_dir.is_empty() {
        root.clone()
    } else {
        root.join(&rel_dir)
    };
    let dest_dir_c = canonical_or_new(&dest_dir);
    enforce_confinement(&root, &dest_dir_c)?;
    // Block copying a directory into its own subtree (would recurse forever).
    if dest_dir_c.starts_with(&src) {
        return Err("cannot copy a folder into itself".to_string());
    }

    let file_name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "source has no file name".to_string())?;
    let dest = if replace {
        dest_dir_c.join(&file_name)
    } else {
        unique_dest(&dest_dir_c, &file_name)
    };
    enforce_confinement(&root, &canonical_or_new(&dest))?;

    fs::create_dir_all(&dest_dir_c).map_err(|e| e.to_string())?;
    if replace && dest.exists() {
        // Clear the existing entry first so a file→dir (or dir→file) replace is
        // clean rather than merging into a stale tree.
        if dest.is_dir() {
            fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(&dest).map_err(|e| e.to_string())?;
        }
    }
    copy_recursive(&src, &dest).map_err(|e| e.to_string())?;

    Ok(dest
        .strip_prefix(&root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or(file_name))
}

/// Whether a project-relative path currently exists. The drag-drop importer
/// calls this before copying so it can prompt rename-vs-replace on a collision.
#[tauri::command]
pub fn project_path_exists(project_dir: String, rel_path: String) -> Result<bool, String> {
    let root = canonical(&project_dir)?;
    let rel = normalize_project_rel_path(&rel_path)?;
    let target = if rel.is_empty() { root.clone() } else { root.join(&rel) };
    let target_c = canonical_or_new(&target);
    enforce_confinement(&root, &target_c)?;
    Ok(target_c.exists())
}

/// Extract a `.zip` archive in place. Contents land in a new sibling folder
/// named after the archive (without its extension, deduped with " (n)"), inside
/// the same directory as the archive — so a double-click in the file tree never
/// dumps loose files over the current folder. Returns the project-relative path
/// of the created folder.
///
/// Security: guards against Zip-Slip. Every entry's path goes through
/// `enclosed_name` (which rejects `..`/absolute components), and the resolved
/// output is additionally confined to the destination folder before any write.
#[tauri::command]
pub fn extract_archive(project_dir: String, rel_path: String) -> Result<String, String> {
    let root = canonical(&project_dir)?;
    let archive = canonical(&root.join(&rel_path).to_string_lossy().to_string())?;
    enforce_confinement(&root, &archive)?;
    if !archive.is_file() {
        return Err("not a file".to_string());
    }

    let parent = archive
        .parent()
        .ok_or("archive has no parent directory")?
        .to_path_buf();
    let stem = archive
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "archive has no name".to_string())?;
    // Reuse the " (n)" collision suffixing — `stem` has no extension, so the
    // suffix simply lands at the end of the folder name.
    let dest_dir = unique_dest(&parent, &stem);
    enforce_confinement(&root, &canonical_or_new(&dest_dir))?;

    let file = fs::File::open(&archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        // `enclosed_name` returns None for any path that would escape the
        // destination (`..`, absolute, drive prefix) — skip those rather than
        // trusting the archive.
        let rel = match entry.enclosed_name() {
            Some(p) => p,
            None => continue,
        };
        let out = dest_dir.join(&rel);
        // Defense in depth: confine the resolved output to the dest folder.
        enforce_confinement(&dest_dir, &canonical_or_new(&out))?;
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out.parent() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut outfile = fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
        }
    }

    Ok(dest_dir
        .strip_prefix(&root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or(stem))
}

/// Pick a non-colliding destination path in `dir` for `file_name`, appending
/// " (1)", " (2)", … before the extension until a free name is found.
fn unique_dest(dir: &Path, file_name: &str) -> PathBuf {
    let direct = dir.join(file_name);
    if !direct.exists() {
        return direct;
    }
    // A leading-dot name with no other dot (".gitignore") has no extension, so
    // `stem` keeps the whole name and the suffix lands at the end.
    let ext = Path::new(file_name).extension().and_then(|e| e.to_str());
    let stem = match ext {
        Some(e) => &file_name[..file_name.len() - e.len() - 1],
        None => file_name,
    };
    for n in 1..10_000 {
        let candidate = match ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        let p = dir.join(candidate);
        if !p.exists() {
            return p;
        }
    }
    direct
}

/// Validate and resolve a copy/move: confine both ends, refuse an existing
/// destination, a no-op, and copying a directory into its own subtree.
fn resolve_transfer(
    src_project_dir: &str,
    src_rel: &str,
    dest_project_dir: &str,
    dest_rel: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let src_root = canonical(src_project_dir)?;
    let src = canonical(&src_root.join(src_rel).to_string_lossy().to_string())?;
    enforce_confinement(&src_root, &src)?;
    if src == src_root {
        return Err("refusing to copy the project root".to_string());
    }

    let dest_root = canonical(dest_project_dir)?;
    let dest = dest_root.join(dest_rel);
    let dest_c = canonical_or_new(&dest);
    enforce_confinement(&dest_root, &dest_c)?;

    if dest_c.exists() {
        return Err(format!("'{}' already exists", dest.display()));
    }
    if dest_c == src {
        return Err("source and destination are the same".to_string());
    }
    // Block copying a directory into its own subtree (would recurse forever).
    if dest_c.starts_with(&src) {
        return Err("cannot copy a folder into itself".to_string());
    }
    Ok((src, dest))
}

/// Recursively copy `src` to `dest`. Directories are recreated and their
/// contents copied entry by entry; symlinks are not followed (copied as their
/// target's contents via the recursive descent on the resolved metadata).
fn copy_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dest)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dest.join(entry.file_name()))?;
        }
    } else {
        fs::copy(src, dest)?;
    }
    Ok(())
}

// ── MIME detection (magic bytes) ──────────────────────────────────────────

/// Detect a file's MIME type. Local projects sniff magic bytes (then fall back to
/// the extension); remote projects (mount-free, Phase 3) use the **extension**
/// only — avoiding a network fetch just to classify — after confining the path to
/// the remote project root.
#[tauri::command]
pub async fn detect_mime(
    path: String,
    project_id: Option<String>,
    _pool: tauri::State<'_, RemotePoolState>,
) -> Result<String, String> {
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a mirror-local path is classified on the LOCAL fs
            // (magic bytes); a host path uses the extension only (no fetch).
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                return Ok(ext_mime_or_octet(&path));
            }
        }
    }
    detect_mime_local(&path, project_id.as_deref())
}

/// Extension-based MIME for `path`, defaulting to `application/octet-stream`.
fn ext_mime_or_octet(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(mime_for_ext)
        .unwrap_or_else(|| "application/octet-stream".to_string())
}

/// Local-fs MIME detection — byte-identical pre-Phase-3 body.
pub fn detect_mime_local(path: &str, scope_id: Option<&str>) -> Result<String, String> {
    let p = PathBuf::from(path);
    confine_abs_read(&p, scope_id)?;
    // 1. Try magic bytes via infer.
    if let Ok(mut f) = fs::File::open(&p) {
        let mut buf = [0u8; 8192];
        use std::io::Read;
        if let Ok(n) = f.read(&mut buf) {
            if let Some(kind) = infer::get(&buf[..n]) {
                return Ok(kind.mime_type().to_string());
            }
        }
    }
    // 2. Fall back to extension.
    Ok(ext_mime_or_octet(path))
}

// ── Viewer source classification (remote-native vs local mirror) ──────────

/// Classify where an in-app viewer's bytes come from, for the viewer's source
/// notice. Returns exactly one of:
///   - `"remote"` — a remote (SSH) project path served straight from the host
///                  over SFTP (remote-native, no local copy).
///   - `"local"`  — a remote project path under the local **mirror**, read on the
///                  LOCAL fs (the paired working copy synced from the host).
///   - `"none"`   — a local project (or root scope): there is no remote/local
///                  distinction, so the frontend shows no badge.
/// This mirrors the *exact* routing `read_file_text`/`read_file_bytes` apply
/// (`remote_target_for` gates remoteness, `is_under_mirror` picks the side), so
/// the badge can never disagree with where the bytes were actually read from.
#[tauri::command]
pub fn file_source(path: String, project_id: Option<String>) -> String {
    match project_id.as_deref() {
        Some(pid) if crate::services::remote::remote_target_for(pid).is_some() => {
            if crate::services::remote_sync::is_under_mirror(pid, &path) {
                "local".to_string()
            } else {
                "remote".to_string()
            }
        }
        _ => "none".to_string(),
    }
}

// ── Read file contents for in-app viewers (Group K #40) ───────────────────

/// Largest text file we will load into an in-app viewer (8 MiB). Larger files
/// are refused rather than risking a multi-MB string crossing the IPC bridge.
const MAX_TEXT_VIEW_BYTES: u64 = 8 * 1024 * 1024;
/// Largest binary (PDF) we will load into the in-app viewer (64 MiB).
const MAX_BINARY_VIEW_BYTES: u64 = 64 * 1024 * 1024;

/// Read an absolute file path as UTF-8 text for the in-app text/markdown viewer.
///
/// Takes an absolute path (the same `FileEntry.path` the file tree already uses
/// to open files). Security #1: the path is confined to Eldrun's known roots
/// (`~/eldrun`, the sshfs mounts dir, the state dir) so a content-injection in
/// a renderer cannot turn this into an arbitrary file read of e.g.
/// `~/.ssh/id_rsa`. Refuses files over `MAX_TEXT_VIEW_BYTES` and non-UTF-8
/// (binary) files.
#[tauri::command]
pub async fn read_file_text(
    path: String,
    project_id: Option<String>,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<String, String> {
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a path under the local mirror is read on the LOCAL fs
            // even for a remote project, so the local source view / local-on-remote
            // tabs see mirrored bytes instead of round-tripping SFTP.
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                let (size, _) = remote_metadata(pool.inner(), &target, &path).await?;
                if size > MAX_TEXT_VIEW_BYTES {
                    return Err(format!(
                        "file too large to view ({size} bytes; limit {MAX_TEXT_VIEW_BYTES})"
                    ));
                }
                let bytes = remote_read(pool.inner(), &target, &path).await?;
                return String::from_utf8(bytes)
                    .map_err(|_| "file is not valid UTF-8 text".to_string());
            }
        }
    }
    read_file_text_local(&path, project_id.as_deref())
}

/// Local-fs text read — byte-identical pre-Phase-3 body.
pub fn read_file_text_local(path: &str, scope_id: Option<&str>) -> Result<String, String> {
    let p = PathBuf::from(path);
    confine_abs_read(&p, scope_id)?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    if meta.len() > MAX_TEXT_VIEW_BYTES {
        return Err(format!(
            "file too large to view ({} bytes; limit {})",
            meta.len(),
            MAX_TEXT_VIEW_BYTES
        ));
    }
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8 text".to_string())
}

/// Write UTF-8 text to an absolute file path from the in-app editor.
///
/// Counterpart to `read_file_text`: same absolute `FileEntry.path`, confined to
/// Eldrun's known roots (Security #1 — without it any reachable IPC caller could
/// overwrite arbitrary user files), refuses to grow a file past
/// `MAX_TEXT_VIEW_BYTES`, and only writes to an existing regular file (the
/// editor edits files opened from the tree; it never creates new paths).
#[tauri::command]
pub async fn write_file_text(
    path: String,
    content: String,
    project_id: Option<String>,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a mirror-local path saves to the LOCAL mirror (Phase 2
            // optionally pushes it on to the host through sync_push).
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                if content.len() as u64 > MAX_TEXT_VIEW_BYTES {
                    return Err(format!(
                        "content too large to save ({} bytes; limit {})",
                        content.len(),
                        MAX_TEXT_VIEW_BYTES
                    ));
                }
                return remote_write(pool.inner(), &target, &path, content.as_bytes()).await;
            }
        }
    }
    write_file_text_local(&path, &content, project_id.as_deref())
}

/// Local-fs text write (existing regular file only) — byte-identical pre-Phase-3 body.
pub fn write_file_text_local(path: &str, content: &str, scope_id: Option<&str>) -> Result<(), String> {
    let p = PathBuf::from(path);
    confine_abs_write(&p, scope_id)?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    if content.len() as u64 > MAX_TEXT_VIEW_BYTES {
        return Err(format!(
            "content too large to save ({} bytes; limit {})",
            content.len(),
            MAX_TEXT_VIEW_BYTES
        ));
    }
    fs::write(&p, content).map_err(|e| e.to_string())
}

/// Write raw bytes to an absolute path, confined to Eldrun's known roots
/// (Security #1). Unlike `write_file_text` this may create a new file (so the
/// image annotator can "Save as…" a sibling PNG), but still refuses paths
/// outside the allowed roots and oversized payloads.
#[tauri::command]
pub async fn write_file_bytes(
    path: String,
    content: Vec<u8>,
    project_id: Option<String>,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a mirror-local path writes to the LOCAL mirror.
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                if content.len() as u64 > MAX_BINARY_VIEW_BYTES {
                    return Err(format!(
                        "content too large to save ({} bytes; limit {})",
                        content.len(),
                        MAX_BINARY_VIEW_BYTES
                    ));
                }
                return remote_write(pool.inner(), &target, &path, &content).await;
            }
        }
    }
    write_file_bytes_local(&path, &content, project_id.as_deref())
}

/// Local-fs byte write (may create a new file) — byte-identical pre-Phase-3 body.
pub fn write_file_bytes_local(path: &str, content: &[u8], scope_id: Option<&str>) -> Result<(), String> {
    let p = PathBuf::from(path);
    confine_abs_write(&p, scope_id)?;
    if content.len() as u64 > MAX_BINARY_VIEW_BYTES {
        return Err(format!(
            "content too large to save ({} bytes; limit {})",
            content.len(),
            MAX_BINARY_VIEW_BYTES
        ));
    }
    fs::write(&p, content).map_err(|e| e.to_string())
}

/// Read an absolute file path as raw bytes for the in-app PDF viewer.
///
/// Confined to Eldrun's known roots (Security #1). Refuses files over
/// `MAX_BINARY_VIEW_BYTES`. The frontend wraps the returned bytes in a Blob URL
/// so the PDF renders in-tab without an external viewer.
#[tauri::command]
pub async fn read_file_bytes(
    path: String,
    project_id: Option<String>,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<Vec<u8>, String> {
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a mirror-local path reads from the LOCAL mirror.
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                let (size, _) = remote_metadata(pool.inner(), &target, &path).await?;
                if size > MAX_BINARY_VIEW_BYTES {
                    return Err(format!(
                        "file too large to view ({size} bytes; limit {MAX_BINARY_VIEW_BYTES})"
                    ));
                }
                return remote_read(pool.inner(), &target, &path).await;
            }
        }
    }
    read_file_bytes_local(&path, project_id.as_deref())
}

/// Local-fs byte read — byte-identical pre-Phase-3 body.
pub fn read_file_bytes_local(path: &str, scope_id: Option<&str>) -> Result<Vec<u8>, String> {
    let p = PathBuf::from(path);
    confine_abs_read(&p, scope_id)?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    if meta.len() > MAX_BINARY_VIEW_BYTES {
        return Err(format!(
            "file too large to view ({} bytes; limit {})",
            meta.len(),
            MAX_BINARY_VIEW_BYTES
        ));
    }
    fs::read(&p).map_err(|e| e.to_string())
}

/// Return a file's last-modified time as whole seconds since the Unix epoch.
///
/// Used by the in-app text/markdown/TeX viewer to poll for external changes
/// (#43 diff-aware auto-reload). Confined to Eldrun's known roots (Security #1).
/// Mirrors the `FileEntry.modified_secs` machinery in `list_dir`.
#[tauri::command]
pub async fn file_mtime(
    path: String,
    project_id: Option<String>,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<u64, String> {
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a mirror-local path is stat'd on the LOCAL fs.
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                let (_, modified) = remote_metadata(pool.inner(), &target, &path).await?;
                return Ok(modified.unwrap_or(0));
            }
        }
    }
    file_mtime_local(&path, project_id.as_deref())
}

/// Local-fs mtime — byte-identical pre-Phase-3 body.
pub fn file_mtime_local(path: &str, scope_id: Option<&str>) -> Result<u64, String> {
    let p = PathBuf::from(path);
    confine_abs_read(&p, scope_id)?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    let secs = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(secs)
}

// ── Absolute-path confinement (Security #1) ────────────────────────────────

/// The set of directories the absolute-path file commands may touch for a given
/// **scope**: the scope project's own directory, plus the directories of any
/// projects that share a box with it. Projects are filesystem-isolated from one
/// another — a file command made on behalf of project X can reach X's tree (and
/// any box sibling's tree, since box members are deliberately co-accessible), and
/// nothing else.
///
/// Crucially the scope is the project that *owns the calling viewer* (passed by
/// the frontend), NOT whichever project is globally "current". In-app viewers
/// stay mounted across project switches, are restored on relaunch, and can live
/// in detached windows; binding confinement to the current project made those
/// fail with a spurious "path is not in the current project" error the moment you
/// switched away (e.g. a `file_mtime` poll or `read_file_text` reload). Binding
/// it to the viewer's own project keeps strict per-project isolation while
/// letting a viewer keep working regardless of which project is current.
///
/// `scope_id` of `None` (root scope, or a caller that supplied no project) falls
/// back to the current project + its box siblings. Returns an empty set when the
/// scope resolves to no project (e.g. first run), which makes every absolute-path
/// command fail closed. See REVIEW.md Security #1.
fn allowed_roots(scope_id: Option<&str>) -> Vec<PathBuf> {
    let projects: ProjectsList = read_state_json("projects.json");
    let boxes: BoxesList = read_state_json("boxes.json");
    compute_allowed_roots(&projects, &boxes, scope_id)
}

/// Pure core of [`allowed_roots`], split out so the project/box scoping logic is
/// testable without touching the real state dir.
fn compute_allowed_roots(
    projects: &ProjectsList,
    boxes: &BoxesList,
    scope_id: Option<&str>,
) -> Vec<PathBuf> {
    // Anchor on the scope project when one is named, else the current project.
    let anchor = match scope_id {
        Some(id) => projects.iter().find(|e| e.id == id),
        None => projects.iter().find(|e| e.status == "current"),
    };
    let Some(anchor) = anchor else {
        return Vec::new();
    };

    // Start with the anchor project, then fold in every member of any box the
    // anchor belongs to (`member_ids` is the authoritative membership —
    // see schema::boxes::ProjectBox).
    let mut ids: HashSet<&str> = HashSet::new();
    ids.insert(anchor.id.as_str());
    for b in boxes {
        if b.member_ids.iter().any(|m| m == &anchor.id) {
            for m in &b.member_ids {
                ids.insert(m.as_str());
            }
        }
    }

    let in_scope = || projects.iter().filter(|e| ids.contains(e.id.as_str()));
    let mut roots: Vec<PathBuf> = in_scope().filter_map(project_dir).collect();
    // For a remote (SSH) project the tree the user actually browses is the local
    // *mirror*, not the state dir that `project_dir` returns. The default mirror
    // lives under the state dir (already covered above), but an explicit
    // `extra["mirror"]` relocation — including the top-level default minted at
    // import — sits outside it, so add each in-scope project's mirror override as
    // its own root. Otherwise opening a mirrored local file fails confinement
    // with a spurious "not in the current project" error. Pure: read straight
    // from the entry, no state-dir touch.
    roots.extend(in_scope().filter_map(mirror_override_dir));
    // Canonicalize where possible so symlinked roots compare correctly; fall
    // back to the literal path when the dir does not exist (yet).
    roots
        .iter_mut()
        .for_each(|r| *r = r.canonicalize().unwrap_or_else(|_| r.clone()));
    roots
}

/// A project entry's working directory: the canonical `directory` field when
/// present, otherwise the parent of its `local_file` (which is `<dir>/project.json`).
fn project_dir(entry: &ProjectEntry) -> Option<PathBuf> {
    if let Some(Value::String(d)) = entry.extra.get("directory") {
        if !d.is_empty() {
            return Some(PathBuf::from(d));
        }
    }
    Path::new(&entry.local_file)
        .parent()
        .map(|p| p.to_path_buf())
}

/// A remote project's explicit local-mirror override (`extra["mirror"]`), or
/// `None` when unset/empty or for a local project. Mirrors the resolution in
/// `services::remote_sync::mirror_override` but stays pure (reads the passed
/// entry, not the state dir) so `compute_allowed_roots` remains testable.
fn mirror_override_dir(entry: &ProjectEntry) -> Option<PathBuf> {
    let raw = entry.extra.get("mirror").and_then(Value::as_str)?.trim();
    (!raw.is_empty()).then(|| PathBuf::from(raw))
}

/// Read a JSON state file under `state_dir()`, defaulting to `T::default()` when
/// the file is absent or unparseable (so confinement degrades to fail-closed).
fn read_state_json<T>(name: &str) -> T
where
    T: serde::de::DeserializeOwned + Default,
{
    let path = storage::state_dir().join(name);
    if !path.exists() {
        return T::default();
    }
    storage::read_json(&path).unwrap_or_default()
}

/// Resolve `p` to a canonical path for confinement checks. For existing paths
/// this follows symlinks and `..`; for not-yet-existing paths it canonicalizes
/// the parent and re-joins the final component (so a write target inside an
/// allowed root still validates before creation).
fn resolve_for_confinement(p: &Path) -> PathBuf {
    if p.exists() {
        p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
    } else {
        match p.parent().and_then(|parent| parent.canonicalize().ok()) {
            Some(parent) => parent.join(p.file_name().unwrap_or_default()),
            None => p.to_path_buf(),
        }
    }
}

fn confine_abs(p: &Path, scope_id: Option<&str>) -> Result<(), String> {
    confine_abs_within(p, &allowed_roots(scope_id))
}

/// Pure confinement check against an explicit root set. Empty `roots` (no current
/// project) refuses everything.
fn confine_abs_within(p: &Path, roots: &[PathBuf]) -> Result<(), String> {
    let resolved = resolve_for_confinement(p);
    if roots.iter().any(|root| resolved.starts_with(root)) {
        Ok(())
    } else {
        Err(format!(
            "path '{}' is not in the current project (open that project, or add it to a box with the current one, to access it)",
            p.display()
        ))
    }
}

/// Confine a read of an absolute path to the scope's known roots.
fn confine_abs_read(p: &Path, scope_id: Option<&str>) -> Result<(), String> {
    confine_abs(p, scope_id)
}

/// Confine a write of an absolute path to the scope's known roots.
fn confine_abs_write(p: &Path, scope_id: Option<&str>) -> Result<(), String> {
    confine_abs(p, scope_id)
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn canonical(path: &str) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|e| format!("canonicalize {path}: {e}"))
}

/// Render a (typically canonicalized) path as the string handed to the frontend.
///
/// `fs::canonicalize` returns *verbatim* paths on Windows — `\\?\C:\proj\file`
/// for a drive path, `\\?\UNC\server\share\...` for a network path. The frontend
/// (`src/lib/paths.ts`) expects NATIVE paths (`C:\proj\file`, `\\server\share`)
/// and prefix-matches `entry.path` against the project directory (stored without
/// the verbatim prefix); the `\\?\` prefix would break that match and `file://`
/// URI building. This strips it. No-op on Unix and for paths lacking the prefix.
pub(crate) fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            // `\\?\UNC\server\share` → `\\server\share`
            return format!(r"\\{rest}");
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    s.into_owned()
}

fn collect_project_endings(
    root: &Path,
    dir: &Path,
    depth: usize,
    endings: &mut BTreeSet<String>,
) -> Result<(), String> {
    enforce_confinement(root, dir)?;
    if depth >= MAX_SCAN_DEPTH {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // Use the dir entry's own file type so symlinks are never followed —
        // a self-referential symlink (e.g. `repo -> .`) would otherwise recurse
        // until the path length limit. `Path::is_dir()` follows symlinks; this
        // does not.
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        if is_dir {
            if should_skip_ending_scan_dir(&name) {
                continue;
            }
            collect_project_endings(root, &path, depth + 1, endings)?;
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            endings.insert(format!(".{ext}"));
        }
    }
    Ok(())
}

fn normalize_project_rel_path(rel: &str) -> Result<String, String> {
    let p = std::path::Path::new(rel);
    for component in p.components() {
        match component {
            std::path::Component::ParentDir | std::path::Component::RootDir => {
                return Err(format!("invalid path component in '{rel}'"));
            }
            _ => {}
        }
    }
    Ok(rel.trim_start_matches('/').to_string())
}

fn gitignore_ignore_rules(rel_path: &str, is_dir: bool) -> Vec<String> {
    let rule = if is_dir {
        format!("/{rel_path}/")
    } else {
        format!("/{rel_path}")
    };
    vec![rule]
}

fn gitignore_unignore_rules(rel_path: &str, is_dir: bool) -> Vec<String> {
    let mut rules = Vec::new();
    let parts: Vec<&str> = rel_path.split('/').filter(|part| !part.is_empty()).collect();
    let parent_count = if is_dir { parts.len() } else { parts.len().saturating_sub(1) };
    for i in 0..parent_count {
        rules.push(format!("!/{}/", parts[..=i].join("/")));
    }
    if !is_dir {
        rules.push(format!("!/{rel_path}"));
    }
    rules
}

fn collect_project_paths(
    root: &Path,
    dir: &Path,
    rel_dir: &str,
    depth: usize,
    paths: &mut Vec<ProjectPathEntry>,
) -> Result<(), String> {
    enforce_confinement(root, dir)?;
    if depth >= MAX_SCAN_DEPTH {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".eldrun" {
            continue;
        }
        let rel_path = if rel_dir.is_empty() {
            name.clone()
        } else {
            format!("{rel_dir}/{name}")
        };
        // `entry.file_type()` does not follow symlinks; a symlinked directory is
        // reported as a non-directory so we never recurse through it (and so a
        // self-referential symlink can't loop). See collect_project_endings.
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        paths.push(ProjectPathEntry {
            path: rel_path.clone(),
            is_dir,
        });
        if is_dir && !should_skip_ending_scan_dir(&name) {
            collect_project_paths(root, &path, &rel_path, depth + 1, paths)?;
        }
    }
    Ok(())
}

/// Hard cap on recursive project-tree scan depth. Guards against pathological
/// trees (deep nesting, symlink chains) wedging a scan even though symlinks are
/// no longer followed.
const MAX_SCAN_DEPTH: usize = 64;

fn should_skip_ending_scan_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".eldrun" | "node_modules" | "target" | "dist" | "build" | ".next" | ".cache"
    )
}

fn canonical_or_new(path: &Path) -> PathBuf {
    // For new paths that don't exist yet, canonicalize the parent and join.
    if path.exists() {
        return path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    }
    let parent = path.parent().and_then(|p| p.canonicalize().ok());
    match parent {
        Some(p) => p.join(path.file_name().unwrap_or_default()),
        None => path.to_path_buf(),
    }
}

/// Enforce that `target` is inside `root` (relative-path project confinement).
pub(crate) fn enforce_confinement(root: &Path, target: &Path) -> Result<(), String> {
    if !target.starts_with(root) {
        return Err(format!(
            "path '{}' escapes project root '{}'",
            target.display(),
            root.display()
        ));
    }
    Ok(())
}

/// One subdirectory in a [`DirListing`]: its display name and absolute path.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
}

/// The directory listing backing the in-app folder-browser popup: the current
/// absolute directory, its parent (for up-navigation; `None` at a filesystem
/// root), and the immediate subdirectories.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
}

/// List the immediate subdirectories of a LOCAL directory for the in-app folder
/// picker. Unlike [`list_dir`], this is deliberately NOT project-confined — the
/// picker browses the whole local filesystem to choose a destination folder.
/// Empty `path` starts at the user's home directory. Files are omitted (only
/// folders); unreadable entries are skipped rather than failing the whole call.
#[tauri::command]
pub fn list_dirs(path: String) -> Result<DirListing, String> {
    let trimmed = path.trim();
    let base = if trimmed.is_empty() {
        crate::paths::home_dir()
    } else {
        PathBuf::from(trimmed)
    };
    // Best-effort canonicalize so `..`/symlinks resolve to a stable absolute
    // path; fall back to the raw path if it can't be canonicalized.
    let base = fs::canonicalize(&base).unwrap_or(base);

    let read = fs::read_dir(&base).map_err(|e| format!("cannot read '{}': {e}", base.display()))?;
    let mut entries: Vec<DirEntry> = read
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: display_path(&e.path()),
        })
        .collect();
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(DirListing {
        path: display_path(&base),
        parent: base.parent().map(display_path),
        entries,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // ── join_remote_dir / remote_file_entry ────────────────────────────────

    #[test]
    fn join_remote_dir_root_is_remote_path() {
        assert_eq!(join_remote_dir("/srv/project", ""), "/srv/project");
        // Trailing slash on the root is trimmed.
        assert_eq!(join_remote_dir("/srv/project/", ""), "/srv/project");
    }

    #[test]
    fn join_remote_dir_appends_relative() {
        assert_eq!(join_remote_dir("/srv/project", "sub/dir"), "/srv/project/sub/dir");
        // A leading slash on the rel is normalized away (no doubled slash).
        assert_eq!(join_remote_dir("/srv/project", "/sub"), "/srv/project/sub");
        assert_eq!(join_remote_dir("/srv/project/", "sub"), "/srv/project/sub");
    }

    #[test]
    fn join_remote_dir_handles_filesystem_root() {
        // remote_path "/" trims to empty; results stay single-leading-slash.
        assert_eq!(join_remote_dir("/", ""), "/");
        assert_eq!(join_remote_dir("/", "etc"), "/etc");
    }

    #[test]
    fn remote_file_entry_maps_path_and_mime() {
        let entry = crate::services::sftp::Entry {
            name: "notes.txt".to_string(),
            is_dir: false,
            size: 42,
            modified_secs: Some(1000),
        };
        let fe = remote_file_entry("/srv/project/src", entry);
        assert_eq!(fe.path, "/srv/project/src/notes.txt");
        assert_eq!(fe.extension.as_deref(), Some(".txt"));
        assert_eq!(fe.mime.as_deref(), Some("text/plain"));
        assert_eq!(fe.size, 42);
        assert_eq!(fe.modified_secs, Some(1000));
        assert_eq!(fe.created_secs, None);
        assert!(!fe.is_dir);
    }

    #[test]
    fn remote_file_entry_dir_has_no_extension() {
        let entry = crate::services::sftp::Entry {
            name: "src".to_string(),
            is_dir: true,
            size: 0,
            modified_secs: None,
        };
        let fe = remote_file_entry("/srv/project", entry);
        assert_eq!(fe.path, "/srv/project/src");
        assert_eq!(fe.extension, None);
        assert_eq!(fe.mime, None);
        assert!(fe.is_dir);
    }

    // ── enforce_confinement ────────────────────────────────────────────────

    #[test]
    fn enforce_confinement_allows_exact_root() {
        let root = PathBuf::from("/tmp/project");
        assert!(enforce_confinement(&root, &root).is_ok());
    }

    #[test]
    fn enforce_confinement_allows_child() {
        let root = PathBuf::from("/tmp/project");
        let child = PathBuf::from("/tmp/project/src/main.rs");
        assert!(enforce_confinement(&root, &child).is_ok());
    }

    #[test]
    fn enforce_confinement_blocks_parent_escape() {
        let root = PathBuf::from("/tmp/project");
        let parent = PathBuf::from("/tmp");
        assert!(enforce_confinement(&root, &parent).is_err());
    }

    #[test]
    fn enforce_confinement_blocks_sibling() {
        let root = PathBuf::from("/tmp/project");
        let sibling = PathBuf::from("/tmp/other");
        assert!(enforce_confinement(&root, &sibling).is_err());
    }

    #[test]
    fn enforce_confinement_blocks_absolute_escape() {
        let root = PathBuf::from("/tmp/project");
        let escape = PathBuf::from("/etc/passwd");
        assert!(enforce_confinement(&root, &escape).is_err());
    }

    #[test]
    fn enforce_confinement_error_message_mentions_root() {
        let root = PathBuf::from("/tmp/project");
        let escape = PathBuf::from("/etc/passwd");
        let err = enforce_confinement(&root, &escape).unwrap_err();
        assert!(
            err.contains("/tmp/project"),
            "error must mention root: {err}"
        );
    }

    // ── copy_path / move_path ──────────────────────────────────────────────

    #[test]
    fn copy_path_duplicates_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();

        copy_path(dir.clone(), "a.txt".into(), dir.clone(), "b.txt".into()).unwrap();

        assert_eq!(std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(), "hello");
        assert_eq!(std::fs::read_to_string(tmp.path().join("b.txt")).unwrap(), "hello");
    }

    #[test]
    fn copy_path_recurses_into_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        std::fs::create_dir(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/main.rs"), "fn main() {}").unwrap();

        copy_path(dir.clone(), "src".into(), dir.clone(), "src2".into()).unwrap();

        assert_eq!(
            std::fs::read_to_string(tmp.path().join("src2/main.rs")).unwrap(),
            "fn main() {}"
        );
        assert!(tmp.path().join("src/main.rs").exists());
    }

    #[test]
    fn copy_path_refuses_existing_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        std::fs::write(tmp.path().join("a.txt"), "1").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "2").unwrap();

        let err = copy_path(dir.clone(), "a.txt".into(), dir.clone(), "b.txt".into()).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        // The pre-existing destination is untouched.
        assert_eq!(std::fs::read_to_string(tmp.path().join("b.txt")).unwrap(), "2");
    }

    // ── extract_archive ────────────────────────────────────────────────────

    /// Write a minimal .zip (stored, no compression) at `path` from
    /// (entry-name, contents) pairs. An entry name ending in `/` is a directory.
    fn write_test_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            if name.ends_with('/') {
                zip.add_directory(*name, opts).unwrap();
            } else {
                use std::io::Write;
                zip.start_file(*name, opts).unwrap();
                zip.write_all(data).unwrap();
            }
        }
        zip.finish().unwrap();
    }

    #[test]
    fn extract_archive_unpacks_into_named_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        write_test_zip(
            &tmp.path().join("bundle.zip"),
            &[("a.txt", b"hello"), ("sub/", b""), ("sub/b.txt", b"world")],
        );

        let folder = extract_archive(dir.clone(), "bundle.zip".into()).unwrap();

        assert_eq!(folder, "bundle");
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("bundle/a.txt")).unwrap(),
            "hello"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("bundle/sub/b.txt")).unwrap(),
            "world"
        );
    }

    #[test]
    fn extract_archive_dedupes_existing_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        std::fs::create_dir(tmp.path().join("bundle")).unwrap();
        write_test_zip(&tmp.path().join("bundle.zip"), &[("a.txt", b"x")]);

        let folder = extract_archive(dir.clone(), "bundle.zip".into()).unwrap();

        assert_eq!(folder, "bundle (1)");
        assert!(tmp.path().join("bundle (1)/a.txt").exists());
    }

    #[test]
    fn extract_archive_ignores_zip_slip_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        // A crafted entry trying to escape the destination via `..`.
        write_test_zip(
            &tmp.path().join("evil.zip"),
            &[("../escaped.txt", b"pwned"), ("safe.txt", b"ok")],
        );

        extract_archive(dir.clone(), "evil.zip".into()).unwrap();

        // The traversal entry is dropped; the sibling escape file never appears.
        assert!(!tmp.path().join("escaped.txt").exists());
        assert!(tmp.path().join("evil/safe.txt").exists());
    }

    #[test]
    fn copy_path_refuses_directory_into_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        std::fs::create_dir(tmp.path().join("src")).unwrap();

        let err = copy_path(dir.clone(), "src".into(), dir.clone(), "src/inner".into()).unwrap_err();
        assert!(err.contains("into itself"), "{err}");
    }

    #[test]
    fn move_path_relocates_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();

        move_path(dir.clone(), "a.txt".into(), dir.clone(), "sub/b.txt".into()).unwrap();

        assert!(!tmp.path().join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(tmp.path().join("sub/b.txt")).unwrap(), "hello");
    }

    // ── import_external_file ───────────────────────────────────────────────

    #[test]
    fn import_external_file_copies_into_subfolder() {
        let ext = tempfile::tempdir().unwrap();
        std::fs::write(ext.path().join("photo.png"), "img").unwrap();
        let proj = tempfile::tempdir().unwrap();
        std::fs::create_dir(proj.path().join("assets")).unwrap();

        let rel = import_external_file(
            proj.path().to_string_lossy().to_string(),
            ext.path().join("photo.png").to_string_lossy().to_string(),
            "assets".into(),
            false,
        )
        .unwrap();

        assert_eq!(rel, "assets/photo.png");
        assert_eq!(
            std::fs::read_to_string(proj.path().join("assets/photo.png")).unwrap(),
            "img"
        );
        // Source is left in place (copy, not move).
        assert!(ext.path().join("photo.png").exists());
    }

    #[test]
    fn import_external_file_renames_on_collision() {
        let ext = tempfile::tempdir().unwrap();
        std::fs::write(ext.path().join("a.txt"), "new").unwrap();
        let proj = tempfile::tempdir().unwrap();
        std::fs::write(proj.path().join("a.txt"), "old").unwrap();

        let rel = import_external_file(
            proj.path().to_string_lossy().to_string(),
            ext.path().join("a.txt").to_string_lossy().to_string(),
            "".into(),
            false,
        )
        .unwrap();

        assert_eq!(rel, "a (1).txt");
        // The pre-existing file is untouched; the import lands beside it.
        assert_eq!(std::fs::read_to_string(proj.path().join("a.txt")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(proj.path().join("a (1).txt")).unwrap(), "new");
    }

    #[test]
    fn import_external_file_replace_overwrites() {
        let ext = tempfile::tempdir().unwrap();
        std::fs::write(ext.path().join("a.txt"), "new").unwrap();
        let proj = tempfile::tempdir().unwrap();
        std::fs::write(proj.path().join("a.txt"), "old").unwrap();

        let rel = import_external_file(
            proj.path().to_string_lossy().to_string(),
            ext.path().join("a.txt").to_string_lossy().to_string(),
            "".into(),
            true,
        )
        .unwrap();

        // Same name, content overwritten — no " (1)" copy created.
        assert_eq!(rel, "a.txt");
        assert_eq!(std::fs::read_to_string(proj.path().join("a.txt")).unwrap(), "new");
        assert!(!proj.path().join("a (1).txt").exists());
    }

    #[test]
    fn project_path_exists_reports_presence() {
        let proj = tempfile::tempdir().unwrap();
        std::fs::write(proj.path().join("here.txt"), "x").unwrap();
        let dir = proj.path().to_string_lossy().to_string();
        assert!(project_path_exists(dir.clone(), "here.txt".into()).unwrap());
        assert!(!project_path_exists(dir, "missing.txt".into()).unwrap());
    }

    #[test]
    fn import_external_file_recurses_into_directories() {
        let ext = tempfile::tempdir().unwrap();
        std::fs::create_dir(ext.path().join("pkg")).unwrap();
        std::fs::write(ext.path().join("pkg/mod.rs"), "fn x() {}").unwrap();
        let proj = tempfile::tempdir().unwrap();

        let rel = import_external_file(
            proj.path().to_string_lossy().to_string(),
            ext.path().join("pkg").to_string_lossy().to_string(),
            "".into(),
            false,
        )
        .unwrap();

        assert_eq!(rel, "pkg");
        assert_eq!(
            std::fs::read_to_string(proj.path().join("pkg/mod.rs")).unwrap(),
            "fn x() {}"
        );
    }

    #[test]
    fn import_external_file_rejects_escaping_dest() {
        let ext = tempfile::tempdir().unwrap();
        std::fs::write(ext.path().join("a.txt"), "x").unwrap();
        let proj = tempfile::tempdir().unwrap();

        let err = import_external_file(
            proj.path().to_string_lossy().to_string(),
            ext.path().join("a.txt").to_string_lossy().to_string(),
            "../escape".into(),
            false,
        )
        .unwrap_err();
        assert!(err.contains("invalid path component"), "{err}");
    }

    // ── list_project_endings ───────────────────────────────────────────────

    #[test]
    #[cfg(unix)]
    fn list_project_endings_does_not_follow_self_symlink() {
        // A symlink pointing back at the project root (`repo -> .`) must not
        // cause the recursive ending scan to loop. Before the fix this hung
        // until the OS path-length limit, walking the tree hundreds of times.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("main.rs"), "fn main() {}").unwrap();
        std::fs::create_dir(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/lib.py"), "x = 1").unwrap();
        std::os::unix::fs::symlink(tmp.path(), tmp.path().join("repo")).unwrap();

        let endings =
            list_project_endings(tmp.path().to_string_lossy().to_string()).unwrap();

        // Real file endings are collected; the self-symlink is never entered.
        assert!(endings.contains(&".rs".to_string()));
        assert!(endings.contains(&".py".to_string()));
    }

    // ── write_project_file / rename_path ────────────────────────────────────

    #[test]
    fn write_project_file_creates_nested_file_inside_project() {
        let tmp = tempfile::tempdir().unwrap();
        write_project_file_local(
            &tmp.path().to_string_lossy(),
            ".eldrun/scaffold-fill-claude.md",
            "fill AGENTS.md",
        )
        .unwrap();

        let content =
            std::fs::read_to_string(tmp.path().join(".eldrun/scaffold-fill-claude.md")).unwrap();
        assert_eq!(content, "fill AGENTS.md");
    }

    #[test]
    fn rename_path_renames_file_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("old.txt"), "content").unwrap();

        rename_path_local(&tmp.path().to_string_lossy(), "old.txt", "new.txt").unwrap();

        assert!(!tmp.path().join("old.txt").exists());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("new.txt")).unwrap(),
            "content"
        );
    }

    #[test]
    fn rename_path_rejects_non_bare_names() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "x").unwrap();
        let dir = tmp.path().to_string_lossy().to_string();

        for bad in ["", " ", ".", "..", "sub/name", "..\\name", "a\0b"] {
            let err = rename_path_local(&dir, "a.txt", bad);
            assert!(err.is_err(), "name {bad:?} must be rejected");
        }
        assert!(tmp.path().join("a.txt").exists(), "file must be untouched");
    }

    #[test]
    fn write_project_file_blocks_parent_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let err = write_project_file_local(
            &tmp.path().to_string_lossy(),
            "../outside.md",
            "escape",
        )
        .unwrap_err();

        assert!(err.contains("escapes project root"), "unexpected error: {err}");
    }

    // ── Remote path join / confinement (mount-free remote, Phase 3) ─────────

    #[test]
    fn remote_join_confined_joins_clean_rel() {
        assert_eq!(
            remote_join_confined("/srv/project", "src/main.rs").unwrap(),
            "/srv/project/src/main.rs"
        );
        // Empty rel resolves to the project root itself.
        assert_eq!(remote_join_confined("/srv/project", "").unwrap(), "/srv/project");
    }

    #[test]
    fn remote_join_confined_rejects_traversal() {
        assert!(remote_join_confined("/srv/project", "../escape").is_err());
        assert!(remote_join_confined("/srv/project", "a/../../b").is_err());
        // A leading slash (absolute rel) is a RootDir component → rejected, so a
        // caller can never pivot the join off the project root.
        assert!(remote_join_confined("/srv/project", "/etc/passwd").is_err());
    }

    #[test]
    fn confine_remote_abs_allows_paths_under_root() {
        assert!(confine_remote_abs("/srv/project", "/srv/project").is_ok());
        assert!(confine_remote_abs("/srv/project", "/srv/project/src/main.rs").is_ok());
        // Trailing slash on the root is tolerated.
        assert!(confine_remote_abs("/srv/project/", "/srv/project/a").is_ok());
    }

    #[test]
    fn confine_remote_abs_blocks_outside_and_prefix_sibling() {
        // A sibling that merely shares a string prefix must NOT be inside.
        assert!(confine_remote_abs("/srv/project", "/srv/project-evil/loot").is_err());
        // Unrelated absolute path.
        assert!(confine_remote_abs("/srv/project", "/etc/passwd").is_err());
        // Parent-dir traversal is refused even if it would resolve back inside.
        assert!(confine_remote_abs("/srv/project", "/srv/project/../secret").is_err());
    }

    // ── Absolute-path confinement (Security #1) ─────────────────────────────

    fn entry(id: &str, status: &str, dir: &str) -> ProjectEntry {
        let mut extra = std::collections::HashMap::new();
        extra.insert("directory".to_string(), Value::String(dir.to_string()));
        ProjectEntry {
            id: id.to_string(),
            name: id.to_string(),
            status: status.to_string(),
            position: 0,
            local_file: format!("{dir}/project.json"),
            extra,
        }
    }

    #[test]
    fn allowed_roots_scoped_to_named_project_not_current() {
        // The scope is the *viewer's own* project, not whichever is current. A
        // viewer owned by Y stays able to reach Y even while X is current — and
        // X's tree is NOT reachable through Y's scope (per-project isolation).
        let projects = vec![
            entry("x", "current", "/home/u/code/projectx"),
            entry("y", "inactive", "/home/u/code/projecty"),
        ];
        let roots = compute_allowed_roots(&projects, &Vec::new(), Some("y"));
        assert!(
            roots.iter().any(|r| r.ends_with("projecty")),
            "the scope project must be reachable even when it is not current"
        );
        assert!(
            !roots.iter().any(|r| r.ends_with("projectx")),
            "a project outside the scope must not be reachable"
        );
    }

    #[test]
    fn allowed_roots_falls_back_to_current_when_no_scope() {
        // No scope id (root scope / legacy caller) → the current project.
        let projects = vec![
            entry("x", "current", "/home/u/code/projectx"),
            entry("y", "inactive", "/home/u/code/projecty"),
        ];
        let roots = compute_allowed_roots(&projects, &Vec::new(), None);
        assert!(roots.iter().any(|r| r.ends_with("projectx")));
        assert!(!roots.iter().any(|r| r.ends_with("projecty")));
    }

    #[test]
    fn allowed_roots_includes_box_siblings_of_scope() {
        let projects = vec![
            entry("x", "current", "/home/u/code/projectx"),
            entry("y", "inactive", "/home/u/code/projecty"),
            entry("z", "inactive", "/home/u/code/projectz"),
        ];
        let boxes = vec![crate::schema::boxes::ProjectBox {
            id: "b1".to_string(),
            name: "grp".to_string(),
            member_ids: vec!["y".to_string(), "z".to_string()],
            ..Default::default()
        }];
        // Scope is Y; its box sibling Z is co-accessible, X (current) is not.
        let roots = compute_allowed_roots(&projects, &boxes, Some("y"));
        assert!(roots.iter().any(|r| r.ends_with("projecty")));
        assert!(roots.iter().any(|r| r.ends_with("projectz")));
        assert!(
            !roots.iter().any(|r| r.ends_with("projectx")),
            "a project outside the scope's box must not be reachable"
        );
    }

    #[test]
    fn allowed_roots_includes_remote_mirror_override() {
        // A remote (SSH) project's browsable tree is its local mirror, relocated
        // outside the state dir via extra["mirror"]. That mirror must be reachable
        // or opening a mirrored local file fails confinement (#28k regression).
        let mut r = entry("r", "current", "/home/u/.local/share/eldrun/remote-projects/r");
        r.extra.insert(
            "mirror".to_string(),
            Value::String("/home/u/eldrun/projects-ssh/myproj".to_string()),
        );
        let roots = compute_allowed_roots(&vec![r], &Vec::new(), Some("r"));
        assert!(
            roots.iter().any(|p| p.ends_with("projects-ssh/myproj")),
            "the relocated local mirror must be an allowed root"
        );
    }

    #[test]
    fn allowed_roots_empty_when_scope_unknown() {
        let projects = vec![entry("x", "current", "/home/u/code/projectx")];
        // An unknown scope id resolves to no project → fail closed.
        assert!(compute_allowed_roots(&projects, &Vec::new(), Some("nope")).is_empty());
    }

    #[test]
    fn allowed_roots_empty_when_no_current_and_no_scope() {
        let projects = vec![entry("x", "inactive", "/home/u/code/projectx")];
        assert!(compute_allowed_roots(&projects, &Vec::new(), None).is_empty());
    }

    #[test]
    fn confine_abs_within_blocks_outside_roots() {
        // With the current project at projectx, classic exploit targets and a
        // sibling project alike must be refused.
        let roots = vec![PathBuf::from("/home/u/code/projectx")];
        for p in [
            "/home/u/.ssh/id_rsa",
            "/home/u/.aws/credentials",
            "/etc/passwd",
            "/home/u/code/projecty/secret", // sibling project
        ] {
            assert!(
                confine_abs_within(Path::new(p), &roots).is_err(),
                "must refuse {p}"
            );
        }
    }

    #[test]
    fn confine_abs_within_allows_paths_inside_current_project() {
        let roots = vec![PathBuf::from("/home/u/code/projectx")];
        // A file inside the project tree must pass even before it exists (write
        // target validation canonicalizes the parent).
        let inside = Path::new("/home/u/code/projectx/src/main.rs");
        assert!(confine_abs_within(inside, &roots).is_ok());
    }

    #[test]
    fn confine_abs_within_blocks_prefix_sibling() {
        // /home/u/code/projectx-evil must NOT be treated as inside projectx.
        let roots = vec![PathBuf::from("/home/u/code/projectx")];
        let sibling = Path::new("/home/u/code/projectx-evil/loot");
        assert!(confine_abs_within(sibling, &roots).is_err());
    }

    #[test]
    fn confine_abs_within_empty_roots_refuses_everything() {
        assert!(confine_abs_within(Path::new("/home/u/code/projectx/a"), &[]).is_err());
    }

    // ── display_path ───────────────────────────────────────────────────────

    #[test]
    fn display_path_is_noop_without_verbatim_prefix() {
        // A plain path is returned unchanged on every platform.
        let p = if cfg!(target_os = "windows") {
            r"C:\Users\u\proj\file.txt"
        } else {
            "/home/u/proj/file.txt"
        };
        assert_eq!(display_path(Path::new(p)), p);
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn display_path_strips_windows_verbatim_prefixes() {
        // Drive verbatim prefix is removed so the frontend sees a native path.
        assert_eq!(
            display_path(Path::new(r"\\?\C:\proj\file.txt")),
            r"C:\proj\file.txt"
        );
        // UNC verbatim prefix collapses back to a `\\server\share` path.
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\file.txt")),
            r"\\server\share\file.txt"
        );
    }
}
