//! GitHub publishing for projects, via the system `gh` CLI.
//!
//! Publishing creates a GitHub repo from the project's git working tree and
//! pushes to it (`gh repo create … --source=. --push`). The project's push
//! target (`git_type`) is then updated to `remote-<visibility>`.
//!
//! A project's bytes may live locally or on an SSH work-remote host. For a
//! remote project the push must originate where the repo actually is, so the
//! `gh` invocation runs over `ssh` on the remote host (mirroring `commands::ssh`:
//! `BatchMode`, validated argv, no shell string built from untrusted input — the
//! remote path/name are single-quoted for the remote shell).

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

use crate::commands::projects::{normalize_git_type, sanitize_name};
use crate::schema::project::Project;
use crate::schema::projects::ProjectsList;
use crate::services::ssh_mount::{ssh_base_args, validate_arg};
use crate::storage;

/// Publish a project's git repository to GitHub and record the new push target.
///
/// `visibility` must be "public" or "private". Returns `gh`'s stdout (typically
/// the new repository URL) on success, or the trimmed stderr on failure.
#[tauri::command]
pub fn github_publish(project_id: String, visibility: String) -> Result<String, String> {
    let visibility = match visibility.trim() {
        "public" => "public",
        "private" => "private",
        other => {
            return Err(format!(
                "visibility must be 'public' or 'private', got '{other}'"
            ))
        }
    };

    let (entry_index, mut list) = find_entry(&project_id)?;
    let local_file = list[entry_index].local_file.clone();
    let project: Project =
        storage::read_json(&PathBuf::from(&local_file)).map_err(|e| e.to_string())?;

    // GitHub repo names can't contain spaces/special chars; reuse the project
    // name sanitizer that already produces a safe slug for local directories.
    let repo_name = sanitize_name(&project.name);
    if repo_name.is_empty() {
        return Err("Project name does not yield a valid GitHub repo name".to_string());
    }

    let stdout = match project.remote.as_ref() {
        // Remote project: run gh on the host where the bytes live.
        Some(remote) => {
            let base = ssh_base_args(&remote.user, &remote.host, remote.port)?;
            validate_arg("remote_path", &remote.remote_path)?;
            let script = format!(
                "cd {} && gh repo create {} --{} --source=. --remote=origin --push",
                shell_quote(&remote.remote_path),
                shell_quote(&repo_name),
                visibility,
            );
            run_command(Command::new("ssh").args(&base).arg(script))?
        }
        // Local project: run gh in the project directory.
        None => {
            let dir = PathBuf::from(&project.directory);
            if !dir.is_dir() {
                return Err(format!(
                    "Project directory does not exist: {}",
                    project.directory
                ));
            }
            let mut cmd = Command::new("gh");
            cmd.current_dir(&dir).args([
                "repo",
                "create",
                &repo_name,
                &format!("--{visibility}"),
                "--source=.",
                "--remote=origin",
                "--push",
            ]);
            run_command(&mut cmd)?
        }
    };

    // Reflect the new push target in both projects.json and project.json.
    let new_git_type = normalize_git_type(&format!("remote-{visibility}"));
    list[entry_index]
        .extra
        .insert("git_type".to_string(), Value::String(new_git_type.clone()));
    storage::write_json(&storage::state_dir().join("projects.json"), &list)
        .map_err(|e| e.to_string())?;

    let proj_path = PathBuf::from(&local_file);
    if proj_path.exists() {
        if let Ok(mut p) = storage::read_json::<Project>(&proj_path) {
            p.git_type = Some(new_git_type);
            let _ = storage::write_json(&proj_path, &p);
        }
    }

    Ok(stdout.trim().to_string())
}

/// Find a project entry by id, returning its index and the full (owned) list so
/// the caller can mutate + persist it.
fn find_entry(project_id: &str) -> Result<(usize, ProjectsList), String> {
    let list_path = storage::state_dir().join("projects.json");
    let list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let idx = list
        .iter()
        .position(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    Ok((idx, list))
}

/// Run a command, returning trimmed stdout on success or a useful error
/// (stderr, else stdout, else a generic message) on failure.
fn run_command(cmd: &mut Command) -> Result<String, String> {
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run command: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            return Err(stderr);
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Err(stdout);
        }
        return Err("command failed".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Single-quote a string for safe embedding in a remote `/bin/sh` command,
/// escaping any embedded single quotes.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_wraps_plain_value() {
        assert_eq!(shell_quote("/home/user/proj"), "'/home/user/proj'");
    }

    #[test]
    fn shell_quote_escapes_embedded_single_quotes() {
        assert_eq!(shell_quote("a'b"), r"'a'\''b'");
        // The result is a safe single-quoted shell token (no unescaped quote
        // breaks out of the quoting).
        assert!(shell_quote("; rm -rf /").starts_with('\''));
    }
}
