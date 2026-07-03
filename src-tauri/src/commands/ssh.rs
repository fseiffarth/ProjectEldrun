//! SSH commands for remote projects.
//!
//! These shell out to the system `ssh` binary in `BatchMode` so the user's
//! existing key/agent/`~/.ssh/config` setup is the source of truth. We never
//! build a shell string from user input: `host`, `user`, `path` and `port` are
//! passed as separate argv items, and we reject values that could be mistaken
//! for `ssh`/`ls` options (a leading `-`) or that contain control characters.

use std::process::Command;

use serde::Serialize;

// The validation + base-argv helpers live in `services::ssh_common` so every
// remote path shares a single validated implementation.
use crate::services::sftp;
use crate::services::ssh_common::{ssh_base_args, ssh_password_base_args};

/// One entry in a remote directory listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Availability of the external binaries remote projects rely on, so the UI can
/// warn the moment the "Remote (SSH) project" checkbox is enabled instead of
/// only surfacing a failure after the user tries to connect. Remote projects are
/// SSH/SFTP-native (no FUSE mount), so only `sshpass`/`openvpn` are relevant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SshTooling {
    /// Whether non-interactive password auth works without the user installing
    /// anything. Always true on Unix (OpenSSH's own `SSH_ASKPASS` carries it);
    /// on Windows it still depends on `sshpass` being present.
    pub password_auth: bool,
    /// `openvpn` + `pkexec` — required only for VPN-gated hosts.
    pub openvpn: bool,
    /// `rsync` on the LOCAL machine — enables the SSH-sync bulk fast-path (the
    /// SFTP-native floor is always used when it (or the host's rsync) is missing).
    pub rsync: bool,
}

/// Report which remote-project tools are present on `PATH`. Called when the
/// remote checkbox is toggled on so missing tools can be flagged up front.
#[tauri::command]
pub fn ssh_tooling_status() -> SshTooling {
    SshTooling {
        password_auth: crate::services::ssh_common::password_auth_available(),
        openvpn: crate::services::openvpn::openvpn_available(),
        rsync: crate::services::remote_sync::rsync_available_local(),
    }
}

/// Most-recently-used SSH addresses to keep. Old entries past this fall off.
const SSH_ADDRESS_CAP: usize = 20;

/// File backing the recently-used SSH address list (a plain `Vec<String>`).
fn ssh_addresses_path() -> std::path::PathBuf {
    crate::storage::state_dir().join("ssh_addresses.json")
}

/// Merge `addr` into `existing` as a most-recently-used list: drop any prior
/// case-insensitive duplicate, prepend the new value, and cap the length. Pure
/// so the dedupe/cap policy is unit-tested without touching disk.
fn merge_recent_address(existing: Vec<String>, addr: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(existing.len() + 1);
    out.push(addr.to_string());
    for e in existing {
        if !e.eq_ignore_ascii_case(addr) {
            out.push(e);
        }
    }
    out.truncate(SSH_ADDRESS_CAP);
    out
}

/// Previously-used SSH addresses (most-recent first) so the project dialog can
/// offer them for reuse instead of retyping. Best-effort: a missing or corrupt
/// store yields an empty list.
#[tauri::command]
pub fn ssh_list_addresses() -> Vec<String> {
    crate::storage::read_json(&ssh_addresses_path()).unwrap_or_default()
}

/// Remember `address` as the most-recently-used SSH address. Trims and validates
/// it (rejecting blanks, option-looking values, and control chars) so we never
/// persist something the connect path couldn't use, then moves it to the front
/// of the recents list.
#[tauri::command]
pub fn ssh_remember_address(address: String) -> Result<(), String> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return Err("empty SSH address".to_string());
    }
    crate::services::ssh_common::validate_arg("SSH address", trimmed)?;
    let existing: Vec<String> = crate::storage::read_json(&ssh_addresses_path()).unwrap_or_default();
    let merged = merge_recent_address(existing, trimmed);
    crate::storage::write_json(&ssh_addresses_path(), &merged).map_err(|e| e.to_string())
}

/// Most-recently-used remote paths to keep, per host. Old entries past this
/// fall off.
const REMOTE_PATH_CAP: usize = 20;

/// File backing the recently-used remote-path lists, keyed by host
/// (case-insensitive) so a path picked on one host isn't suggested for another.
fn remote_paths_path() -> std::path::PathBuf {
    crate::storage::state_dir().join("remote_paths.json")
}

/// Merge `path` into `existing` as a most-recently-used list: drop any prior
/// exact-match duplicate (paths are case-sensitive, unlike hostnames), prepend
/// the new value, and cap the length. Pure so the dedupe/cap policy is
/// unit-tested without touching disk.
fn merge_recent_path(existing: Vec<String>, path: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(existing.len() + 1);
    out.push(path.to_string());
    for e in existing {
        if e != path {
            out.push(e);
        }
    }
    out.truncate(REMOTE_PATH_CAP);
    out
}

/// Previously-used remote paths for `host` (most-recent first), so the project
/// dialog can offer them for reuse instead of re-browsing. Best-effort: a
/// missing or corrupt store, or a host with no history, yields an empty list.
#[tauri::command]
pub fn remote_list_paths(host: String) -> Vec<String> {
    let store: std::collections::HashMap<String, Vec<String>> =
        crate::storage::read_json(&remote_paths_path()).unwrap_or_default();
    store.get(&host.to_lowercase()).cloned().unwrap_or_default()
}

/// Remember `path` as the most-recently-used remote path for `host`. Trims and
/// validates it (rejecting blanks, option-looking values, and control chars) so
/// we never persist something the browse/connect path couldn't use, then moves
/// it to the front of that host's recents list.
#[tauri::command]
pub fn remote_remember_path(host: String, path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty remote path".to_string());
    }
    crate::services::ssh_common::validate_arg("remote path", trimmed)?;
    let key = host.to_lowercase();
    let mut store: std::collections::HashMap<String, Vec<String>> =
        crate::storage::read_json(&remote_paths_path()).unwrap_or_default();
    let existing = store.remove(&key).unwrap_or_default();
    store.insert(key, merge_recent_path(existing, trimmed));
    crate::storage::write_json(&remote_paths_path(), &store).map_err(|e| e.to_string())
}

/// Open a web URL in the user's default browser. Refuses anything that is not an
/// `http(s)` URL so it cannot be turned into a launcher for arbitrary local files
/// or schemes.
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
///   - password present → password-only auth. On Unix the password is fed through
///     OpenSSH's own `SSH_ASKPASS` shim (`services::ssh_common::make_askpass`), so
///     no external binary is needed; on Windows we still shell out to `sshpass -e`.
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
            let base = ssh_password_base_args(user, host, port)?;
            #[cfg(unix)]
            {
                // Feed the password via OpenSSH's SSH_ASKPASS (no `sshpass`). The
                // shim guard must outlive the ssh run, so it stays in scope until
                // `capture` returns.
                let mut cmd = crate::paths::command_no_window("ssh");
                cmd.args(&base);
                cmd.args(remote);
                let askpass = crate::services::ssh_common::make_askpass(pw)?;
                for (k, v) in askpass.env_vars() {
                    cmd.env(k, v);
                }
                capture(cmd, "ssh")
            }
            #[cfg(not(unix))]
            {
                if !crate::services::ssh_common::sshpass_available() {
                    return Err(
                        "sshpass not found — install sshpass to use password auth, or set up SSH keys"
                            .to_string(),
                    );
                }
                // `command_no_window` keeps the ssh/sshpass probe from flashing a
                // console window on Windows.
                let mut cmd = crate::paths::command_no_window("sshpass");
                cmd.arg("-e"); // read the password from the SSHPASS env var
                cmd.env("SSHPASS", pw);
                cmd.arg("ssh");
                cmd.args(&base);
                cmd.args(remote);
                capture(cmd, "sshpass")
            }
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
/// non-empty `password`, authenticates by feeding it to ssh (via `SSH_ASKPASS` on
/// Unix, `sshpass` on Windows); otherwise uses key/agent auth. Returns the trimmed
/// ssh stderr as the error on failure.
///
/// Async + `spawn_blocking`: the ssh probe spawns a subprocess that can block for
/// up to `ConnectTimeout=10s` (BatchMode key/agent auth against an unreachable or
/// not-yet-tunnelled host, or while a password login's master comes up). As a
/// *synchronous* Tauri command this ran on the main/UI thread and froze the whole
/// window — most visibly during reconnect, where `pollSshReady` polls it every
/// few seconds against a still-authenticating master. Running it on a blocking
/// worker keeps the UI responsive (e.g. the SSH-login button stays clickable while
/// the OpenVPN tunnel is coming up).
///
/// `remember` opts into saving the working password in the OS keychain (keyed by
/// the host target) for no-prompt reconnects; it is written **only after auth
/// succeeds**. A `None`/empty `password` first falls back to any saved credential
/// (silent reconnect) before dropping to key/agent auth. Unticking (`remember =
/// false`) clears any previously-saved password.
#[tauri::command]
pub async fn ssh_connect(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    password: Option<String>,
    remember: Option<bool>,
) -> Result<(), String> {
    let remember = remember.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        use crate::services::remote_credentials as creds;
        let account = creds::ssh_account(&user, &host, port);
        // A typed password wins; otherwise fall back to a saved one so an
        // activation-time reconnect authenticates without a prompt.
        let effective = password
            .filter(|p| !p.is_empty())
            .or_else(|| creds::get(&account));
        run_ssh_auth(&user, &host, port, effective.as_deref(), &["true"])?;
        // Auth succeeded — persist (opt-in) or clear per the checkbox. Best-effort:
        // a keychain write failure must not fail an already-successful connect.
        let to_store = if remember { effective.as_deref() } else { None };
        let _ = creds::set(&account, to_store);
        Ok(())
    })
    .await
    .map_err(|e| format!("ssh probe task failed: {e}"))?
}

/// Whether a saved SSH password exists for this host target, so the UI can
/// pre-check the "Save password" box and show "saved" without ever receiving the
/// secret itself.
#[tauri::command]
pub fn remote_has_saved_password(user: Option<String>, host: String, port: Option<u16>) -> bool {
    let account = crate::services::remote_credentials::ssh_account(&user, &host, port);
    crate::services::remote_credentials::has(&account)
}

/// Forget any saved SSH password for this host target (explicit "clear" action).
#[tauri::command]
pub fn remote_forget_password(
    user: Option<String>,
    host: String,
    port: Option<u16>,
) -> Result<(), String> {
    let account = crate::services::remote_credentials::ssh_account(&user, &host, port);
    crate::services::remote_credentials::set(&account, None)
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

/// Create a remote directory (mkdir -p) over SFTP. Like `ssh_list_dir`, `path`
/// is a binary SFTP field, never re-interpreted by a remote shell — so a folder
/// name with shell metacharacters is created verbatim, not executed. Used by the
/// new/import dialog's remote browser to add a target folder while browsing.
#[tauri::command]
pub async fn ssh_mkdir(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    password: Option<String>,
    path: String,
) -> Result<(), String> {
    sftp::mkdir(&user, &host, port, password.as_deref(), &path).await
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
        assert!(crate::services::ssh_common::validate_arg("path", "/home/user/projects").is_ok());
        assert!(crate::services::ssh_common::validate_arg("path", "-rf").is_err());
        assert!(crate::services::ssh_common::validate_arg("path", "a\nb").is_err());
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

    // ── merge_recent_address (recently-used SSH addresses) ─────────────────

    #[test]
    fn merge_recent_prepends_new_address() {
        let out = merge_recent_address(vec!["a@h".to_string(), "b@h".to_string()], "c@h");
        assert_eq!(out, vec!["c@h", "a@h", "b@h"]);
    }

    #[test]
    fn merge_recent_moves_existing_to_front_without_duplicating() {
        let out = merge_recent_address(vec!["a@h".to_string(), "b@h".to_string()], "b@h");
        assert_eq!(out, vec!["b@h", "a@h"]);
    }

    #[test]
    fn merge_recent_dedup_is_case_insensitive() {
        let out = merge_recent_address(vec!["User@Host".to_string()], "user@host");
        assert_eq!(out, vec!["user@host"]);
    }

    #[test]
    fn merge_recent_caps_length_keeping_newest() {
        let existing: Vec<String> = (0..SSH_ADDRESS_CAP).map(|i| format!("h{i}")).collect();
        let out = merge_recent_address(existing, "newest");
        assert_eq!(out.len(), SSH_ADDRESS_CAP);
        assert_eq!(out[0], "newest");
        // The oldest entry ("h19") is dropped to make room.
        assert!(!out.iter().any(|a| a == &format!("h{}", SSH_ADDRESS_CAP - 1)));
    }

    // ── merge_recent_path (recently-used remote paths, per host) ───────────

    #[test]
    fn merge_recent_path_prepends_new_path() {
        let out = merge_recent_path(vec!["/a".to_string(), "/b".to_string()], "/c");
        assert_eq!(out, vec!["/c", "/a", "/b"]);
    }

    #[test]
    fn merge_recent_path_moves_existing_to_front_without_duplicating() {
        let out = merge_recent_path(vec!["/a".to_string(), "/b".to_string()], "/b");
        assert_eq!(out, vec!["/b", "/a"]);
    }

    #[test]
    fn merge_recent_path_dedup_is_case_sensitive() {
        // Unlike hostnames, remote filesystem paths are case-sensitive — "/Foo"
        // and "/foo" are different directories on Linux, so both must survive.
        let out = merge_recent_path(vec!["/Foo".to_string()], "/foo");
        assert_eq!(out, vec!["/foo", "/Foo"]);
    }

    #[test]
    fn merge_recent_path_caps_length_keeping_newest() {
        let existing: Vec<String> = (0..REMOTE_PATH_CAP).map(|i| format!("/p{i}")).collect();
        let out = merge_recent_path(existing, "/newest");
        assert_eq!(out.len(), REMOTE_PATH_CAP);
        assert_eq!(out[0], "/newest");
        assert!(!out.iter().any(|a| a == &format!("/p{}", REMOTE_PATH_CAP - 1)));
    }
}
