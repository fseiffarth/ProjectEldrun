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
use crate::services::ssh_mount::{self, ssh_base_args, ssh_target, sshpass_available, validate_arg};

/// One entry in a remote directory listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Availability of the external binaries remote projects rely on, so the UI can
/// warn the moment the "Remote (SSH) project" checkbox is enabled instead of
/// only surfacing a failure after the user tries to connect/mount.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SshTooling {
    /// `sshfs` — required to mount a remote project locally.
    pub sshfs: bool,
    /// `sshpass` — required only for password auth (key/agent auth needs none).
    pub sshpass: bool,
    /// `openvpn` + `pkexec` — required only for VPN-gated hosts.
    pub openvpn: bool,
}

/// Report which remote-project tools are present on `PATH`. Called when the
/// remote checkbox is toggled on so missing tools can be flagged up front.
#[tauri::command]
pub fn ssh_tooling_status() -> SshTooling {
    SshTooling {
        sshfs: ssh_mount::sshfs_available(),
        sshpass: sshpass_available(),
        openvpn: crate::services::openvpn::openvpn_available(),
    }
}

/// Run a built command, returning stdout on success or the trimmed stderr (or a
/// generic message) on failure. `what` names the binary for error messages.
fn capture(mut cmd: Command, what: &str) -> Result<String, String> {
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run {what}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err(format!("{what} command failed"));
        }
        return Err(stderr);
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Build the password-auth ssh argv: BatchMode off and only the password method
/// enabled, so ssh never falls back to (or hangs on) keys/keyboard-interactive.
/// The target `[user@]host` is validated and rendered as a single argv item.
fn ssh_password_base_args(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = vec![
        "-o".to_string(),
        "BatchMode=no".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        "-o".to_string(),
        "PreferredAuthentications=password".to_string(),
        "-o".to_string(),
        "PubkeyAuthentication=no".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=1".to_string(),
    ];
    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(ssh_target(user, host)?);
    Ok(args)
}

/// Run an ssh command against `[user@]host[:port]`, choosing the auth method by
/// whether a non-empty `password` was supplied:
///   - password present → `sshpass -e ssh …` (password read from the `SSHPASS`
///     env var so it never appears in the process's argv), password-only auth;
///   - otherwise → key/agent auth in `BatchMode=yes` (the original v1 flow).
/// Returns ssh stdout on success or the trimmed stderr on failure.
fn run_ssh_auth(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    remote: &[&str],
) -> Result<String, String> {
    match password.filter(|p| !p.is_empty()) {
        Some(pw) => {
            if !sshpass_available() {
                return Err(
                    "sshpass not found — install sshpass to use password auth, or set up SSH keys"
                        .to_string(),
                );
            }
            let base = ssh_password_base_args(user, host, port)?;
            // `command_no_window` keeps the ssh/sshpass probe from flashing a
            // console window on Windows (no-op on Linux/macOS).
            let mut cmd = crate::paths::command_no_window("sshpass");
            cmd.arg("-e"); // read the password from the SSHPASS env var
            cmd.env("SSHPASS", pw);
            cmd.arg("ssh");
            cmd.args(&base);
            cmd.args(remote);
            capture(cmd, "sshpass")
        }
        None => {
            let base = ssh_base_args(user, host, port)?;
            let mut cmd = crate::paths::command_no_window("ssh");
            cmd.args(&base);
            cmd.args(remote);
            capture(cmd, "ssh")
        }
    }
}

/// Single-quote `s` for a POSIX shell, escaping embedded single quotes as
/// `'\''`. The result parses back to exactly `s` regardless of spaces, `;`,
/// `$()`, quotes, or other metacharacters.
///
/// This is required because `ssh` concatenates its trailing argv with spaces and
/// hands the result to the *remote* `$SHELL -c`. Passing the path after `--`
/// only stops `ls`'s own option parsing; it does **not** stop the remote shell
/// from interpreting metacharacters. So each remote path argument must be quoted
/// before it reaches ssh, or a directory named e.g. `foo; rm -rf ~` would run as
/// a command on the remote host.
fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
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

/// Verify the remote host is reachable over SSH (non-interactive). With a
/// non-empty `password`, authenticates via `sshpass`; otherwise uses key/agent
/// auth. Returns the trimmed ssh stderr as the error on failure.
#[tauri::command]
pub fn ssh_connect(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    password: Option<String>,
) -> Result<(), String> {
    run_ssh_auth(&user, &host, port, password.as_deref(), &["true"]).map(|_| ())
}

/// Return the remote `$HOME` (via `pwd`) as the browser's start location.
#[tauri::command]
pub fn ssh_default_dir(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    password: Option<String>,
) -> Result<String, String> {
    let stdout = run_ssh_auth(&user, &host, port, password.as_deref(), &["pwd"])?;
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
    password: Option<String>,
    path: String,
) -> Result<Vec<RemoteEntry>, String> {
    let pw = password.as_deref();
    let path = path.trim();
    let stdout = if path.is_empty() {
        // No path → list the remote home directory.
        run_ssh_auth(&user, &host, port, pw, &["ls", "-1Ap", "--"])?
    } else {
        validate_arg("path", path)?;
        // `ssh` joins its trailing argv with spaces and feeds it to the remote
        // `$SHELL -c`, so the path must be single-quoted for that shell (the
        // `--` only stops `ls`'s own flag parsing). Without this a directory name
        // containing `;`/`$()`/spaces would be re-interpreted on the remote host.
        let quoted = shell_quote(path);
        run_ssh_auth(&user, &host, port, pw, &["ls", "-1Ap", "--", quoted.as_str()])?
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
pub(crate) fn load_project_by_id(project_id: &str) -> Result<Project, String> {
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

    // ── shell_quote (remote path injection defense) ────────────────────────

    #[test]
    fn shell_quote_wraps_plain_and_metachars() {
        assert_eq!(shell_quote("projects"), "'projects'");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("$HOME"), "'$HOME'");
    }

    #[test]
    fn shell_quote_neutralizes_command_injection() {
        // A directory named so as to inject a command must come back fully
        // single-quoted, so the remote shell treats it as one literal argument.
        let evil = "foo; rm -rf ~";
        assert_eq!(shell_quote(evil), "'foo; rm -rf ~'");
        let subst = "$(touch /tmp/pwned)";
        assert_eq!(shell_quote(subst), "'$(touch /tmp/pwned)'");
    }

    #[test]
    fn shell_quote_escapes_embedded_single_quotes() {
        // The classic break-out attempt: close the quote, inject, reopen.
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
        // A name trying to escape its own quoting stays inert.
        assert_eq!(shell_quote("'; rm -rf ~ #"), "''\\''; rm -rf ~ #'");
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

    // ── ssh_password_base_args ─────────────────────────────────────────────

    #[test]
    fn password_args_disable_batchmode_and_pin_password_auth() {
        let args = ssh_password_base_args(&Some("me".to_string()), "host.example", None).unwrap();
        assert_eq!(args.last().unwrap(), "me@host.example");
        assert!(args.iter().any(|a| a == "BatchMode=no"));
        assert!(args.iter().any(|a| a == "PreferredAuthentications=password"));
        assert!(args.iter().any(|a| a == "PubkeyAuthentication=no"));
        // Must never enable BatchMode=yes (that would block the password prompt).
        assert!(!args.iter().any(|a| a == "BatchMode=yes"));
    }

    #[test]
    fn password_args_include_port_and_reject_bad_target() {
        let args = ssh_password_base_args(&None, "host", Some(2222)).unwrap();
        let pos = args.iter().position(|a| a == "-p").expect("-p present");
        assert_eq!(args[pos + 1], "2222");
        assert!(ssh_password_base_args(&None, "-evil", None).is_err());
        assert!(ssh_password_base_args(&Some("-evil".to_string()), "host", None).is_err());
    }
}
