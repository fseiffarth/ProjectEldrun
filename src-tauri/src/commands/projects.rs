use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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

/// The default local mirror location for a new remote (SSH) project: a readable
/// `ssh/<name>` subfolder of the Eldrun projects root (rather than a hidden state
/// dir). The `id` disambiguates a name-based path already taken by another remote
/// project, so two hosts' `~/work` never collide on the same local mirror.
fn default_remote_mirror(name: &str, id: &str) -> PathBuf {
    let base = projects_root().join("ssh");
    let safe = sanitize_name(name);
    let leaf = if safe.is_empty() { id.to_string() } else { safe };
    let candidate = base.join(&leaf);
    if candidate.exists() {
        base.join(format!("{leaf}-{}", &id[..id.len().min(8)]))
    } else {
        candidate
    }
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
        image: None,
        extra: HashMap::new(),
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
/// directory outright — every commit, branch, stash, and remote is gone and
/// cannot be recovered — and moves the project to `git_type` `"none"`, the same
/// state a "No git (local files only)" project starts in. Enabling runs
/// `git init` (a no-op if a repo already exists) and moves the project to
/// `git_type` `"local"`.
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
        "none".to_string()
    } else {
        if !git_dir.exists() {
            let output = Command::new("git")
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
        .insert("mirror".to_string(), Value::String(resolved.clone()));
    let local_file = entry.local_file.clone();
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;

    // project.json — keep the per-project file consistent (best effort).
    let proj_path = PathBuf::from(&local_file);
    if proj_path.exists() {
        if let Ok(mut project) = storage::read_json::<Project>(&proj_path) {
            project.mirror = Some(resolved.clone());
            storage::write_json(&proj_path, &project).map_err(|e| e.to_string())?;
        }
    }

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

const GITIGNORE_DEFAULT: &str = "__pycache__/\n*.pyc\n.venv/\nnode_modules/\ntarget/\ndist/\nbuild/\n.env\n.env.local\n.DS_Store\n*.log\n*.swp\n*.swo\n.idea/\n.eldrun/\n";

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
        let _ = Command::new("git").args(["init"]).current_dir(dir).output();
    }
    Ok(())
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

    // Remote projects mirror into a readable `ssh/<name>` subfolder of the
    // projects root (chosen here as the default; relocatable later). None for
    // local projects.
    let mirror = req
        .remote
        .as_ref()
        .map(|_| default_remote_mirror(&req.name, &id).to_string_lossy().to_string());

    // Scaffold only LOCAL projects onto the (local) project dir. A remote
    // project's scaffold belongs on the host (deferred — see #28j follow-up); its
    // local `directory` only holds project.json, created below.
    if req.remote.is_some() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // SSH-sync Phase 1: every remote project has an always-present (empty)
        // local mirror twin; bytes only land here on explicit sync. Created up
        // front so a local-on-remote tab can cwd into it immediately.
        if let Some(mirror) = &mirror {
            let _ = std::fs::create_dir_all(mirror);
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

    let now = chrono_now();
    let requested_description = clean_description(req.description);

    // Remote imports mirror into a readable `ssh/<name>` subfolder of the projects
    // root (the default; relocatable later), created up front so a local-on-remote
    // tab can cwd into it immediately. None for local imports.
    let mirror = remote
        .as_ref()
        .map(|_| default_remote_mirror(&req.name, &id).to_string_lossy().to_string());
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

}
