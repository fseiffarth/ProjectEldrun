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

/// Returns a map of `relative_path → status` for all entries directly under `rel_path`.
/// Status values (highest priority first when bubbled up to a directory):
///   "modified"  – tracked file with unstaged working-tree changes (red bar)
///   "untracked" – new, not yet tracked (red bar)
///   "staged"    – staged, not yet committed (orange bar)
///   "unpushed"  – committed locally but not pushed to upstream (green ↑)
///   "ignored"   – ignored by git (gray ✕)
/// For directories the highest-priority child status bubbles up.
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
    let porcelain = String::from_utf8_lossy(&out.stdout).into_owned();

    // prefix used to filter entries under rel_path
    let prefix = if rel_path.is_empty() { String::new() } else { format!("{rel_path}/") };

    fn priority(s: &str) -> u8 {
        match s {
            "modified"  => 5,
            "untracked" => 4,
            "staged"    => 3,
            "unpushed"  => 2,
            "ignored"   => 1,
            _           => 0,
        }
    }

    let mut map: HashMap<String, String> = HashMap::new();
    // Record `raw_path → status`, bubbling the highest-priority status up to the
    // top-level entry directly under `rel_path`.
    let mut record = |raw_path: &str, status: &str| {
        let file_path = if raw_path.contains(" -> ") {
            raw_path.split(" -> ").last().unwrap_or(raw_path).trim_matches('"')
        } else {
            raw_path.trim_matches('"')
        };

        let rel = if prefix.is_empty() {
            file_path
        } else if let Some(stripped) = file_path.strip_prefix(&prefix) {
            stripped
        } else {
            return;
        };

        let top = rel.split('/').next().unwrap_or(rel);
        if top.is_empty() { return; }

        let cur = map.get(top).map(|s| priority(s.as_str())).unwrap_or(0);
        if priority(status) > cur {
            map.insert(top.to_string(), status.to_string());
        }
    };

    for line in porcelain.lines() {
        if line.len() < 4 { continue; }
        let bytes = line.as_bytes();
        let (x, y) = (bytes[0], bytes[1]);
        let raw_path = &line[3..];

        let status = if x == b'!' && y == b'!' {
            "ignored"
        } else if x == b'?' && y == b'?' {
            "untracked"
        } else if y != b' ' {
            // Unstaged working-tree change (also covers partly-staged like "MM").
            "modified"
        } else if x != b' ' {
            "staged"
        } else {
            continue;
        };
        record(raw_path, status);
    }

    // Files in commits that exist locally but are not on the upstream branch.
    if let Ok(out) = Command::new("git")
        .args(["log", "@{u}..", "--name-only", "--pretty=format:"])
        .current_dir(&project_dir)
        .output()
    {
        if out.status.success() {
            let committed = String::from_utf8_lossy(&out.stdout).into_owned();
            for line in committed.lines() {
                let p = line.trim();
                if !p.is_empty() {
                    record(p, "unpushed");
                }
            }
        }
    }

    Ok(map)
}

/// Stages a specific path (file or directory) via `git add`.
#[tauri::command]
pub fn git_add_path(project_dir: String, rel_path: String) -> Result<(), String> {
    let out = Command::new("git")
        .args(["add", "--", &rel_path])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

/// Returns one-line summaries of commits ahead of the upstream (not yet pushed).
/// Returns an empty vec when there is no upstream or the repo is not git.
#[tauri::command]
pub fn git_unpushed_commits(project_dir: String) -> Result<Vec<String>, String> {
    let dir = Path::new(&project_dir);
    if !dir.join(".git").exists() {
        return Ok(vec![]);
    }
    let out = Command::new("git")
        .args(["log", "@{u}..", "--oneline"])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text.lines().filter(|l| !l.is_empty()).map(|l| l.to_string()).collect())
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

// ── Git history & branches ──────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub refs: String,
    pub is_head: bool,
    /// Full hashes of this commit's parents (2+ for merge commits), oldest-first
    /// as reported by git. Empty for the root commit.
    pub parents: Vec<String>,
}

fn git_head_hash(project_dir: &str) -> Option<String> {
    Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(project_dir)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// Returns the most recent commits (default 100) as one-line summaries.
/// Returns an empty vec for a non-git directory or a repo with no commits yet.
#[tauri::command]
pub fn git_log(project_dir: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    let dir = Path::new(&project_dir);
    if !dir.join(".git").exists() {
        return Ok(vec![]);
    }
    let max = limit.unwrap_or(100);
    // Fields separated by US (0x1f) so subjects can contain anything but a newline.
    let fmt = "--pretty=format:%H\u{1f}%h\u{1f}%s\u{1f}%an\u{1f}%ar\u{1f}%D\u{1f}%P";
    let out = Command::new("git")
        .args(["log", &format!("--max-count={max}"), fmt])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        // Empty repository (no commits) — not an error for our purposes.
        return Ok(vec![]);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let head = git_head_hash(&project_dir);
    let mut commits = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split('\u{1f}').collect();
        if parts.len() < 7 {
            continue;
        }
        let hash = parts[0].to_string();
        let is_head = head.as_deref() == Some(hash.as_str());
        let parents = parts[6]
            .split_whitespace()
            .map(|p| p.to_string())
            .collect();
        commits.push(GitCommit {
            hash,
            short: parts[1].to_string(),
            subject: parts[2].to_string(),
            author: parts[3].to_string(),
            date: parts[4].to_string(),
            refs: parts[5].to_string(),
            is_head,
            parents,
        });
    }
    Ok(commits)
}

#[derive(serde::Serialize)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
}

/// Lists local and remote-tracking branches.
#[tauri::command]
pub fn git_branches(project_dir: String) -> Result<Vec<GitBranch>, String> {
    let dir = Path::new(&project_dir);
    if !dir.join(".git").exists() {
        return Ok(vec![]);
    }
    let fmt = "--format=%(if)%(HEAD)%(then)*%(else) %(end)\u{1f}%(refname:short)\u{1f}%(refname)";
    let out = Command::new("git")
        .args(["branch", "-a", fmt])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut branches = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split('\u{1f}').collect();
        if parts.len() < 3 {
            continue;
        }
        let name = parts[1].to_string();
        // Skip the symbolic remote HEAD pointer (e.g. "origin/HEAD").
        if name.ends_with("/HEAD") {
            continue;
        }
        branches.push(GitBranch {
            is_current: parts[0] == "*",
            is_remote: parts[2].starts_with("refs/remotes/"),
            name,
        });
    }
    Ok(branches)
}

/// Checks out a branch name or commit hash. Surfaces git's stderr on failure
/// (e.g. when the working tree has conflicting uncommitted changes).
#[tauri::command]
pub fn git_checkout(project_dir: String, target: String) -> Result<String, String> {
    let out = Command::new("git")
        .args(["checkout", &target])
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

/// Returns the full commit message (subject + body) for a single commit.
#[tauri::command]
pub fn git_commit_message(project_dir: String, hash: String) -> Result<String, String> {
    let out = Command::new("git")
        .args(["log", "-1", "--pretty=format:%B", &hash])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Rewords the most recent commit (HEAD) via `git commit --amend`. Only valid
/// for the latest commit; rewording older commits would require a rebase.
#[tauri::command]
pub fn git_reword_head(project_dir: String, message: String) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }
    let out = Command::new("git")
        .args(["commit", "--amend", "-m", &message])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

/// Returns the unified diff for a single file relative to `project_dir`.
///
/// Runs `git diff -- <rel_path>` (working-tree changes against the index/HEAD).
/// When that yields no output — typically because the file is untracked, so it
/// has no tracked diff — it falls back to `git diff --no-index -- /dev/null
/// <rel_path>`, which renders the whole file as added. `--no-index` exits
/// non-zero whenever there are differences, so for the fallback we treat any
/// non-empty stdout as success regardless of exit status.
#[tauri::command]
pub fn git_diff_file(project_dir: String, rel_path: String) -> Result<String, String> {
    let out = Command::new("git")
        .args(["diff", "--", &rel_path])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !stdout.is_empty() {
        return Ok(stdout);
    }

    // Tracked diff is empty (e.g. untracked file). Show the whole file as added.
    // `--no-index` exits non-zero when differences exist, which is the normal
    // case here, so treat any non-empty stdout as success.
    let fallback = Command::new("git")
        .args(["diff", "--no-index", "--", "/dev/null", &rel_path])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    let fb_stdout = String::from_utf8_lossy(&fallback.stdout).to_string();
    if !fb_stdout.is_empty() {
        return Ok(fb_stdout);
    }
    if !fallback.status.success() {
        return Err(String::from_utf8_lossy(&fallback.stderr).to_string());
    }
    // No tracked changes and the fallback produced nothing — return empty diff.
    Ok(stdout)
}

// ── Git worktrees (#23) ──────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct Worktree {
    pub path: String,
    /// Short branch name, or "" when detached/bare.
    pub branch: String,
    /// Full HEAD sha, or "" for a bare worktree.
    pub head: String,
    pub is_main: bool,
    pub is_locked: bool,
    pub is_bare: bool,
}

/// Parses `git worktree list --porcelain` output. Records are blank-line
/// separated; each starts with `worktree <abs-path>` followed by optional
/// attribute lines (`HEAD <sha>`, `branch refs/heads/<name>`, `bare`,
/// `detached`, `locked [<reason>]`, `prunable [<reason>]`). git always lists
/// the main worktree first, so the first record is flagged `is_main`.
fn parse_worktree_porcelain(text: &str) -> Vec<Worktree> {
    let mut out: Vec<Worktree> = Vec::new();
    let mut cur: Option<Worktree> = None;
    let mut first = true;

    fn flush(cur: &mut Option<Worktree>, out: &mut Vec<Worktree>) {
        if let Some(wt) = cur.take() {
            if !wt.path.is_empty() {
                out.push(wt);
            }
        }
    }

    for line in text.lines() {
        if line.is_empty() {
            flush(&mut cur, &mut out);
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            // Starting a new record; close any in progress.
            flush(&mut cur, &mut out);
            cur = Some(Worktree {
                path: path.to_string(),
                branch: String::new(),
                head: String::new(),
                is_main: first,
                is_locked: false,
                is_bare: false,
            });
            first = false;
        } else if let Some(wt) = cur.as_mut() {
            if let Some(sha) = line.strip_prefix("HEAD ") {
                wt.head = sha.to_string();
            } else if let Some(refname) = line.strip_prefix("branch ") {
                wt.branch = refname
                    .strip_prefix("refs/heads/")
                    .unwrap_or(refname)
                    .to_string();
            } else if line == "bare" {
                wt.is_bare = true;
            } else if line == "detached" {
                // branch stays empty
            } else if line == "locked" || line.starts_with("locked ") {
                wt.is_locked = true;
            }
            // ignore prunable / unknown lines
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// Lists worktrees attached to the repository at `project_dir`.
#[tauri::command]
pub fn git_worktree_list(project_dir: String) -> Result<Vec<Worktree>, String> {
    // `.git` exists as a dir for the main repo and as a file in linked worktrees.
    if !Path::new(&project_dir).join(".git").exists() {
        return Ok(vec![]);
    }
    let out = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        // Lenient, like git_log (e.g. empty repo).
        return Ok(vec![]);
    }
    Ok(parse_worktree_porcelain(&String::from_utf8_lossy(&out.stdout)))
}

/// Adds a worktree at `path`. When `new_branch` is true, creates a new branch
/// `branch` at `path` (`git worktree add -b <branch> <path>`); otherwise checks
/// out the existing `branch` (`git worktree add <path> <branch>`).
#[tauri::command]
pub fn git_worktree_add(
    project_dir: String,
    path: String,
    branch: String,
    new_branch: bool,
) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Worktree path cannot be empty".to_string());
    }
    if branch.trim().is_empty() {
        return Err("Branch cannot be empty".to_string());
    }
    let mut args: Vec<&str> = vec!["worktree", "add"];
    if new_branch {
        args.push("-b");
        args.push(&branch);
        args.push(&path);
    } else {
        args.push(&path);
        args.push(&branch);
    }
    let out = Command::new("git")
        .args(&args)
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(())
}

/// Removes the worktree at `path`. Pass `force` to remove a dirty worktree;
/// git refuses to remove the main worktree or a dirty one without it, and that
/// error is surfaced to the caller as-is.
#[tauri::command]
pub fn git_worktree_remove(project_dir: String, path: String, force: bool) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path);
    let out = Command::new("git")
        .args(&args)
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(())
}

/// Prunes administrative entries for worktrees whose directories were removed
/// out-of-band (`git worktree prune`).
#[tauri::command]
pub fn git_worktree_prune(project_dir: String) -> Result<(), String> {
    let out = Command::new("git")
        .args(["worktree", "prune"])
        .current_dir(&project_dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    /// Returns true when `git` is on PATH; tests skip gracefully otherwise.
    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn init_repo(dir: &std::path::Path) {
        let run = |args: &[&str]| {
            let ok = Command::new("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git command should run")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        run(&["init"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test User"]);
    }

    #[test]
    fn git_diff_file_shows_modified_hunk() {
        if !git_available() {
            eprintln!("git not on PATH — skipping git_diff_file_shows_modified_hunk");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        init_repo(dir);

        let file = dir.join("note.txt");
        fs::write(&file, "first line\nsecond line\n").expect("write");
        let add_ok = Command::new("git")
            .args(["add", "note.txt"])
            .current_dir(dir)
            .output()
            .expect("add runs")
            .status
            .success();
        assert!(add_ok, "git add failed");
        let real_commit = Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(dir)
            .output()
            .expect("commit runs")
            .status
            .success();
        assert!(real_commit, "git commit failed");

        // Modify the file so a tracked diff exists.
        fs::write(&file, "first line\nCHANGED line\n").expect("rewrite");

        let diff = git_diff_file(
            dir.to_string_lossy().to_string(),
            "note.txt".to_string(),
        )
        .expect("git_diff_file should succeed");
        assert!(diff.contains("@@"), "expected a hunk marker, got: {diff}");
        assert!(diff.contains("CHANGED line"), "expected changed line, got: {diff}");
    }

    #[test]
    fn git_diff_file_untracked_uses_no_index_fallback() {
        if !git_available() {
            eprintln!("git not on PATH — skipping git_diff_file_untracked_uses_no_index_fallback");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        init_repo(dir);

        // Brand-new untracked file: the tracked `git diff` is empty, so the
        // command must fall back to `--no-index` and show it as added.
        let file = dir.join("fresh.txt");
        fs::write(&file, "brand new content\nanother line\n").expect("write");

        let diff = git_diff_file(
            dir.to_string_lossy().to_string(),
            "fresh.txt".to_string(),
        )
        .expect("git_diff_file should succeed via fallback");
        assert!(!diff.is_empty(), "fallback diff should be non-empty");
        assert!(
            diff.contains("brand new content"),
            "expected file content in fallback diff, got: {diff}"
        );
    }

    #[test]
    fn parses_main_and_linked_with_branches() {
        let text = "worktree /home/u/proj\nHEAD abc123def456\nbranch refs/heads/main\n\nworktree /home/u/proj-feature\nHEAD 999888777666\nbranch refs/heads/feature\n";
        let wts = parse_worktree_porcelain(text);
        assert_eq!(wts.len(), 2);
        assert_eq!(wts[0].path, "/home/u/proj");
        assert_eq!(wts[0].branch, "main");
        assert_eq!(wts[0].head, "abc123def456");
        assert!(wts[0].is_main);
        assert!(!wts[0].is_bare);
        assert!(!wts[0].is_locked);
        assert_eq!(wts[1].path, "/home/u/proj-feature");
        assert_eq!(wts[1].branch, "feature");
        assert!(!wts[1].is_main);
    }

    #[test]
    fn parses_detached_head() {
        let text = "worktree /home/u/proj\nHEAD abc123\nbranch refs/heads/main\n\nworktree /home/u/detached\nHEAD deadbeef\ndetached\n";
        let wts = parse_worktree_porcelain(text);
        assert_eq!(wts.len(), 2);
        assert_eq!(wts[1].branch, "");
        assert_eq!(wts[1].head, "deadbeef");
        assert!(!wts[1].is_main);
    }

    #[test]
    fn parses_bare_main() {
        let text = "worktree /home/u/bare.git\nbare\n\nworktree /home/u/linked\nHEAD abc123\nbranch refs/heads/work\n";
        let wts = parse_worktree_porcelain(text);
        assert_eq!(wts.len(), 2);
        assert!(wts[0].is_bare);
        assert!(wts[0].is_main);
        assert_eq!(wts[0].branch, "");
        assert_eq!(wts[0].head, "");
        assert_eq!(wts[1].branch, "work");
    }

    #[test]
    fn parses_locked_with_reason() {
        let text = "worktree /home/u/proj\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/u/locked\nHEAD def\nbranch refs/heads/wip\nlocked on a removable drive\n";
        let wts = parse_worktree_porcelain(text);
        assert_eq!(wts.len(), 2);
        assert!(wts[1].is_locked);
        assert_eq!(wts[1].branch, "wip");
    }

    #[test]
    fn skips_empty_path_records() {
        // Leading/trailing blank lines must not produce phantom worktrees.
        let text = "\n\nworktree /home/u/proj\nHEAD abc\nbranch refs/heads/main\n\n\n";
        let wts = parse_worktree_porcelain(text);
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].path, "/home/u/proj");
        assert!(wts[0].is_main);
    }

    #[test]
    fn add_list_remove_roundtrip() {
        if !git_available() {
            eprintln!("skipping: git binary not available");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let root_str = root.to_string_lossy().to_string();

        let run = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .expect("git run")
        };
        assert!(run(&["init"]).status.success());
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        // Ensure a known starting branch name regardless of git defaults.
        run(&["checkout", "-b", "main"]);
        std::fs::write(root.join("file.txt"), "hello").unwrap();
        run(&["add", "-A"]);
        assert!(run(&["commit", "-m", "init"]).status.success());

        // Initially a single (main) worktree.
        let listed = git_worktree_list(root_str.clone()).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].is_main);

        // Add a new worktree on a new branch.
        let wt_path = tmp.path().join("wt-feature").to_string_lossy().to_string();
        git_worktree_add(root_str.clone(), wt_path.clone(), "feature".to_string(), true).unwrap();

        let listed = git_worktree_list(root_str.clone()).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed.iter().filter(|w| w.is_main).count(), 1);
        assert!(listed.iter().any(|w| w.branch == "feature"));

        // Remove it and confirm we are back to one.
        git_worktree_remove(root_str.clone(), wt_path, true).unwrap();
        let listed = git_worktree_list(root_str).unwrap();
        assert_eq!(listed.len(), 1);
    }
}
