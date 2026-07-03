use std::collections::HashMap;
use std::path::Path;

use crate::services::remote::{remote_target_for_dir, RemoteTarget};

// Every git invocation goes through the single `run_git` helper, which dispatches
// on whether the project is local or remote:
//
//   * **local** → `crate::paths::command_no_window("git")` in `project_dir`
//     rather than a bare `Command::new`: Eldrun is a windowed app with no
//     console, so on Windows every `git` subprocess would otherwise flash a
//     transient console window — and `git_status`/`git_file_statuses` are polled
//     continuously for the file tree. `command_no_window` sets CREATE_NO_WINDOW
//     on Windows and is a no-op elsewhere.
//   * **remote** (project carries a `RemoteSpec`) → the same `git <args>` run on
//     the host over SSH, riding the shared ControlMaster (`ssh_exec::
//     run_git_remote`). git's output is plain text, so the captured stdout/
//     stderr/exit are parsed byte-for-byte identically to the local case and
//     every parser below is reused unchanged. `push` then authenticates with the
//     *host's* own git credentials/SSH keys, since git runs there.
//
// Each command resolves remoteness once via `remote_target_for_dir(&project_dir)`
// (a reverse-lookup from the absolute `project_dir` the frontend passes to the
// owning project's `RemoteSpec`) and threads the resulting `Option<&RemoteTarget>`
// into `run_git` and the `local_non_repo` guard.

/// Run `git <args>` for a project, dispatching local-vs-remote on `target`.
/// Returns the captured `Output` (stdout/stderr/exit) for both, so callers parse
/// it identically. `target` is the resolved remoteness for `project_dir`.
fn run_git(
    target: Option<&RemoteTarget>,
    project_dir: &str,
    args: &[&str],
) -> Result<std::process::Output, String> {
    match target {
        Some(t) => {
            let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            crate::services::ssh_exec::run_git_remote(&t.spec, &owned)
        }
        None => crate::paths::command_no_window("git")
            .args(args)
            .current_dir(project_dir)
            .output()
            .map_err(|e| e.to_string()),
    }
}

/// Cheap "not a git repo" short-circuit for the read commands. Applies only to
/// **local** projects, where a missing `.git` means "no repo" without spawning
/// git. A remote project's `.git` lives on the host, so it is never short-
/// circuited here — its command runs over SSH and the usual lenient
/// empty-on-failure handling covers a non-repo host dir.
fn local_non_repo(target: Option<&RemoteTarget>, project_dir: &str) -> bool {
    target.is_none() && !Path::new(project_dir).join(".git").exists()
}

/// Run a blocking git command body on a worker thread.
///
/// Every git command here is genuinely blocking — `run_git` either spawns a local
/// `git` subprocess (`.output()`) or runs `git` over SSH (`run_git_remote`, which
/// can stall up to the SSH `ConnectTimeout`/`ServerAlive` window on an unreachable
/// or unauthenticated host). Tauri runs a synchronous `#[command]` on the MAIN
/// thread, so doing that work inline froze the whole window whenever a remote
/// project's host was down (the remote-disconnect freeze). Each command is an
/// `async` wrapper that offloads its sync body here via `spawn_blocking`, so the
/// blocking work runs on tokio's blocking pool and the UI thread stays free. The
/// bodies live in sibling `*_blocking` fns (kept sync, so they remain directly
/// unit-testable without a tokio runtime).
async fn run_off_thread<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("git task failed: {e}"))?
}

#[derive(serde::Serialize)]
pub struct GitStatus {
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub has_remote: bool,
    pub is_repo: bool,
}

#[tauri::command]
pub async fn git_status(project_dir: String) -> Result<GitStatus, String> {
    run_off_thread(move || git_status_blocking(project_dir)).await
}

fn git_status_blocking(project_dir: String) -> Result<GitStatus, String> {
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(GitStatus { staged: 0, unstaged: 0, untracked: 0, has_remote: false, is_repo: false });
    }

    let out = run_git(target.as_ref(), &project_dir, &["status", "--porcelain"])?;

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

    let has_remote = run_git(target.as_ref(), &project_dir, &["remote"])
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);

    Ok(GitStatus { staged, unstaged, untracked, has_remote, is_repo: true })
}

#[tauri::command]
pub async fn git_add_all(project_dir: String) -> Result<(), String> {
    run_off_thread(move || git_add_all_blocking(project_dir)).await
}

fn git_add_all_blocking(project_dir: String) -> Result<(), String> {
    let target = remote_target_for_dir(&project_dir);
    let out = run_git(target.as_ref(), &project_dir, &["add", "-A"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn git_generate_commit_message(project_dir: String) -> Result<String, String> {
    run_off_thread(move || git_generate_commit_message_blocking(project_dir)).await
}

fn git_generate_commit_message_blocking(project_dir: String) -> Result<String, String> {
    let target = remote_target_for_dir(&project_dir);
    let files_out = run_git(target.as_ref(), &project_dir, &["diff", "--staged", "--name-only"])?;
    let staged_text = String::from_utf8_lossy(&files_out.stdout).to_string();
    let staged: Vec<&str> = staged_text.lines().collect();

    // Also check untracked / unstaged if nothing staged
    let files: Vec<String> = if staged.is_empty() {
        let all = run_git(target.as_ref(), &project_dir, &["diff", "--name-only"])
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
pub async fn git_commit(project_dir: String, message: String) -> Result<(), String> {
    run_off_thread(move || git_commit_blocking(project_dir, message)).await
}

fn git_commit_blocking(project_dir: String, message: String) -> Result<(), String> {
    let target = remote_target_for_dir(&project_dir);
    let out = run_git(target.as_ref(), &project_dir, &["commit", "-m", &message])?;
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
pub async fn git_file_statuses(
    project_dir: String,
    rel_path: String,
) -> Result<HashMap<String, String>, String> {
    run_off_thread(move || git_file_statuses_blocking(project_dir, rel_path)).await
}

fn git_file_statuses_blocking(
    project_dir: String,
    rel_path: String,
) -> Result<HashMap<String, String>, String> {
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(HashMap::new());
    }

    let out = run_git(target.as_ref(), &project_dir, &["status", "--porcelain", "--ignored"])?;
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

        // "ignored" must not bubble up from a descendant: git reports a wholly
        // ignored path as `foo` (file) or `foo/` (whole dir), but an ignored
        // file inside an otherwise-tracked dir as `foo/bar`. Only mark the
        // top-level entry ignored when the ignored path IS that entry — else a
        // single ignored child would drag the whole folder into the gitignored
        // section. Other statuses still bubble up so a dir reflects its changes.
        if status == "ignored" && rel.trim_end_matches('/') != top {
            return;
        }

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
    if let Ok(out) = run_git(target.as_ref(), &project_dir, &["log", "@{u}..", "--name-only", "--pretty=format:"])
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
pub async fn git_add_path(project_dir: String, rel_path: String) -> Result<(), String> {
    run_off_thread(move || git_add_path_blocking(project_dir, rel_path)).await
}

fn git_add_path_blocking(project_dir: String, rel_path: String) -> Result<(), String> {
    let target = remote_target_for_dir(&project_dir);
    let out = run_git(target.as_ref(), &project_dir, &["add", "--", &rel_path])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

/// A single changed file with its line delta, used by the action-button change
/// tree (Add/Commit/Push). `binary` files report 0/0 — git emits "-" for them.
#[derive(serde::Serialize)]
pub struct FileChange {
    pub path: String,
    pub added: i64,
    pub deleted: i64,
    pub binary: bool,
}

/// Per-file line stats (`git diff --numstat`) for one of three scopes:
///   "unstaged" – working-tree changes + untracked files (the Add list)
///   "staged"   – index vs HEAD (the Commit list)
///   "unpushed" – local commits ahead of upstream (the Push list)
/// The frontend folds these flat paths into a navigable folder tree.
#[tauri::command]
pub async fn git_change_stats(
    project_dir: String,
    scope: String,
    pool: tauri::State<'_, crate::services::remote::RemotePoolState>,
) -> Result<Vec<FileChange>, String> {
    let dir = Path::new(&project_dir);
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }

    let numstat_args: &[&str] = match scope.as_str() {
        "staged" => &["diff", "--cached", "--numstat", "--"],
        "unpushed" => &["diff", "@{u}..", "--numstat", "--"],
        _ => &["diff", "--numstat", "--"],
    };

    let mut changes: Vec<FileChange> = Vec::new();
    if let Ok(out) = run_git(target.as_ref(), &project_dir, numstat_args)
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let mut parts = line.splitn(3, '\t');
                let a = parts.next().unwrap_or("");
                let d = parts.next().unwrap_or("");
                let p = parts.next().unwrap_or("");
                if p.is_empty() {
                    continue;
                }
                changes.push(FileChange {
                    path: normalize_numstat_path(p),
                    added: a.parse().unwrap_or(0),
                    deleted: d.parse().unwrap_or(0),
                    binary: a == "-" || d == "-",
                });
            }
        }
    }

    // Untracked files never appear in `git diff`; list them separately and count
    // their lines as additions (the Add list shows them alongside modified files).
    if scope == "unstaged" {
        if let Ok(out) = run_git(target.as_ref(), &project_dir, &["ls-files", "--others", "--exclude-standard", "-z"])
        {
            if out.status.success() {
                for chunk in out.stdout.split(|&b| b == 0) {
                    if chunk.is_empty() {
                        continue;
                    }
                    let rel = String::from_utf8_lossy(chunk).into_owned();
                    // Untracked line counts read the file's bytes and apply the
                    // same NUL/newline logic for both project kinds:
                    //   * local  → `std::fs::read` under the project directory;
                    //   * remote → the bytes over the pooled SFTP session, with
                    //     the rel path confined under `spec.remote_path` (a path
                    //     that escapes the root is treated as unreadable).
                    // Any read/confinement error degrades to (0, false) rather
                    // than failing the whole listing.
                    let (added, binary) = match &target {
                        None => count_added_lines(&dir.join(&rel)),
                        Some(t) => count_added_lines_remote(&pool, t, &rel).await,
                    };
                    changes.push(FileChange { path: rel, added, deleted: 0, binary });
                }
            }
        }
    }

    Ok(changes)
}

/// `git --numstat` renders renames as `old => new`, optionally with a braced
/// common segment (`src/{a => b}/f.rs`). Reduce either form to the new path.
fn normalize_numstat_path(p: &str) -> String {
    let Some(arrow) = p.find(" => ") else {
        return p.to_string();
    };
    if let (Some(lb), Some(rb)) = (p.find('{'), p.find('}')) {
        if lb < arrow && arrow < rb {
            return format!("{}{}{}", &p[..lb], &p[arrow + 4..rb], &p[rb + 1..]);
        }
    }
    p[arrow + 4..].to_string()
}

/// Classify an untracked file's bytes into `(added_lines, binary)`, treating
/// NUL-containing files as binary (0 lines). A final line without a trailing
/// newline still counts. Shared by the local and remote readers below.
fn count_lines_in_bytes(bytes: &[u8]) -> (i64, bool) {
    if bytes.contains(&0) {
        return (0, true);
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count() as i64;
    let trailing = matches!(bytes.last(), Some(&b) if b != b'\n') as i64;
    (newlines + trailing, false)
}

/// Line count of an untracked **local** file. An unreadable path degrades to
/// `(0, false)` rather than failing the listing.
fn count_added_lines(path: &Path) -> (i64, bool) {
    match std::fs::read(path) {
        Ok(bytes) => count_lines_in_bytes(&bytes),
        Err(_) => (0, false),
    }
}

/// Line count of an untracked **remote** file, read over the project's pooled
/// SFTP session (mount-free remote). `rel` is the project-relative path from
/// `git ls-files --others`; it is confined under `spec.remote_path` so a hostile
/// path cannot escape the root. A confinement or read error degrades to
/// `(0, false)`, mirroring the local reader.
async fn count_added_lines_remote(
    pool: &crate::services::remote::RemotePoolState,
    target: &RemoteTarget,
    rel: &str,
) -> (i64, bool) {
    let Ok(path) = crate::commands::fs::remote_join_confined(&target.spec.remote_path, rel) else {
        return (0, false);
    };
    match crate::commands::fs::remote_read(pool, target, &path).await {
        Ok(bytes) => count_lines_in_bytes(&bytes),
        Err(_) => (0, false),
    }
}

/// Returns one-line summaries of commits ahead of the upstream (not yet pushed).
/// Returns an empty vec when there is no upstream or the repo is not git.
#[tauri::command]
pub async fn git_unpushed_commits(project_dir: String) -> Result<Vec<String>, String> {
    run_off_thread(move || git_unpushed_commits_blocking(project_dir)).await
}

fn git_unpushed_commits_blocking(project_dir: String) -> Result<Vec<String>, String> {
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    let out = run_git(target.as_ref(), &project_dir, &["log", "@{u}..", "--oneline"])?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text.lines().filter(|l| !l.is_empty()).map(|l| l.to_string()).collect())
}

#[tauri::command]
pub async fn git_push(project_dir: String, project_id: Option<String>) -> Result<String, String> {
    run_off_thread(move || git_push_blocking(project_dir, project_id)).await
}

fn git_push_blocking(project_dir: String, project_id: Option<String>) -> Result<String, String> {
    let out = if let Some(target) = remote_target_for_dir(&project_dir) {
        // Remote project: the push runs on the host and authenticates with the
        // host's own git credentials/SSH keys. The local effective token does not
        // apply (it would be the wrong machine's secret), so it is not forwarded.
        crate::services::ssh_exec::run_git_remote(&target.spec, &["push".to_string()])?
    } else {
        // Local project: effective per-project → global token (if any).
        let token = project_id
            .as_deref()
            .and_then(|id| crate::commands::git_hosting::effective_git_creds(id).1);

        let mut cmd = crate::paths::command_no_window("git");
        cmd.current_dir(&project_dir);
        if let Some(tok) = token.as_deref() {
            // Authenticate an https push with the effective token via an ephemeral
            // inline credential helper. The token is read from the child's env INSIDE
            // the helper snippet, so it never lands in argv or on disk. The leading
            // empty `credential.helper=` clears any system helper (e.g. GCM) so only
            // ours runs. Harmless for SSH remotes — git won't call an http helper.
            cmd.args([
                "-c",
                "credential.helper=",
                "-c",
                "credential.helper=!f() { test \"$1\" = get && echo username=x-access-token && echo \"password=$ELDRUN_GIT_TOKEN\"; }; f",
                "push",
            ]);
            cmd.env("ELDRUN_GIT_TOKEN", tok);
            cmd.env("GIT_TERMINAL_PROMPT", "0");
        } else {
            cmd.args(["push"]);
        }
        cmd.output().map_err(|e| e.to_string())?
    };
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

fn git_head_hash(target: Option<&RemoteTarget>, project_dir: &str) -> Option<String> {
    run_git(target, project_dir, &["rev-parse", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// Returns the most recent commits (default 100) as one-line summaries.
/// Returns an empty vec for a non-git directory or a repo with no commits yet.
#[tauri::command]
pub async fn git_log(project_dir: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    run_off_thread(move || git_log_blocking(project_dir, limit)).await
}

fn git_log_blocking(project_dir: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    let max = limit.unwrap_or(100);
    // Fields separated by US (0x1f) so subjects can contain anything but a newline.
    let fmt = "--pretty=format:%H\u{1f}%h\u{1f}%s\u{1f}%an\u{1f}%ar\u{1f}%D\u{1f}%P";
    let max_count = format!("--max-count={max}");
    let out = run_git(target.as_ref(), &project_dir, &["log", &max_count, fmt])?;
    if !out.status.success() {
        // Empty repository (no commits) — not an error for our purposes.
        return Ok(vec![]);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let head = git_head_hash(target.as_ref(), &project_dir);
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
pub async fn git_branches(project_dir: String) -> Result<Vec<GitBranch>, String> {
    run_off_thread(move || git_branches_blocking(project_dir)).await
}

fn git_branches_blocking(project_dir: String) -> Result<Vec<GitBranch>, String> {
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    let fmt = "--format=%(if)%(HEAD)%(then)*%(else) %(end)\u{1f}%(refname:short)\u{1f}%(refname)";
    let out = run_git(target.as_ref(), &project_dir, &["branch", "-a", fmt])?;
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
pub async fn git_checkout(project_dir: String, target: String) -> Result<String, String> {
    run_off_thread(move || git_checkout_blocking(project_dir, target)).await
}

fn git_checkout_blocking(project_dir: String, target: String) -> Result<String, String> {
    let rt = remote_target_for_dir(&project_dir);
    let out = run_git(rt.as_ref(), &project_dir, &["checkout", &target])?;
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

/// Returns the full commit message (subject + body) for a single commit.
#[tauri::command]
pub async fn git_commit_message(project_dir: String, hash: String) -> Result<String, String> {
    run_off_thread(move || git_commit_message_blocking(project_dir, hash)).await
}

fn git_commit_message_blocking(project_dir: String, hash: String) -> Result<String, String> {
    let target = remote_target_for_dir(&project_dir);
    let out = run_git(target.as_ref(), &project_dir, &["log", "-1", "--pretty=format:%B", &hash])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Rewords the most recent commit (HEAD) via `git commit --amend`. Only valid
/// for the latest commit; rewording older commits would require a rebase.
#[tauri::command]
pub async fn git_reword_head(project_dir: String, message: String) -> Result<(), String> {
    run_off_thread(move || git_reword_head_blocking(project_dir, message)).await
}

fn git_reword_head_blocking(project_dir: String, message: String) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }
    let target = remote_target_for_dir(&project_dir);
    let out = run_git(target.as_ref(), &project_dir, &["commit", "--amend", "-m", &message])?;
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
pub async fn git_diff_file(project_dir: String, rel_path: String) -> Result<String, String> {
    run_off_thread(move || git_diff_file_blocking(project_dir, rel_path)).await
}

fn git_diff_file_blocking(project_dir: String, rel_path: String) -> Result<String, String> {
    let target = remote_target_for_dir(&project_dir);
    let out = run_git(target.as_ref(), &project_dir, &["diff", "--", &rel_path])?;
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
    let fallback = run_git(target.as_ref(), &project_dir, &["diff", "--no-index", "--", "/dev/null", &rel_path])?;
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
pub async fn git_worktree_list(project_dir: String) -> Result<Vec<Worktree>, String> {
    run_off_thread(move || git_worktree_list_blocking(project_dir)).await
}

fn git_worktree_list_blocking(project_dir: String) -> Result<Vec<Worktree>, String> {
    // `.git` exists as a dir for the main repo and as a file in linked worktrees.
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    let out = run_git(target.as_ref(), &project_dir, &["worktree", "list", "--porcelain"])?;
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
pub async fn git_worktree_add(
    project_dir: String,
    path: String,
    branch: String,
    new_branch: bool,
) -> Result<(), String> {
    run_off_thread(move || git_worktree_add_blocking(project_dir, path, branch, new_branch)).await
}

fn git_worktree_add_blocking(
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
    let target = remote_target_for_dir(&project_dir);
    let out = run_git(target.as_ref(), &project_dir, &args)?;
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
pub async fn git_worktree_remove(project_dir: String, path: String, force: bool) -> Result<(), String> {
    run_off_thread(move || git_worktree_remove_blocking(project_dir, path, force)).await
}

fn git_worktree_remove_blocking(project_dir: String, path: String, force: bool) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path);
    let target = remote_target_for_dir(&project_dir);
    let out = run_git(target.as_ref(), &project_dir, &args)?;
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
pub async fn git_worktree_prune(project_dir: String) -> Result<(), String> {
    run_off_thread(move || git_worktree_prune_blocking(project_dir)).await
}

fn git_worktree_prune_blocking(project_dir: String) -> Result<(), String> {
    let target = remote_target_for_dir(&project_dir);
    let out = run_git(target.as_ref(), &project_dir, &["worktree", "prune"])?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(())
}

/// Map an `origin` remote URL to a hosting provider by its **host only**.
/// Handles both SSH (`git@github.com:owner/repo.git`) and HTTPS
/// (`https://github.com/owner/repo.git`) forms. Read-only string work — no
/// network. Returns `None` for unrecognized/self-hosted vanity hosts so we
/// never render a wrong badge.
fn provider_from_origin_url(url: &str) -> Option<&'static str> {
    let lower = url.to_ascii_lowercase();
    if lower.contains("gitlab") {
        Some("gitlab")
    } else if lower.contains("github") {
        Some("github")
    } else {
        None
    }
}

/// A recognized `origin` for a local project: the hosting provider plus the raw
/// remote URL, so the frontend can both badge the provider and display the git
/// address in the project hover.
#[derive(serde::Serialize)]
pub struct DetectedOrigin {
    pub provider: String,
    pub url: String,
}

/// Sniff the `origin` host for each **local** git project and map it to a
/// hosting provider (`"github"`/`"gitlab"`) plus its raw URL. Read-only: runs
/// `git remote get-url origin`, makes no network calls and writes nothing.
/// Returns `{ project_id -> { provider, url } }` only for projects whose origin
/// resolves to a recognized provider. Published (`remote-*`) local projects are
/// included too, so their git address shows in the hover even though their badge
/// already rides on `git_type`. Used to decorate pill/right-panel hovers for
/// repos pushed to a host — including ones published outside Eldrun's own
/// Publish flow (the sole writer of the `remote-*` `git_type`).
#[tauri::command]
pub fn detect_git_providers() -> Result<HashMap<String, DetectedOrigin>, String> {
    use serde_json::Value;

    let path = crate::storage::state_dir().join("projects.json");
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let list: crate::schema::projects::ProjectsList =
        crate::storage::read_json(&path).map_err(|e| e.to_string())?;

    let mut out = HashMap::new();
    for entry in &list {
        // Local projects only: a remote project's `origin` lives on the host,
        // and sniffing it would be a network call.
        if entry.extra.contains_key("remote") {
            continue;
        }
        // Skip repo-less projects; `local` and `remote-*` are both eligible.
        if let Some(Value::String(gt)) = entry.extra.get("git_type") {
            if gt == "none" {
                continue;
            }
        }
        let Some(Value::String(dir)) = entry.extra.get("directory") else {
            continue;
        };
        if !Path::new(dir).join(".git").exists() {
            continue;
        }
        let output = crate::paths::command_no_window("git")
            .args(["-C", dir, "remote", "get-url", "origin"])
            .output();
        let Ok(output) = output else { continue };
        if !output.status.success() {
            continue;
        }
        let url = String::from_utf8_lossy(&output.stdout);
        let url = url.trim();
        if let Some(provider) = provider_from_origin_url(url) {
            out.insert(
                entry.id.clone(),
                DetectedOrigin {
                    provider: provider.to_string(),
                    url: url.to_string(),
                },
            );
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Returns true when `git` is on PATH; tests skip gracefully otherwise.
    fn git_available() -> bool {
        crate::paths::command_no_window("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn init_repo(dir: &std::path::Path) {
        let run = |args: &[&str]| {
            let ok = crate::paths::command_no_window("git")
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
        let add_ok = crate::paths::command_no_window("git")
            .args(["add", "note.txt"])
            .current_dir(dir)
            .output()
            .expect("add runs")
            .status
            .success();
        assert!(add_ok, "git add failed");
        let real_commit = crate::paths::command_no_window("git")
            .args(["commit", "-m", "init"])
            .current_dir(dir)
            .output()
            .expect("commit runs")
            .status
            .success();
        assert!(real_commit, "git commit failed");

        // Modify the file so a tracked diff exists.
        fs::write(&file, "first line\nCHANGED line\n").expect("rewrite");

        let diff = git_diff_file_blocking(
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

        let diff = git_diff_file_blocking(
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
    fn ignored_child_does_not_mark_whole_folder_ignored() {
        if !git_available() {
            eprintln!("git not on PATH — skipping ignored_child_does_not_mark_whole_folder_ignored");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        init_repo(dir);

        // `partial/` has one ignored file and one tracked file → the folder
        // itself is NOT ignored. `whole/` is ignored in its entirety.
        fs::write(dir.join(".gitignore"), "partial/ignored.log\nwhole/\n").expect("write .gitignore");
        fs::create_dir(dir.join("partial")).expect("mkdir partial");
        fs::write(dir.join("partial/ignored.log"), "log\n").expect("write log");
        fs::write(dir.join("partial/keep.txt"), "keep\n").expect("write keep");
        fs::create_dir(dir.join("whole")).expect("mkdir whole");
        fs::write(dir.join("whole/a.txt"), "a\n").expect("write a");

        let statuses = git_file_statuses_blocking(
            dir.to_string_lossy().to_string(),
            String::new(),
        )
        .expect("git_file_statuses should succeed");

        // A folder with only some ignored content stays out of the ignored bucket.
        assert_ne!(
            statuses.get("partial").map(String::as_str),
            Some("ignored"),
            "partial/ must not be marked ignored (got {:?})",
            statuses.get("partial")
        );
        // A wholly-ignored folder is still reported as ignored.
        assert_eq!(
            statuses.get("whole").map(String::as_str),
            Some("ignored"),
            "whole/ should be ignored (got {:?})",
            statuses.get("whole")
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
            crate::paths::command_no_window("git")
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
        let listed = git_worktree_list_blocking(root_str.clone()).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].is_main);

        // Add a new worktree on a new branch.
        let wt_path = tmp.path().join("wt-feature").to_string_lossy().to_string();
        git_worktree_add_blocking(root_str.clone(), wt_path.clone(), "feature".to_string(), true).unwrap();

        let listed = git_worktree_list_blocking(root_str.clone()).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed.iter().filter(|w| w.is_main).count(), 1);
        assert!(listed.iter().any(|w| w.branch == "feature"));

        // Remove it and confirm we are back to one.
        git_worktree_remove_blocking(root_str.clone(), wt_path, true).unwrap();
        let listed = git_worktree_list_blocking(root_str).unwrap();
        assert_eq!(listed.len(), 1);
    }

    #[test]
    fn provider_from_origin_url_recognizes_hosts() {
        // SSH form.
        assert_eq!(
            provider_from_origin_url("git@github.com:owner/repo.git"),
            Some("github")
        );
        assert_eq!(
            provider_from_origin_url("git@gitlab.com:owner/repo.git"),
            Some("gitlab")
        );
        // HTTPS form.
        assert_eq!(
            provider_from_origin_url("https://github.com/owner/repo.git"),
            Some("github")
        );
        assert_eq!(
            provider_from_origin_url("https://gitlab.example.com/owner/repo.git"),
            Some("gitlab")
        );
        // Enterprise/vanity host containing the provider name still matches.
        assert_eq!(
            provider_from_origin_url("git@github.corp.internal:owner/repo.git"),
            Some("github")
        );
        // Unrecognized / self-hosted vanity host → no badge.
        assert_eq!(
            provider_from_origin_url("git@git.mycorp.com:owner/repo.git"),
            None
        );
    }
}
