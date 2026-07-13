//! Explicit remoteness + pooled SSH/SFTP connection for remote (SSH) projects.
//!
//! Phase 0 of the mount-free remote model (`docs/mountfree_remote_plan.md`).
//! Two responsibilities:
//!
//! 1. **Explicit remoteness.** [`remote_target_for`] is the single source of
//!    truth for "is this project remote, and where does it live?" — replacing
//!    the old infer-from-mountpoint-path signal (`ssh_exec::project_id_from_cwd`,
//!    which sniffed a cwd under `ssh_mount::mounts_root()`). It returns `Some`
//!    iff the project carries a [`RemoteSpec`]. Later phases (terminal, file
//!    browse, file I/O, git) dispatch on this rather than on a path convention.
//!
//! 2. **Pooled connection.** A single persistent SSH ControlMaster + SFTP session
//!    per active remote project, opened once on activation ([`connect`]) and
//!    reused by file browsing / I-O (and ridden by agent tabs / git over the
//!    shared master). This is the single-sign-on + performance linchpin:
//!    authentication happens once here, and every later channel rides the master
//!    with no re-auth and fast channel setup. Held in Tauri-managed state
//!    ([`RemotePoolState`]); torn down by [`disconnect`] / [`disconnect_all`].
//!
//! Password-auth hosts feed the password to the master via `SSHPASS`
//! (`sshpass -e`), never on argv. By default it is never stored; when the user
//! opts into "Save password", it is kept in the OS keychain (never our JSON) and
//! reused here for silent reconnect (see `services::remote_credentials`).

use std::collections::HashMap;
use std::sync::Arc;

use openssh_sftp_client::Sftp;
use tokio::process::Child;
use tokio::sync::Mutex;

use crate::schema::project::RemoteSpec;
use crate::schema::projects::{ProjectEntry, ProjectsList};

/// A resolved remote project: its [`RemoteSpec`] plus the owning project id.
/// The explicit replacement for inferring remoteness from a mountpoint path.
#[derive(Debug, Clone)]
pub struct RemoteTarget {
    pub spec: RemoteSpec,
    pub project_id: String,
}

/// `Some(target)` iff the project identified by `project_id` is remote; `None`
/// for a local project or any read failure (degrades to local-fs behavior).
///
/// The remote spec is read from the **always-local** `projects.json` entry's
/// flattened `extra["remote"]` (mirrored there at create/import time), NOT from
/// the per-project `project.json`: for a mount-free remote project that file
/// lives on the host and is not locally readable, whereas this global list is
/// always on the local disk. This keeps the resolver synchronous and fast.
pub fn remote_target_for(project_id: &str) -> Option<RemoteTarget> {
    let list = read_projects_list()?;
    let entry = list.iter().find(|e| e.id == project_id)?;
    spec_from_entry(entry).map(|spec| RemoteTarget {
        spec,
        project_id: project_id.to_string(),
    })
}

/// `Some(target)` iff the project whose stored `directory` equals `project_dir`
/// is remote; `None` for a local project, an unknown directory, or a read
/// failure.
///
/// The git/file commands receive a `project_dir` (not a `project_id`), so to
/// dispatch remote-vs-local without threading a `project_id` through every
/// frontend call site we reverse-look-up the owning project: the value the
/// frontend passes as `project_dir` is the project's stored `directory`, kept in
/// the `projects.json` entry's flattened `extra["directory"]`. For a remote
/// project `directory` is a local per-project state dir (no longer a mountpoint)
/// that simply keys the entry and holds its `project.json`; the actual tree lives
/// on `spec.remote_path` and is reached over SFTP/SSH.
pub fn remote_target_for_dir(project_dir: &str) -> Option<RemoteTarget> {
    let list = read_projects_list()?;
    let entry = list
        .iter()
        .find(|e| entry_directory(e) == Some(project_dir))?;
    spec_from_entry(entry).map(|spec| RemoteTarget {
        spec,
        project_id: entry.id.clone(),
    })
}

/// Read the global `projects.json` list, or `None` if absent/unparseable.
fn read_projects_list() -> Option<ProjectsList> {
    let list_path = crate::storage::state_dir().join("projects.json");
    if !list_path.exists() {
        return None;
    }
    crate::storage::read_json(&list_path).ok()
}

/// A `projects.json` entry's stored `directory` (its flattened `extra` field).
fn entry_directory(entry: &ProjectEntry) -> Option<&str> {
    entry.extra.get("directory").and_then(|v| v.as_str())
}

/// The `directory` recorded for `project_id` in the always-local `projects.json`.
///
/// The forward lookup to [`remote_target_for_dir`]'s reverse one. For a LOCAL
/// project this is where its files are; for a REMOTE project it is the local
/// per-project state dir, not the tree (which lives on the host).
pub fn project_directory(project_id: &str) -> Option<String> {
    let list = read_projects_list()?;
    let entry = list.iter().find(|e| e.id == project_id)?;
    entry_directory(entry).map(str::to_string)
}

/// The `RemoteSpec` mirrored into a `projects.json` entry's flattened
/// `extra["remote"]`, or `None` for a local project. Pure, so the "remote iff a
/// spec is present" mapping is testable without the real state dir.
fn spec_from_entry(entry: &ProjectEntry) -> Option<RemoteSpec> {
    let value = entry.extra.get("remote")?;
    serde_json::from_value(value.clone()).ok()
}

// ── Pooled connection ──────────────────────────────────────────────────────

/// One pooled remote connection: the live SFTP session (shared via `Arc` so file
/// commands can clone it and run operations without holding the pool lock — see
/// [`pooled_sftp`]) and the `ssh` child whose lifetime keeps the session, and the
/// ControlMaster it established, alive. Dropping `child` would collapse the
/// connection, so it is owned here and killed explicitly on teardown.
struct PooledRemote {
    sftp: Arc<Sftp>,
    child: Child,
}

/// Tauri-managed pool of live remote connections, keyed by project id.
#[derive(Default)]
pub struct RemotePool {
    conns: HashMap<String, PooledRemote>,
}

/// Managed-state handle to the pool. `tokio::sync::Mutex` because every access is
/// inside an async command and teardown awaits the child.
pub type RemotePoolState = Arc<Mutex<RemotePool>>;

/// Build a fresh, empty pool for `tauri::Builder::manage`.
pub fn new_pool() -> RemotePoolState {
    Arc::new(Mutex::new(RemotePool::default()))
}

/// Open (idempotently) the pooled SSH/SFTP connection for `project_id`. A no-op
/// for a local project or one already connected. `password` is used only for
/// password-auth hosts (fed to `sshpass` over `SSHPASS`, never stored / on argv);
/// `None` uses key/agent auth. The connection is opened OUTSIDE the pool lock so
/// a slow handshake never blocks other pool access.
///
/// By contract of the caller (the UI invokes this fire-and-forget on activation)
/// a failure must never block activation: it is returned as `Err` for the caller
/// to log, and the project simply has no pooled connection (later access falls
/// back to a one-shot session, exactly as before).
pub async fn connect(
    pool: &RemotePoolState,
    project_id: &str,
    password: Option<&str>,
) -> Result<(), String> {
    let Some(target) = remote_target_for(project_id) else {
        return Ok(()); // local project — nothing to pool
    };
    // SSH-sync Phase 1: ensure the local mirror twin exists for any connected
    // remote project (covers projects created before the mirror was minted at
    // create time), so the "Local" source view and local-on-remote tabs have a
    // real, empty directory to read/cwd into rather than erroring.
    let _ = std::fs::create_dir_all(crate::services::remote_sync::mirror_dir(project_id));
    if pool.lock().await.conns.contains_key(project_id) {
        return Ok(()); // already connected
    }

    let spec = &target.spec;
    // Silent reconnect: the activation path calls this with `None`. Before falling
    // back to key/agent auth, use a saved password for this host target if the user
    // opted to remember one (see `services::remote_credentials`).
    //
    // An *empty* password counts as "none given", not as "authenticate with the
    // empty string": the Connect modal sends a blank field when the user is relying
    // on the saved credential, and taking that literally made the pooled connect
    // fail with a saved password sitting right there in the keychain (`ssh_connect`
    // filters it, so the probe passed and only this leg failed).
    let saved_pw;
    let password = password.filter(|p| !p.is_empty());
    let password = if password.is_some() {
        password
    } else {
        saved_pw = crate::services::remote_credentials::get(
            &crate::services::remote_credentials::ssh_account(&spec.user, &spec.host, spec.port),
        );
        saved_pw.as_deref()
    };
    let (sftp, child) =
        crate::services::sftp::open_pooled_session(&spec.user, &spec.host, spec.port, password)
            .await?;

    let mut guard = pool.lock().await;
    // A concurrent connect may have won the race while we were handshaking. If so
    // keep theirs and tear ours down rather than leaking a second ssh child.
    if guard.conns.contains_key(project_id) {
        drop(guard);
        teardown_session(sftp, child).await;
        return Ok(());
    }
    guard.conns.insert(
        project_id.to_string(),
        PooledRemote {
            sftp: Arc::new(sftp),
            child,
        },
    );
    Ok(())
}

/// Close and remove the pooled connection for `project_id` (no-op if none).
pub async fn disconnect(pool: &RemotePoolState, project_id: &str) {
    let removed = pool.lock().await.conns.remove(project_id);
    if let Some(conn) = removed {
        teardown_pooled(conn).await;
    }
}

/// Tear down every pooled connection. Used at app exit so no ssh ControlMaster
/// child outlives Eldrun.
pub async fn disconnect_all(pool: &RemotePoolState) {
    let conns: Vec<PooledRemote> = {
        let mut guard = pool.lock().await;
        guard.conns.drain().map(|(_, c)| c).collect()
    };
    for conn in conns {
        teardown_pooled(conn).await;
    }
}

/// Clone the pooled SFTP session for `project_id`, if one is connected. Later
/// phases (file browse / I-O) call this and run operations on the returned
/// `Arc<Sftp>` without holding the pool lock. `None` when the project is not
/// connected — the caller then opens a one-shot session or surfaces a
/// "disconnected" state rather than hanging.
#[allow(dead_code)] // consumed by Phase 2/3 (remote file browse + I/O)
pub async fn pooled_sftp(pool: &RemotePoolState, project_id: &str) -> Option<Arc<Sftp>> {
    let mut guard = pool.lock().await;
    let conn = guard.conns.get_mut(project_id)?;
    // If the ssh child has already exited — the keepalive killed it after a
    // network drop (ServerAliveInterval/CountMax), or the remote closed the
    // connection — the pooled session is dead and every SFTP op on it would fail
    // against a closed pipe. Evict the corpse so the caller falls back to a
    // one-shot session (which can ride a still-live master, or surface a clean
    // disconnected state) instead of looping on the dead entry forever.
    if matches!(conn.child.try_wait(), Ok(Some(_))) {
        guard.conns.remove(project_id);
        return None;
    }
    Some(Arc::clone(&conn.sftp))
}

/// The ids of every project whose pooled SSH connection is currently live.
/// Evicts any whose ssh child has already exited (same corpse-reaping as
/// [`is_connected`]) so the background traffic sampler never samples a dead
/// ControlMaster. Order is unspecified.
pub async fn connected_ids(pool: &RemotePoolState) -> Vec<String> {
    let mut guard = pool.lock().await;
    let dead: Vec<String> = guard
        .conns
        .iter_mut()
        .filter_map(|(id, conn)| match conn.child.try_wait() {
            Ok(Some(_)) => Some(id.clone()),
            _ => None,
        })
        .collect();
    for id in &dead {
        guard.conns.remove(id);
    }
    guard.conns.keys().cloned().collect()
}

/// Whether a project's pooled SSH connection is live. Like [`pooled_sftp`], this
/// evicts a child that has already exited so read-only observers never launch a
/// fallback connection merely to discover that the project is offline.
pub async fn is_connected(pool: &RemotePoolState, project_id: &str) -> bool {
    let mut guard = pool.lock().await;
    let Some(conn) = guard.conns.get_mut(project_id) else {
        return false;
    };
    if matches!(conn.child.try_wait(), Ok(Some(_))) {
        guard.conns.remove(project_id);
        return false;
    }
    true
}

/// Tear down a pooled connection: gracefully close the SFTP session (sends
/// `SSH_FXP_CLOSE`, matching [`teardown_session`]) when we hold its only
/// reference, then kill the `ssh` child, which collapses the channel and the
/// ControlMaster it owned. If a file op is still borrowing the `Arc<Sftp>`, we
/// can't take ownership to `close()` it, so we drop our reference and let its own
/// `Drop` close the local side once that borrow finishes.
async fn teardown_pooled(conn: PooledRemote) {
    let PooledRemote { sftp, mut child } = conn;
    match Arc::try_unwrap(sftp) {
        Ok(sftp) => {
            let _ = sftp.close().await;
        }
        Err(arc) => drop(arc),
    }
    let _ = child.kill().await;
}

/// Gracefully close a freshly-opened, not-yet-pooled session (the lost-race path
/// in [`connect`]). Here we still own the `Sftp` outright, so the consuming
/// `Sftp::close` can run before the child is killed.
async fn teardown_session(sftp: Sftp, mut child: Child) {
    let _ = sftp.close().await;
    let _ = child.kill().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn spec() -> RemoteSpec {
        RemoteSpec {
            user: Some("alice".to_string()),
            host: "host.example".to_string(),
            port: None,
            remote_path: "/srv/project".to_string(),
            openvpn: None,
            auto_connect: None,
            key_auth: None,
            extra: HashMap::new(),
        }
    }

    /// A `projects.json` entry, optionally remote (its spec mirrored into
    /// `extra["remote"]` exactly as `commands::projects::project_extra` does).
    fn entry(id: &str, directory: Option<&str>, remote: Option<RemoteSpec>) -> ProjectEntry {
        let mut extra = HashMap::new();
        if let Some(d) = directory {
            extra.insert(
                "directory".to_string(),
                serde_json::Value::String(d.to_string()),
            );
        }
        if let Some(r) = remote {
            extra.insert("remote".to_string(), serde_json::to_value(&r).unwrap());
        }
        ProjectEntry {
            id: id.to_string(),
            name: id.to_string(),
            status: "active".to_string(),
            position: 0,
            local_file: format!("/state/{id}.json"),
            extra,
        }
    }

    #[test]
    fn spec_from_entry_some_for_remote_project() {
        let e = entry("p1", Some("/state/remote-projects/p1"), Some(spec()));
        let resolved = spec_from_entry(&e).expect("remote entry resolves a spec");
        assert_eq!(resolved.host, "host.example");
        assert_eq!(resolved.remote_path, "/srv/project");
    }

    #[test]
    fn spec_from_entry_none_for_local_project() {
        let e = entry("p1", Some("/home/u/eldrun/projects/alpha"), None);
        assert!(spec_from_entry(&e).is_none());
    }

    #[test]
    fn entry_directory_reads_extra() {
        let e = entry("p1", Some("/some/dir"), None);
        assert_eq!(entry_directory(&e), Some("/some/dir"));
        let e2 = entry("p2", None, None);
        assert_eq!(entry_directory(&e2), None);
    }

    #[test]
    fn new_pool_starts_empty() {
        let pool = new_pool();
        // The pool is async-locked; a blocking check here is fine in a sync test
        // since nothing else holds the lock.
        let guard = pool.try_lock().expect("uncontended");
        assert!(guard.conns.is_empty());
    }
}
