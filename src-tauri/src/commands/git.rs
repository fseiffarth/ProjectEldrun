use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

#[derive(serde::Serialize)]
pub struct GitStatus {
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub has_remote: bool,
    pub is_repo: bool,
}

#[tauri::command]
pub fn git_status(project_dir: String) -> Result<GitStatus, String> {
    let dir = Path::new(&project_dir);
    if !dir.join(".git").exists() {
        return Ok(GitStatus { staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: false });
    }

    let out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;

    let text = String::from_utf8_lossy(&out.stdout);
    let mut staged = 0usize;
    let mut unstaged = 0usize;
    let mut untracked = 0usize;
    for line in text.lines() {
        if line.len() < 2 { continue; }
        let x = line.chars().next().unwrap_or(' ');
        let y = line.chars().nth(1).unwrap_or(' ');
        if x == '?' && y == '?' {
            untracked += 1;
        } else {
            if x != ' ' { staged += 1; }
            if y != ' ' { unstaged += 1; }
        }
    }

    let has_remote = Command::new("git")
        .args(["remote"])
        .current_dir(&project_dir)
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);

    Ok(GitStatus { staged, unstaged, untracked, has_remote, is_repo: true })
}

#[tauri::command]
pub fn git_add_all(project_dir: String) -> Result<(), String> {
    let out = Command::new("git")
        .args(["add", "-A"])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn git_generate_commit_message(project_dir: String) -> Result<String, String> {
    let files_out = Command::new("git")
        .args(["diff", "--staged", "--name-only"])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    let staged_text = String::from_utf8_lossy(&files_out.stdout).to_string();
    let staged: Vec<&str> = staged_text.lines().collect();

    // Also check untracked / unstaged if nothing staged
    let files: Vec<String> = if staged.is_empty() {
        let all = Command::new("git")
            .args(["diff", "--name-only"])
            .current_dir(&project_dir)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(str::to_owned).collect())
            .unwrap_or_default();
        all
    } else {
        staged.iter().map(|s| s.to_string()).collect()
    };

    if files.is_empty() {
        return Ok("chore: update files".to_string());
    }

    let kind = infer_commit_type(&files);
    let msg = format_commit_message(kind, &files);
    Ok(msg)
}

fn infer_commit_type(files: &[String]) -> &'static str {
    let has = |pat: &str| files.iter().any(|f| f.contains(pat));
    if has(".github/") || has("ci-cd") || has("Dockerfile") { return "ci"; }
    if files.iter().all(|f| f.ends_with(".md")) { return "docs"; }
    if has("Cargo.toml") || has("package.json") || has("package-lock") { return "chore"; }
    if has("test") || has("spec") || has("__tests__") { return "test"; }
    if has("src/") || has("src-tauri/src/") { return "feat"; }
    "chore"
}

fn format_commit_message(kind: &str, files: &[String]) -> String {
    let names: Vec<String> = files
        .iter()
        .map(|f| {
            std::path::Path::new(f)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(f.as_str())
                .to_string()
        })
        .collect();

    let mut seen = std::collections::HashSet::new();
    let unique: Vec<&String> = names.iter().filter(|n| seen.insert(n.as_str())).collect();

    let subject = match unique.len() {
        0 => "update files".to_string(),
        1 => format!("update {}", unique[0]),
        2 => format!("update {} and {}", unique[0], unique[1]),
        _ => format!("update {}, {} and {} more", unique[0], unique[1], unique.len() - 2),
    };
    format!("{kind}: {subject}")
}

#[tauri::command]
pub fn git_commit(project_dir: String, message: String) -> Result<(), String> {
    let out = Command::new("git")
        .args(["commit", "-m", &message])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

/// Returns a map of `relative_path → status` for all entries under `rel_path`.
/// Status values: "staged" | "modified" | "untracked" | "ignored"
/// For directories the "worst" child status bubbles up.
#[tauri::command]
pub fn git_file_statuses(
    project_dir: String,
    rel_path: String,
) -> Result<HashMap<String, String>, String> {
    let dir = Path::new(&project_dir);
    if !dir.join(".git").exists() {
        return Ok(HashMap::new());
    }

    let out = Command::new("git")
        .args(["status", "--porcelain", "--ignored"])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;

    let text = String::from_utf8_lossy(&out.stdout);
    // prefix used to filter entries under rel_path
    let prefix = if rel_path.is_empty() { String::new() } else { format!("{rel_path}/") };

    // Priority: staged > untracked > modified > ignored
    fn priority(s: &str) -> u8 {
        match s {
            "staged"    => 3,
            "untracked" => 2,
            "modified"  => 1,
            _           => 0, // ignored
        }
    }

    let mut map: HashMap<String, String> = HashMap::new();

    for line in text.lines() {
        if line.len() < 4 { continue; }
        let xy = &line[..2];
        let raw_path = line[3..].trim_matches('"');
        let file_path = if raw_path.contains(" -> ") {
            raw_path.split(" -> ").last().unwrap_or(raw_path).trim_matches('"')
        } else {
            raw_path
        };

        let status = match xy {
            "!!" => "ignored",
            "??" => "untracked",
            s if s.chars().next().map(|c| c != ' ').unwrap_or(false) => "staged",
            _ => "modified",
        };

        let rel = if prefix.is_empty() {
            file_path.to_string()
        } else if let Some(stripped) = file_path.strip_prefix(&prefix) {
            stripped.to_string()
        } else {
            continue;
        };

        let top = rel.split('/').next().unwrap_or(&rel).to_string();
        if top.is_empty() { continue; }

        let cur_priority = map.get(&top).map(|s| priority(s.as_str())).unwrap_or(0);
        if priority(status) > cur_priority {
            map.insert(top, status.to_string());
        }
    }

    Ok(map)
}

#[tauri::command]
pub fn git_push(project_dir: String) -> Result<String, String> {
    let out = Command::new("git")
        .args(["push"])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}
