use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::paths;
use crate::schema::project::Project;
use crate::schema::projects::{ProjectEntry, ProjectsList};
use crate::schema::time_log::TimeLog;
use crate::storage;

// ── Project list ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_projects() -> Result<ProjectsList, String> {
    let path = storage::state_dir().join("projects.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    storage::read_json(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_projects(projects: ProjectsList) -> Result<(), String> {
    let path = storage::state_dir().join("projects.json");
    storage::write_json(&path, &projects).map_err(|e| e.to_string())
}

// ── Per-project project.json ───────────────────────────────────────────────

#[tauri::command]
pub fn load_project(local_file: String) -> Result<Project, String> {
    let path = PathBuf::from(&local_file);
    storage::read_json(&path).map_err(|e| e.to_string())
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
) -> Result<(), String> {
    crate::services::terminal_service::save_tab_layout(&local_file, &tabs)
}

#[tauri::command]
pub fn root_work_dir() -> String {
    storage::root_work_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn projects_root_dir() -> String {
    projects_root().to_string_lossy().to_string()
}

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

/// List directory contents — validates the path stays inside the project root.
#[tauri::command]
pub fn list_dir(project_dir: String, rel_path: String) -> Result<Vec<FileEntry>, String> {
    let root = canonical(&project_dir)?;
    let target = if rel_path.is_empty() {
        root.clone()
    } else {
        canonical(&root.join(&rel_path).to_string_lossy().to_string())?
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
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| format!(".{s}"));
        let mime = ext.as_deref().map(|e| {
            mime_guess::from_ext(&e[1..])
                .first_or_octet_stream()
                .to_string()
        });

        result.push(FileEntry {
            name,
            path: path.to_string_lossy().to_string(),
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
        });
    }
    result.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(result)
}

#[tauri::command]
pub fn list_project_endings(project_dir: String) -> Result<Vec<String>, String> {
    let root = canonical(&project_dir)?;
    let mut endings = BTreeSet::new();
    collect_project_endings(&root, &root, &mut endings)?;
    Ok(endings.into_iter().collect())
}

#[tauri::command]
pub fn list_project_paths(project_dir: String) -> Result<Vec<ProjectPathEntry>, String> {
    let root = canonical(&project_dir)?;
    let mut paths = Vec::new();
    collect_project_paths(&root, &root, "", &mut paths)?;
    paths.sort_by_key(|entry| (!entry.is_dir, entry.path.to_lowercase()));
    Ok(paths)
}

/// Rename a file or directory — path must stay inside the project root.
/// `new_name` must be a bare file name; renames never move entries between
/// directories.
#[tauri::command]
pub fn rename_path(project_dir: String, old_rel: String, new_name: String) -> Result<(), String> {
    let new_name = new_name.trim();
    if new_name.is_empty()
        || new_name == "."
        || new_name == ".."
        || new_name.contains('/')
        || new_name.contains('\\')
        || new_name.contains('\0')
    {
        return Err(format!("invalid file name '{new_name}'"));
    }

    let root = canonical(&project_dir)?;
    let old = canonical(&root.join(&old_rel).to_string_lossy().to_string())?;
    enforce_confinement(&root, &old)?;

    let new = old.parent().ok_or("no parent")?.join(new_name);
    // New path must also stay inside root.
    let new_c = canonical_or_new(&new);
    enforce_confinement(&root, &new_c)?;

    fs::rename(&old, &new).map_err(|e| e.to_string())
}

/// Delete a file — never a directory (safety: use trash or explicit confirm for dirs).
#[tauri::command]
pub fn delete_file(project_dir: String, rel_path: String) -> Result<(), String> {
    let root = canonical(&project_dir)?;
    let target = canonical(&root.join(&rel_path).to_string_lossy().to_string())?;
    enforce_confinement(&root, &target)?;

    if target.is_dir() {
        return Err("use delete_dir for directories".to_string());
    }
    fs::remove_file(&target).map_err(|e| e.to_string())
}

/// Delete a directory tree inside the project root.
#[tauri::command]
pub fn delete_dir(project_dir: String, rel_path: String) -> Result<(), String> {
    let root = canonical(&project_dir)?;
    let target = canonical(&root.join(&rel_path).to_string_lossy().to_string())?;
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
pub fn create_file(project_dir: String, rel_path: String) -> Result<(), String> {
    let root = canonical(&project_dir)?;
    let target = root.join(&rel_path);
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
pub fn write_project_file(
    project_dir: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    let root = canonical(&project_dir)?;
    let target = root.join(&rel_path);
    let target_c = canonical_or_new(&target);
    enforce_confinement(&root, &target_c)?;

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&target, content).map_err(|e| e.to_string())
}

/// Write raw bytes to a file inside the project (used for drag-and-drop uploads).
#[tauri::command]
pub fn write_project_file_bytes(
    project_dir: String,
    rel_path: String,
    content: Vec<u8>,
) -> Result<(), String> {
    let root = canonical(&project_dir)?;
    let target = root.join(&rel_path);
    let target_c = canonical_or_new(&target);
    enforce_confinement(&root, &target_c)?;

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&target, &content).map_err(|e| e.to_string())
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
pub fn create_dir(project_dir: String, rel_path: String) -> Result<(), String> {
    let root = canonical(&project_dir)?;
    let target = root.join(&rel_path);
    let target_c = canonical_or_new(&target);
    enforce_confinement(&root, &target_c)?;
    fs::create_dir_all(&target).map_err(|e| e.to_string())
}

// ── MIME detection (magic bytes) ──────────────────────────────────────────

#[tauri::command]
pub fn detect_mime(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
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
    Ok(p.extension()
        .and_then(|e| e.to_str())
        .map(|e| mime_guess::from_ext(e).first_or_octet_stream().to_string())
        .unwrap_or_else(|| "application/octet-stream".to_string()))
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
pub fn scaffold_project(dir: &Path) -> std::io::Result<()> {
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
    if !dir.join(".git").exists() {
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
}

#[tauri::command]
pub fn create_project(req: CreateProjectRequest) -> Result<ProjectEntry, String> {
    let dir = PathBuf::from(&req.directory);
    scaffold_project(&dir).map_err(|e| e.to_string())?;

    let id = uuid_v4();
    let now = chrono_now();
    let git_type = req.git_type.unwrap_or_else(|| "private".to_string());
    let description = clean_description(req.description);

    let project = Project {
        id: id.clone(),
        name: req.name.clone(),
        directory: req.directory.clone(),
        description: description.clone(),
        git_type: Some(git_type.clone()),
        created_at: Some(now),
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
    let extra = project_extra(req.directory, git_type, description);

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
}

#[tauri::command]
pub fn import_project(req: ImportProjectRequest) -> Result<ProjectEntry, String> {
    if req.name.trim().is_empty() {
        return Err("Project name is invalid".to_string());
    }

    let source = PathBuf::from(&req.source_dir);
    if !source.is_dir() {
        return Err("Source folder does not exist".to_string());
    }

    if matches!(req.mode.as_str(), "copy" | "move") && req.manual_validation_confirmed != Some(true)
    {
        return Err("Copy and move imports require manual validation".to_string());
    }

    let _scaffold_fill_modes = req.scaffold_fill_modes.unwrap_or_default();

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
                fs::rename(&source, &dest).map_err(|e| e.to_string())?;
            }
            dest
        }
        other => return Err(format!("Unknown import mode: {other}")),
    };

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

    scaffold_project(&target).map_err(|e| e.to_string())?;

    let id = uuid_v4();
    let now = chrono_now();
    let git_type = req.git_type.unwrap_or_else(|| "private".to_string());
    let requested_description = clean_description(req.description);

    let project = if project_file.exists() {
        let mut existing: Project = storage::read_json(&project_file).unwrap_or_default();
        existing.id = id.clone();
        existing.name = req.name.clone();
        existing.directory = directory.clone();
        if requested_description.is_some() {
            existing.description = requested_description.clone();
        }
        existing.git_type = Some(git_type.clone());
        existing
    } else {
        Project {
            id: id.clone(),
            name: req.name.clone(),
            directory: directory.clone(),
            description: requested_description.clone(),
            git_type: Some(git_type.clone()),
            created_at: Some(now),
            ..Default::default()
        }
    };
    storage::write_json(&project_file, &project).map_err(|e| e.to_string())?;

    let position = next_position(&list);
    let description = project.description.clone();
    let extra = project_extra(directory, git_type, description);
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
    let path = storage::state_dir().join("time_log.json");
    if !path.exists() {
        return 0.0;
    }
    let log: TimeLog = match storage::read_json(&path) {
        Ok(l) => l,
        Err(_) => return 0.0,
    };
    let today = storage::today_utc();
    log.iter()
        .filter(|e| e.project_id == project_id && e.date == today)
        .map(|e| e.duration_s)
        .sum()
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn next_position(list: &ProjectsList) -> i64 {
    list.iter().map(|p| p.position).max().unwrap_or(0) + 10
}

fn project_extra(
    directory: String,
    git_type: String,
    description: Option<String>,
) -> HashMap<String, Value> {
    let mut extra = HashMap::from([
        ("directory".to_string(), Value::String(directory)),
        ("git_type".to_string(), Value::String(git_type)),
    ]);
    if let Some(description) = description {
        extra.insert("description".to_string(), Value::String(description));
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

fn canonical(path: &str) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|e| format!("canonicalize {path}: {e}"))
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

fn collect_project_endings(
    root: &Path,
    dir: &Path,
    endings: &mut BTreeSet<String>,
) -> Result<(), String> {
    enforce_confinement(root, dir)?;
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if should_skip_ending_scan_dir(&name) {
                continue;
            }
            collect_project_endings(root, &path, endings)?;
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
    paths: &mut Vec<ProjectPathEntry>,
) -> Result<(), String> {
    enforce_confinement(root, dir)?;
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
        let is_dir = path.is_dir();
        paths.push(ProjectPathEntry {
            path: rel_path.clone(),
            is_dir,
        });
        if is_dir && !should_skip_ending_scan_dir(&name) {
            collect_project_paths(root, &path, &rel_path, paths)?;
        }
    }
    Ok(())
}

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

/// Enforce that `target` is inside `root`.
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

fn uuid_v4() -> String {
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
    use std::path::PathBuf;

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

    // ── scaffold_project ───────────────────────────────────────────────────

    #[test]
    fn scaffold_project_creates_all_files() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path()).unwrap();

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

        scaffold_project(tmp.path()).unwrap();

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

        scaffold_project(tmp.path()).unwrap();

        let content = std::fs::read_to_string(&cs).unwrap();
        assert!(
            content.contains("custom"),
            "custom settings must not be overwritten"
        );
    }

    #[test]
    fn scaffold_project_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path()).unwrap();
        scaffold_project(tmp.path()).unwrap(); // second call must not error
        assert!(tmp.path().join("TODO.md").exists());
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

    #[test]
    fn write_project_file_creates_nested_file_inside_project() {
        let tmp = tempfile::tempdir().unwrap();
        write_project_file(
            tmp.path().to_string_lossy().to_string(),
            ".eldrun/scaffold-fill-claude.md".to_string(),
            "fill AGENTS.md".to_string(),
        )
        .unwrap();

        let content =
            std::fs::read_to_string(tmp.path().join(".eldrun/scaffold-fill-claude.md")).unwrap();
        assert_eq!(content, "fill AGENTS.md");
    }

    // ── rename_path ────────────────────────────────────────────────────────

    #[test]
    fn rename_path_renames_file_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("old.txt"), "content").unwrap();

        rename_path(
            tmp.path().to_string_lossy().to_string(),
            "old.txt".to_string(),
            "new.txt".to_string(),
        )
        .unwrap();

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
            let err = rename_path(dir.clone(), "a.txt".to_string(), bad.to_string());
            assert!(err.is_err(), "name {bad:?} must be rejected");
        }
        assert!(tmp.path().join("a.txt").exists(), "file must be untouched");
    }

    #[test]
    fn write_project_file_blocks_parent_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let err = write_project_file(
            tmp.path().to_string_lossy().to_string(),
            "../outside.md".to_string(),
            "escape".to_string(),
        )
        .unwrap_err();

        assert!(err.contains("escapes project root"), "unexpected error: {err}");
    }
}
