//! The Claude credential **mirror**: an Eldrun-owned copy of
//! `~/.claude/.credentials.json` whose inode never changes, mounted into every
//! fenced/contained agent tab in place of the host file and kept in step with
//! it by in-place writes in both directions.
//!
//! # Why a mirror and not the file itself
//!
//! `~/.claude` is exposed to a fenced tab **per entry** (see
//! `sandbox::narrowed_agent_mounts`), and `.credentials.json` is a file, so it
//! was a single-file bind mount. A file bind mount pins an *inode*, not a path.
//! Claude Code rotates its credentials with an atomic write — a sibling temp
//! file `rename(2)`d over the original — which puts a **new inode** at that
//! path. The host, and every tab spawned afterwards, follow the path and read
//! the fresh token; every tab already running is still mounted onto the
//! orphaned old inode. It reads a stale access token, tries to refresh with a
//! refresh token the server has already rotated away, fails, clears its record
//! in place, and prints `Login expired · Please run /login` — while a freshly
//! opened tab and a terminal-run `claude` work fine. Measured on 2026-09-07:
//! host file inode 122169946 with real tokens; the same path seen through
//! `/proc/<pid>/root` of nineteen live fenced tabs was inode 122170138, 280
//! bytes, both tokens empty. Same device, different inode. The fenced tab
//! cannot even install a refreshed credential itself: a rename onto a bind
//! mount point is `EBUSY` (the same wall `agent_fence::STAGE_MOUNT` documents
//! for the config shadows).
//!
//! # Why not a symlink
//!
//! The config shadows solve the `EBUSY` problem by symlinking each real path
//! into one mounted staging *directory*. That does not work here: Claude Code
//! (checked against 2.1.263 by inspecting the CLI bundle) opens the credential
//! store with `O_RDONLY|O_NOFOLLOW`, reports a symlinked path as
//! `refused-symlink`, and its credential probe rejects it with `ELOOP`. The
//! path inside the fence must be a **regular file**.
//!
//! # Why not the whole `~/.claude` directory
//!
//! Mounting the parent would make the rename work and follow the path — and
//! would fail *open* for every deny-listed entry created after the tab spawned
//! (`shell-snapshots/`, `plugins/`, `agents/`, …: the routes back to host code
//! execution `sandbox::CLAUDE_UNMOUNTED` exists to close). The narrowing is the
//! fence; it stays.
//!
//! # So: one inode, written in place
//!
//! The mirror lives at `<state_dir>/agent-creds/claude/.credentials.json`
//! (0600, directory 0700) and is the file every fence mounts at the real path.
//! Its inode is created once and never replaced: every write to it is
//! open-truncate-write, never a rename, so a tab that mounted it an hour ago is
//! still looking at the bytes written a second ago. `sync_from_host` copies the
//! host record into it whenever the host changes (a `notify` watch on the host
//! file's **parent directory** — a watch on the file itself dies with the
//! rename that replaces it — plus a 60 s poll for the events a filesystem
//! drops). `sync_to_host` carries a refresh a fenced tab managed to persist
//! back to the host, so a terminal-run `claude` sees it too. Both directions
//! are no-ops on identical content, so there is no ping-pong, and a **cleared
//! record is never pushed from mirror to host**: a tab that failed its refresh
//! blanks the tokens in place, and copying that to the host would log the user
//! out everywhere — the very symptom this module exists to end.
//!
//! Which side wins when both hold a usable record is decided by the token's
//! own `expiresAt` (the later one is the newer rotation), then by mtime; the
//! host wins a tie, because it is the file the user can see and the one every
//! uncontained CLI reads. A missing host file is a no-op in every direction:
//! it means logged out (or never logged in), and Eldrun must not manufacture
//! a login from a copy.
//!
//! Only Linux mounts the mirror. macOS is untouched: Seatbelt can deny but not
//! substitute a path, so there the real file stays in place and writable
//! (`sandbox::claude_credential_mounts` returns the identical-path pair);
//! Windows fences nothing and refuses the container. Neither creates a mirror
//! or runs the keeper — a second copy of a secret nobody mounts.
//!
//! Codex is deliberately **not** mirrored. Its `~/.codex/auth.json` is written
//! in place (checked 2026-09-07: a live fenced Codex tab and the host see the
//! same inode), so the per-entry file mount keeps following it and the pin is
//! harmless there. Mirroring a file that does not need it would only add a
//! second copy of a secret.
//!
//! AppHandle-free and unit-testable: every function takes the paths it works
//! on, and the process-wide entry points (`mirror_path`, `ensure_mirror_current`,
//! `start`) only resolve the real locations and delegate.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, SystemTime};

use crate::paths;
use crate::storage;

/// Where Claude Code keeps its OAuth record, relative to `$HOME`.
pub const CLAUDE_CREDENTIALS_REL: &str = ".claude/.credentials.json";

/// How long after the first watcher event the sync runs, so a temp-file write
/// followed by its rename is handled once, after the rename.
const DEBOUNCE: Duration = Duration::from_millis(250);

/// The fallback cadence for filesystems and editors whose events never arrive.
/// One `read` of two small files per tick — cheap enough to leave running.
const POLL: Duration = Duration::from_secs(60);

/// The host credential path for a home directory.
pub fn host_path(home: &Path) -> PathBuf {
    CLAUDE_CREDENTIALS_REL
        .split('/')
        .fold(home.to_path_buf(), |p, seg| p.join(seg))
}

/// The mirror path under a given state dir.
pub fn mirror_path_in(state_dir: &Path) -> PathBuf {
    state_dir
        .join("agent-creds")
        .join("claude")
        .join(".credentials.json")
}

/// The mirror path under the real state dir.
pub fn mirror_path() -> PathBuf {
    mirror_path_in(&storage::state_dir())
}

/// What one sync pass did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The source file does not exist; nothing was touched.
    Missing,
    /// Both sides already held the same bytes.
    Unchanged,
    /// The destination was rewritten in place.
    Updated,
    /// The mirror held a cleared/unusable record; it was not pushed.
    Refused,
}

/// Which way a reconcile pass copies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    None,
    HostToMirror,
    MirrorToHost,
}

/// Whether a credential record still holds a token worth having: any
/// non-empty `accessToken` or `refreshToken` string anywhere in the document.
/// Walked recursively rather than indexed by `claudeAiOauth`, so a renamed
/// provider key changes nothing here. A cleared record (`""`/`0`) and a file
/// that is not JSON are both unusable.
pub fn record_is_usable(bytes: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return false;
    };
    fn walk(v: &serde_json::Value) -> bool {
        match v {
            serde_json::Value::Object(map) => map.iter().any(|(k, v)| {
                ((k == "accessToken" || k == "refreshToken")
                    && v.as_str().is_some_and(|s| !s.is_empty()))
                    || walk(v)
            }),
            serde_json::Value::Array(items) => items.iter().any(walk),
            _ => false,
        }
    }
    walk(&value)
}

/// The record's `expiresAt` (the latest one found, if several), used to tell
/// which of two usable records is the newer rotation. `None` when absent.
pub fn expires_at(bytes: &[u8]) -> Option<i64> {
    let value = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
    fn walk(v: &serde_json::Value, best: &mut Option<i64>) {
        match v {
            serde_json::Value::Object(map) => {
                for (k, v) in map {
                    if k == "expiresAt" {
                        if let Some(n) = v.as_i64() {
                            *best = Some(best.map_or(n, |b| b.max(n)));
                        }
                    }
                    walk(v, best);
                }
            }
            serde_json::Value::Array(items) => items.iter().for_each(|i| walk(i, best)),
            _ => {}
        }
    }
    let mut best = None;
    walk(&value, &mut best);
    best
}

/// Decide which way to copy from the two records and whether the mirror's
/// mtime is later than the host's. Pure — see the module docs for the rules.
pub fn plan(host: Option<&[u8]>, mirror: Option<&[u8]>, mirror_newer: bool) -> Direction {
    let Some(host) = host else {
        return Direction::None;
    };
    let Some(mirror) = mirror else {
        return Direction::HostToMirror;
    };
    if host == mirror {
        return Direction::None;
    }
    let (host_ok, mirror_ok) = (record_is_usable(host), record_is_usable(mirror));
    match (host_ok, mirror_ok) {
        (_, false) => Direction::HostToMirror,
        (false, true) => {
            if mirror_newer {
                Direction::MirrorToHost
            } else {
                Direction::HostToMirror
            }
        }
        (true, true) => match (expires_at(host), expires_at(mirror)) {
            (Some(h), Some(m)) if m > h => Direction::MirrorToHost,
            (Some(h), Some(m)) if h > m => Direction::HostToMirror,
            _ if mirror_newer => Direction::MirrorToHost,
            _ => Direction::HostToMirror,
        },
    }
}

/// Write `bytes` to `path` **in place** — open, truncate, write — so the file
/// keeps its inode and every bind mount of it sees the new content. Created
/// 0600 when new; an existing file keeps its mode. Never a rename.
fn write_in_place(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut opts = fs::OpenOptions::new();
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

/// Create the mirror's directory, private to the user.
fn ensure_mirror_dir(mirror: &Path) -> io::Result<()> {
    let Some(dir) = mirror.parent() else {
        return Ok(());
    };
    if dir.is_dir() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

fn read_opt(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Bring the mirror up to the host record, in place. A missing host file is
/// `Missing` and touches nothing — including not creating the mirror, so a
/// logged-out host mounts nothing rather than an empty file.
pub fn sync_from_host(host: &Path, mirror: &Path) -> io::Result<Outcome> {
    let Some(host_bytes) = read_opt(host)? else {
        return Ok(Outcome::Missing);
    };
    let mirror_bytes = read_opt(mirror)?;
    if mirror_bytes.as_deref() == Some(host_bytes.as_slice()) {
        return Ok(Outcome::Unchanged);
    }
    ensure_mirror_dir(mirror)?;
    write_in_place(mirror, &host_bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(mirror, fs::Permissions::from_mode(0o600));
    }
    Ok(Outcome::Updated)
}

/// Carry the mirror's record back to the host, in place — only when the mirror
/// holds a usable record. A cleared record is `Refused`; a missing host file is
/// `Missing` (never created from a copy); identical content is `Unchanged`.
pub fn sync_to_host(host: &Path, mirror: &Path) -> io::Result<Outcome> {
    let Some(mirror_bytes) = read_opt(mirror)? else {
        return Ok(Outcome::Missing);
    };
    let Some(host_bytes) = read_opt(host)? else {
        return Ok(Outcome::Missing);
    };
    if host_bytes == mirror_bytes {
        return Ok(Outcome::Unchanged);
    }
    if !record_is_usable(&mirror_bytes) {
        return Ok(Outcome::Refused);
    }
    write_in_place(host, &mirror_bytes)?;
    Ok(Outcome::Updated)
}

/// One reconcile pass: read both sides, [`plan`] the direction, copy. This is
/// what the watcher and the poll run; both directions are no-ops on identical
/// bytes, so a pass never triggers another.
pub fn reconcile(host: &Path, mirror: &Path) -> io::Result<(Direction, Outcome)> {
    let host_bytes = read_opt(host)?;
    let mirror_bytes = read_opt(mirror)?;
    let mirror_newer = match (mtime(mirror), mtime(host)) {
        (Some(m), Some(h)) => m > h,
        _ => false,
    };
    let dir = plan(host_bytes.as_deref(), mirror_bytes.as_deref(), mirror_newer);
    let outcome = match dir {
        Direction::None => {
            if host_bytes.is_none() {
                Outcome::Missing
            } else {
                Outcome::Unchanged
            }
        }
        Direction::HostToMirror => sync_from_host(host, mirror)?,
        Direction::MirrorToHost => sync_to_host(host, mirror)?,
    };
    Ok((dir, outcome))
}

/// Make sure the mirror exists and holds the host's current record, for the
/// moment a mount plan is built — a freshly spawned tab must start with the
/// token the host has *now*, not the one the last watcher tick saw. Returns the
/// mirror path when there is one to mount; `None` when the host file does not
/// exist or the mirror could not be written.
pub fn ensure_mirror_current(host: &Path, mirror: &Path) -> Option<PathBuf> {
    // A fenced tab may have refreshed since the last tick; carry that first so
    // the new tab (and the copy below) start from the newest rotation.
    match reconcile(host, mirror) {
        Ok((_, Outcome::Missing)) => return None,
        Ok(_) => {}
        Err(e) => {
            eprintln!("agent_creds: reconcile {}: {e}", mirror.display());
            return None;
        }
    }
    if mirror.is_file() {
        Some(mirror.to_path_buf())
    } else {
        None
    }
}

/// Start the background keeper: an initial pass, then a debounced watch on
/// both parent directories plus the poll. One detached thread holding no lock
/// and no child process — it dies with the process, which is all a clean quit
/// requires of it. Errors are logged and never fatal: a missing `~/.claude`
/// simply leaves the poll running.
pub fn start() {
    let host = host_path(&paths::home_dir());
    let mirror = mirror_path();
    if let Err(e) = std::thread::Builder::new()
        .name("agent-creds".into())
        .spawn(move || run(host, mirror))
    {
        eprintln!("agent_creds: spawn watcher: {e}");
    }
}

fn run(host: PathBuf, mirror: PathBuf) {
    if let Err(e) = reconcile(&host, &mirror) {
        eprintln!("agent_creds: initial sync: {e}");
    }
    let (tx, rx) = mpsc::channel::<()>();
    // Kept alive for the thread's lifetime; dropping it unwatches.
    let _watcher = watcher(&host, &mirror, tx);
    loop {
        match rx.recv_timeout(POLL) {
            Ok(()) => {
                // Debounce: a write is usually a temp file, a rename and an
                // attribute change in quick succession — act once, after them.
                std::thread::sleep(DEBOUNCE);
                while rx.try_recv().is_ok() {}
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if let Err(e) = reconcile(&host, &mirror) {
            eprintln!("agent_creds: sync: {e}");
        }
    }
}

/// Watch the **parent directories** of both files, non-recursively, and wake
/// the loop only for events naming one of the two files (or naming nothing —
/// some backends report an overflow that way). The host file itself cannot be
/// watched: the rename that rotates it replaces the watched inode.
fn watcher(host: &Path, mirror: &Path, tx: mpsc::Sender<()>) -> Option<notify::RecommendedWatcher> {
    use notify::{RecursiveMode, Watcher};
    let interesting = [host.to_path_buf(), mirror.to_path_buf()];
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.is_empty() || ev.paths.iter().any(|p| interesting.contains(p)) {
                let _ = tx.send(());
            }
        }
    })
    .ok()?;
    let mut any = false;
    for dir in [host.parent(), mirror.parent()].into_iter().flatten() {
        if dir.is_dir() && w.watch(dir, RecursiveMode::NonRecursive).is_ok() {
            any = true;
        }
    }
    any.then_some(w)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "eldrun-agent-creds-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let home = base.join("home");
        fs::create_dir_all(home.join(".claude")).unwrap();
        let host = host_path(&home);
        let mirror = mirror_path_in(&base.join("state"));
        (base, host, mirror)
    }

    fn record(access: &str, refresh: &str, expires: i64) -> Vec<u8> {
        serde_json::json!({
            "claudeAiOauth": {
                "accessToken": access,
                "refreshToken": refresh,
                "expiresAt": expires,
                "scopes": ["user:inference"],
            }
        })
        .to_string()
        .into_bytes()
    }

    #[cfg(unix)]
    fn inode(path: &Path) -> u64 {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(path).unwrap().ino()
    }

    #[test]
    fn usable_means_a_non_empty_token_anywhere() {
        assert!(record_is_usable(&record("a", "", 1)));
        assert!(record_is_usable(&record("", "r", 1)));
        assert!(!record_is_usable(&record("", "", 0)));
        assert!(!record_is_usable(b"{}"));
        assert!(!record_is_usable(b"not json"));
        assert_eq!(expires_at(&record("a", "r", 42)), Some(42));
        assert_eq!(expires_at(b"{}"), None);
    }

    #[test]
    fn missing_host_file_is_a_no_op_in_every_direction() {
        let (base, host, mirror) = fixture("missing");
        assert_eq!(sync_from_host(&host, &mirror).unwrap(), Outcome::Missing);
        assert!(!mirror.exists(), "a logged-out host must not grow a mirror");
        // Even a usable mirror never creates the host file.
        ensure_mirror_dir(&mirror).unwrap();
        fs::write(&mirror, record("a", "r", 5)).unwrap();
        assert_eq!(sync_to_host(&host, &mirror).unwrap(), Outcome::Missing);
        assert_eq!(reconcile(&host, &mirror).unwrap().0, Direction::None);
        assert!(!host.exists());
        assert_eq!(ensure_mirror_current(&host, &mirror), None);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn identical_content_is_a_no_op_both_ways() {
        let (base, host, mirror) = fixture("same");
        fs::write(&host, record("a", "r", 5)).unwrap();
        assert_eq!(sync_from_host(&host, &mirror).unwrap(), Outcome::Updated);
        assert_eq!(sync_from_host(&host, &mirror).unwrap(), Outcome::Unchanged);
        assert_eq!(sync_to_host(&host, &mirror).unwrap(), Outcome::Unchanged);
        assert_eq!(
            reconcile(&host, &mirror).unwrap(),
            (Direction::None, Outcome::Unchanged)
        );
        fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn mirror_writes_keep_the_inode_and_stay_private() {
        use std::os::unix::fs::PermissionsExt;
        let (base, host, mirror) = fixture("inode");
        fs::write(&host, record("a", "r", 5)).unwrap();
        assert_eq!(sync_from_host(&host, &mirror).unwrap(), Outcome::Updated);
        let first = inode(&mirror);
        assert_eq!(fs::metadata(&mirror).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(
            fs::metadata(mirror.parent().unwrap()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        // The host rotates by rename: a new inode at the same path.
        let tmp = host.with_extension("json.tmp");
        fs::write(&tmp, record("b", "s", 6)).unwrap();
        fs::rename(&tmp, &host).unwrap();
        assert_eq!(sync_from_host(&host, &mirror).unwrap(), Outcome::Updated);
        assert_eq!(inode(&mirror), first, "the mirror must be rewritten in place");
        assert_eq!(fs::read(&mirror).unwrap(), record("b", "s", 6));
        // Shorter content, same inode, no trailing garbage.
        fs::write(&host, b"{}").unwrap();
        assert_eq!(sync_from_host(&host, &mirror).unwrap(), Outcome::Updated);
        assert_eq!(inode(&mirror), first);
        assert_eq!(fs::read(&mirror).unwrap(), b"{}");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_cleared_record_is_never_pushed_to_the_host() {
        let (base, host, mirror) = fixture("cleared");
        fs::write(&host, record("a", "r", 5)).unwrap();
        sync_from_host(&host, &mirror).unwrap();
        // A fenced tab that failed its refresh blanks the record in place.
        fs::write(&mirror, record("", "", 0)).unwrap();
        assert_eq!(sync_to_host(&host, &mirror).unwrap(), Outcome::Refused);
        assert_eq!(fs::read(&host).unwrap(), record("a", "r", 5));
        // The reconcile pass goes the other way and restores the tab's copy.
        assert_eq!(
            reconcile(&host, &mirror).unwrap(),
            (Direction::HostToMirror, Outcome::Updated)
        );
        assert_eq!(fs::read(&mirror).unwrap(), record("a", "r", 5));
        // Pure form: an unusable mirror never wins, however new it is.
        let (good, blank) = (record("a", "r", 5), record("", "", 0));
        assert_eq!(
            plan(Some(good.as_slice()), Some(blank.as_slice()), true),
            Direction::HostToMirror
        );
        assert_eq!(
            plan(Some(b"{}".as_slice()), Some(b"garbage".as_slice()), true),
            Direction::HostToMirror
        );
        fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_fenced_refresh_reaches_the_host_in_place() {
        let (base, host, mirror) = fixture("push");
        fs::write(&host, record("a", "r", 5)).unwrap();
        sync_from_host(&host, &mirror).unwrap();
        let host_inode = inode(&host);
        // The tab rotated to a later-expiring token through the mounted mirror.
        fs::write(&mirror, record("b", "s", 9)).unwrap();
        assert_eq!(
            reconcile(&host, &mirror).unwrap(),
            (Direction::MirrorToHost, Outcome::Updated)
        );
        assert_eq!(fs::read(&host).unwrap(), record("b", "s", 9));
        assert_eq!(inode(&host), host_inode, "the host is rewritten in place too");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn the_later_expiry_wins_and_the_host_wins_ties() {
        let older = record("a", "r", 5);
        let newer = record("b", "s", 9);
        let both = |h: &Vec<u8>, m: &Vec<u8>, newer: bool| plan(Some(h), Some(m), newer);
        assert_eq!(both(&older, &newer, false), Direction::MirrorToHost);
        assert_eq!(both(&newer, &older, true), Direction::HostToMirror);
        // Same expiry, different bytes: mtime breaks the tie, host by default.
        let twin = record("c", "t", 5);
        assert_eq!(both(&older, &twin, true), Direction::MirrorToHost);
        assert_eq!(both(&older, &twin, false), Direction::HostToMirror);
        // A cleared host: the mirror's record wins only if it is the newer write
        // (a logout on the host after the last pull must stick).
        let cleared = record("", "", 0);
        assert_eq!(both(&cleared, &older, true), Direction::MirrorToHost);
        assert_eq!(both(&cleared, &older, false), Direction::HostToMirror);
        // No mirror yet: seed it. No host: nothing.
        assert_eq!(plan(Some(older.as_slice()), None, false), Direction::HostToMirror);
        assert_eq!(plan(None, Some(older.as_slice()), true), Direction::None);
        assert_eq!(both(&older, &older, true), Direction::None);
    }

    #[test]
    fn ensure_mirror_current_seeds_and_refreshes_for_a_spawn() {
        let (base, host, mirror) = fixture("ensure");
        fs::write(&host, record("a", "r", 5)).unwrap();
        assert_eq!(ensure_mirror_current(&host, &mirror), Some(mirror.clone()));
        assert_eq!(fs::read(&mirror).unwrap(), record("a", "r", 5));
        fs::write(&host, record("b", "s", 6)).unwrap();
        assert_eq!(ensure_mirror_current(&host, &mirror), Some(mirror.clone()));
        assert_eq!(fs::read(&mirror).unwrap(), record("b", "s", 6));
        fs::remove_dir_all(&base).ok();
    }
}
