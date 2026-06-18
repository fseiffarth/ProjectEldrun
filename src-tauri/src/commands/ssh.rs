//! SSH commands for remote projects.
//!
//! These shell out to the system `ssh` binary in `BatchMode` so the user's
//! existing key/agent/`~/.ssh/config` setup is the source of truth. We never
//! build a shell string from user input: `host`, `user`, `path` and `port` are
//! passed as separate argv items, and we reject values that could be mistaken
//! for `ssh`/`ls` options (a leading `-`) or that contain control characters.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

use crate::schema::project::Project;
use crate::schema::projects::ProjectsList;
use crate::storage;
// The validation + base-argv helpers live in `services::ssh_mount` so the
// `ssh` and `sshfs` commands share a single validated implementation.
use crate::services::ssh_mount::{self, ssh_base_args, validate_arg};

/// One entry in a remote directory listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Run `ssh <base> <remote_argv...>` and return stdout on success, or the
/// trimmed stderr on failure.
fn run_ssh(base: Vec<String>, remote: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("ssh");
    cmd.args(&base);
    cmd.args(remote);

    let output = cmd
        .output()
        .map_err(|e| format!("failed to run ssh: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err("ssh command failed".to_string());
        }
        return Err(stderr);
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Parse `ls -1Ap` output into entries. A trailing `/` marks a directory; we
/// strip it and set `is_dir`. `.`/`..` are filtered out, blank lines skipped.
/// Result is sorted dirs-first, then case-insensitively by name.
fn parse_ls_output(stdout: &str) -> Vec<RemoteEntry> {
    let mut entries: Vec<RemoteEntry> = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            continue;
        }
        let (name, is_dir) = match line.strip_suffix('/') {
            Some(stripped) => (stripped, true),
            None => (line, false),
        };
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        entries.push(RemoteEntry {
            name: name.to_string(),
            is_dir,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

/// Verify the remote host is reachable over SSH (non-interactive). Returns the
/// trimmed ssh stderr as the error on failure.
#[tauri::command]
pub fn ssh_connect(user: Option<String>, host: String, port: Option<u16>) -> Result<(), String> {
    let base = ssh_base_args(&user, &host, port)?;
    run_ssh(base, &["true"]).map(|_| ())
}

/// Return the remote `$HOME` (via `pwd`) as the browser's start location.
#[tauri::command]
pub fn ssh_default_dir(
    user: Option<String>,
    host: String,
    port: Option<u16>,
) -> Result<String, String> {
    let base = ssh_base_args(&user, &host, port)?;
    let stdout = run_ssh(base, &["pwd"])?;
    let path = stdout.trim().to_string();
    if path.is_empty() {
        return Err("remote pwd returned no path".to_string());
    }
    Ok(path)
}

/// List one remote directory. Empty `path` lists the remote home directory.
#[tauri::command]
pub fn ssh_list_dir(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    path: String,
) -> Result<Vec<RemoteEntry>, String> {
    let base = ssh_base_args(&user, &host, port)?;

    let path = path.trim();
    let stdout = if path.is_empty() {
        // No path → list the remote home directory.
        run_ssh(base, &["ls", "-1Ap", "--"])?
    } else {
        validate_arg("path", path)?;
        run_ssh(base, &["ls", "-1Ap", "--", path])?
    };

    Ok(parse_ls_output(&stdout))
}

/// Ensure a project's bytes are reachable locally and return the directory to
/// use. For a remote project this sshfs-mounts it (no-op if already mounted)
/// and returns the local mountpoint; for a local project it returns the stored
/// `directory` unchanged.
#[tauri::command]
pub fn ensure_project_mounted(project_id: String) -> Result<String, String> {
    let project = load_project_by_id(&project_id)?;

    match project.remote.as_ref() {
        Some(remote) => {
            let mountpoint = ssh_mount::mount(remote, &project_id)?;
            Ok(mountpoint.to_string_lossy().into_owned())
        }
        None => Ok(project.directory),
    }
}

/// Load a project's `project.json` by its id, resolving `local_file` from the
/// global `projects.json` list.
fn load_project_by_id(project_id: &str) -> Result<Project, String> {
    let list_path = storage::state_dir().join("projects.json");
    let list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let entry = list
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    let path = PathBuf::from(&entry.local_file);
    storage::read_json::<Project>(&path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_ls_output ────────────────────────────────────────────────────

    #[test]
    fn parse_ls_distinguishes_dirs_and_files() {
        let out = "src/\nmain.rs\nCargo.toml\ntarget/\n";
        let entries = parse_ls_output(out);
        let dirs: Vec<_> = entries
            .iter()
            .filter(|e| e.is_dir)
            .map(|e| e.name.as_str())
            .collect();
        let files: Vec<_> = entries
            .iter()
            .filter(|e| !e.is_dir)
            .map(|e| e.name.as_str())
            .collect();
        assert_eq!(dirs, vec!["src", "target"]);
        assert_eq!(files, vec!["Cargo.toml", "main.rs"]);
    }

    #[test]
    fn parse_ls_sorts_dirs_first_then_name_ci() {
        let out = "zebra.txt\nApple/\nbanana.txt\nCherry/\n";
        let entries = parse_ls_output(out);
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        // Dirs first (Apple, Cherry), then files (banana, zebra), each ci-sorted.
        assert_eq!(names, vec!["Apple", "Cherry", "banana.txt", "zebra.txt"]);
    }

    #[test]
    fn parse_ls_includes_hidden_entries() {
        let out = ".config/\n.bashrc\nvisible.txt\n";
        let entries = parse_ls_output(out);
        assert!(entries
            .iter()
            .any(|e| e.name == ".config" && e.is_dir));
        assert!(entries
            .iter()
            .any(|e| e.name == ".bashrc" && !e.is_dir));
    }

    #[test]
    fn parse_ls_filters_dot_and_dotdot_and_blanks() {
        // -Ap omits . and .., but be defensive: ./ and ../ and blank lines drop.
        let out = "./\n../\n\nreal/\n";
        let entries = parse_ls_output(out);
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["real"]);
    }

    #[test]
    fn parse_ls_handles_crlf_line_endings() {
        let out = "dir/\r\nfile.txt\r\n";
        let entries = parse_ls_output(out);
        assert_eq!(entries.len(), 2);
        assert!(entries[0].is_dir && entries[0].name == "dir");
        assert!(!entries[1].is_dir && entries[1].name == "file.txt");
    }

    #[test]
    fn parse_ls_empty_output_yields_no_entries() {
        assert!(parse_ls_output("").is_empty());
        assert!(parse_ls_output("\n\n").is_empty());
    }

    // ── ssh_base_args / validation ─────────────────────────────────────────

    #[test]
    fn base_args_renders_user_at_host_as_single_item() {
        let args = ssh_base_args(&Some("alice".to_string()), "host.example", None).unwrap();
        assert_eq!(args.last().unwrap(), "alice@host.example");
        // BatchMode + ConnectTimeout present.
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
        assert!(args.iter().any(|a| a == "ConnectTimeout=10"));
    }

    #[test]
    fn base_args_no_user_uses_bare_host() {
        let args = ssh_base_args(&None, "host.example", None).unwrap();
        assert_eq!(args.last().unwrap(), "host.example");
    }

    #[test]
    fn base_args_includes_port_flag() {
        let args = ssh_base_args(&None, "host.example", Some(2222)).unwrap();
        let pos = args.iter().position(|a| a == "-p").expect("-p present");
        assert_eq!(args[pos + 1], "2222");
    }

    #[test]
    fn base_args_rejects_leading_dash_host() {
        assert!(ssh_base_args(&None, "-oProxyCommand=evil", None).is_err());
    }

    #[test]
    fn base_args_rejects_leading_dash_user() {
        assert!(ssh_base_args(&Some("-evil".to_string()), "host", None).is_err());
    }

    #[test]
    fn base_args_rejects_control_chars() {
        assert!(ssh_base_args(&None, "host\nevil", None).is_err());
        assert!(ssh_base_args(&None, "host\0evil", None).is_err());
        assert!(ssh_base_args(&Some("us\ter".to_string()), "host", None).is_err());
    }

    #[test]
    fn base_args_rejects_empty_host() {
        assert!(ssh_base_args(&None, "   ", None).is_err());
    }

    #[test]
    fn base_args_rejects_empty_user_when_provided() {
        assert!(ssh_base_args(&Some("  ".to_string()), "host", None).is_err());
    }

    #[test]
    fn validate_arg_rejects_dash_and_control_allows_normal_path() {
        assert!(validate_arg("path", "/home/user/projects").is_ok());
        assert!(validate_arg("path", "-rf").is_err());
        assert!(validate_arg("path", "a\nb").is_err());
    }
}
