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
use crate::services::sftp;
use crate::services::ssh_mount::{self, ssh_base_args, ssh_password_base_args, sshpass_available};

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

/// Platform-tailored instructions for installing `sshfs`, so the missing-tool
/// warning can offer the exact command to run plus a downloads page to open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SshfsInstallGuide {
    /// Host OS: `"linux"`, `"macos"`, `"windows"`, or `"other"`.
    pub os: String,
    /// One-line human instruction shown above the commands.
    pub instruction: String,
    /// Shell command(s) the user can run to install sshfs. May be empty where
    /// install is driver-based (e.g. Windows) and the download page is the path.
    pub commands: Vec<String>,
    /// Web page with full instructions / downloads to open in the browser.
    pub url: String,
}

/// Build the install guide for the host platform. On Linux the package-manager
/// command is chosen by which manager is on `PATH` so the suggestion matches the
/// user's distro; falls back to a generic note when none is recognised.
#[tauri::command]
pub fn sshfs_install_guide() -> SshfsInstallGuide {
    #[cfg(target_os = "windows")]
    {
        SshfsInstallGuide {
            os: "windows".to_string(),
            instruction: "Install WinFsp and SSHFS-Win (then restart Eldrun):".to_string(),
            commands: vec![
                "winget install -e --id WinFsp.WinFsp".to_string(),
                "winget install -e --id SSHFS-Win.SSHFS-Win".to_string(),
            ],
            url: "https://github.com/winfsp/sshfs-win/releases".to_string(),
        }
    }
    #[cfg(target_os = "macos")]
    {
        SshfsInstallGuide {
            os: "macos".to_string(),
            instruction: "Install macFUSE and sshfs via Homebrew:".to_string(),
            commands: vec![
                "brew install --cask macfuse".to_string(),
                "brew install gromgit/fuse/sshfs-mac".to_string(),
            ],
            url: "https://osxfuse.github.io/".to_string(),
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let on_path = crate::paths::binary_on_path;
        let cmd = if on_path("apt-get") || on_path("apt") {
            Some("sudo apt install sshfs")
        } else if on_path("dnf") {
            Some("sudo dnf install fuse-sshfs")
        } else if on_path("pacman") {
            Some("sudo pacman -S sshfs")
        } else if on_path("zypper") {
            Some("sudo zypper install sshfs")
        } else if on_path("apk") {
            Some("sudo apk add sshfs")
        } else {
            None
        };
        SshfsInstallGuide {
            os: "linux".to_string(),
            instruction: match cmd {
                Some(_) => "Install sshfs/FUSE with your package manager:".to_string(),
                None => "Install the sshfs/FUSE package for your distribution:".to_string(),
            },
            commands: cmd.map(|c| vec![c.to_string()]).unwrap_or_default(),
            url: "https://github.com/libfuse/sshfs#installation".to_string(),
        }
    }
}

/// Open a web URL in the user's default browser. Used to surface install/download
/// pages (e.g. sshfs); refuses anything that is not an `http(s)` URL so it cannot
/// be turned into a launcher for arbitrary local files or schemes.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("refusing to open a non-web URL".to_string());
    }
    opener::open(&url).map_err(|e| format!("failed to open {url}: {e}"))
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

/// Build the shell command that opens an **interactive** ssh login to
/// `[user@]host[:port]`, sharing the multiplexing master the mount/check paths
/// reuse. Returned for the frontend to type into a root-scope shell tab when
/// headless connections are off, so the password is entered in the visible
/// terminal and never handled by Eldrun (see `ssh_exec::interactive_login_command`).
#[tauri::command]
pub fn remote_login_command(
    user: Option<String>,
    host: String,
    port: Option<u16>,
) -> Result<String, String> {
    crate::services::ssh_exec::interactive_login_command(&user, &host, port)
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

/// Return the remote default (home) directory as the browser's start location.
/// Resolved over SFTP (REALPATH of `.`), so no remote shell runs.
#[tauri::command]
pub async fn ssh_default_dir(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    password: Option<String>,
) -> Result<String, String> {
    sftp::default_dir(&user, &host, port, password.as_deref()).await
}

/// List one remote directory over SFTP. Empty `path` lists the remote home
/// directory. Because SFTP is a binary protocol, a directory name containing
/// `;`/`$()`/spaces is just a listing entry — it is never re-interpreted by a
/// remote shell (the injection surface the old `ssh ls` path had to guard).
#[tauri::command]
pub async fn ssh_list_dir(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    password: Option<String>,
    path: String,
) -> Result<Vec<RemoteEntry>, String> {
    let entries = sftp::list_dir(&user, &host, port, password.as_deref(), &path).await?;
    Ok(entries
        .into_iter()
        .map(|e| RemoteEntry {
            name: e.name,
            is_dir: e.is_dir,
        })
        .collect())
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

    // NOTE: the old `ls`-text browse path (`parse_ls_output`) and its
    // `shell_quote` remote-path injection defense were removed when browsing
    // moved to native SFTP (TODO #80). The dirs-first/ci sort + dot-filter and
    // the injection-is-inert property now live in `services::sftp` tests
    // (`finalize_entries`, `finalize_injection_named_dir_is_one_inert_entry`),
    // since SFTP paths are protocol fields and never reach a remote shell.

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
        assert!(ssh_mount::validate_arg("path", "/home/user/projects").is_ok());
        assert!(ssh_mount::validate_arg("path", "-rf").is_err());
        assert!(ssh_mount::validate_arg("path", "a\nb").is_err());
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
