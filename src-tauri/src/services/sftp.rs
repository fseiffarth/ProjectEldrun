//! Native SFTP session for the remote folder browser (TODO #80).
//!
//! This replaces the `ssh … ls -1Ap` shell-out the browse commands used to do.
//! We open the **SFTP subsystem** over a child `ssh -s sftp` process and speak
//! the binary SFTP protocol to it, so:
//!   - directory listings carry real file-type metadata (no `ls -p` trailing-`/`
//!     guessing), and
//!   - remote path components are protocol fields, never concatenated into a
//!     remote `$SHELL -c` string — the command-injection class that
//!     `shell_quote`/`validate_arg` exist to defend against simply cannot occur
//!     here (a directory named `foo; rm -rf ~` is one inert listing entry).
//!
//! Only the *browse* path moves to SFTP. The project **mount** still uses sshfs
//! (a local mountpoint needs a kernel FUSE driver regardless of language) and
//! remote **agent/terminal** tabs still run over `ssh -tt` (see #28b). Auth is
//! shared with those paths: key/agent in `BatchMode=yes`, or `sshpass` reading
//! the password from `SSHPASS` when one is supplied.

use std::process::Stdio;

use futures_util::StreamExt;
use openssh_sftp_client::{Sftp, SftpOptions};
use tokio::process::{Child, Command};

use crate::services::ssh_mount::{
    ssh_base_args, ssh_password_base_args, sshpass_available, validate_arg,
};

/// One entry in a remote directory listing. Structurally identical to the
/// frontend-facing `commands::ssh::RemoteEntry`; kept separate so this service
/// stays free of the command layer (the command maps one to the other).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
}

/// Build the argv for invoking the remote SFTP subsystem. `base` is the validated
/// option+target list (`ssh_base_args`/`ssh_password_base_args`), whose **last**
/// element is the `[user@]host` target. OpenSSH requires options before the
/// destination, so we splice `-s` in front of the target and append the
/// subsystem name `sftp` as the remote command: `ssh <opts> -s <target> sftp`.
fn sftp_subsystem_args(mut base: Vec<String>) -> Result<Vec<String>, String> {
    let target = base
        .pop()
        .ok_or_else(|| "internal: empty ssh base args".to_string())?;
    base.push("-s".to_string());
    base.push(target);
    base.push("sftp".to_string());
    Ok(base)
}

/// Spawn `ssh -s sftp` (optionally via `sshpass`) with piped stdin/stdout and
/// hand the pipes to an `Sftp` client. Returns the live client plus the child so
/// the caller can await its exit after dropping the client (dropping closes
/// stdin, which makes ssh exit).
async fn open_session(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
) -> Result<(Sftp, Child), String> {
    let (mut cmd, _via_sshpass) = match password.filter(|p| !p.is_empty()) {
        Some(pw) => {
            if !sshpass_available() {
                return Err(
                    "sshpass not found — install sshpass to use password auth, or set up SSH keys"
                        .to_string(),
                );
            }
            let args = sftp_subsystem_args(ssh_password_base_args(user, host, port)?)?;
            let mut c = Command::new("sshpass");
            c.arg("-e"); // read the password from $SSHPASS, never argv
            c.env("SSHPASS", pw);
            c.arg("ssh");
            c.args(&args);
            (c, true)
        }
        None => {
            let args = sftp_subsystem_args(ssh_base_args(user, host, port)?)?;
            let mut c = Command::new("ssh");
            c.args(&args);
            (c, false)
        }
    };

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Don't pop a console window for the child ssh on Windows.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch ssh for sftp: {e}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "ssh stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ssh stdout unavailable".to_string())?;

    let sftp = Sftp::new(stdin, stdout, SftpOptions::default())
        .await
        .map_err(|e| format!("sftp connection failed: {e}"))?;
    Ok((sftp, child))
}

/// Wait for the ssh child to exit after the `Sftp` client has been dropped, so we
/// don't leave a zombie. Best-effort — a stuck child is not worth failing on.
async fn reap(mut child: Child) {
    let _ = child.wait().await;
}

/// Resolve the remote default directory (the SFTP server's notion of `.`, i.e.
/// the login/home directory) via REALPATH — no remote `pwd` shell-out.
pub async fn default_dir(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
) -> Result<String, String> {
    let (sftp, child) = open_session(user, host, port, password).await?;
    let mut fs = sftp.fs();
    let result = fs
        .canonicalize(".")
        .await
        .map_err(|e| format!("sftp realpath failed: {e}"))
        .map(|p| p.to_string_lossy().into_owned());
    drop(fs);
    let _ = sftp.close().await;
    reap(child).await;
    let path = result?;
    if path.trim().is_empty() {
        return Err("remote realpath returned no path".to_string());
    }
    Ok(path)
}

/// List one remote directory over SFTP. An empty `path` lists the remote default
/// (home) directory. Entries carry real SFTP file-type metadata.
pub async fn list_dir(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
) -> Result<Vec<Entry>, String> {
    let path = path.trim();
    // Leading-`-`/control-char guard is no longer load-bearing (SFTP paths are
    // protocol fields, not shell tokens) but kept as cheap defense in depth.
    if !path.is_empty() {
        validate_arg("path", path)?;
    }
    let target = if path.is_empty() { "." } else { path };

    let (sftp, child) = open_session(user, host, port, password).await?;
    let mut fs = sftp.fs();
    let listing = read_entries(&mut fs, target).await;
    drop(fs);
    let _ = sftp.close().await;
    reap(child).await;

    Ok(finalize_entries(listing?))
}

/// Directory / symlink / other, as reported by a `readdir` entry's lstat-style
/// `file_type()`. Symlinks need a follow-up stat to learn what they point at.
enum RawKind {
    Dir,
    Symlink,
    Other,
}

/// Build the path to a directory child for a follow-up stat. `target` is the
/// listed directory (`"."` for the SFTP home, otherwise an absolute path); the
/// child is resolved relative to it. Pure, so it is unit-tested.
fn resolve_child_path(target: &str, name: &str) -> String {
    if target == "." || target.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", target.trim_end_matches('/'), name)
    }
}

/// Open `target` and drain its `ReadDir` stream into raw `Entry`s (unsorted,
/// unfiltered). Split out so `list_dir`'s session teardown always runs.
///
/// Two passes: pass 1 drains the listing (the `readdir` `file_type()` is
/// lstat-style, so a symlink reports as a symlink, not its target); pass 2
/// follow-stats each **symlink** so a symlink-to-directory is flagged `is_dir`
/// and is navigable in the picker. Only symlinks cost an extra round-trip; a
/// broken/inaccessible link resolves to non-dir.
async fn read_entries(
    fs: &mut openssh_sftp_client::fs::Fs,
    target: &str,
) -> Result<Vec<Entry>, String> {
    let dir = fs
        .open_dir(target)
        .await
        .map_err(|e| format!("sftp open_dir failed: {e}"))?;
    // `ReadDir` is `!Unpin`; `Pin<Box<_>>` is `Unpin` so `StreamExt::next` applies.
    let mut rd = Box::pin(dir.read_dir());
    let mut raw: Vec<(String, RawKind)> = Vec::new();
    while let Some(item) = rd.next().await {
        let entry = item.map_err(|e| format!("sftp read_dir failed: {e}"))?;
        let name = entry.filename().to_string_lossy().into_owned();
        let kind = match entry.file_type() {
            Some(t) if t.is_dir() => RawKind::Dir,
            Some(t) if t.is_symlink() => RawKind::Symlink,
            _ => RawKind::Other,
        };
        raw.push((name, kind));
    }
    drop(rd); // release the directory handle before the follow-up stats

    let mut out: Vec<Entry> = Vec::with_capacity(raw.len());
    for (name, kind) in raw {
        let is_dir = match kind {
            RawKind::Dir => true,
            RawKind::Other => false,
            // `metadata` follows the link (vs `symlink_metadata`), so this is the
            // *target's* type. Errors (broken/denied link) fall back to non-dir.
            RawKind::Symlink => {
                let child = resolve_child_path(target, &name);
                fs.metadata(&child)
                    .await
                    .ok()
                    .and_then(|m| m.file_type())
                    .map(|t| t.is_dir())
                    .unwrap_or(false)
            }
        };
        out.push(Entry { name, is_dir });
    }
    Ok(out)
}

/// Drop `.`/`..`/blank names, then sort dirs-first and case-insensitively by
/// name — the exact ordering the old `parse_ls_output` produced, so the browser
/// UI is unchanged. Pure, so it is unit-tested without a live host.
pub(crate) fn finalize_entries(entries: Vec<Entry>) -> Vec<Entry> {
    let mut entries: Vec<Entry> = entries
        .into_iter()
        .filter(|e| !e.name.is_empty() && e.name != "." && e.name != "..")
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(name: &str, is_dir: bool) -> Entry {
        Entry {
            name: name.to_string(),
            is_dir,
        }
    }

    #[test]
    fn subsystem_args_splice_dash_s_before_target() {
        // base = [..opts.., target]; result = [..opts.., -s, target, sftp].
        let base = vec![
            "-o".to_string(),
            "BatchMode=yes".to_string(),
            "alice@host.example".to_string(),
        ];
        let args = sftp_subsystem_args(base).unwrap();
        assert_eq!(
            args,
            vec!["-o", "BatchMode=yes", "-s", "alice@host.example", "sftp"]
        );
    }

    #[test]
    fn finalize_sorts_dirs_first_then_name_ci() {
        let raw = vec![
            e("zebra.txt", false),
            e("Apple", true),
            e("banana.txt", false),
            e("Cherry", true),
        ];
        let names: Vec<_> = finalize_entries(raw)
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, vec!["Apple", "Cherry", "banana.txt", "zebra.txt"]);
    }

    #[test]
    fn finalize_filters_dot_and_dotdot_and_blanks() {
        let raw = vec![e(".", true), e("..", true), e("", false), e("real", true)];
        let names: Vec<_> = finalize_entries(raw)
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, vec!["real"]);
    }

    #[test]
    fn finalize_keeps_hidden_entries() {
        let raw = vec![e(".config", true), e(".bashrc", false), e("visible", false)];
        let out = finalize_entries(raw);
        assert!(out.iter().any(|x| x.name == ".config" && x.is_dir));
        assert!(out.iter().any(|x| x.name == ".bashrc" && !x.is_dir));
    }

    #[test]
    fn child_path_joins_against_target_or_home() {
        // "." / empty target → bare name (resolved against the SFTP home).
        assert_eq!(resolve_child_path(".", "link"), "link");
        assert_eq!(resolve_child_path("", "link"), "link");
        // Absolute target → joined, with no doubled slash.
        assert_eq!(resolve_child_path("/home/u", "link"), "/home/u/link");
        assert_eq!(resolve_child_path("/home/u/", "link"), "/home/u/link");
        // Root stays a single leading slash.
        assert_eq!(resolve_child_path("/", "link"), "/link");
    }

    #[test]
    fn finalize_injection_named_dir_is_one_inert_entry() {
        // The whole point: a hostile directory name is just data here.
        let raw = vec![e("foo; rm -rf ~", true), e("$(touch pwned)", false)];
        let out = finalize_entries(raw);
        assert_eq!(out.len(), 2);
        assert!(out.iter().any(|x| x.name == "foo; rm -rf ~" && x.is_dir));
    }
}
