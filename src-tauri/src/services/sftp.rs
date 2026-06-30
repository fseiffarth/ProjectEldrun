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

use crate::services::ssh_common::{
    ssh_base_args, ssh_master_base_args, ssh_password_base_args, ssh_password_master_base_args,
    sshpass_available, validate_arg,
};

/// One entry in a remote directory listing. Structurally identical to the
/// frontend-facing `commands::ssh::RemoteEntry`; kept separate so this service
/// stays free of the command layer (the command maps one to the other).
///
/// `size`/`modified_secs` come from the `readdir`-supplied attributes (no extra
/// round-trip), so the file browser can show the same metadata columns local
/// listings do. They are best-effort: a server that omits an attribute yields
/// `0`/`None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    /// File size in bytes from the listing attrs (`0` when absent or a dir).
    pub size: u64,
    /// Last-modified time as whole seconds since the Unix epoch, when reported.
    pub modified_secs: Option<u64>,
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

/// Open a **master-owning, persistent** SFTP session for the pooled remote
/// connection (Phase 0; `services::remote`). Unlike [`open_session`] — a one-shot
/// per-call session for the project dialog — this rides `ControlMaster=auto`
/// (Unix), so it *creates and persists* the shared multiplexing master that
/// agent tabs, git-over-ssh, and later SFTP channels reuse without
/// re-authenticating. Returns the live client plus the `ssh` child, whose
/// lifetime keeps the master alive; the caller pools both and tears them down on
/// deactivation/exit.
pub async fn open_pooled_session(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
) -> Result<(Sftp, Child), String> {
    // Ensure the control-socket directory exists before ssh binds the master.
    #[cfg(not(target_os = "windows"))]
    let _ = std::fs::create_dir_all(crate::services::ssh_exec::control_dir());

    let mut cmd = match password.filter(|p| !p.is_empty()) {
        Some(pw) => {
            if !sshpass_available() {
                return Err(
                    "sshpass not found — install sshpass to use password auth, or set up SSH keys"
                        .to_string(),
                );
            }
            let args = sftp_subsystem_args(ssh_password_master_base_args(user, host, port)?)?;
            let mut c = Command::new("sshpass");
            c.arg("-e"); // read the password from $SSHPASS, never argv
            c.env("SSHPASS", pw);
            c.arg("ssh");
            c.args(&args);
            c
        }
        None => {
            let args = sftp_subsystem_args(ssh_master_base_args(user, host, port)?)?;
            let mut c = Command::new("ssh");
            c.args(&args);
            c
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
        .map_err(|e| format!("failed to launch ssh for pooled sftp: {e}"))?;
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
        .map_err(|e| format!("pooled sftp connection failed: {e}"))?;
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
    let result = list_dir_on(&sftp, target).await;
    let _ = sftp.close().await;
    reap(child).await;

    result
}

/// List one remote directory on an **already-open** `Sftp` session — the shared
/// core used by both the one-shot [`list_dir`] (which owns its session) and the
/// pooled file-browse path (Phase 2: `commands::fs::list_dir` rides the
/// persistent session from `services::remote`). An empty `path` lists the SFTP
/// default (home) directory. Entries carry real SFTP file-type metadata plus the
/// `readdir`-supplied size/mtime.
pub async fn list_dir_on(sftp: &Sftp, path: &str) -> Result<Vec<Entry>, String> {
    let path = path.trim();
    // Leading-`-`/control-char guard is no longer load-bearing (SFTP paths are
    // protocol fields, not shell tokens) but kept as cheap defense in depth.
    if !path.is_empty() {
        validate_arg("path", path)?;
    }
    let target = if path.is_empty() { "." } else { path };

    let mut fs = sftp.fs();
    let listing = read_entries(&mut fs, target).await;
    drop(fs);
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
    let mut raw: Vec<(String, RawKind, u64, Option<u64>)> = Vec::new();
    while let Some(item) = rd.next().await {
        let entry = item.map_err(|e| format!("sftp read_dir failed: {e}"))?;
        let name = entry.filename().to_string_lossy().into_owned();
        // `metadata()` here is the `readdir`-supplied attrs — no extra round-trip.
        let meta = entry.metadata();
        let size = meta.len().unwrap_or(0);
        let modified_secs = meta.modified().map(|t| t.as_duration().as_secs());
        let kind = match entry.file_type() {
            Some(t) if t.is_dir() => RawKind::Dir,
            Some(t) if t.is_symlink() => RawKind::Symlink,
            _ => RawKind::Other,
        };
        raw.push((name, kind, size, modified_secs));
    }
    drop(rd); // release the directory handle before the follow-up stats

    let mut out: Vec<Entry> = Vec::with_capacity(raw.len());
    for (name, kind, size, modified_secs) in raw {
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
        out.push(Entry {
            name,
            is_dir,
            // Mirror the local lister: directories report size 0.
            size: if is_dir { 0 } else { size },
            modified_secs,
        });
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

// ── Write/read half (mount-free remote, Phase 3) ────────────────────────────
//
// The counterpart to the read/list half above: file I/O (read / write / create /
// delete / mkdir / rename / metadata) over SFTP, used by `commands::fs` to route
// remote-project file operations. Mirrors the `list_dir` / `list_dir_on` shape —
// a `*_on(&Sftp, …)` core that runs on an already-open (pooled) session, plus a
// one-shot wrapper that opens its own session and tears it down (teardown runs
// even on error). SFTP paths are protocol fields, never shell tokens, so no
// quoting/validation against injection is needed here (see the module header).

/// The parent directory of a remote (POSIX) path, or `None` for a bare leaf
/// name. `"/a/b"` → `"/a"`, `"/a"` → `"/"`, `"a"` → `None`. Pure, unit-tested.
fn remote_parent(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => Some("/".to_string()),
        Some(i) => Some(trimmed[..i].to_string()),
        None => None,
    }
}

/// Every directory prefix of `path`, shallowest-first up to `path` itself:
/// `"/a/b/c"` → `["/a", "/a/b", "/a/b/c"]`. Used to emulate `mkdir -p` (SFTP
/// MKDIR is single-level). Pure, unit-tested.
fn ancestor_dirs(path: &str) -> Vec<String> {
    let trimmed = path.trim_end_matches('/');
    let absolute = trimmed.starts_with('/');
    let mut out = Vec::new();
    let mut acc = String::new();
    for comp in trimmed.split('/').filter(|c| !c.is_empty()) {
        if acc.is_empty() && !absolute {
            acc.push_str(comp);
        } else {
            acc.push('/');
            acc.push_str(comp);
        }
        out.push(acc.clone());
    }
    out
}

/// Create `path` and any missing parents on an open session — the remote
/// analogue of `std::fs::create_dir_all`. A no-op when `path` already exists
/// (any kind). SFTP has no atomic `mkdir -p`, so each missing ancestor is created
/// in turn; a level that already exists (or a create race) is tolerated.
pub async fn mkdir_on(sftp: &Sftp, path: &str) -> Result<(), String> {
    let mut fs = sftp.fs();
    if fs.metadata(path).await.is_ok() {
        return Ok(()); // already present — nothing to create
    }
    for prefix in ancestor_dirs(path) {
        if fs.metadata(&prefix).await.is_ok() {
            continue;
        }
        if let Err(e) = fs.create_dir(&prefix).await {
            // A concurrent create / pre-existing dir is fine; only a still-missing
            // level after the attempt is a real failure.
            if fs.metadata(&prefix).await.is_err() {
                return Err(format!("sftp mkdir failed for '{prefix}': {e}"));
            }
        }
    }
    Ok(())
}

/// Ensure the parent directory of `path` exists (mirrors the `create_dir_all`
/// the local file writers do before a write).
async fn ensure_parent_dirs_on(sftp: &Sftp, path: &str) -> Result<(), String> {
    if let Some(parent) = remote_parent(path) {
        mkdir_on(sftp, &parent).await?;
    }
    Ok(())
}

/// Read a remote file's whole contents on an already-open session.
pub async fn read_file_on(sftp: &Sftp, path: &str) -> Result<Vec<u8>, String> {
    let mut fs = sftp.fs();
    let bytes = fs
        .read(path)
        .await
        .map_err(|e| format!("sftp read failed: {e}"))?;
    Ok(bytes.to_vec())
}

/// Write (create/truncate) a remote file with `bytes`, creating missing parent
/// directories first — mirrors the local writers' `create_dir_all` + `write`.
pub async fn write_file_on(sftp: &Sftp, path: &str, bytes: &[u8]) -> Result<(), String> {
    ensure_parent_dirs_on(sftp, path).await?;
    let mut fs = sftp.fs();
    fs.write(path, bytes)
        .await
        .map_err(|e| format!("sftp write failed: {e}"))
}

/// Create an empty remote file (truncating an existing one), creating missing
/// parents — the remote analogue of `fs::File::create`.
pub async fn create_file_on(sftp: &Sftp, path: &str) -> Result<(), String> {
    write_file_on(sftp, path, &[]).await
}

/// Remove a remote file on an open session.
pub async fn remove_file_on(sftp: &Sftp, path: &str) -> Result<(), String> {
    let mut fs = sftp.fs();
    fs.remove_file(path)
        .await
        .map_err(|e| format!("sftp remove_file failed: {e}"))
}

/// Recursively remove a remote directory tree on an open session — the remote
/// analogue of `std::fs::remove_dir_all` (SFTP RMDIR only removes an *empty*
/// directory, so children are listed and removed depth-first first).
pub async fn remove_dir_on(sftp: &Sftp, path: &str) -> Result<(), String> {
    // List the directory (errors → empty/leaf, fall through to RMDIR).
    let entries = list_dir_on(sftp, path).await.unwrap_or_default();
    for entry in &entries {
        let child = format!("{}/{}", path.trim_end_matches('/'), entry.name);
        if entry.is_dir {
            Box::pin(remove_dir_on(sftp, &child)).await?;
        } else {
            remove_file_on(sftp, &child).await?;
        }
    }
    let mut fs = sftp.fs();
    fs.remove_dir(path)
        .await
        .map_err(|e| format!("sftp remove_dir failed: {e}"))
}

/// Rename/move a remote path on an open session.
pub async fn rename_on(sftp: &Sftp, from: &str, to: &str) -> Result<(), String> {
    let mut fs = sftp.fs();
    fs.rename(from, to)
        .await
        .map_err(|e| format!("sftp rename failed: {e}"))
}

/// `(size, modified_secs)` for a remote path on an open session. `size` is `0`
/// and `modified_secs` is `None` when the server omits the attribute.
pub async fn metadata_on(sftp: &Sftp, path: &str) -> Result<(u64, Option<u64>), String> {
    let mut fs = sftp.fs();
    let meta = fs
        .metadata(path)
        .await
        .map_err(|e| format!("sftp metadata failed: {e}"))?;
    let size = meta.len().unwrap_or(0);
    let modified = meta.modified().map(|t| t.as_duration().as_secs());
    Ok((size, modified))
}

/// SFTP-get a remote file into a local destination path on an open session
/// (read the bytes, then write them locally). The primitive a per-project
/// "download" command would call; see [`download`].
#[allow(dead_code)] // wired by the download-routing command (Phase 3/5 follow-up)
pub async fn download_on(
    sftp: &Sftp,
    remote_path: &str,
    dest_local: &std::path::Path,
) -> Result<(), String> {
    let bytes = read_file_on(sftp, remote_path).await?;
    std::fs::write(dest_local, bytes).map_err(|e| format!("write downloaded file failed: {e}"))
}

// ── One-shot wrappers (open a session, run one op, tear it down) ─────────────
//
// The cold-pool fallback for `commands::fs` (mirrors `list_dir` over
// `list_dir_on`). Key/agent auth when `password` is `None`; teardown always runs.

/// Open a one-shot session, run `op` against it, then close + reap (even on op
/// error). Cuts the per-wrapper boilerplate while keeping teardown guaranteed.
async fn with_oneshot<F, Fut, T>(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    op: F,
) -> Result<T, String>
where
    F: FnOnce(Sftp) -> Fut,
    Fut: std::future::Future<Output = (Sftp, Result<T, String>)>,
{
    let (sftp, child) = open_session(user, host, port, password).await?;
    let (sftp, result) = op(sftp).await;
    let _ = sftp.close().await;
    reap(child).await;
    result
}

/// One-shot remote file read.
pub async fn read_file(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
) -> Result<Vec<u8>, String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = read_file_on(&sftp, path).await;
        (sftp, r)
    })
    .await
}

/// One-shot remote file write (create/truncate, creating parents).
pub async fn write_file(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
    bytes: &[u8],
) -> Result<(), String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = write_file_on(&sftp, path, bytes).await;
        (sftp, r)
    })
    .await
}

/// One-shot remote empty-file create.
pub async fn create_file(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
) -> Result<(), String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = create_file_on(&sftp, path).await;
        (sftp, r)
    })
    .await
}

/// One-shot remote `mkdir -p`.
pub async fn mkdir(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
) -> Result<(), String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = mkdir_on(&sftp, path).await;
        (sftp, r)
    })
    .await
}

/// One-shot remote file remove.
pub async fn remove_file(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
) -> Result<(), String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = remove_file_on(&sftp, path).await;
        (sftp, r)
    })
    .await
}

/// One-shot remote recursive directory remove.
pub async fn remove_dir(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
) -> Result<(), String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = remove_dir_on(&sftp, path).await;
        (sftp, r)
    })
    .await
}

/// One-shot remote rename/move.
pub async fn rename(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    from: &str,
    to: &str,
) -> Result<(), String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = rename_on(&sftp, from, to).await;
        (sftp, r)
    })
    .await
}

/// One-shot remote metadata (`(size, modified_secs)`).
pub async fn metadata(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    path: &str,
) -> Result<(u64, Option<u64>), String> {
    with_oneshot(user, host, port, password, |sftp| async move {
        let r = metadata_on(&sftp, path).await;
        (sftp, r)
    })
    .await
}

/// One-shot SFTP-get a remote file into a local destination path.
#[allow(dead_code)] // wired by the download-routing command (Phase 3/5 follow-up)
pub async fn download(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    password: Option<&str>,
    remote_path: &str,
    dest_local: &std::path::Path,
) -> Result<(), String> {
    let bytes = read_file(user, host, port, password, remote_path).await?;
    std::fs::write(dest_local, bytes).map_err(|e| format!("write downloaded file failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(name: &str, is_dir: bool) -> Entry {
        Entry {
            name: name.to_string(),
            is_dir,
            size: 0,
            modified_secs: None,
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
    fn remote_parent_of_paths() {
        assert_eq!(remote_parent("/a/b/c"), Some("/a/b".to_string()));
        assert_eq!(remote_parent("/a/b/c/"), Some("/a/b".to_string()));
        assert_eq!(remote_parent("/a"), Some("/".to_string()));
        // A bare leaf name (relative) has no parent.
        assert_eq!(remote_parent("leaf"), None);
        assert_eq!(remote_parent("/"), None);
    }

    #[test]
    fn ancestor_dirs_walks_absolute_prefixes() {
        assert_eq!(
            ancestor_dirs("/a/b/c"),
            vec!["/a".to_string(), "/a/b".to_string(), "/a/b/c".to_string()]
        );
        // Trailing slash trimmed; root-only path has no components.
        assert_eq!(ancestor_dirs("/"), Vec::<String>::new());
        // Relative path keeps the first component bare.
        assert_eq!(
            ancestor_dirs("a/b"),
            vec!["a".to_string(), "a/b".to_string()]
        );
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
