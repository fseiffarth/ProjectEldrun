//! sshfs mount lifecycle for remote (SSH) projects.
//!
//! A remote project's bytes live on `host:remote_path`; on activation we
//! `sshfs`-mount that remote directory to a local mountpoint under
//! `~/.local/share/eldrun/mounts/<project-id>/`. The project's `directory`
//! field then points at the mountpoint so all existing local code (file tree,
//! PTY cwd, git) keeps working unchanged.
//!
//! As in `commands/ssh.rs`, every argument is passed to the child process as a
//! separate argv item (never a shell string), and values that could be mistaken
//! for an option (a leading `-`) or that contain control characters are
//! rejected. The validation/argv helpers here are the single source of truth;
//! `commands::ssh` re-uses `validate_arg`/`ssh_base_args` from this module.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::schema::project::RemoteSpec;
use crate::storage;

/// Reject values that contain control characters (incl. NUL/newline) or that
/// begin with `-` (which `ssh`/`sshfs`/`ls` would treat as an option). Empty
/// values are allowed here; callers decide whether emptiness is acceptable.
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
    ];

    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }

    args.push(ssh_target(user, host)?);

    Ok(args)
}

/// Render the `[user@]host` SSH target as a single, validated argv item.
pub fn ssh_target(user: &Option<String>, host: &str) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("host must not be empty".to_string());
    }
    validate_arg("host", host)?;
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

/// Local mountpoint for a remote project:
/// `<state_dir>/mounts/<project-id>` (e.g.
/// `~/.local/share/eldrun/mounts/<project-id>`).
pub fn mountpoint_for(project_id: &str) -> PathBuf {
    storage::state_dir().join("mounts").join(project_id)
}

/// Root directory that holds every project's mountpoint.
pub fn mounts_root() -> PathBuf {
    storage::state_dir().join("mounts")
}

/// True if `sshfs` is available on `PATH`.
pub fn sshfs_available() -> bool {
    which_exists("sshfs")
}

/// True if `sshpass` is available on `PATH`. Required for password auth, which
/// otherwise cannot run non-interactively (ssh reads the passphrase from the
/// controlling TTY, which we do not have).
pub fn sshpass_available() -> bool {
    which_exists("sshpass")
}

fn which_exists(bin: &str) -> bool {
    Command::new("which")
        .arg(bin)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// True if `path` is currently a mountpoint. Reads `/proc/mounts` (Linux) and
/// falls back to `mountpoint -q` where that file is unavailable.
pub fn is_mounted(path: &Path) -> bool {
    let target = path.to_string_lossy();
    if let Ok(contents) = std::fs::read_to_string("/proc/mounts") {
        for line in contents.lines() {
            // fields: <src> <mountpoint> <fstype> <opts> ...
            if let Some(mp) = line.split_whitespace().nth(1) {
                // /proc/mounts escapes spaces as \040; a plain compare is enough
                // for our mount paths (project ids never contain spaces).
                if mp == target {
                    return true;
                }
            }
        }
        return false;
    }
    Command::new("mountpoint")
        .arg("-q")
        .arg(path)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The `sshfs` options we always pass (after `-o`): non-interactive auth plus
/// resilient reconnect/keepalive so a flaky link recovers instead of wedging.
const SSHFS_OPTS: &str = "BatchMode=yes,reconnect,ServerAliveInterval=15,ServerAliveCountMax=3";

/// Build the full `sshfs` argv for mounting `remote` at `mountpoint`.
/// Returned as `Vec<String>` so it is unit-testable without actually mounting.
///
/// Shape: `sshfs [user@]host:remote_path <mountpoint> [-p <port>] -o <opts>`.
pub fn sshfs_args(remote: &RemoteSpec, mountpoint: &Path) -> Result<Vec<String>, String> {
    let remote_path = remote.remote_path.trim();
    if remote_path.is_empty() {
        return Err("remote path must not be empty".to_string());
    }
    validate_arg("remote path", remote_path)?;

    let target = ssh_target(&remote.user, &remote.host)?;
    // `[user@]host:remote_path` is a single argv item for sshfs.
    let source = format!("{target}:{remote_path}");

    let mut args: Vec<String> = vec![source, mountpoint.to_string_lossy().into_owned()];
    if let Some(port) = remote.port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push("-o".to_string());
    args.push(SSHFS_OPTS.to_string());
    Ok(args)
}

/// Ensure `remote` is mounted at its project mountpoint, returning the
/// mountpoint. No-op if already mounted. Creates the mountpoint directory.
pub fn mount(remote: &RemoteSpec, project_id: &str) -> Result<PathBuf, String> {
    let mountpoint = mountpoint_for(project_id);

    std::fs::create_dir_all(&mountpoint)
        .map_err(|e| format!("failed to create mountpoint {}: {e}", mountpoint.display()))?;

    if is_mounted(&mountpoint) {
        return Ok(mountpoint);
    }

    if !sshfs_available() {
        return Err(
            "sshfs not found — install sshfs/FUSE to use remote projects".to_string(),
        );
    }

    let args = sshfs_args(remote, &mountpoint)?;
    let output = Command::new("sshfs")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run sshfs: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            "sshfs mount failed".to_string()
        } else {
            stderr
        };
        return Err(msg);
    }

    Ok(mountpoint)
}

/// Unmount `path` if it is mounted. Tries `fusermount -u`, then falls back to
/// `umount`. A "not mounted" path is treated as success (idempotent).
pub fn unmount(path: &Path) -> Result<(), String> {
    if !is_mounted(path) {
        return Ok(());
    }

    // Preferred: fusermount -u (FUSE unmount, no root needed).
    let fuser = Command::new("fusermount").arg("-u").arg(path).output();
    if let Ok(out) = &fuser {
        if out.status.success() {
            return Ok(());
        }
    }

    // Fallback: umount.
    let umount = Command::new("umount").arg(path).output();
    match umount {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => {
            // If it became unmounted in the meantime, succeed.
            if !is_mounted(path) {
                return Ok(());
            }
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let fuser_err = fuser
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stderr).trim().to_string())
                .unwrap_or_default();
            Err(format!(
                "failed to unmount {}: {}",
                path.display(),
                if stderr.is_empty() { fuser_err } else { stderr }
            ))
        }
        Err(e) => {
            if !is_mounted(path) {
                return Ok(());
            }
            Err(format!("failed to run umount on {}: {e}", path.display()))
        }
    }
}

// NOTE (project-removal unmount): there is no project-delete command today, so
// a remote project's mount is only torn down at app exit (`unmount_all`). When a
// delete command is added it should call `unmount(&mountpoint_for(id))` and
// remove the now-empty mountpoint dir. Until then, a removed-from-the-list
// remote project's stale mount is cleaned up on the next app exit. Stale mounts
// after a hard crash are benign: `mount()` is idempotent (no-op if already
// mounted), so re-launch reuses the existing mount.

/// Best-effort unmount of every eldrun mount under `mounts/`. Used at app exit.
/// Errors are logged, not propagated, so cleanup never blocks shutdown.
pub fn unmount_all() {
    let root = mounts_root();
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return, // no mounts dir → nothing to do
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && is_mounted(&path) {
            if let Err(e) = unmount(&path) {
                eprintln!("ssh_mount: unmount {} failed: {e}", path.display());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn spec(
        user: Option<&str>,
        host: &str,
        port: Option<u16>,
        remote_path: &str,
    ) -> RemoteSpec {
        RemoteSpec {
            user: user.map(str::to_string),
            host: host.to_string(),
            port,
            remote_path: remote_path.to_string(),
            openvpn: None,
            extra: HashMap::new(),
        }
    }

    // ── mountpoint_for ─────────────────────────────────────────────────────

    #[test]
    fn mountpoint_for_is_under_mounts_subdir_named_by_id() {
        let mp = mountpoint_for("abc-123");
        assert_eq!(mp.file_name().unwrap(), "abc-123");
        let parent = mp.parent().unwrap();
        assert_eq!(parent.file_name().unwrap(), "mounts");
        // grandparent is the eldrun state dir.
        let grandparent = parent.parent().unwrap();
        assert_eq!(grandparent.file_name().unwrap(), "eldrun");
        assert_eq!(mp, storage::state_dir().join("mounts").join("abc-123"));
    }

    #[test]
    fn mounts_root_is_state_dir_mounts() {
        assert_eq!(mounts_root(), storage::state_dir().join("mounts"));
    }

    // ── sshfs_args ─────────────────────────────────────────────────────────

    #[test]
    fn sshfs_args_basic_shape_user_host_path() {
        let s = spec(Some("alice"), "host.example", None, "/srv/project");
        let mp = PathBuf::from("/tmp/mnt/p1");
        let args = sshfs_args(&s, &mp).unwrap();

        // First item: [user@]host:remote_path as one argv.
        assert_eq!(args[0], "alice@host.example:/srv/project");
        // Second item: the mountpoint.
        assert_eq!(args[1], "/tmp/mnt/p1");
        // -o opts present with all required flags.
        let o = args.iter().position(|a| a == "-o").expect("-o present");
        let opts = &args[o + 1];
        assert!(opts.contains("BatchMode=yes"));
        assert!(opts.contains("reconnect"));
        assert!(opts.contains("ServerAliveInterval=15"));
        assert!(opts.contains("ServerAliveCountMax=3"));
        // No port flag when port is None.
        assert!(!args.iter().any(|a| a == "-p"));
    }

    #[test]
    fn sshfs_args_no_user_uses_bare_host() {
        let s = spec(None, "host.example", None, "/data");
        let args = sshfs_args(&s, Path::new("/tmp/m")).unwrap();
        assert_eq!(args[0], "host.example:/data");
    }

    #[test]
    fn sshfs_args_includes_port_flag() {
        let s = spec(Some("u"), "h", Some(2222), "/p");
        let args = sshfs_args(&s, Path::new("/tmp/m")).unwrap();
        let pos = args.iter().position(|a| a == "-p").expect("-p present");
        assert_eq!(args[pos + 1], "2222");
    }

    #[test]
    fn sshfs_args_rejects_leading_dash_remote_path() {
        let s = spec(None, "h", None, "-oProxyCommand=evil");
        assert!(sshfs_args(&s, Path::new("/tmp/m")).is_err());
    }

    #[test]
    fn sshfs_args_rejects_control_chars_in_path() {
        let s = spec(None, "h", None, "/a\nb");
        assert!(sshfs_args(&s, Path::new("/tmp/m")).is_err());
    }

    #[test]
    fn sshfs_args_rejects_empty_remote_path() {
        let s = spec(None, "h", None, "   ");
        assert!(sshfs_args(&s, Path::new("/tmp/m")).is_err());
    }

    #[test]
    fn sshfs_args_rejects_bad_host_and_user() {
        assert!(sshfs_args(&spec(None, "-evil", None, "/p"), Path::new("/tmp/m")).is_err());
        assert!(sshfs_args(&spec(Some("-evil"), "h", None, "/p"), Path::new("/tmp/m")).is_err());
        assert!(sshfs_args(&spec(Some("  "), "h", None, "/p"), Path::new("/tmp/m")).is_err());
        assert!(sshfs_args(&spec(None, "   ", None, "/p"), Path::new("/tmp/m")).is_err());
    }

    // ── ssh_base_args / validate_arg (shared helpers) ──────────────────────

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

    #[test]
    fn validate_arg_rejects_dash_and_control() {
        assert!(validate_arg("path", "/home/user").is_ok());
        assert!(validate_arg("path", "-rf").is_err());
        assert!(validate_arg("path", "a\nb").is_err());
        assert!(validate_arg("path", "a\0b").is_err());
    }
}
