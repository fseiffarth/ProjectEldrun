//! One login per agent CLI, shared by every Eldrun-owned agent home.
//!
//! Each CLI keeps its sign-in in a plain file (or a small directory) under
//! `$HOME` — see the `auth_paths` column of the registry in
//! `commands::agents`. Those paths, and only those, are shared across scopes:
//! the file lives once in `<state_dir>/agent-auth/<cli-id>/` and every scope
//! home (`services::agent_home`) carries a **hard link** to it at the CLI's
//! own path. A hard link, not a bind mount and not a symlink: several CLIs
//! rotate a token by writing a sibling file and renaming it over the original,
//! which a file bind mount refuses (`EBUSY` on a mount point) and Claude opens
//! its store `O_NOFOLLOW`, so a symlink is refused too. A rename simply gives
//! the scope a new inode; the keeper ([`start`]) notices, copies the new bytes
//! into the store's inode in place — every other scope's link sees them at
//! once — and links the scope's path back to the store. So a login made in any
//! tab, fenced or not, sticks everywhere, and a refresh a tab persists reaches
//! the other tabs without a respawn.
//!
//! Directories (a CLI that keeps only its login in a folder of its own) are
//! bind-mounted from the store on Linux (`dir_binds`) and symlinked elsewhere.
//!
//! Only credential files are shared — never a config that could name a
//! command (an MCP server, a hook), which stays per scope. Where the file
//! names an account, the store records it at first adoption and a later file
//! naming a different account is **not** adopted (the tab that wrote it keeps
//! its own login, the store keeps the user's); switching accounts on purpose
//! is Sign out, then log in again. AppHandle-free and unit-testable.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

use crate::storage;

/// The directory under the state dir holding every CLI's login.
pub const STORE_DIR: &str = "agent-auth";
/// The keeper's cadence: a login done in a tab reaches the other scopes'
/// next spawn at once (spawn reconciles) and their running tabs within this.
const POLL: Duration = Duration::from_secs(20);
/// Sidecar in a CLI's store dir naming the account the store was adopted from.
const ACCOUNT_FILE: &str = ".account";
/// Sidecar left when an adoption was refused, for the Agents view to show.
const BLOCKED_FILE: &str = ".blocked";

/// What kind of path a CLI keeps its login in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthKind {
    /// One file; hard-linked into every home.
    File,
    /// A directory holding nothing but the login; bound into every home.
    Dir,
}

/// One login path of a CLI, relative to `$HOME`, forward slashes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthPath {
    pub rel: &'static str,
    pub kind: AuthKind,
}

pub const fn file(rel: &'static str) -> AuthPath {
    AuthPath { rel, kind: AuthKind::File }
}

pub const fn dir(rel: &'static str) -> AuthPath {
    AuthPath { rel, kind: AuthKind::Dir }
}

/// `<state_dir>/agent-auth/`.
pub fn store_root_in(state_dir: &Path) -> PathBuf {
    state_dir.join(STORE_DIR)
}

/// `<state_dir>/agent-auth/<cli-id>/`.
pub fn store_dir_in(state_dir: &Path, cli: &str) -> PathBuf {
    store_root_in(state_dir).join(storage::project_key(cli))
}

/// A path's home-relative spelling as one store leaf: `.claude/.credentials.json`
/// → `.claude_.credentials.json`.
fn leaf_of(rel: &str) -> String {
    rel.replace(['/', '\\'], "_")
}

/// Where `path`'s login lives in the store of `cli`.
pub fn store_path_in(state_dir: &Path, cli: &str, path: &AuthPath) -> PathBuf {
    store_dir_in(state_dir, cli).join(leaf_of(path.rel))
}

fn home_path(home: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(home.to_path_buf(), |p, seg| p.join(seg))
}

/// The registry's login paths, `(cli id, paths)`.
fn registry() -> Vec<(&'static str, &'static [AuthPath])> {
    crate::commands::agents::auth_registry()
}

#[cfg(unix)]
fn inode(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path).ok()?;
    Some((m.dev(), m.ino()))
}

#[cfg(not(unix))]
fn inode(_path: &Path) -> Option<(u64, u64)> {
    // Windows exposes file ids only through an unstable API; compare content
    // instead (`same_file` below), which is what the linkage buys anyway.
    None
}

/// Whether `a` and `b` are the same file (one inode, two names).
fn same_file(a: &Path, b: &Path) -> bool {
    match (inode(a), inode(b)) {
        (Some(x), Some(y)) => x == y,
        _ => match (std::fs::read(a), std::fs::read(b)) {
            (Ok(x), Ok(y)) => x == y,
            _ => false,
        },
    }
}

/// Write in place — open, truncate, write — so every link keeps seeing the
/// one inode. Created `0600`.
fn write_in_place(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.flush()
}

/// Put a hard link to `store` at `link`, replacing whatever is there
/// (atomically: a temp link renamed over). Falls back to a copy when linking
/// is impossible (another filesystem), which then holds a per-scope login.
fn link_or_copy(store: &Path, link: &Path) -> io::Result<()> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = link.with_file_name(format!(
        ".{}.eldrun-{}",
        link.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        std::process::id()
    ));
    let _ = std::fs::remove_file(&tmp);
    match std::fs::hard_link(store, &tmp) {
        Ok(()) => std::fs::rename(&tmp, link).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        }),
        Err(_) => {
            let _ = std::fs::remove_file(&tmp);
            std::fs::copy(store, link).map(|_| ())
        }
    }
}

/// The account a login file names, where a CLI's file does: Codex's
/// `tokens.account_id`; Claude's identity is read off `.claude.json`
/// ([`claude_account_in_home`]) since its credential file names none.
pub fn account_of(cli: &str, bytes: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let found = match cli {
        "codex" => value
            .pointer("/tokens/account_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        _ => None,
    };
    found.filter(|s| !s.is_empty())
}

/// The signed-in Claude account of a home, from its `.claude.json`.
pub fn claude_account_in_home(home: &Path) -> Option<String> {
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(home.join(".claude.json")).ok()?).ok()?;
    value
        .pointer("/oauthAccount/emailAddress")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn read_sidecar(dir: &Path, name: &str) -> Option<String> {
    std::fs::read_to_string(dir.join(name))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Why an adoption was refused, recorded per CLI for the Agents view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Blocked {
    pub account: String,
    pub stored: String,
}

/// Adopt the login a tab wrote at `home_file` into `store`, if it is a new
/// file (not the store's own inode), holds something, and does not switch the
/// account. Returns whether the store changed.
fn adopt_file(cli: &str, store_dir: &Path, store: &Path, home: &Path, home_file: &Path) -> bool {
    if !home_file.is_file() || (store.is_file() && same_file(store, home_file)) {
        return false;
    }
    let Ok(bytes) = std::fs::read(home_file) else {
        return false;
    };
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return false;
    }
    if store.is_file() && std::fs::read(store).ok().as_deref() == Some(bytes.as_slice()) {
        return false;
    }
    let account = if cli == "claude" {
        claude_account_in_home(home)
    } else {
        account_of(cli, &bytes)
    };
    if let (Some(new), Some(stored)) = (&account, read_sidecar(store_dir, ACCOUNT_FILE)) {
        if *new != stored {
            eprintln!("agent_auth: {cli}: a tab signed in as {new}, the store holds {stored}; not adopted");
            let blocked = serde_json::json!({ "account": new, "stored": stored });
            let _ = std::fs::write(store_dir.join(BLOCKED_FILE), blocked.to_string());
            return false;
        }
    }
    if crate::services::agent_home::create_private_dir(store_dir).is_err() {
        return false;
    }
    if let Err(e) = write_in_place(store, &bytes) {
        eprintln!("agent_auth: {cli}: store {}: {e}", store.display());
        return false;
    }
    if let Some(account) = account {
        let _ = std::fs::write(store_dir.join(ACCOUNT_FILE), account);
        let _ = std::fs::remove_file(store_dir.join(BLOCKED_FILE));
    }
    true
}

/// Reconcile one home against the store, both ways: adopt what its tabs
/// wrote, then link the store in. Pure over `state_dir`/`home`.
pub fn reconcile_home_in(state_dir: &Path, home: &Path) {
    for (cli, paths) in registry() {
        let store_dir = store_dir_in(state_dir, cli);
        for path in paths {
            let home_file = home_path(home, path.rel);
            match path.kind {
                AuthKind::File => {
                    let store = store_path_in(state_dir, cli, path);
                    adopt_file(cli, &store_dir, &store, home, &home_file);
                    if store.is_file() && !same_file(&store, &home_file) {
                        if let Err(e) = link_or_copy(&store, &home_file) {
                            eprintln!("agent_auth: {cli}: link {}: {e}", home_file.display());
                        }
                    }
                }
                AuthKind::Dir => {
                    let store = store_path_in(state_dir, cli, path);
                    let _ = crate::services::agent_home::create_private_dir(&store);
                    // Linux binds the store dir over this path (`dir_binds`);
                    // the mount point must exist. Elsewhere the path is a
                    // symlink to the store.
                    if cfg!(target_os = "linux") {
                        let _ = std::fs::create_dir_all(&home_file);
                    } else if !home_file.exists() {
                        if let Some(parent) = home_file.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        #[cfg(unix)]
                        let _ = std::os::unix::fs::symlink(&store, &home_file);
                        #[cfg(windows)]
                        let _ = std::os::windows::fs::symlink_dir(&store, &home_file);
                    }
                }
            }
        }
        if cli == "claude" {
            link_claude_identity(&store_dir, home);
        }
    }
}

/// Claude's `.claude.json` identity: the store keeps a copy of the identity
/// keys; a home whose file lacks a signed-in account gets them, and a home
/// that signed in feeds them back (same account rule as the credentials).
fn link_claude_identity(store_dir: &Path, home: &Path) {
    let identity = store_dir.join("identity.json");
    let file = home.join(".claude.json");
    let mut value: serde_json::Value = std::fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !value.is_object() {
        return;
    }
    let stored: Option<serde_json::Value> = std::fs::read(&identity)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let home_account = claude_account_in_home(home);
    let stored_account = read_sidecar(store_dir, ACCOUNT_FILE);
    match (home_account, stored) {
        // The home is signed in: record its identity unless it is another account.
        (Some(account), _) if stored_account.as_deref().is_none_or(|s| s == account) => {
            let keys = crate::services::agent_home::filtered_claude_json(&value, &[]);
            let mut keys = keys;
            keys.as_object_mut().map(|o| o.remove("projects"));
            let _ = crate::services::agent_home::create_private_dir(store_dir);
            if let Ok(body) = serde_json::to_vec(&keys) {
                let _ = write_in_place(&identity, &body);
            }
            let _ = std::fs::write(store_dir.join(ACCOUNT_FILE), account);
        }
        // Not signed in here, but the store knows who: seed the identity keys.
        (None, Some(stored)) => {
            let Some(obj) = value.as_object_mut() else { return };
            let mut changed = false;
            if let Some(src) = stored.as_object() {
                for (k, v) in src {
                    if obj.get(k) != Some(v) {
                        obj.insert(k.clone(), v.clone());
                        changed = true;
                    }
                }
            }
            if changed {
                if let Ok(body) = serde_json::to_vec_pretty(&value) {
                    let _ = std::fs::write(&file, body);
                }
            }
        }
        _ => {}
    }
}

/// [`reconcile_home_in`] against the real state dir — what every local
/// agent spawn runs for its home before the agent starts.
pub fn link_into_home(state_dir: &Path, home: &Path) {
    reconcile_home_in(state_dir, home);
}

/// The Linux fence's / container's directory binds for `home`:
/// `(store dir, path in home)` for every `Dir` login path.
pub fn dir_binds_in(state_dir: &Path, home: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (cli, paths) in registry() {
        for path in paths.iter().filter(|p| p.kind == AuthKind::Dir) {
            let store = store_path_in(state_dir, cli, path);
            let _ = crate::services::agent_home::create_private_dir(&store);
            let dst = home_path(home, path.rel);
            let _ = std::fs::create_dir_all(&dst);
            out.push((
                store.to_string_lossy().into_owned(),
                dst.to_string_lossy().into_owned(),
            ));
        }
    }
    out
}

/// Environment that makes a CLI keep its login in its file instead of a
/// keyring the fence hides (or that fails inside it), by command basename.
pub fn fence_env(bin: &str) -> &'static [(&'static str, &'static str)] {
    match bin {
        "muse" => &[("TBH_CREDENTIAL_BACKEND", "file")],
        "droid" => &[("FACTORY_DISABLE_KEYRING", "1")],
        "goose" => &[("GOOSE_DISABLE_KEYRING", "1")],
        "gemini" => &[("GEMINI_FORCE_FILE_STORAGE", "true")],
        "qwen" => &[("QWEN_CODE_FORCE_FILE_STORAGE", "true")],
        "qoder" => &[("QODER_FORCE_FILE_STORAGE", "true")],
        // `fail`, not `null`: the null backend drops writes silently.
        "vibe" => &[("PYTHON_KEYRING_BACKEND", "keyring.backends.fail.Keyring")],
        _ => &[],
    }
}

/// Apply [`fence_env`] for the spawn's command to its environment. A value
/// the user already set wins.
pub fn apply_fence_env(cmd: &str, env: &mut std::collections::HashMap<String, String>) {
    let bin = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    let bin = bin.strip_suffix(".exe").unwrap_or(bin);
    for (k, v) in fence_env(bin) {
        env.entry((*k).to_string()).or_insert_with(|| (*v).to_string());
    }
}

/// One CLI's login as the Agents view shows it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LoginStatus {
    pub id: String,
    /// The store holds a login for this CLI.
    pub signed_in: bool,
    /// The account it names, where the file names one.
    pub account: Option<String>,
    /// The user's own home has a login to import.
    pub importable: bool,
    /// A tab signed in as another account and was not adopted.
    pub blocked: Option<Blocked>,
    /// This CLI keeps its login somewhere Eldrun cannot share (a keyring, a
    /// database mixed with other state): one login per scope.
    pub shared: bool,
}

pub fn status_in(state_dir: &Path, user_home: &Path) -> Vec<LoginStatus> {
    registry()
        .into_iter()
        .map(|(cli, paths)| {
            let store_dir = store_dir_in(state_dir, cli);
            let signed_in = paths.iter().any(|p| {
                let s = store_path_in(state_dir, cli, p);
                match p.kind {
                    AuthKind::File => std::fs::metadata(&s).is_ok_and(|m| m.len() > 0),
                    AuthKind::Dir => std::fs::read_dir(&s).is_ok_and(|mut d| d.next().is_some()),
                }
            });
            let importable = paths.iter().any(|p| home_path(user_home, p.rel).exists());
            let blocked = std::fs::read(store_dir.join(BLOCKED_FILE))
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .and_then(|v| {
                    Some(Blocked {
                        account: v.get("account")?.as_str()?.to_string(),
                        stored: v.get("stored")?.as_str()?.to_string(),
                    })
                });
            LoginStatus {
                id: cli.to_string(),
                signed_in,
                account: read_sidecar(&store_dir, ACCOUNT_FILE),
                importable,
                blocked,
                shared: !paths.is_empty(),
            }
        })
        .collect()
}

pub fn status() -> Vec<LoginStatus> {
    status_in(&storage::state_dir(), &crate::paths::home_dir())
}

/// Copy the user's own login files for `cli` into the store (the one safe
/// direction: this computer → Eldrun), then link them into every home. The
/// account record is reset to whatever the imported file names. Instructions,
/// skills and MCP entries are never imported.
pub fn import_from_user_home_in(state_dir: &Path, user_home: &Path, cli: &str) -> Result<usize, String> {
    let paths = registry()
        .into_iter()
        .find(|(id, _)| *id == cli)
        .map(|(_, p)| p)
        .ok_or_else(|| format!("unknown agent: {cli}"))?;
    let store_dir = store_dir_in(state_dir, cli);
    crate::services::agent_home::create_private_dir(&store_dir).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(store_dir.join(ACCOUNT_FILE));
    let _ = std::fs::remove_file(store_dir.join(BLOCKED_FILE));
    let mut copied = 0;
    for path in paths {
        let src = home_path(user_home, path.rel);
        let store = store_path_in(state_dir, cli, path);
        match path.kind {
            AuthKind::File if src.is_file() => {
                let bytes = std::fs::read(&src).map_err(|e| format!("{}: {e}", src.display()))?;
                write_in_place(&store, &bytes).map_err(|e| format!("{}: {e}", store.display()))?;
                if let Some(account) = account_of(cli, &bytes) {
                    let _ = std::fs::write(store_dir.join(ACCOUNT_FILE), account);
                }
                copied += 1;
            }
            AuthKind::Dir if src.is_dir() => {
                let _ = std::fs::remove_dir_all(&store);
                copy_dir(&src, &store).map_err(|e| format!("{}: {e}", src.display()))?;
                copied += 1;
            }
            _ => {}
        }
    }
    if cli == "claude" {
        // The identity keys of the user's `.claude.json`, so the first tab is
        // not a fresh install; its `projects` map stays with the user.
        if let Some(value) = std::fs::read(user_home.join(".claude.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        {
            let mut keys = crate::services::agent_home::filtered_claude_json(&value, &[]);
            keys.as_object_mut().map(|o| o.remove("projects"));
            if let Some(account) = keys
                .pointer("/oauthAccount/emailAddress")
                .and_then(|v| v.as_str())
            {
                let _ = std::fs::write(store_dir.join(ACCOUNT_FILE), account);
            }
            if let Ok(body) = serde_json::to_vec(&keys) {
                let _ = write_in_place(&store_dir.join("identity.json"), &body);
            }
        }
    }
    if copied == 0 {
        return Err("this computer holds no login file for that CLI (it may keep it in a keyring — log in once in an Eldrun tab instead)".into());
    }
    for home in crate::services::agent_home::existing_homes_in(state_dir) {
        // Every home takes the imported login, whatever it held.
        for path in paths.iter().filter(|p| p.kind == AuthKind::File) {
            let _ = std::fs::remove_file(home_path(&home, path.rel));
        }
        reconcile_home_in(state_dir, &home);
    }
    Ok(copied)
}

pub fn import_from_user_home(cli: &str) -> Result<usize, String> {
    import_from_user_home_in(&storage::state_dir(), &crate::paths::home_dir(), cli)
}

/// Marks that the first start of the login store has run.
const IMPORTED_MARKER: &str = ".agent_logins_imported";

/// Import, once, every login this computer holds for a CLI the store has no
/// login for yet, so the upgrade to per-scope homes keeps every agent signed
/// in without a trip to Settings. Never repeated: a later Sign out stays
/// signed out. Run before the keeper starts and before any tab spawns.
pub fn import_once_in(state_dir: &Path, user_home: &Path) {
    let marker = state_dir.join(IMPORTED_MARKER);
    if marker.exists() {
        return;
    }
    for login in status_in(state_dir, user_home) {
        if login.shared && login.importable && !login.signed_in {
            if let Err(e) = import_from_user_home_in(state_dir, user_home, &login.id) {
                eprintln!("agent_auth: first import of {}: {e}", login.id);
            }
        }
    }
    let _ = std::fs::write(&marker, b"");
}

pub fn import_once() {
    import_once_in(&storage::state_dir(), &crate::paths::home_dir());
}

fn copy_dir(src: &Path, dst: &Path) -> io::Result<()> {
    crate::services::agent_home::create_private_dir(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else if entry.file_type()?.is_file() {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// Forget the login of `cli` everywhere: the store and every home's link to
/// it (a home's own, unlinked file — a refused other-account login — stays).
pub fn sign_out_in(state_dir: &Path, cli: &str) -> Result<(), String> {
    let paths = registry()
        .into_iter()
        .find(|(id, _)| *id == cli)
        .map(|(_, p)| p)
        .ok_or_else(|| format!("unknown agent: {cli}"))?;
    let store_dir = store_dir_in(state_dir, cli);
    for home in crate::services::agent_home::existing_homes_in(state_dir) {
        for path in paths {
            let link = home_path(&home, path.rel);
            let store = store_path_in(state_dir, cli, path);
            if path.kind == AuthKind::File && link.is_file() && store.is_file() && same_file(&store, &link) {
                let _ = std::fs::remove_file(&link);
            }
        }
        if cli == "claude" {
            strip_claude_identity(&home.join(".claude.json"));
        }
    }
    if store_dir.exists() {
        std::fs::remove_dir_all(&store_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn sign_out(cli: &str) -> Result<(), String> {
    sign_out_in(&storage::state_dir(), cli)
}

fn strip_claude_identity(file: &Path) {
    let Some(mut value) = std::fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
    else {
        return;
    };
    if let Some(obj) = value.as_object_mut() {
        if obj.remove("oauthAccount").is_some() {
            if let Ok(body) = serde_json::to_vec_pretty(&value) {
                let _ = std::fs::write(file, body);
            }
        }
    }
}

/// One keeper pass over every home.
pub fn reconcile_all_in(state_dir: &Path) {
    for home in crate::services::agent_home::existing_homes_in(state_dir) {
        reconcile_home_in(state_dir, &home);
    }
}

fn keeper_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Reconcile now (a tab just ended, which is when a login lands).
pub fn reconcile_now() {
    let _guard = keeper_lock().lock().unwrap_or_else(|p| p.into_inner());
    reconcile_all_in(&storage::state_dir());
}

/// Start the keeper: one detached thread that reconciles every home every
/// [`POLL`]. Holds no lock across the sleep and dies with the process.
pub fn start() {
    if let Err(e) = std::thread::Builder::new()
        .name("agent-auth".into())
        .spawn(|| loop {
            reconcile_now();
            std::thread::sleep(POLL);
        })
    {
        eprintln!("agent_auth: spawn keeper: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_of(state: &Path, cli: &str, rel: &'static str) -> PathBuf {
        store_path_in(state, cli, &file(rel))
    }

    #[test]
    fn a_login_written_in_one_home_is_adopted_and_linked_into_the_others() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let a = crate::services::agent_home::scope_home_in(state, "a");
        let b = crate::services::agent_home::scope_home_in(state, "b");
        std::fs::create_dir_all(a.join(".codex")).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join(".codex/auth.json"), r#"{"tokens":{"account_id":"acc-1","access_token":"t"}}"#).unwrap();
        reconcile_all_in(state);
        let store = store_of(state, "codex", ".codex/auth.json");
        assert!(store.is_file());
        assert!(same_file(&store, &a.join(".codex/auth.json")));
        assert!(same_file(&store, &b.join(".codex/auth.json")));
        assert_eq!(read_sidecar(&store_dir_in(state, "codex"), ACCOUNT_FILE).as_deref(), Some("acc-1"));

        // A rotation by rename in b: new inode, same account → adopted, a sees it.
        let fresh = b.join(".codex/auth.json.tmp");
        std::fs::write(&fresh, r#"{"tokens":{"account_id":"acc-1","access_token":"t2"}}"#).unwrap();
        std::fs::rename(&fresh, b.join(".codex/auth.json")).unwrap();
        reconcile_all_in(state);
        assert!(std::fs::read_to_string(a.join(".codex/auth.json")).unwrap().contains("t2"));
        assert!(same_file(&store, &b.join(".codex/auth.json")));
    }

    #[test]
    fn a_login_as_another_account_is_refused_and_stays_in_its_own_home() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let a = crate::services::agent_home::scope_home_in(state, "a");
        let b = crate::services::agent_home::scope_home_in(state, "b");
        std::fs::create_dir_all(a.join(".codex")).unwrap();
        std::fs::create_dir_all(b.join(".codex")).unwrap();
        std::fs::write(a.join(".codex/auth.json"), r#"{"tokens":{"account_id":"user"}}"#).unwrap();
        reconcile_all_in(state);
        std::fs::remove_file(b.join(".codex/auth.json")).unwrap();
        std::fs::write(b.join(".codex/auth.json"), r#"{"tokens":{"account_id":"attacker"}}"#).unwrap();
        reconcile_all_in(state);
        let store = store_of(state, "codex", ".codex/auth.json");
        assert!(std::fs::read_to_string(&store).unwrap().contains("\"user\""));
        assert!(std::fs::read_to_string(a.join(".codex/auth.json")).unwrap().contains("\"user\""));
        // b keeps what it wrote; the store's link is restored only on sign-out/import.
        assert!(std::fs::read_to_string(b.join(".codex/auth.json")).unwrap().contains("\"user\""));
        let status: Vec<LoginStatus> = status_in(state, tmp.path());
        let codex = status.iter().find(|s| s.id == "codex").unwrap();
        assert_eq!(codex.blocked.as_ref().map(|b| b.account.as_str()), Some("attacker"));
        assert!(codex.signed_in);
    }

    #[test]
    fn import_copies_the_users_files_and_sign_out_forgets_them_everywhere() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let user = tmp.path().join("user");
        std::fs::create_dir_all(user.join(".codex")).unwrap();
        std::fs::write(user.join(".codex/auth.json"), r#"{"tokens":{"account_id":"me"}}"#).unwrap();
        std::fs::write(user.join(".codex/config.toml"), "[mcp_servers.x]\ncommand='x'\n").unwrap();
        let a = crate::services::agent_home::scope_home_in(&state, "a");
        std::fs::create_dir_all(&a).unwrap();
        assert_eq!(import_from_user_home_in(&state, &user, "codex"), Ok(1));
        assert!(a.join(".codex/auth.json").is_file());
        // Only the login: the config with its MCP servers is not imported.
        assert!(!a.join(".codex/config.toml").exists());
        assert!(import_from_user_home_in(&state, &user, "kiro").is_err());
        sign_out_in(&state, "codex").unwrap();
        assert!(!a.join(".codex/auth.json").exists());
        assert!(!store_dir_in(&state, "codex").exists());
        assert!(!status_in(&state, &user).iter().find(|s| s.id == "codex").unwrap().signed_in);
    }

    #[test]
    fn first_start_imports_missing_logins_once_and_keeps_existing_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let user = tmp.path().join("user");
        std::fs::create_dir_all(user.join(".codex")).unwrap();
        std::fs::create_dir_all(user.join(".claude")).unwrap();
        std::fs::write(user.join(".codex/auth.json"), r#"{"tokens":{"account_id":"me"}}"#).unwrap();
        std::fs::write(user.join(".claude/.credentials.json"), "user").unwrap();
        // Claude is already in the store (the older mirror was adopted).
        let claude = store_of(&state, "claude", ".claude/.credentials.json");
        std::fs::create_dir_all(claude.parent().unwrap()).unwrap();
        std::fs::write(&claude, "mirror").unwrap();
        import_once_in(&state, &user);
        assert!(store_of(&state, "codex", ".codex/auth.json").is_file());
        assert_eq!(std::fs::read_to_string(&claude).unwrap(), "mirror");
        // A sign-out afterwards stays: the import never runs again.
        sign_out_in(&state, "codex").unwrap();
        import_once_in(&state, &user);
        assert!(!store_of(&state, "codex", ".codex/auth.json").exists());
    }

    #[test]
    fn claude_identity_follows_the_credentials_and_is_seeded_into_new_homes() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let a = crate::services::agent_home::scope_home_in(state, "a");
        let b = crate::services::agent_home::scope_home_in(state, "b");
        std::fs::create_dir_all(a.join(".claude")).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join(".claude/.credentials.json"), r#"{"claudeAiOauth":{"accessToken":"x"}}"#).unwrap();
        std::fs::write(a.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"me@x"},"hasCompletedOnboarding":true,"projects":{"/p":{}}}"#).unwrap();
        reconcile_all_in(state);
        assert!(b.join(".claude/.credentials.json").is_file());
        let seeded: serde_json::Value = serde_json::from_slice(&std::fs::read(b.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(seeded["oauthAccount"]["emailAddress"], "me@x");
        assert!(seeded.get("projects").is_none());
        assert_eq!(read_sidecar(&store_dir_in(state, "claude"), ACCOUNT_FILE).as_deref(), Some("me@x"));
    }

    #[test]
    fn fence_env_is_per_cli_and_never_overrides_the_users_value() {
        let mut env = std::collections::HashMap::new();
        env.insert("GOOSE_DISABLE_KEYRING".to_string(), "0".to_string());
        apply_fence_env("/usr/bin/goose", &mut env);
        assert_eq!(env["GOOSE_DISABLE_KEYRING"], "0");
        apply_fence_env("vibe", &mut env);
        assert_eq!(env["PYTHON_KEYRING_BACKEND"], "keyring.backends.fail.Keyring");
        assert!(fence_env("claude").is_empty());
    }
}
