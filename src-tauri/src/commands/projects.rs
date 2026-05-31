use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::schema::project::Project;
use crate::schema::projects::{ProjectEntry, ProjectsList};
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

// ── File tree ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub extension: Option<String>,
    pub mime: Option<String>,
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
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| format!(".{s}"));
        let mime = ext
            .as_deref()
            .map(|e| mime_guess::from_ext(&e[1..]).first_or_octet_stream().to_string());

        result.push(FileEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_file() { meta.len() } else { 0 },
            extension: ext,
            mime,
        });
    }
    result.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(result)
}

/// Rename a file or directory — path must stay inside the project root.
#[tauri::command]
pub fn rename_path(
    project_dir: String,
    old_rel: String,
    new_name: String,
) -> Result<(), String> {
    let root = canonical(&project_dir)?;
    let old = canonical(&root.join(&old_rel).to_string_lossy().to_string())?;
    enforce_confinement(&root, &old)?;

    let new = old.parent().ok_or("no parent")?.join(&new_name);
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
    fs::File::create(&target).map(|_| ()).map_err(|e| e.to_string())
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
    ("DOCUMENTATION.md", "# Documentation\n"),
];

const GITIGNORE_DEFAULT: &str = "__pycache__/\n*.pyc\n.venv/\n.DS_Store\n*.log\n";

const CLAUDE_SETTINGS: &str =
    r#"{"permissions":{"allow":[],"deny":[]}}"#;

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
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub directory: String,
}

#[tauri::command]
pub fn create_project(req: CreateProjectRequest) -> Result<ProjectEntry, String> {
    let dir = PathBuf::from(&req.directory);
    scaffold_project(&dir).map_err(|e| e.to_string())?;

    let id = uuid_v4();
    let now = chrono_now();

    let project = Project {
        id: id.clone(),
        name: req.name.clone(),
        directory: req.directory.clone(),
        git_type: Some("private".to_string()),
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
    let max_pos = list.iter().map(|p| p.position).max().unwrap_or(0);
    let entry = ProjectEntry {
        id: id.clone(),
        name: req.name,
        status: "inactive".to_string(),
        position: max_pos + 10,
        local_file: project_file.to_string_lossy().to_string(),
        extra: Default::default(),
    };
    list.push(entry.clone());
    storage::write_json(&list_path, &list).map_err(|e| e.to_string())?;

    Ok(entry)
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn canonical(path: &str) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|e| format!("canonicalize {path}: {e}"))
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
fn enforce_confinement(root: &Path, target: &Path) -> Result<(), String> {
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
    // ISO-8601 without chrono dep (added in Phase 4 if needed).
    // Basic UTC timestamp.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}+00:00")
}
