//! Shared SSH argv + validation helpers for remote (SSH) projects.
//!
//! These are the single source of truth for building validated `ssh` argv and
//! the `[user@]host` target used by every remote path: the SFTP sessions
//! (`services::sftp`), the pooled connection (`services::remote`), remote agent
//! tabs and git-over-ssh (`services::ssh_exec`, `commands::git`), the reachability
//! probe (`commands::ssh`), and `commands::git_publish`.
//!
//! Every argument is passed to the child process as a separate argv item (never a
//! shell string), and values that could be mistaken for an option (a leading `-`)
//! or that contain control characters are rejected. The one unavoidable remote
//! shell string (the trailing command ssh hands to the remote `$SHELL -c`) is
//! single-quoted by its caller; see `ssh_exec::shell_quote`.
//!
//! This module was extracted from the former `services::ssh_mount` when the
//! sshfs/FUSE mount was removed (mount-free remote model, see
//! `docs/mountfree_remote_plan.md`): remote projects are SSH/SFTP-native and no
//! longer mount a local FUSE filesystem, but the SSH validation/argv helpers the
//! mount once shared are still needed by every remote path.

/// Reject values that contain control characters (incl. NUL/newline) or that
/// begin with `-` (which `ssh`/`ls` would treat as an option). Empty values are
/// allowed here; callers decide whether emptiness is acceptable.
pub fn validate_arg(label: &str, value: &str) -> Result<(), String> {
    if value.starts_with('-') {
        return Err(format!("{label} must not start with '-'"));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(format!("{label} contains invalid control characters"));
    }
    Ok(())
}

/// Build the base `ssh` argv (everything up to but not including the remote
/// command), validating `host`/`user` and rendering the `[user@]host` target as
/// a single argv item.
pub fn ssh_base_args(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Result<Vec<String>, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("host must not be empty".to_string());
    }
    validate_arg("host", host)?;

    let mut args: Vec<String> = vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        // TOFU: auto-accept a first-contact host key (so a fresh connection does
        // not fail with no way to answer the yes/no prompt — BatchMode can't, and
        // the password path answers via SSH_ASKPASS which would feed the password),
        // but still REFUSE a key that has *changed* (the MITM case).
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
    ];

    // Reuse (never create) the multiplexing master the pooled connection / an
    // interactive login may have opened (see `ssh_exec::interactive_login_command`
    // and `services::remote`). With `ControlMaster=no` + the shared `cm-%C`
    // socket, an otherwise-`BatchMode=yes` probe/exec rides that authenticated
    // master with no second prompt; if no master exists it simply falls through to
    // normal (key/agent) auth. Unix-only — Windows OpenSSH lacks the control
    // socket (see `ssh_pty_args`).
    #[cfg(not(target_os = "windows"))]
    for opt in control_reuse_opts() {
        args.push(opt);
    }

    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }

    args.push(ssh_target(user, host)?);

    Ok(args)
}

/// `ssh` `-o` options that **reuse** (but never create) the shared multiplexing
/// master socket `ssh_exec` / the pooled connection / the interactive-login
/// command establish. `ControlMaster=no` means "use a master if one is live,
/// otherwise connect directly" — pure opportunistic reuse that never spawns a
/// master of its own.
#[cfg(not(target_os = "windows"))]
fn control_reuse_opts() -> Vec<String> {
    let control_path = crate::services::ssh_exec::control_dir().join("cm-%C");
    vec![
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        format!("ControlPath={}", control_path.to_string_lossy()),
    ]
}

/// Render the `[user@]host` SSH target as a single, validated argv item.
pub fn ssh_target(user: &Option<String>, host: &str) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("host must not be empty".to_string());
    }
    validate_arg("host", host)?;
    // A bare `host` must be only a hostname: `ssh` splits the target on the LAST
    // `@`, so an `@` smuggled into `host` (e.g. "real.host@evil.com") would
    // silently redirect the connection to a different server. Whitespace would
    // likewise split into extra argv-ish tokens. Reject both here, the single
    // choke point every base-args builder funnels the target through.
    if host.contains('@') || host.chars().any(|c| c.is_whitespace()) {
        return Err("host must not contain '@' or whitespace".to_string());
    }
    match user {
        Some(user) => {
            let user = user.trim();
            if user.is_empty() {
                return Err("user must not be empty when provided".to_string());
            }
            validate_arg("user", user)?;
            Ok(format!("{user}@{host}"))
        }
        None => Ok(host.to_string()),
    }
}

/// Build the password-auth ssh argv: BatchMode off and only the password method
/// enabled, so ssh never falls back to (or hangs on) keys/keyboard-interactive.
/// The target `[user@]host` is validated and rendered as a single argv item.
/// Shared by the browse commands (`commands::ssh`) and the SFTP session
/// (`services::sftp`) so both authenticate identically.
pub fn ssh_password_base_args(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = vec![
        "-o".to_string(),
        "BatchMode=no".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        // TOFU first contact, refuse changed keys — see `ssh_base_args`.
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        "PreferredAuthentications=password".to_string(),
        "-o".to_string(),
        "PubkeyAuthentication=no".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=1".to_string(),
    ];

    // Ride an existing master if one is live (key-auth `ssh_base_args` does the
    // same). Without this, a one-shot SFTP/browse for a password-auth host whose
    // pooled session has dropped could not reuse the master and would need the
    // password again — which we never store, so it would simply fail. With
    // `ControlMaster=no` + the shared `cm-%C` socket it transparently rides the
    // still-live master; if none exists it falls through to the password prompt.
    #[cfg(not(target_os = "windows"))]
    for opt in control_reuse_opts() {
        args.push(opt);
    }

    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(ssh_target(user, host)?);
    Ok(args)
}

/// `ssh` `-o` options that **create and persist** the shared multiplexing master
/// (vs [`control_reuse_opts`], which only rides an existing one). Used by the
/// pooled connection (`services::remote`) opened on activation: it owns the master
/// so every later sftp channel / agent tab / git-over-ssh rides it with no
/// re-auth. `%C` is expanded by `ssh`, not the shell, so it is embedded literally.
/// Unix-only — Windows OpenSSH lacks the control socket (see
/// `ssh_exec::ssh_pty_args`).
#[cfg(not(target_os = "windows"))]
fn control_master_opts() -> Vec<String> {
    let control_path = crate::services::ssh_exec::control_dir().join("cm-%C");
    vec![
        "-o".to_string(),
        "ControlMaster=auto".to_string(),
        "-o".to_string(),
        format!("ControlPath={}", control_path.to_string_lossy()),
        "-o".to_string(),
        "ControlPersist=600".to_string(),
    ]
}

/// Base `ssh` argv for a master-**owning** connection authenticated by key/agent
/// (`BatchMode=yes`). Like [`ssh_base_args`] but creates + persists the shared
/// ControlMaster (and adds keepalive for the long-lived pooled session) instead
/// of only reusing an existing master. The validated `[user@]host` target is the
/// final argv item. Drives the pooled SFTP session in `services::remote`.
pub fn ssh_master_base_args(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Result<Vec<String>, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("host must not be empty".to_string());
    }
    validate_arg("host", host)?;

    let mut args: Vec<String> = vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        // TOFU first contact, refuse changed keys — see `ssh_base_args`.
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        "ServerAliveInterval=15".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=3".to_string(),
    ];

    #[cfg(not(target_os = "windows"))]
    for opt in control_master_opts() {
        args.push(opt);
    }

    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(ssh_target(user, host)?);
    Ok(args)
}

/// Password-auth variant of [`ssh_master_base_args`] (BatchMode off, password the
/// only enabled method) for hosts reached with a supplied password (fed to ssh via
/// [`make_askpass`] on Unix / `sshpass` on Windows). Still master-owning so the
/// one-time password authenticates the master once and every later channel rides
/// it with no further prompt.
pub fn ssh_password_master_base_args(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = vec![
        "-o".to_string(),
        "BatchMode=no".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        // TOFU first contact, refuse changed keys — see `ssh_base_args`.
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        "PreferredAuthentications=password".to_string(),
        "-o".to_string(),
        "PubkeyAuthentication=no".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=1".to_string(),
        "-o".to_string(),
        "ServerAliveInterval=15".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=3".to_string(),
    ];

    #[cfg(not(target_os = "windows"))]
    for opt in control_master_opts() {
        args.push(opt);
    }

    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(ssh_target(user, host)?);
    Ok(args)
}

/// True if `sshpass` is available on `PATH`. On Windows this is still how password
/// auth runs; on Unix it is no longer needed (see [`make_askpass`]) and is only
/// reported for diagnostics.
pub fn sshpass_available() -> bool {
    crate::paths::binary_on_path("sshpass")
}

/// Whether non-interactive password auth works on this platform **without the user
/// installing anything**. On Unix it always does — we feed the password through
/// OpenSSH's own `SSH_ASKPASS` mechanism ([`make_askpass`]), no external binary.
/// On Windows we still shell out to `sshpass`, so it depends on that being present.
pub fn password_auth_available() -> bool {
    #[cfg(unix)]
    {
        true
    }
    #[cfg(not(unix))]
    {
        sshpass_available()
    }
}

/// A temporary, owner-only askpass shim that feeds a password to OpenSSH via its
/// built-in `SSH_ASKPASS` mechanism — the in-tree replacement for the external
/// `sshpass` binary on Unix. The shim script holds **no secret**: it prints
/// whatever is in the `ELDRUN_ASKPASS` environment variable, which we set only on
/// the specific `ssh` child (same `/proc/<pid>/environ` exposure `sshpass -e`'s
/// `SSHPASS` had — no worse). Pairing it with `SSH_ASKPASS_REQUIRE=force` makes
/// OpenSSH (>= 8.4) call the shim with no controlling TTY and no `DISPLAY`, which
/// is exactly our situation (a GUI app spawning `ssh` with piped stdio).
///
/// The shim file is deleted when this guard is dropped, so a caller MUST keep the
/// guard alive until the `ssh` child has finished authenticating (i.e. until the
/// SFTP handshake / command completes, not merely until spawn returns).
#[cfg(unix)]
pub struct Askpass {
    path: std::path::PathBuf,
    password: String,
}

#[cfg(unix)]
impl Askpass {
    /// Environment variables to set on the `ssh` (or `ssh -s`) child so OpenSSH
    /// obtains the password from this shim instead of a controlling TTY.
    pub fn env_vars(&self) -> Vec<(&'static str, std::ffi::OsString)> {
        vec![
            (
                "SSH_ASKPASS",
                self.path.clone().into_os_string(),
            ),
            ("SSH_ASKPASS_REQUIRE", std::ffi::OsString::from("force")),
            ("ELDRUN_ASKPASS", std::ffi::OsString::from(&self.password)),
        ]
    }
}

#[cfg(unix)]
impl Drop for Askpass {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Monotonic suffix so concurrent connects never collide on the shim filename
/// (paired with the pid, which separates instances).
#[cfg(unix)]
static ASKPASS_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Write an owner-only (0700) askpass shim for `password` and return a guard that
/// deletes it on drop. The shim reads the password from the `ELDRUN_ASKPASS` env
/// var (set via [`Askpass::env_vars`]), so the secret never lands in the file.
#[cfg(unix)]
pub fn make_askpass(password: &str) -> Result<Askpass, String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use std::sync::atomic::Ordering;

    let dir = crate::storage::state_dir().join("ssh-askpass");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create askpass dir: {e}"))?;
    let seq = ASKPASS_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("ap-{}-{seq}.sh", std::process::id()));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o700)
        .open(&path)
        .map_err(|e| format!("create askpass shim: {e}"))?;
    // The password comes from the environment; the script itself is generic.
    f.write_all(b"#!/bin/sh\nprintf '%s\\n' \"$ELDRUN_ASKPASS\"\n")
        .map_err(|e| format!("write askpass shim: {e}"))?;
    Ok(Askpass {
        path,
        password: password.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_arg_rejects_dash_and_control() {
        assert!(validate_arg("path", "/home/user").is_ok());
        assert!(validate_arg("path", "-rf").is_err());
        assert!(validate_arg("path", "a\nb").is_err());
        assert!(validate_arg("path", "a\0b").is_err());
    }

    #[test]
    fn base_args_renders_user_at_host_single_item_with_batchmode() {
        let args = ssh_base_args(&Some("alice".to_string()), "host.example", None).unwrap();
        assert_eq!(args.last().unwrap(), "alice@host.example");
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
        assert!(args.iter().any(|a| a == "ConnectTimeout=10"));
    }

    #[test]
    fn base_args_includes_port() {
        let args = ssh_base_args(&None, "host", Some(2200)).unwrap();
        let pos = args.iter().position(|a| a == "-p").unwrap();
        assert_eq!(args[pos + 1], "2200");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn ssh_base_args_reuse_master_and_keep_target_last() {
        let args = ssh_base_args(&Some("alice".to_string()), "host.example", None).unwrap();
        assert!(args.iter().any(|a| a == "ControlMaster=no"));
        assert!(args.iter().any(|a| a.starts_with("ControlPath=")));
        // The validated target must remain the final argv item despite the inserted
        // -o options, so ssh still parses it as the destination.
        assert_eq!(args.last().unwrap(), "alice@host.example");
        // BatchMode is still set: with no live master, auth falls back to key/agent.
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
    }

    // ── ssh_master_base_args (pooled-connection, master-owning) ────────────

    #[test]
    fn master_base_args_owns_master_and_keeps_target_last() {
        let args = ssh_master_base_args(&Some("alice".to_string()), "host.example", None).unwrap();
        // Target is still the final argv item despite the inserted -o options.
        assert_eq!(args.last().unwrap(), "alice@host.example");
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
        // Long-lived session keepalive.
        assert!(args.iter().any(|a| a == "ServerAliveInterval=15"));
        // Multiplexing is Unix-only: this variant CREATES (auto) the master, vs
        // ssh_base_args which only reuses (ControlMaster=no).
        #[cfg(not(target_os = "windows"))]
        {
            assert!(args.iter().any(|a| a == "ControlMaster=auto"));
            assert!(args.iter().any(|a| a.starts_with("ControlPath=")));
            assert!(args.iter().any(|a| a.starts_with("ControlPersist=")));
            assert!(args.iter().any(|a| a.contains("cm-%C")));
        }
        #[cfg(target_os = "windows")]
        assert!(!args.iter().any(|a| a == "ControlMaster=auto"));
    }

    #[test]
    fn master_base_args_includes_port_and_rejects_bad_target() {
        let args = ssh_master_base_args(&None, "host", Some(2222)).unwrap();
        let pos = args.iter().position(|a| a == "-p").expect("-p present");
        assert_eq!(args[pos + 1], "2222");
        assert!(ssh_master_base_args(&None, "-evil", None).is_err());
        assert!(ssh_master_base_args(&Some("-evil".to_string()), "host", None).is_err());
    }

    #[test]
    fn password_base_args_disable_batchmode_and_pin_password_auth() {
        let args = ssh_password_base_args(&Some("me".to_string()), "host.example", None).unwrap();
        assert_eq!(args.last().unwrap(), "me@host.example");
        assert!(args.iter().any(|a| a == "BatchMode=no"));
        assert!(args.iter().any(|a| a == "PreferredAuthentications=password"));
        assert!(!args.iter().any(|a| a == "BatchMode=yes"));
    }

    #[test]
    fn password_master_base_args_pin_password_auth_and_own_master() {
        let args =
            ssh_password_master_base_args(&Some("me".to_string()), "host.example", None).unwrap();
        assert_eq!(args.last().unwrap(), "me@host.example");
        assert!(args.iter().any(|a| a == "BatchMode=no"));
        assert!(args.iter().any(|a| a == "PreferredAuthentications=password"));
        assert!(args.iter().any(|a| a == "PubkeyAuthentication=no"));
        // Must never force BatchMode=yes (that would block the password prompt).
        assert!(!args.iter().any(|a| a == "BatchMode=yes"));
        #[cfg(not(target_os = "windows"))]
        assert!(args.iter().any(|a| a == "ControlMaster=auto"));
    }

    #[test]
    fn target_rejects_bad_host_and_user() {
        assert!(ssh_target(&None, "-evil").is_err());
        assert!(ssh_target(&Some("-evil".to_string()), "host").is_err());
        assert!(ssh_target(&Some("  ".to_string()), "host").is_err());
        assert!(ssh_target(&None, "   ").is_err());
        assert_eq!(ssh_target(&None, "host.example").unwrap(), "host.example");
    }

    #[test]
    fn target_rejects_host_with_at_or_whitespace() {
        // `@` would make ssh split the target and redirect to a different host.
        assert!(ssh_target(&None, "real.host@evil.com").is_err());
        assert!(ssh_target(&Some("alice".to_string()), "real.host@evil.com").is_err());
        // Internal whitespace would split into extra tokens.
        assert!(ssh_target(&None, "host name").is_err());
    }

    #[test]
    fn all_base_args_use_tofu_host_key_policy() {
        // accept-new: auto-trust a first-contact key but refuse a changed one.
        // Must be on every builder so key- and password-auth first connects behave
        // identically and never hang on an unanswerable yes/no prompt.
        for args in [
            ssh_base_args(&Some("a".into()), "h", None).unwrap(),
            ssh_password_base_args(&Some("a".into()), "h", None).unwrap(),
            ssh_master_base_args(&Some("a".into()), "h", None).unwrap(),
            ssh_password_master_base_args(&Some("a".into()), "h", None).unwrap(),
        ] {
            assert!(
                args.iter().any(|a| a == "StrictHostKeyChecking=accept-new"),
                "missing accept-new in {args:?}"
            );
            // Never the insecure variants that would accept a *changed* key.
            assert!(!args.iter().any(|a| a == "StrictHostKeyChecking=no"));
            assert!(!args.iter().any(|a| a == "StrictHostKeyChecking=off"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn askpass_shim_is_secret_free_executable_and_self_deleting() {
        use std::os::unix::fs::PermissionsExt;
        let ap = make_askpass("hunter2").unwrap();
        // Locate the shim path via its SSH_ASKPASS env var.
        let env = ap.env_vars();
        let shim = env
            .iter()
            .find(|(k, _)| *k == "SSH_ASKPASS")
            .map(|(_, v)| std::path::PathBuf::from(v))
            .unwrap();
        // The password is passed only via ELDRUN_ASKPASS, never written to disk.
        let body = std::fs::read_to_string(&shim).unwrap();
        assert!(!body.contains("hunter2"), "shim must not embed the secret");
        assert!(body.contains("ELDRUN_ASKPASS"));
        assert!(env
            .iter()
            .any(|(k, v)| *k == "ELDRUN_ASKPASS" && v == "hunter2"));
        assert!(env
            .iter()
            .any(|(k, v)| *k == "SSH_ASKPASS_REQUIRE" && v == "force"));
        // Owner-only, executable.
        let mode = std::fs::metadata(&shim).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        // Dropping the guard removes the shim.
        drop(ap);
        assert!(!shim.exists(), "shim must be deleted on drop");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn password_base_args_reuse_existing_master() {
        // A password-auth one-shot must be able to ride a live master (so a
        // dropped pooled session can recover without the unstored password).
        let args = ssh_password_base_args(&Some("me".to_string()), "host.example", None).unwrap();
        assert!(args.iter().any(|a| a == "ControlMaster=no"));
        assert!(args.iter().any(|a| a.starts_with("ControlPath=")));
        assert_eq!(args.last().unwrap(), "me@host.example");
    }
}
