use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::paths;
use crate::schema::project::{Project, RemoteSpec, SandboxSpec};
use crate::schema::projects::{ProjectEntry, ProjectsList};
use crate::storage;

/// Local per-project state directory for a **remote** project:
/// `<state_dir>/remote-projects/<id>`. Mount-free remote projects keep their
/// `project.json` (tabs/time/etc.) here — a real local dir, unlike the old sshfs
/// mountpoint — while the project's tree lives on the host and is reached over
/// SFTP/SSH. This path becomes the project's `directory` (a stable local key the
/// fs/git/terminal commands resolve to a `RemoteTarget`).
fn remote_project_state_dir(id: &str) -> std::path::PathBuf {
    storage::state_dir().join("remote-projects").join(id)
}

/// Compute a `<name>` leaf under `parent` for a remote (SSH) project's local
/// mirror. `sanitize_name` keeps the folder readable; the `id` disambiguates a
/// name-based path already taken by another remote project, so two hosts' `~/work`
/// never collide on the same local mirror. Shared by the default location and the
/// user-chosen `mirror_parent`.
fn remote_mirror_in(parent: &Path, name: &str, id: &str) -> PathBuf {
    let safe = sanitize_name(name);
    let leaf = if safe.is_empty() { id.to_string() } else { safe };
    let candidate = parent.join(&leaf);
    if candidate.exists() {
        parent.join(format!("{leaf}-{}", &id[..id.len().min(8)]))
    } else {
        candidate
    }
}

/// The default local mirror location for a new remote (SSH) project: a readable
/// `<name>` subfolder of the top-level `eldrun/projects-ssh/` root (rather than a
/// hidden state dir or the managed-local `projects/` tree).
fn default_remote_mirror(name: &str, id: &str) -> PathBuf {
    remote_mirror_in(&paths::projects_ssh_root(), name, id)
}

/// Resolve a remote project's local mirror path: under the user-chosen
/// `mirror_parent` (the dialog's "Local location") when provided and non-empty,
/// otherwise the default `projects-ssh` root. Returns the full `<parent>/<name>`
/// path as a string, ready to store in `project.json`/`projects.json`.
fn resolve_remote_mirror(mirror_parent: Option<&str>, name: &str, id: &str) -> String {
    match mirror_parent.map(str::trim).filter(|p| !p.is_empty()) {
        Some(parent) => remote_mirror_in(Path::new(parent), name, id),
        None => default_remote_mirror(name, id),
    }
    .to_string_lossy()
    .to_string()
}

// ── Project list ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_projects() -> Result<ProjectsList, String> {
    let path = storage::state_dir().join("projects.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let mut list: ProjectsList = storage::read_json(&path).map_err(|e| e.to_string())?;
    // Migrate legacy git_type values (private/public) to the local/remote model
    // in-memory so the frontend always sees canonical values. Persisted on the
    // next natural save (no surprise write from a read command).
    for entry in list.iter_mut() {
        if let Some(Value::String(gt)) = entry.extra.get("git_type") {
            let norm = normalize_git_type(gt);
            if &norm != gt {
                entry
                    .extra
                    .insert("git_type".to_string(), Value::String(norm));
            }
        }
    }
    Ok(list)
}

/// Normalize a `git_type` value to the local/remote model used since Group D.
/// Legacy values map private → remote-private, public → remote-public; the
/// canonical values pass through; anything unrecognized falls back to "local".
pub(crate) fn normalize_git_type(value: &str) -> String {
    match value.trim() {
        "private" => "remote-private",
        "public" => "remote-public",
        "local" => "local",
        "none" => "none",
        "remote-private" => "remote-private",
        "remote-public" => "remote-public",
        _ => "local",
    }
    .to_string()
}

#[tauri::command]
pub fn save_projects(projects: ProjectsList) -> Result<(), String> {
    let path = storage::state_dir().join("projects.json");
    storage::write_json(&path, &projects).map_err(|e| e.to_string())
}

// ── Archive (delete → restorable holding area) ─────────────────────────────
//
// Deleting a project moves its LOCAL folders into `~/eldrun/archive/<id>/` and
// drops it from `projects.json`. A remote project's tree on its host is never
// touched — only its local state dir + mirror move. The archive is only cleared
// manually from Settings; restore moves the folders back and re-registers the
// project as `inactive`.

/// Restore manifest written into `archive/<id>/entry.json`. Holds the full
/// original `projects.json` entry (the source of truth for restore) plus the
/// archive stamp and a remote flag.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ArchiveManifest {
    entry: ProjectEntry,
    archived_at: String,
    remote: bool,
}

/// A summary row for the Settings "Archived projects" list.
#[derive(Debug, Clone, Serialize)]
pub struct ArchivedProject {
    pub id: String,
    pub name: String,
    pub archived_at: String,
    pub remote: bool,
}

/// Reject ids that could escape the archive root (path traversal). Project ids
/// are UUIDs in practice, so anything with a separator or `..` is invalid.
fn validate_project_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("invalid project id '{id}'"));
    }
    Ok(())
}

fn entry_directory(entry: &ProjectEntry) -> Option<String> {
    entry
        .extra
        .get("directory")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn entry_mirror(entry: &ProjectEntry) -> Option<String> {
    entry
        .extra
        .get("mirror")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn entry_is_remote(entry: &ProjectEntry) -> bool {
    entry
        .extra
        .get("remote")
        .map(|v| !v.is_null())
        .unwrap_or(false)
}

/// Move a directory tree from `src` to `dst`, creating `dst`'s parent. Tries a
/// fast `rename` first and falls back to recursive copy + remove when that fails
/// (e.g. a cross-filesystem move). No-op when `src` does not exist.
fn move_tree(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    copy_tree(src, dst).map_err(|e| e.to_string())?;
    fs::remove_dir_all(src).map_err(|e| e.to_string())?;
    Ok(())
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// The original path if free, else a collision-safe sibling, so restoring never
/// clobbers a folder re-created since the project was archived.
fn free_target(orig: &Path) -> PathBuf {
    if !orig.exists() {
        return orig.to_path_buf();
    }
    let parent = orig.parent().unwrap_or_else(|| Path::new("."));
    let stem = orig.file_name().and_then(|n| n.to_str()).unwrap_or("restored");
    for n in 1..1000 {
        let cand = parent.join(format!("{stem}-restored-{n}"));
        if !cand.exists() {
            return cand;
        }
    }
    parent.join(format!("{stem}-restored"))
}

/// Purge a project's time-tracking history: drop it from every day bucket of the
/// rolling summary and filter it out of the legacy append-only log if present.
/// Called only on PERMANENT deletion (archiving keeps the history).
fn purge_project_time(project_id: &str) {
    use crate::schema::time_log;
    let mut summary = time_log::load_summary_migrating();
    let mut changed = false;
    for by_project in summary.days.values_mut() {
        if by_project.remove(project_id).is_some() {
            changed = true;
        }
    }
    if changed {
        let _ = time_log::save_summary(&summary);
    }
    let legacy = storage::state_dir().join(time_log::LEGACY_LOG_FILE);
    if legacy.exists() {
        if let Ok(entries) = storage::read_json::<time_log::TimeLog>(&legacy) {
            let kept: time_log::TimeLog = entries
                .into_iter()
                .filter(|e| e.project_id != project_id)
                .collect();
            let _ = storage::write_json(&legacy, &kept);
        }
    }
}

/// Move a project into the archive and drop it from `projects.json`. `archived_at`
/// is a caller-supplied ISO timestamp (the frontend stamps it). The remote host
/// tree is never touched — only local folders move.
#[tauri::command]
pub fn archive_project(project_id: String, archived_at: String) -> Result<(), String> {
    validate_project_id(&project_id)?;

    let list_path = storage::state_dir().join("projects.json");
    let mut list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let idx = list
        .iter()
        .position(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    let entry = list[idx].clone();
    let remote = entry_is_remote(&entry);

    let dest = paths::archive_root().join(&project_id);
    if dest.exists() {
        return Err(format!(
            "an archived project with id '{project_id}' already exists"
        ));
    }
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;

    // Move the LOCAL folders. Remote host tree is intentionally left in place.
    if remote {
        move_tree(&remote_project_state_dir(&project_id), &dest.join("state"))?;
        if let Some(mirror) = entry_mirror(&entry) {
            move_tree(Path::new(&mirror), &dest.join("mirror"))?;
        }
    } else if let Some(dir) = entry_directory(&entry) {
        move_tree(Path::new(&dir), &dest.join("dir"))?;
    }

    let manifest = ArchiveManifest {
        entry,
        archived_at,
        remote,
    };
    storage::write_json(&dest.join("entry.json"), &manifest).map_err(|e| e.to_string())?;

    list.remove(idx);
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;
    Ok(())
}

/// List archived projects (newest first) for the Settings panel.
#[tauri::command]
pub fn list_archived_projects() -> Result<Vec<ArchivedProject>, String> {
    let root = paths::archive_root();
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if let Ok(m) = storage::read_json::<ArchiveManifest>(&entry.path().join("entry.json")) {
            out.push(ArchivedProject {
                id: m.entry.id.clone(),
                name: m.entry.name.clone(),
                archived_at: m.archived_at,
                remote: m.remote,
            });
        }
    }
    // Newest first; the stamp is an ISO string so a lexical sort is chronological.
    out.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
    Ok(out)
}

/// Restore an archived project: move its folders back (collision-safe) and
/// re-register it in `projects.json` as `inactive`. Returns the restored entry.
#[tauri::command]
pub fn restore_archived_project(project_id: String) -> Result<ProjectEntry, String> {
    validate_project_id(&project_id)?;

    let dest = paths::archive_root().join(&project_id);
    let manifest: ArchiveManifest =
        storage::read_json(&dest.join("entry.json")).map_err(|e| e.to_string())?;
    let mut entry = manifest.entry;

    if manifest.remote {
        // The state dir is keyed by id and was moved out on archive, so its
        // original path is free again.
        let state_dst = remote_project_state_dir(&project_id);
        move_tree(&dest.join("state"), &state_dst)?;
        entry.local_file = state_dst
            .join("project.json")
            .to_string_lossy()
            .to_string();
        entry.extra.insert(
            "directory".to_string(),
            Value::String(state_dst.to_string_lossy().to_string()),
        );
        let mirror_src = dest.join("mirror");
        if mirror_src.exists() {
            if let Some(orig) = entry_mirror(&entry) {
                let target = free_target(Path::new(&orig));
                move_tree(&mirror_src, &target)?;
                entry.extra.insert(
                    "mirror".to_string(),
                    Value::String(target.to_string_lossy().to_string()),
                );
            }
        }
    } else if let Some(dir) = entry_directory(&entry) {
        let target = free_target(Path::new(&dir));
        move_tree(&dest.join("dir"), &target)?;
        entry.extra.insert(
            "directory".to_string(),
            Value::String(target.to_string_lossy().to_string()),
        );
        entry.local_file = target.join("project.json").to_string_lossy().to_string();
    }

    entry.status = "inactive".to_string();

    let list_path = storage::state_dir().join("projects.json");
    let mut list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).unwrap_or_default()
    } else {
        Vec::new()
    };
    entry.position = next_position(&list);
    list.retain(|p| p.id != entry.id); // guard against a stale duplicate
    list.push(entry.clone());
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;

    fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    Ok(entry)
}

/// Permanently delete an archived project: remove its archive folder and purge
/// its time-tracking history. Irreversible.
#[tauri::command]
pub fn delete_archived_project(project_id: String) -> Result<(), String> {
    validate_project_id(&project_id)?;
    let dest = paths::archive_root().join(&project_id);
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    purge_project_time(&project_id);
    Ok(())
}

/// Permanently delete every archived project (Settings "Clear archive").
#[tauri::command]
pub fn clear_archive() -> Result<(), String> {
    for archived in list_archived_projects()? {
        delete_archived_project(archived.id)?;
    }
    Ok(())
}

/// Update a project's description in both `projects.json` (the pill list) and
/// the project's own `project.json`, keeping the two in sync. An empty/blank
/// description clears the field. Returns the cleaned description (or null).
#[tauri::command]
pub fn set_project_description(
    project_id: String,
    description: Option<String>,
) -> Result<Option<String>, String> {
    let cleaned = clean_description(description);

    // projects.json — find the entry and update its flattened `description`.
    let list_path = storage::state_dir().join("projects.json");
    let mut list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let entry = list
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    match &cleaned {
        Some(d) => {
            entry
                .extra
                .insert("description".to_string(), Value::String(d.clone()));
        }
        None => {
            entry.extra.remove("description");
        }
    }
    let local_file = entry.local_file.clone();
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;

    // project.json — keep the per-project file consistent (best effort: a
    // missing file is not fatal since the list is the source of truth for pills).
    let proj_path = PathBuf::from(&local_file);
    if proj_path.exists() {
        if let Ok(mut project) = storage::read_json::<Project>(&proj_path) {
            project.description = cleaned.clone();
            storage::write_json(&proj_path, &project).map_err(|e| e.to_string())?;
        }
    }

    Ok(cleaned)
}

/// Rename a project: update its display `name` in both `projects.json` (the
/// pill list) and the project's own `project.json`, keeping the two in sync.
/// The on-disk `directory` is left untouched — only the human-facing name
/// changes. A blank name is rejected. Returns the cleaned (trimmed) name.
#[tauri::command]
pub fn set_project_name(project_id: String, name: String) -> Result<String, String> {
    let cleaned = name.trim().to_string();
    if cleaned.is_empty() {
        return Err("project name cannot be empty".to_string());
    }

    // projects.json — find the entry and update its `name`.
    let list_path = storage::state_dir().join("projects.json");
    let mut list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let entry = list
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    entry.name = cleaned.clone();
    let local_file = entry.local_file.clone();
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;

    // project.json — keep the per-project file consistent (best effort: a
    // missing file is not fatal since the list is the source of truth for pills).
    let proj_path = PathBuf::from(&local_file);
    if proj_path.exists() {
        if let Ok(mut project) = storage::read_json::<Project>(&proj_path) {
            project.name = cleaned.clone();
            storage::write_json(&proj_path, &project).map_err(|e| e.to_string())?;
        }
    }

    Ok(cleaned)
}

/// Toggle the Docker sandbox for a project in both `projects.json` (so the pill
/// list / frontend can flag it without reading project.json) and the project's
/// own `project.json`. When `enabled` is false the `sandbox` field is cleared
/// (treated identically to "never set" — agents run on the host). Returns the
/// resulting enabled state.
#[tauri::command]
pub fn set_project_sandbox(project_id: String, enabled: bool) -> Result<bool, String> {
    let spec = enabled.then(|| SandboxSpec {
        enabled: true,
        ..Default::default()
    });

    // projects.json — mirror into the entry's flattened `sandbox`.
    let list_path = storage::state_dir().join("projects.json");
    let mut list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let entry = list
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    match &spec {
        Some(s) => {
            let value = serde_json::to_value(s).map_err(|e| e.to_string())?;
            entry.extra.insert("sandbox".to_string(), value);
        }
        None => {
            entry.extra.remove("sandbox");
        }
    }
    let local_file = entry.local_file.clone();
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;

    // project.json — keep the per-project file consistent (best effort).
    let proj_path = PathBuf::from(&local_file);
    if proj_path.exists() {
        if let Ok(mut project) = storage::read_json::<Project>(&proj_path) {
            project.sandbox = spec;
            storage::write_json(&proj_path, &project).map_err(|e| e.to_string())?;
        }
    }

    Ok(enabled)
}

/// Normalize a list of category tags: trim each, drop blanks, and de-duplicate
/// case-insensitively (first spelling wins), preserving order. Mirrors the
/// frontend `cleanCategories` so storage stays canonical regardless of caller.
fn clean_categories(raw: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for r in raw {
        let c = r.split_whitespace().collect::<Vec<_>>().join(" ");
        if c.is_empty() {
            continue;
        }
        if seen.insert(c.to_lowercase()) {
            out.push(c);
        }
    }
    out
}

/// Set a project's category tags in both `projects.json` (the pill list) and the
/// project's own `project.json`, keeping the two in sync. Categories color/group
/// the project in the cloud and the pill bar. An empty list clears the field
/// entirely. Returns the cleaned, de-duplicated list that was stored.
#[tauri::command]
pub fn set_project_categories(
    project_id: String,
    categories: Vec<String>,
) -> Result<Vec<String>, String> {
    let cleaned = clean_categories(categories);

    // projects.json — mirror into the entry's flattened `categories`.
    let list_path = storage::state_dir().join("projects.json");
    let mut list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let entry = list
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    if cleaned.is_empty() {
        entry.extra.remove("categories");
    } else {
        let value = serde_json::to_value(&cleaned).map_err(|e| e.to_string())?;
        entry.extra.insert("categories".to_string(), value);
    }
    let local_file = entry.local_file.clone();
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;

    // project.json — keep the per-project file consistent (best effort).
    let proj_path = PathBuf::from(&local_file);
    if proj_path.exists() {
        if let Ok(mut project) = storage::read_json::<Project>(&proj_path) {
            if cleaned.is_empty() {
                project.extra.remove("categories");
            } else {
                let value = serde_json::to_value(&cleaned).map_err(|e| e.to_string())?;
                project.extra.insert("categories".to_string(), value);
            }
            storage::write_json(&proj_path, &project).map_err(|e| e.to_string())?;
        }
    }

    Ok(cleaned)
}

/// Enable or disable git version control for an existing project.
///
/// **Destructive when disabling.** Disabling deletes the project's `.git`
/// directory and `.gitignore` file outright — every commit, branch, stash,
/// and remote is gone and cannot be recovered — and moves the project to
/// `git_type` `"none"`, the same state a "No git (local files only)" project
/// starts in. Enabling runs
/// `git init` (a no-op if a repo already exists), writes the default
/// `.gitignore` if missing (same as `scaffold_project`), and moves the
/// project to `git_type` `"local"`.
///
/// Returns the resulting `git_type`. Mirrors the change into both
/// `projects.json` and `project.json`, like `set_project_sandbox`.
#[tauri::command]
pub fn set_project_git_disabled(project_id: String, disabled: bool) -> Result<String, String> {
    // projects.json — locate the entry and resolve its on-disk directory.
    let list_path = storage::state_dir().join("projects.json");
    let mut list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let entry = list
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    let local_file = entry.local_file.clone();
    let directory = entry
        .extra
        .get("directory")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "project has no directory".to_string())?;
    if !directory.is_dir() {
        return Err(format!(
            "project directory does not exist: {}",
            directory.display()
        ));
    }

    let git_dir = directory.join(".git");
    let new_git_type = if disabled {
        // Destroy version-control history. `.git` is the single source of truth
        // for it, so removing the directory is the whole operation.
        if git_dir.exists() {
            fs::remove_dir_all(&git_dir)
                .map_err(|e| format!("failed to remove .git: {e}"))?;
        }
        let gitignore = directory.join(".gitignore");
        if gitignore.exists() {
            fs::remove_file(&gitignore)
                .map_err(|e| format!("failed to remove .gitignore: {e}"))?;
        }
        "none".to_string()
    } else {
        if !git_dir.exists() {
            let output = crate::paths::command_no_window("git")
                .args(["init"])
                .current_dir(&directory)
                .output()
                .map_err(|e| format!("failed to run git init: {e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "git init failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        }
        let gitignore = directory.join(".gitignore");
        if !gitignore.exists() {
            fs::write(&gitignore, GITIGNORE_DEFAULT)
                .map_err(|e| format!("failed to write .gitignore: {e}"))?;
        }
        "local".to_string()
    };

    // projects.json — mirror the new push-axis type into the flattened entry.
    entry
        .extra
        .insert("git_type".to_string(), Value::String(new_git_type.clone()));
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;

    // project.json — keep the per-project file consistent (best effort).
    let proj_path = PathBuf::from(&local_file);
    if proj_path.exists() {
        if let Ok(mut project) = storage::read_json::<Project>(&proj_path) {
            project.git_type = Some(new_git_type.clone());
            storage::write_json(&proj_path, &project).map_err(|e| e.to_string())?;
        }
    }

    Ok(new_git_type)
}

// ── Per-project project.json ───────────────────────────────────────────────

#[tauri::command]
pub fn load_project(local_file: String) -> Result<Project, String> {
    let path = PathBuf::from(&local_file);
    let mut project: Project = storage::read_json(&path).map_err(|e| e.to_string())?;
    if let Some(gt) = project.git_type.as_deref() {
        project.git_type = Some(normalize_git_type(gt));
    }
    Ok(project)
}

#[tauri::command]
pub fn save_project(local_file: String, project: Project) -> Result<(), String> {
    let path = PathBuf::from(&local_file);
    storage::write_json(&path, &project).map_err(|e| e.to_string())
}

/// Save only the tab layout — writes to both project.json and the session file.
#[tauri::command]
pub fn save_tab_layout(
    local_file: String,
    tabs: Vec<crate::schema::project::TabEntry>,
    groups: Option<Value>,
    sessions: Option<Value>,
) -> Result<(), String> {
    crate::services::terminal_service::save_tab_layout(&local_file, &tabs, groups, sessions)
}

#[tauri::command]
pub fn root_work_dir() -> String {
    storage::root_work_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn projects_root_dir() -> String {
    projects_root().to_string_lossy().to_string()
}

/// The default parent directory for a remote (SSH) project's local mirror — the
/// top-level `eldrun/projects-ssh/` root. The New/Import dialog seeds its "Local
/// location" picker from this so its default matches `default_remote_mirror`.
#[tauri::command]
pub fn remote_mirror_root_dir() -> String {
    paths::projects_ssh_root().to_string_lossy().to_string()
}

/// Open a directory in the OS file manager (Files/Finder/Explorer).
#[tauri::command]
pub fn open_in_file_manager(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    opener::open(&dir).map_err(|e| e.to_string())
}

/// The local mirror status for a remote (SSH) project — backs the pill's "Show on
/// disk". Returns the current mirror root (its stored override or the default),
/// whether that directory still exists on disk (a user may have deleted it), and
/// a suggested fresh location (`ssh/<name>` under the projects root) to default a
/// relocation picker to. Errors for a local project.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorStatus {
    pub path: String,
    pub exists: bool,
    pub suggested: String,
}

#[tauri::command]
pub fn remote_mirror_status(project_id: String, name: String) -> Result<MirrorStatus, String> {
    if crate::services::remote::remote_target_for(&project_id).is_none() {
        return Err("not a remote project".to_string());
    }
    let dir = crate::services::remote_sync::mirror_dir(&project_id);
    let suggested = default_remote_mirror(&name, &project_id);
    Ok(MirrorStatus {
        exists: dir.is_dir(),
        path: dir.to_string_lossy().to_string(),
        suggested: suggested.to_string_lossy().to_string(),
    })
}

/// Point a remote (SSH) project's local mirror at `path`, creating the directory,
/// and persist the choice in both `projects.json` (`extra["mirror"]`, the source
/// of truth `remote_sync::mirror_dir` reads) and the project's `project.json`.
/// Used when the user relocates a mirror whose folder was deleted. Returns the
/// resolved absolute path.
#[tauri::command]
pub fn set_remote_mirror_dir(project_id: String, path: String) -> Result<String, String> {
    if crate::services::remote::remote_target_for(&project_id).is_none() {
        return Err("not a remote project".to_string());
    }
    let dir = PathBuf::from(path.trim());
    if dir.as_os_str().is_empty() {
        return Err("Mirror path is empty".to_string());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let resolved = dir.to_string_lossy().to_string();
    persist_mirror_dir(&project_id, &resolved)?;
    Ok(resolved)
}

/// Persist a remote project's chosen mirror root into both `projects.json`
/// (`extra["mirror"]`, the always-local source of truth `remote_sync::mirror_dir`
/// reads) and the project's `project.json` (best effort). Shared by
/// `set_remote_mirror_dir` and `move_remote_mirror`.
fn persist_mirror_dir(project_id: &str, resolved: &str) -> Result<(), String> {
    // projects.json — the always-local source of truth.
    let list_path = storage::state_dir().join("projects.json");
    let mut list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let entry = list
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    entry
        .extra
        .insert("mirror".to_string(), Value::String(resolved.to_string()));
    let local_file = entry.local_file.clone();
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;

    // project.json — keep the per-project file consistent (best effort).
    let proj_path = PathBuf::from(&local_file);
    if proj_path.exists() {
        if let Ok(mut project) = storage::read_json::<Project>(&proj_path) {
            project.mirror = Some(resolved.to_string());
            storage::write_json(&proj_path, &project).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

/// Move a remote (SSH) project's local mirror folder to a new location: the user
/// picks a **parent** directory, and the mirror is relocated to
/// `<parent_dir>/<sanitized-name>` (disambiguated with a short id suffix if that
/// leaf is taken). The existing mirror bytes are moved (rename, with a
/// copy-then-remove fallback across filesystems); a never-synced mirror simply
/// has the new folder created. Persists the new pointer and returns its absolute
/// path. Errors for a local project. Backs the pill's "Move project…" option.
#[tauri::command]
pub fn move_remote_mirror(
    project_id: String,
    name: String,
    parent_dir: String,
) -> Result<String, String> {
    if crate::services::remote::remote_target_for(&project_id).is_none() {
        return Err("not a remote project".to_string());
    }
    let parent = PathBuf::from(parent_dir.trim());
    if parent.as_os_str().is_empty() {
        return Err("Destination folder is empty".to_string());
    }
    fs::create_dir_all(&parent).map_err(|e| e.to_string())?;

    // Compute the new leaf under the chosen parent, mirroring `default_remote_mirror`.
    let safe = sanitize_name(&name);
    let leaf = if safe.is_empty() { project_id.clone() } else { safe };
    let candidate = parent.join(&leaf);
    let new_root = if candidate.exists() {
        parent.join(format!("{leaf}-{}", &project_id[..project_id.len().min(8)]))
    } else {
        candidate
    };

    let old = crate::services::remote_sync::mirror_dir(&project_id);
    if old.exists() && old != new_root {
        // A plain rename fails across drives/filesystems (EXDEV on Unix). Fall
        // back to copy-then-remove so a cross-volume move still works.
        if fs::rename(&old, &new_root).is_err() {
            copy_dir_all(&old, &new_root)?;
            fs::remove_dir_all(&old).map_err(|e| e.to_string())?;
        }
    } else {
        fs::create_dir_all(&new_root).map_err(|e| e.to_string())?;
    }

    let resolved = new_root.to_string_lossy().to_string();
    persist_mirror_dir(&project_id, &resolved)?;
    Ok(resolved)
}

// ── Scaffold new project ───────────────────────────────────────────────────

const SCAFFOLD_FILES: &[(&str, &str)] = &[
    ("AGENTS.md", "# Agents\n"),
    ("CLAUDE.md", "# Claude Context\n"),
    ("GEMINI.md", "# Gemini Context\n"),
    ("TODO.md", "# TODO\n"),
    ("ROADMAP.md", "# Roadmap\n"),
    ("STATUS.md", "# Status\n"),
    ("README.md", "# Project\n"),
    ("DOCUMENTATION.md", "# Documentation\n"),
];

const GITIGNORE_DEFAULT: &str = "__pycache__/\n*.pyc\n.venv/\nnode_modules/\ntarget/\ndist/\nbuild/\n.env\n.env.local\n.DS_Store\n*.log\n*.swp\n*.swo\n.idea/\n.eldrun/\nproject.json\n";

const CLAUDE_SETTINGS: &str = r#"{"permissions":{"allow":[],"deny":[]}}"#;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldPreviewItem {
    pub path: String,
    pub exists: bool,
    pub kind: String,
}

/// Write the standard Eldrun project scaffold into a directory.
///
/// When `with_git` is false the scaffold files are still written but no git
/// repository is initialized — used for "local, no git" projects (git_type
/// `"none"`).
pub fn scaffold_project(dir: &Path, with_git: bool) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let dot_claude = dir.join(".claude");
    fs::create_dir_all(&dot_claude)?;

    for (name, content) in SCAFFOLD_FILES {
        let p = dir.join(name);
        if !p.exists() {
            fs::write(&p, content)?;
        }
    }
    let gi = dir.join(".gitignore");
    if !gi.exists() {
        fs::write(gi, GITIGNORE_DEFAULT)?;
    }
    let cs = dot_claude.join("settings.json");
    if !cs.exists() {
        fs::write(cs, CLAUDE_SETTINGS)?;
    }
    if with_git && !dir.join(".git").exists() {
        let _ = crate::paths::command_no_window("git")
            .args(["init"])
            .current_dir(dir)
            .output();
    }
    Ok(())
}

/// Append any `GITIGNORE_DEFAULT` pattern missing from `dir/.gitignore` to the
/// end of the file, creating it fresh if absent. Existing lines are never
/// reordered or removed — this only ever adds patterns Eldrun scaffolds by
/// default (e.g. a new one like `project.json` added after the project's
/// `.gitignore` was first written). Returns the patterns that were added.
fn ensure_gitignore_defaults(dir: &Path) -> std::io::Result<Vec<String>> {
    let path = dir.join(".gitignore");
    let defaults: Vec<&str> = GITIGNORE_DEFAULT.lines().filter(|l| !l.is_empty()).collect();
    if !path.exists() {
        fs::write(&path, GITIGNORE_DEFAULT)?;
        return Ok(defaults.into_iter().map(str::to_string).collect());
    }
    let existing = fs::read_to_string(&path)?;
    let existing_lines: HashSet<&str> = existing.lines().collect();
    let missing: Vec<&str> = defaults
        .into_iter()
        .filter(|l| !existing_lines.contains(l))
        .collect();
    if missing.is_empty() {
        return Ok(vec![]);
    }
    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    for line in &missing {
        updated.push_str(line);
        updated.push('\n');
    }
    fs::write(&path, updated)?;
    Ok(missing.into_iter().map(str::to_string).collect())
}

/// Result of repairing one project's scaffold — which pieces were actually
/// missing and got filled in, so the caller can report something meaningful
/// instead of a silent no-op.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldRepairReport {
    pub created_files: Vec<String>,
    pub gitignore_lines_added: Vec<String>,
    pub git_initialized: bool,
}

impl ScaffoldRepairReport {
    fn is_empty(&self) -> bool {
        self.created_files.is_empty() && self.gitignore_lines_added.is_empty() && !self.git_initialized
    }
}

/// Like `scaffold_project`, but for an **already-scaffolded** project whose
/// scaffold has drifted behind current defaults (e.g. it predates a scaffold
/// file or a `.gitignore` pattern being added). Fills in whatever is missing —
/// same never-overwrite rule for existing files — and additionally merges any
/// missing `GITIGNORE_DEFAULT` pattern into an already-present `.gitignore`
/// (plain `scaffold_project` leaves a pre-existing `.gitignore` untouched).
fn repair_project_scaffold_at(dir: &Path, with_git: bool) -> std::io::Result<ScaffoldRepairReport> {
    fs::create_dir_all(dir)?;
    let dot_claude = dir.join(".claude");
    fs::create_dir_all(&dot_claude)?;

    let mut report = ScaffoldRepairReport::default();
    for (name, content) in SCAFFOLD_FILES {
        let p = dir.join(name);
        if !p.exists() {
            fs::write(&p, content)?;
            report.created_files.push((*name).to_string());
        }
    }
    report.gitignore_lines_added = ensure_gitignore_defaults(dir)?;

    let cs = dot_claude.join("settings.json");
    if !cs.exists() {
        fs::write(&cs, CLAUDE_SETTINGS)?;
        report.created_files.push(".claude/settings.json".to_string());
    }
    if with_git && !dir.join(".git").exists() {
        let _ = crate::paths::command_no_window("git")
            .args(["init"])
            .current_dir(dir)
            .output();
        report.git_initialized = dir.join(".git").is_dir();
    }
    Ok(report)
}

/// Resolve the local, on-disk directory a project's scaffold lives in: the
/// project's own `directory` for a local project, or its local `mirror`
/// working copy for a mount-free remote project (the remote host tree is
/// never touched here — see `finish_import`/`create_project`). `None` when
/// there is no local target to repair (e.g. a remote project with no mirror
/// recorded yet).
fn scaffold_target_for_entry(entry: &ProjectEntry) -> Option<(PathBuf, bool)> {
    let git_type = entry
        .extra
        .get("git_type")
        .and_then(Value::as_str)
        .unwrap_or("local");
    let with_git = git_type != "none";
    let target = if entry_is_remote(entry) {
        entry_mirror(entry)?
    } else {
        entry_directory(entry)?
    };
    Some((PathBuf::from(target), with_git))
}

/// A single project's scaffold-repair outcome, for the "Repair scaffold
/// files" UI action (per-project or bulk across all managed projects).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScaffoldRepair {
    pub project_id: String,
    pub name: String,
    pub target_dir: String,
    pub report: ScaffoldRepairReport,
}

/// Repair one project's scaffold: fill in any scaffold doc, `.gitignore`
/// pattern, or `.claude/settings.json` that is missing relative to current
/// defaults. Safe to run repeatedly — every step is additive/idempotent.
#[tauri::command]
pub fn repair_project_scaffold(project_id: String) -> Result<ProjectScaffoldRepair, String> {
    let list_path = storage::state_dir().join("projects.json");
    let list: ProjectsList = storage::read_json(&list_path).map_err(|e| e.to_string())?;
    let entry = list
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    let (target, with_git) = scaffold_target_for_entry(&entry)
        .ok_or_else(|| "Project has no local scaffold target".to_string())?;
    let report = repair_project_scaffold_at(&target, with_git).map_err(|e| e.to_string())?;
    Ok(ProjectScaffoldRepair {
        project_id: entry.id,
        name: entry.name,
        target_dir: target.to_string_lossy().to_string(),
        report,
    })
}

/// Repair scaffold files across every managed project in one pass — the bulk
/// counterpart to `repair_project_scaffold`. Projects whose local target
/// directory doesn't exist yet (e.g. a remote project whose mirror hasn't
/// materialized) are silently skipped rather than erroring the whole batch.
/// Returns only the projects that actually needed a repair.
#[tauri::command]
pub fn repair_all_project_scaffolds() -> Result<Vec<ProjectScaffoldRepair>, String> {
    let list_path = storage::state_dir().join("projects.json");
    if !list_path.exists() {
        return Ok(vec![]);
    }
    let list: ProjectsList = storage::read_json(&list_path).map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for entry in &list {
        let Some((target, with_git)) = scaffold_target_for_entry(entry) else {
            continue;
        };
        if !target.is_dir() {
            continue;
        }
        match repair_project_scaffold_at(&target, with_git) {
            Ok(report) if !report.is_empty() => results.push(ProjectScaffoldRepair {
                project_id: entry.id.clone(),
                name: entry.name.clone(),
                target_dir: target.to_string_lossy().to_string(),
                report,
            }),
            Ok(_) => {}
            Err(e) => eprintln!(
                "repair_all_project_scaffolds: '{}' ({}) failed: {e}",
                entry.name, entry.id
            ),
        }
    }
    Ok(results)
}

fn scaffold_preview(dir: &Path) -> Vec<ScaffoldPreviewItem> {
    let mut items = SCAFFOLD_FILES
        .iter()
        .map(|(name, _)| ScaffoldPreviewItem {
            path: (*name).to_string(),
            exists: dir.join(name).exists(),
            kind: "file".to_string(),
        })
        .collect::<Vec<_>>();

    items.push(ScaffoldPreviewItem {
        path: ".gitignore".to_string(),
        exists: dir.join(".gitignore").exists(),
        kind: "file".to_string(),
    });
    items.push(ScaffoldPreviewItem {
        path: ".git".to_string(),
        exists: dir.join(".git").is_dir(),
        kind: "directory".to_string(),
    });
    items.push(ScaffoldPreviewItem {
        path: ".claude/settings.json".to_string(),
        exists: dir.join(".claude/settings.json").exists(),
        kind: "file".to_string(),
    });
    items
}

#[tauri::command]
pub fn preview_project_scaffold(source_dir: String) -> Result<Vec<ScaffoldPreviewItem>, String> {
    let source = PathBuf::from(source_dir);
    if !source.is_dir() {
        return Err("Source folder does not exist".to_string());
    }
    Ok(scaffold_preview(&source))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub name: String,
    pub directory: String,
    pub description: Option<String>,
    pub git_type: Option<String>,
    /// Skip writing the Eldrun scaffold (and `git init`) — for new projects
    /// that should start empty. `project.json` is still created so the project
    /// registers normally.
    #[serde(default)]
    pub skip_scaffold: bool,
    /// When present the project is remote: `directory` is ignored and the
    /// project root becomes the local sshfs mountpoint for `remote`.
    #[serde(default)]
    pub remote: Option<RemoteSpec>,
    /// Remote projects only: the user-chosen parent directory for the local
    /// mirror (the dialog's "Local location"). The mirror lands at
    /// `<mirror_parent>/<name>`. Absent → the default `projects-ssh` root.
    #[serde(default)]
    pub mirror_parent: Option<String>,
}

#[tauri::command]
pub fn create_project(req: CreateProjectRequest) -> Result<ProjectEntry, String> {
    let id = uuid_v4();

    // Mount-free remote: a remote project's `directory` is a LOCAL per-project
    // state dir that holds its `project.json` (tabs/time/etc.); the project's
    // actual tree lives on the host at `remote.remote_path` and is reached over
    // SFTP/SSH. Best-effort create that remote root so agent tabs / git can `cd`
    // into it (key/agent auth — a password-auth host may need it to pre-exist).
    // Local projects use the chosen directory unchanged.
    let dir = match req.remote.as_ref() {
        Some(remote) => {
            if let Err(e) = crate::services::ssh_exec::remote_mkdir_p(remote) {
                eprintln!(
                    "create_project: remote mkdir '{}' failed (create it on the host if needed): {e}",
                    remote.remote_path
                );
            }
            remote_project_state_dir(&id)
        }
        None => PathBuf::from(&req.directory),
    };
    let directory = dir.to_string_lossy().to_string();

    let git_type = normalize_git_type(req.git_type.as_deref().unwrap_or("local"));

    // Remote projects mirror into `<name>` under the chosen "Local location"
    // (`mirror_parent`), defaulting to the top-level `eldrun/projects-ssh/` root;
    // relocatable later. None for local projects.
    let mirror = req
        .remote
        .as_ref()
        .map(|_| resolve_remote_mirror(req.mirror_parent.as_deref(), &req.name, &id));

    // A remote project's local `directory` only holds project.json (created
    // below); its scaffold belongs in the local **mirror** twin — the working
    // copy the user edits and local-on-remote tabs cwd into. Bytes reach the
    // host only on an explicit manual push (SSH-sync is PULL-only / no-clobber),
    // so scaffolding the mirror is safe and never touches the host tree here.
    if req.remote.is_some() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Every remote project has an always-present local mirror twin, created
        // up front so a local-on-remote tab can cwd into it immediately. Scaffold
        // it like a local project (honoring skip_scaffold); manual sync pushes it.
        if let Some(mirror) = &mirror {
            let mirror_dir = Path::new(mirror);
            if req.skip_scaffold {
                let _ = std::fs::create_dir_all(mirror_dir);
            } else {
                scaffold_project(mirror_dir, git_type != "none").map_err(|e| e.to_string())?;
            }
        }
    } else if !req.skip_scaffold {
        scaffold_project(&dir, git_type != "none").map_err(|e| e.to_string())?;
    } else {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }

    let now = chrono_now();
    let description = clean_description(req.description);

    let project = Project {
        id: id.clone(),
        name: req.name.clone(),
        directory: directory.clone(),
        description: description.clone(),
        git_type: Some(git_type.clone()),
        created_at: Some(now),
        remote: req.remote.clone(),
        mirror: mirror.clone(),
        ..Default::default()
    };

    let project_file = dir.join("project.json");
    storage::write_json(&project_file, &project).map_err(|e| e.to_string())?;

    // Register in the global list.
    let list_path = storage::state_dir().join("projects.json");
    let mut list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).unwrap_or_default()
    } else {
        vec![]
    };
    let position = next_position(&list);
    let extra = project_extra(directory, git_type, description, req.remote.as_ref(), mirror.as_deref());

    let entry = ProjectEntry {
        id: id.clone(),
        name: req.name,
        status: "inactive".to_string(),
        position,
        local_file: project_file.to_string_lossy().to_string(),
        extra,
    };
    list.push(entry.clone());
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;

    Ok(entry)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProjectRequest {
    pub source_dir: String,
    pub name: String,
    pub description: Option<String>,
    pub git_type: Option<String>,
    pub mode: String,
    pub scaffold_fill_modes: Option<HashMap<String, String>>,
    pub manual_validation_confirmed: Option<bool>,
    /// Skip writing the Eldrun scaffold (and `git init`) — for importing
    /// projects that already carry their own files. `project.json` is still
    /// created/updated so the project registers normally.
    #[serde(default)]
    pub skip_scaffold: bool,
    /// When present the project is remote: `source_dir` is the already-mounted
    /// remote directory and the only supported `mode` is "keep".
    #[serde(default)]
    pub remote: Option<RemoteSpec>,
    /// Remote imports only: the user-chosen parent directory for the local
    /// mirror (the dialog's "Local location"). The mirror lands at
    /// `<mirror_parent>/<name>`. Absent → the default `projects-ssh` root.
    #[serde(default)]
    pub mirror_parent: Option<String>,
}

#[tauri::command]
pub fn import_project(req: ImportProjectRequest) -> Result<ProjectEntry, String> {
    if req.name.trim().is_empty() {
        return Err("Project name is invalid".to_string());
    }

    let id = uuid_v4();

    if let Some(remote) = req.remote.clone() {
        if req.mode != "keep" {
            return Err("Remote imports must use 'keep' mode (copy/move are not supported)".to_string());
        }
        // Mount-free: the user browsed to an existing remote directory, so there
        // is nothing to create on the host. The project's `directory` is a LOCAL
        // per-project state dir that holds its project.json; the tree stays on the
        // host (`remote.remote_path`) and is reached over SFTP/SSH.
        let local = remote_project_state_dir(&id);
        std::fs::create_dir_all(&local).map_err(|e| e.to_string())?;
        return finish_import(req, id, local, Some(remote));
    }

    let source = PathBuf::from(&req.source_dir);
    if !source.is_dir() {
        return Err("Source folder does not exist".to_string());
    }

    if matches!(req.mode.as_str(), "copy" | "move") && req.manual_validation_confirmed != Some(true)
    {
        return Err("Copy and move imports require manual validation".to_string());
    }

    let target = match req.mode.as_str() {
        "keep" => source,
        "copy" | "move" => {
            let safe = sanitize_name(&req.name);
            if safe.is_empty() {
                return Err("Project name is invalid".to_string());
            }
            let dest = projects_root().join(safe);
            if dest.exists() {
                return Err(format!("Destination '{}' already exists", dest.display()));
            }
            if req.mode == "copy" {
                copy_dir_all(&source, &dest)?;
            } else {
                fs::create_dir_all(projects_root()).map_err(|e| e.to_string())?;
                // A plain rename fails across drives/filesystems (EXDEV on Unix,
                // ERROR_NOT_SAME_DEVICE / os error 17 on Windows). Fall back to
                // copy-then-remove so a cross-volume import still moves.
                if fs::rename(&source, &dest).is_err() {
                    copy_dir_all(&source, &dest)?;
                    fs::remove_dir_all(&source).map_err(|e| e.to_string())?;
                }
            }
            dest
        }
        other => return Err(format!("Unknown import mode: {other}")),
    };

    finish_import(req, id, target, None)
}

/// Shared tail of `import_project`: scaffold over `target`, build/merge the
/// `project.json`, register the entry in `projects.json`, and return it.
/// `remote` is `Some` for remote imports (where `target` is the mountpoint).
fn finish_import(
    req: ImportProjectRequest,
    id: String,
    target: PathBuf,
    remote: Option<RemoteSpec>,
) -> Result<ProjectEntry, String> {
    let _scaffold_fill_modes = req.scaffold_fill_modes.unwrap_or_default();

    let directory = target.to_string_lossy().to_string();
    let project_file = target.join("project.json");
    let project_file_s = project_file.to_string_lossy().to_string();

    let list_path = storage::state_dir().join("projects.json");
    let mut list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).unwrap_or_default()
    } else {
        vec![]
    };
    if list.iter().any(|p| {
        p.local_file == project_file_s
            || p.extra.get("directory").and_then(Value::as_str) == Some(directory.as_str())
    }) {
        return Err("Project is already registered".to_string());
    }

    let git_type = normalize_git_type(req.git_type.as_deref().unwrap_or("local"));

    // Scaffold only LOCAL imports onto their (local) tree. A remote import's
    // `target` is the local per-project state dir (project.json only); its tree
    // already exists on the host, so no local scaffold is written there.
    if remote.is_none() && !req.skip_scaffold {
        scaffold_project(&target, git_type != "none").map_err(|e| e.to_string())?;
    }

    // A remote import keeps the host tree as the git authority (it pre-exists on
    // the host, so we never scaffold or `git init` the local mirror — pairing
    // pulls the host's history down). But when the user imports **with git
    // support** onto a host dir that is not yet a repo, there is no history for
    // lockstep to pair from; initialize a repo on the host so the mirror can be
    // paired from it. Best-effort + idempotent (skipped if already a repo).
    if let Some(remote) = &remote {
        if git_type != "none" {
            if let Err(e) = crate::services::ssh_exec::remote_git_init(remote) {
                eprintln!(
                    "finish_import: remote git init '{}' failed (init it on the host if needed): {e}",
                    remote.remote_path
                );
            }
        }
    }

    let now = chrono_now();
    let requested_description = clean_description(req.description);

    // Remote imports mirror into `<name>` under the chosen "Local location"
    // (`mirror_parent`), defaulting to the `eldrun/projects-ssh/` root; created up
    // front so a local-on-remote tab can cwd into it immediately. None for local.
    let mirror = remote
        .as_ref()
        .map(|_| resolve_remote_mirror(req.mirror_parent.as_deref(), &req.name, &id));
    if let Some(mirror) = &mirror {
        let _ = std::fs::create_dir_all(mirror);
    }

    let project = if project_file.exists() {
        let mut existing: Project = storage::read_json(&project_file).unwrap_or_default();
        existing.id = id.clone();
        existing.name = req.name.clone();
        existing.directory = directory.clone();
        if requested_description.is_some() {
            existing.description = requested_description.clone();
        }
        existing.git_type = Some(git_type.clone());
        existing.remote = remote.clone();
        existing.mirror = mirror.clone();
        existing
    } else {
        Project {
            id: id.clone(),
            name: req.name.clone(),
            directory: directory.clone(),
            description: requested_description.clone(),
            git_type: Some(git_type.clone()),
            created_at: Some(now),
            remote: remote.clone(),
            mirror: mirror.clone(),
            ..Default::default()
        }
    };
    storage::write_json(&project_file, &project).map_err(|e| e.to_string())?;

    let position = next_position(&list);
    let description = project.description.clone();
    let extra = project_extra(directory, git_type, description, remote.as_ref(), mirror.as_deref());
    let entry = ProjectEntry {
        id,
        name: req.name,
        status: "inactive".to_string(),
        position,
        local_file: project_file_s,
        extra,
    };
    list.push(entry.clone());
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;
    Ok(entry)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtendProjectRemoteRequest {
    pub project_id: String,
    /// The remote spec to attach. `remote_path` already includes the project
    /// name leaf (the frontend appends it, matching direct remote creation).
    pub remote: RemoteSpec,
}

/// Extend an existing **local** project to remote: attach a `RemoteSpec`, create
/// the empty remote root on the host (best-effort, exactly like `create_project`),
/// and re-point the project into the mount-free remote layout **without uploading
/// any data**. The project keeps its id; its current local directory becomes the
/// local `mirror` (working copy) in place — files never move — and its `directory`
/// becomes a local state dir holding `project.json`. The user pushes files to the
/// (empty) host later via the existing manual sync UI.
#[tauri::command]
pub fn extend_project_to_remote(req: ExtendProjectRemoteRequest) -> Result<ProjectEntry, String> {
    let list_path = storage::state_dir().join("projects.json");
    let mut list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).map_err(|e| e.to_string())?
    } else {
        return Err("Project not found".to_string());
    };

    let idx = list
        .iter()
        .position(|p| p.id == req.project_id)
        .ok_or_else(|| "Project not found".to_string())?;

    // Guard: only local projects can be extended.
    if list[idx].extra.contains_key("remote") {
        return Err("Project is already remote".to_string());
    }

    // The current local tree becomes the mirror (working copy), unchanged.
    let old_dir = list[idx]
        .extra
        .get("directory")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Project has no local directory".to_string())?;
    let old_path = PathBuf::from(&old_dir);
    if !old_path.is_dir() {
        return Err(format!("Local directory '{old_dir}' does not exist"));
    }

    // Best-effort create the empty remote root — same as create_project. Failure
    // is non-fatal (key/agent-auth hosts may need it to pre-exist; a password-auth
    // host connects and creates it at activation).
    if let Err(e) = crate::services::ssh_exec::remote_mkdir_p(&req.remote) {
        eprintln!(
            "extend_project_to_remote: remote mkdir '{}' failed (create it on the host if needed): {e}",
            req.remote.remote_path
        );
    }

    // The remote project's `directory` is a local state dir holding project.json.
    let state_dir = remote_project_state_dir(&req.project_id);
    std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;
    let new_directory = state_dir.to_string_lossy().to_string();

    // Move project.json from the old (now mirror) tree into the state dir, tagging
    // it remote. Read the existing one so tabs/time/created_at/etc. survive.
    let old_project_file = old_path.join("project.json");
    let mut project: Project = if old_project_file.exists() {
        storage::read_json(&old_project_file).unwrap_or_default()
    } else {
        Project::default()
    };
    project.id = req.project_id.clone();
    project.name = list[idx].name.clone();
    project.directory = new_directory.clone();
    project.remote = Some(req.remote.clone());
    project.mirror = Some(old_dir.clone());
    let new_project_file = state_dir.join("project.json");
    storage::write_json(&new_project_file, &project).map_err(|e| e.to_string())?;
    // Remote projects don't keep project.json in the working copy — drop the stale
    // one so the mirror is clean. Best-effort (a leftover file is harmless).
    let _ = std::fs::remove_file(&old_project_file);

    // Update the same projects.json entry in place, preserving every other extra
    // key (categories, git_provider, git_type, description, sandbox, …).
    let entry = &mut list[idx];
    entry.local_file = new_project_file.to_string_lossy().to_string();
    entry
        .extra
        .insert("directory".to_string(), Value::String(new_directory));
    if let Ok(value) = serde_json::to_value(&req.remote) {
        entry.extra.insert("remote".to_string(), value);
    }
    entry
        .extra
        .insert("mirror".to_string(), Value::String(old_dir));
    let updated = entry.clone();
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;
    Ok(updated)
}

// ── Time tracking ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_time_today(project_id: String) -> f64 {
    // Efficiency #2: O(1) lookup in the rolling daily-summary file instead of
    // fully deserializing the growing append-only log on every pill hover.
    crate::schema::time_log::today_secs(&project_id)
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn next_position(list: &ProjectsList) -> i64 {
    list.iter().map(|p| p.position).max().unwrap_or(0) + 10
}

fn project_extra(
    directory: String,
    git_type: String,
    description: Option<String>,
    remote: Option<&RemoteSpec>,
    mirror: Option<&str>,
) -> HashMap<String, Value> {
    let mut extra = HashMap::from([
        ("directory".to_string(), Value::String(directory)),
        ("git_type".to_string(), Value::String(git_type)),
    ]);
    if let Some(description) = description {
        extra.insert("description".to_string(), Value::String(description));
    }
    // Mirror the remote spec into the pill-list entry (like `directory`/
    // `git_type`) so the frontend can flag remote projects without reading
    // each project.json. Serialization should never fail for a plain struct.
    if let Some(remote) = remote {
        if let Ok(value) = serde_json::to_value(remote) {
            extra.insert("remote".to_string(), value);
        }
    }
    // The chosen local mirror root (remote projects only) — the always-local
    // source of truth `remote_sync::mirror_dir` reads.
    if let Some(mirror) = mirror {
        extra.insert("mirror".to_string(), Value::String(mirror.to_string()));
    }
    extra
}

fn clean_description(description: Option<String>) -> Option<String> {
    description.and_then(|description| {
        let description = description.trim().to_string();
        if description.is_empty() {
            None
        } else {
            Some(description)
        }
    })
}

fn projects_root() -> PathBuf {
    paths::projects_root()
}

pub(crate) fn sanitize_name(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            if entry.file_name() == ".git" {
                continue;
            }
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Mint a pseudo-UUID without an external dep. Time-based (nanos), so callers
/// that mint several ids back-to-back (e.g. box creation in a loop) must guard
/// against collisions — see `commands::boxes::create_box`, which re-mints if the
/// generated id already exists in the list.
pub(crate) fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Simple UUID v4 without external deps for now.
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{ts:016x}-{ts:08x}-4{ts:03x}-8{ts:03x}-{ts:012x}")
}

fn chrono_now() -> String {
    storage::iso_now()
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── sanitize_name ──────────────────────────────────────────────────────

    #[test]
    fn sanitize_name_lowercase_alphanumeric() {
        assert_eq!(sanitize_name("MyProject"), "myproject");
    }

    #[test]
    fn sanitize_name_replaces_spaces_with_dash() {
        assert_eq!(sanitize_name("my project"), "my-project");
    }

    #[test]
    fn sanitize_name_replaces_special_chars() {
        assert_eq!(sanitize_name("my!project@2"), "my-project-2");
    }

    #[test]
    fn sanitize_name_collapses_consecutive_dashes() {
        assert_eq!(sanitize_name("my  project"), "my-project");
        assert_eq!(sanitize_name("a---b"), "a-b");
    }

    #[test]
    fn sanitize_name_trims_leading_trailing_dashes() {
        assert_eq!(sanitize_name("  hello  "), "hello");
        assert_eq!(sanitize_name("!hello!"), "hello");
    }

    #[test]
    fn sanitize_name_preserves_underscore() {
        assert_eq!(sanitize_name("my_project"), "my_project");
    }

    #[test]
    fn sanitize_name_empty_after_stripping() {
        assert_eq!(sanitize_name("!!!"), "");
        assert_eq!(sanitize_name(""), "");
        assert_eq!(sanitize_name("   "), "");
    }

    #[test]
    fn sanitize_name_numeric_only() {
        assert_eq!(sanitize_name("123"), "123");
    }

    #[test]
    fn sanitize_name_unicode_becomes_dash() {
        // Non-ASCII chars are replaced with '-', then collapsed.
        let result = sanitize_name("café");
        assert!(!result.contains("é"), "unicode must be replaced");
        assert!(!result.contains("--"), "consecutive dashes collapsed");
    }

    // ── normalize_git_type ─────────────────────────────────────────────────

    #[test]
    fn normalize_git_type_migrates_legacy_values() {
        assert_eq!(normalize_git_type("private"), "remote-private");
        assert_eq!(normalize_git_type("public"), "remote-public");
    }

    #[test]
    fn normalize_git_type_passes_through_canonical_values() {
        assert_eq!(normalize_git_type("local"), "local");
        assert_eq!(normalize_git_type("none"), "none");
        assert_eq!(normalize_git_type("remote-private"), "remote-private");
        assert_eq!(normalize_git_type("remote-public"), "remote-public");
    }

    #[test]
    fn normalize_git_type_unknown_falls_back_to_local() {
        assert_eq!(normalize_git_type(""), "local");
        assert_eq!(normalize_git_type("weird"), "local");
        assert_eq!(normalize_git_type("  public  "), "remote-public");
    }

    // ── scaffold_project ───────────────────────────────────────────────────

    #[test]
    fn scaffold_project_creates_all_files() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), true).unwrap();

        for name in &[
            "AGENTS.md",
            "CLAUDE.md",
            "GEMINI.md",
            "TODO.md",
            "ROADMAP.md",
            "STATUS.md",
            "README.md",
            ".gitignore",
        ] {
            assert!(tmp.path().join(name).exists(), "missing: {name}");
        }
        assert!(tmp.path().join(".claude/settings.json").exists());
    }

    #[test]
    fn scaffold_project_gitignores_project_json() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), true).unwrap();

        let content = std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
        assert!(
            content.lines().any(|l| l == "project.json"),
            "default .gitignore must exclude project.json"
        );
    }

    #[test]
    fn scaffold_project_does_not_overwrite_existing_files() {
        let tmp = tempfile::tempdir().unwrap();
        let todo_path = tmp.path().join("TODO.md");
        std::fs::write(&todo_path, "original content").unwrap();

        scaffold_project(tmp.path(), true).unwrap();

        let content = std::fs::read_to_string(&todo_path).unwrap();
        assert_eq!(
            content, "original content",
            "existing file must not be overwritten"
        );
    }

    #[test]
    fn scaffold_project_does_not_overwrite_claude_settings() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".claude")).unwrap();
        let cs = tmp.path().join(".claude/settings.json");
        std::fs::write(&cs, r#"{"custom": true}"#).unwrap();

        scaffold_project(tmp.path(), true).unwrap();

        let content = std::fs::read_to_string(&cs).unwrap();
        assert!(
            content.contains("custom"),
            "custom settings must not be overwritten"
        );
    }

    #[test]
    fn scaffold_project_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), true).unwrap();
        scaffold_project(tmp.path(), true).unwrap(); // second call must not error
        assert!(tmp.path().join("TODO.md").exists());
    }

    #[test]
    fn scaffold_project_without_git_skips_init() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), false).unwrap();
        // Scaffold files are still written, but no git repo is initialized.
        assert!(tmp.path().join("TODO.md").exists());
        assert!(tmp.path().join(".claude/settings.json").exists());
        assert!(
            !tmp.path().join(".git").exists(),
            "git must not be initialized when with_git is false"
        );
    }

    #[test]
    fn scaffold_preview_reports_git_directory_status() {
        let tmp = tempfile::tempdir().unwrap();

        let missing = scaffold_preview(tmp.path())
            .into_iter()
            .find(|item| item.path == ".git")
            .expect(".git preview item");
        assert!(!missing.exists);
        assert_eq!(missing.kind, "directory");

        std::fs::create_dir_all(tmp.path().join(".git")).unwrap();
        let present = scaffold_preview(tmp.path())
            .into_iter()
            .find(|item| item.path == ".git")
            .expect(".git preview item");
        assert!(present.exists);
        assert_eq!(present.kind, "directory");
    }

    // ── repair_project_scaffold_at ─────────────────────────────────────────

    #[test]
    fn repair_fills_missing_scaffold_docs_and_settings() {
        let tmp = tempfile::tempdir().unwrap();
        // Simulate a project scaffolded before DOCUMENTATION.md / .claude
        // settings existed: only a couple of the current scaffold files.
        std::fs::write(tmp.path().join("TODO.md"), "# TODO\n").unwrap();
        std::fs::write(tmp.path().join(".gitignore"), "node_modules/\n").unwrap();

        let report = repair_project_scaffold_at(tmp.path(), false).unwrap();

        assert!(report.created_files.contains(&"AGENTS.md".to_string()));
        assert!(report.created_files.contains(&".claude/settings.json".to_string()));
        assert!(!report.created_files.contains(&"TODO.md".to_string()));
        assert!(tmp.path().join("DOCUMENTATION.md").exists());
        assert!(tmp.path().join(".claude/settings.json").exists());
    }

    #[test]
    fn repair_merges_missing_gitignore_lines_without_clobbering() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".gitignore"), "# my custom rule\nfoo/\n").unwrap();

        let report = repair_project_scaffold_at(tmp.path(), false).unwrap();

        assert!(report.gitignore_lines_added.contains(&"project.json".to_string()));
        let content = std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
        assert!(content.contains("# my custom rule"));
        assert!(content.contains("foo/"));
        assert!(content.lines().any(|l| l == "project.json"));
    }

    #[test]
    fn repair_is_a_noop_when_scaffold_is_already_current() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), false).unwrap();

        let report = repair_project_scaffold_at(tmp.path(), false).unwrap();

        assert!(report.is_empty());
    }

    #[test]
    fn repair_initializes_git_when_missing_and_requested() {
        let tmp = tempfile::tempdir().unwrap();

        let report = repair_project_scaffold_at(tmp.path(), true).unwrap();

        assert!(report.git_initialized);
        assert!(tmp.path().join(".git").is_dir());
    }
}
