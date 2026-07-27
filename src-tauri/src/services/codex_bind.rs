//! Hook-free Codex session binding — the fallback that keeps Codex tabs
//! resumable when Codex won't run Eldrun's `SessionStart` hook.
//!
//! Codex gates user-level hooks behind a one-time trust approval (`/hooks`), and
//! an untrusted hook never fires — silently. Until the user trusts it, nothing
//! records a tab's live session id, so [`agent_session::resolve_codex_session`]
//! has nothing to resume and every restored Codex tab comes back blank.
//!
//! So we learn the id from Codex's own logs instead. Every session writes
//! `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`, whose first
//! line is a `session_meta` record carrying both `session_id` and `cwd`. We
//! follow that tree for a *new* rollout in a tracked tab's cwd and write its id
//! into the very same `live_sessions/<uid>` file the hook would have written —
//! so the resolve path, and Claude's, stay untouched.
//!
//! Attribution is by cwd and time, which is a heuristic, and it has two known
//! soft spots (the trusted hook has neither, which is why we still install it
//! and still nag):
//!
//! - Two Codex tabs started fresh in the *same* cwd within one tick can end up
//!   with each other's sessions. Both conversations stay resumable — possibly in
//!   the wrong tabs.
//! - A Codex started *outside* Eldrun in a tracked tab's cwd can be mis-claimed
//!   when that tab's `/clear` is being rebound.
//!
//! Remote (ssh) Codex tabs are out of scope: their rollouts live on the far
//! host, so `commands::terminal::pty_spawn` never tracks them. Sandboxed tabs
//! *are* in scope and need no special handling — `services::sandbox` bind-mounts
//! both `~/.codex` and the project cwd at identical paths inside the container,
//! so a sandboxed Codex writes host-shaped rollouts to the host's sessions tree.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use crate::paths;
use crate::services::agent_session;

/// Rollout first lines inline the full base instructions, so they run ~20 KB.
/// Cap the read well above that but far below "a whole transcript".
const MAX_HEAD_BYTES: usize = 1 << 20;

/// mtime granularity + clock skew: a rollout created moments *before* we record
/// the spawn time is still plausibly ours.
const SLACK: Duration = Duration::from_secs(2);

/// A fresh Codex writes its rollout within a second or so of spawning; poll
/// briskly while any tracked tab is young, then settle into a slow watch that
/// only exists to catch a `/clear`.
const FAST_TICK: Duration = Duration::from_millis(400);
const SLOW_TICK: Duration = Duration::from_secs(2);
const FAST_PHASE: Duration = Duration::from_secs(20);

/// A rollout's identifying header: the first JSONL line, when it is a
/// `session_meta` record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RolloutMeta {
    pub id: String,
    pub cwd: PathBuf,
    pub mtime: SystemTime,
}

/// One Codex tab the binder is following.
struct Tracked {
    /// `ELDRUN_TAB_UID` — the key `live_sessions/<uid>` is stored under.
    uid: String,
    /// The tab's cwd, canonicalized where possible (matched against `meta.cwd`).
    cwd: PathBuf,
    /// Spawn time, less `SLACK`. Rollouts older than this were not made by us.
    since: SystemTime,
    /// Rollout ids that already existed when this tab spawned, plus every id
    /// we have since inspected and rejected — never opened twice.
    known: HashSet<String>,
    /// The id currently recorded for this tab, if any.
    bound: Option<String>,
    /// Bumped on every `track` of the same pty id, so a dying old PTY's teardown
    /// can't untrack the tab that just replaced it.
    seq: u64,
}

#[derive(Default)]
struct Binder {
    tabs: HashMap<String, Tracked>,
    next_seq: u64,
}

fn binder() -> &'static Mutex<Binder> {
    static BINDER: OnceLock<Mutex<Binder>> = OnceLock::new();
    BINDER.get_or_init(|| Mutex::new(Binder::default()))
}

fn sessions_root() -> PathBuf {
    paths::home_dir().join(".codex").join("sessions")
}

// ── Pure core ───────────────────────────────────────────────────────────────

/// `rollout-2026-07-11T11-26-43-019f5080-….jsonl` → the trailing uuid.
///
/// The id is right there in the filename, which is what lets `snapshot_ids`
/// enumerate every existing session without opening a single file.
pub fn rollout_id_from_filename(name: &str) -> Option<String> {
    let rest = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    // `<ISO date>T<HH-MM-SS>-<uuid>`: the uuid is the last 5 dash-separated
    // groups, so drop everything before them.
    let parts: Vec<&str> = rest.split('-').collect();
    if parts.len() < 5 {
        return None;
    }
    let id = parts[parts.len() - 5..].join("-");
    agent_session::is_uuidish(&id).then_some(id)
}

/// Every rollout under `root`, as `(path, id, mtime)`. Bounded depth (the tree is
/// `YYYY/MM/DD/file`); stats only, no file contents.
fn walk_rollouts(root: &Path, out: &mut Vec<(PathBuf, String, SystemTime)>) {
    fn walk(dir: &Path, depth: u8, out: &mut Vec<(PathBuf, String, SystemTime)>) {
        if depth > 4 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                walk(&path, depth + 1, out);
            } else if let Some(id) = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(rollout_id_from_filename)
            {
                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                out.push((path, id, mtime));
            }
        }
    }
    walk(root, 0, out);
}

/// Ids of every rollout that exists right now. No file is opened.
pub fn snapshot_ids(root: &Path) -> HashSet<String> {
    let mut found = Vec::new();
    walk_rollouts(root, &mut found);
    found.into_iter().map(|(_, id, _)| id).collect()
}

/// Parse a rollout's `session_meta` header. `None` unless the first line really
/// is one and carries both fields — a half-written line (we may be reading while
/// Codex is still writing) simply fails to parse and is retried next tick.
pub fn read_rollout_meta(path: &Path, mtime: SystemTime) -> Option<RolloutMeta> {
    use std::io::Read;

    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; MAX_HEAD_BYTES];
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);
    let text = String::from_utf8_lossy(&buf);
    let line = text.split('\n').next()?;

    #[derive(serde::Deserialize)]
    struct Head {
        #[serde(rename = "type")]
        kind: String,
        payload: Payload,
    }
    #[derive(serde::Deserialize)]
    struct Payload {
        session_id: String,
        cwd: PathBuf,
    }

    let head: Head = serde_json::from_str(line).ok()?;
    if head.kind != "session_meta" || !agent_session::is_uuidish(&head.payload.session_id) {
        return None;
    }
    Some(RolloutMeta {
        id: head.payload.session_id,
        cwd: head.payload.cwd,
        mtime,
    })
}

/// Pick the rollout that belongs to a tab whose cwd is `cwd`.
///
/// The whole attribution decision, kept pure. A candidate qualifies when it is
/// in the tab's cwd, is not one this tab has already seen or rejected (`known`),
/// and is not already bound to a live sibling tab (`claimed`). Among those we
/// take the **oldest** — a tab's own rollout is the *first* to appear after it
/// spawned, so picking the newest would let a later-spawned sibling in the same
/// cwd steal it.
pub fn pick_binding(
    candidates: &[RolloutMeta],
    cwd: &Path,
    known: &HashSet<String>,
    claimed: &HashSet<String>,
) -> Option<String> {
    candidates
        .iter()
        .filter(|m| !known.contains(&m.id) && !claimed.contains(&m.id) && same_dir(&m.cwd, cwd))
        .min_by_key(|m| m.mtime)
        .map(|m| m.id.clone())
}

/// Compare two directories for identity. Both sides are canonicalized when they
/// still exist (a project can be moved), falling back to a literal compare —
/// which also keeps this honest on Windows, where `payload.cwd` comes back as a
/// `C:\…` path that may or may not carry a `\\?\` prefix.
fn same_dir(a: &Path, b: &Path) -> bool {
    let ca = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let cb = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

// ── Registry ────────────────────────────────────────────────────────────────

/// Start following a Codex tab. `initial` is the session id we just resumed it
/// into (if any) — registered as this tab's claim straight away so a sibling
/// can't take it, and so its bumped mtime (resume *appends* to the existing
/// rollout) isn't mistaken for a new session.
///
/// Idempotent per `pty_id`: a re-spawn replaces the entry and bumps its seq.
/// Returns that seq, for `untrack`.
pub fn track(pty_id: &str, uid: &str, cwd: &Path, initial: Option<String>) -> u64 {
    let root = sessions_root();
    let mut known = snapshot_ids(&root);
    if let Some(id) = &initial {
        known.insert(id.clone());
    }
    let since = SystemTime::now() - SLACK;
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());

    {
        let mut b = binder().lock().unwrap();
        b.next_seq += 1;
        let seq = b.next_seq;
        b.tabs.insert(
            pty_id.to_string(),
            Tracked {
                uid: uid.to_string(),
                cwd,
                since,
                known,
                bound: initial,
                seq,
            },
        );
        ensure_poller();
        seq
    }
}

/// Stop following the tab a *specific* spawn of `pty_id` created. The seq guard
/// matters because a PTY's death is observed asynchronously: without it, the
/// dying old process of a re-spawned tab would untrack the live new one.
pub fn untrack(pty_id: &str, seq: u64) {
    let mut b = binder().lock().unwrap();
    if b.tabs.get(pty_id).is_some_and(|t| t.seq == seq) {
        b.tabs.remove(pty_id);
    }
}

/// Stop following `pty_id` outright — the tab itself is gone (explicit kill), so
/// there is no successor spawn to protect.
pub fn untrack_now(pty_id: &str) {
    binder().lock().unwrap().tabs.remove(pty_id);
}

/// The seq currently tracking `pty_id`, if any. Lets `spawn_pty` hand its
/// teardown a token without plumbing `track`'s return value through the wrapper
/// layers between them.
pub fn current_seq(pty_id: &str) -> Option<u64> {
    binder().lock().unwrap().tabs.get(pty_id).map(|t| t.seq)
}

// ── Poll loop ───────────────────────────────────────────────────────────────

/// Start the single global poll task, once. It owns every tracked tab: one walk
/// of the sessions tree per tick serves all of them.
fn ensure_poller() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    tokio::spawn(async move {
        loop {
            let tick = poll_once(&sessions_root());
            tokio::time::sleep(tick).await;
        }
    });
}

/// A tracked tab, copied out from under the lock so the tick's filesystem work
/// never holds it.
struct Snapshot {
    pty: String,
    uid: String,
    cwd: PathBuf,
    since: SystemTime,
    known: HashSet<String>,
    bound: Option<String>,
}

/// One pass: bind every tracked tab that can be bound. Returns how long to wait
/// before the next pass.
fn poll_once(root: &Path) -> Duration {
    let tabs: Vec<Snapshot> = {
        let b = binder().lock().unwrap();
        b.tabs
            .iter()
            .map(|(pty, t)| Snapshot {
                pty: pty.clone(),
                uid: t.uid.clone(),
                cwd: t.cwd.clone(),
                since: t.since,
                known: t.known.clone(),
                bound: t.bound.clone(),
            })
            .collect()
    };
    if tabs.is_empty() {
        return SLOW_TICK;
    }

    let earliest = tabs.iter().map(|t| t.since).min().unwrap();
    let now = SystemTime::now();
    let young = tabs
        .iter()
        .any(|t| now.duration_since(t.since).unwrap_or_default() < FAST_PHASE);

    // Stat-only filter first: the vast majority of rollouts predate every tracked
    // tab, and those we never open.
    let mut found = Vec::new();
    walk_rollouts(root, &mut found);
    let fresh: Vec<(PathBuf, String, SystemTime)> = found
        .into_iter()
        .filter(|(_, _, mtime)| *mtime >= earliest)
        .collect();

    // Ids bound to *some* live tab — off-limits to every other tab.
    let claimed: HashSet<String> = tabs.iter().filter_map(|t| t.bound.clone()).collect();

    // Parse each fresh rollout at most once per tick, and only when at least one
    // tab hasn't already written it off.
    let metas: Vec<RolloutMeta> = fresh
        .iter()
        .filter(|(_, id, _)| tabs.iter().any(|t| !t.known.contains(id)))
        .filter_map(|(path, _, mtime)| read_rollout_meta(path, *mtime))
        .collect();

    let live_dir = agent_session::live_sessions_dir();
    for Snapshot {
        pty,
        uid,
        cwd,
        since: _,
        known,
        bound,
    } in tabs
    {
        // The trusted hook, if it is running, is strictly more precise than we
        // are — so if it has recorded an id we didn't put there, it wins.
        if let Some(hook_id) = agent_session::read_live_session_in(&live_dir, &uid) {
            if Some(&hook_id) != bound.as_ref() && !known.contains(&hook_id) {
                adopt(&pty, hook_id);
                continue;
            }
        }

        let mut mine = claimed.clone();
        if let Some(b) = &bound {
            mine.remove(b); // our own claim doesn't block us
        }
        let inspected: Vec<String> = metas.iter().map(|m| m.id.clone()).collect();

        match pick_binding(&metas, &cwd, &known, &mine) {
            Some(id) => {
                if let Err(e) = agent_session::write_live_session_in(&live_dir, &uid, &id) {
                    eprintln!("codex_bind: record session for {uid}: {e}");
                    continue;
                }
                adopt(&pty, id);
            }
            None => remember(&pty, inspected),
        }
    }

    if young {
        FAST_TICK
    } else {
        SLOW_TICK
    }
}

/// Record `id` as a tab's bound session (and never reconsider it).
fn adopt(pty_id: &str, id: String) {
    let mut b = binder().lock().unwrap();
    if let Some(t) = b.tabs.get_mut(pty_id) {
        t.known.insert(id.clone());
        t.bound = Some(id);
    }
}

/// Write off rollouts this tab has now looked at and does not want, so a later
/// tick never opens them again.
fn remember(pty_id: &str, ids: Vec<String>) {
    let mut b = binder().lock().unwrap();
    if let Some(t) = b.tabs.get_mut(pty_id) {
        t.known.extend(ids);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp(prefix: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()))
    }

    fn meta(id: &str, cwd: &str, secs: u64) -> RolloutMeta {
        RolloutMeta {
            id: id.to_string(),
            cwd: PathBuf::from(cwd),
            mtime: SystemTime::UNIX_EPOCH + Duration::from_secs(secs),
        }
    }

    const A: &str = "019f5080-245c-7813-8a7c-0e3c988ff891";
    const B: &str = "019f5081-1111-7813-8a7c-0e3c988ff892";
    const C: &str = "019f5082-2222-7813-8a7c-0e3c988ff893";

    #[test]
    fn rollout_id_parses_out_of_the_filename() {
        assert_eq!(
            rollout_id_from_filename(&format!("rollout-2026-07-11T11-26-43-{A}.jsonl")).as_deref(),
            Some(A)
        );
        assert_eq!(rollout_id_from_filename("notes.txt"), None);
        assert_eq!(rollout_id_from_filename("rollout-short.jsonl"), None);
        // A `.jsonl` that isn't a rollout at all.
        assert_eq!(rollout_id_from_filename("session-2026.jsonl"), None);
    }

    #[test]
    fn snapshot_ids_opens_no_files() {
        let root = unique_tmp("eldrun-bind-snap");
        let day = root.join("2026").join("07").join("11");
        std::fs::create_dir_all(&day).unwrap();
        for id in [A, B] {
            // Deliberately unparseable content: ids must come from the names.
            std::fs::write(day.join(format!("rollout-2026-07-11T11-26-43-{id}.jsonl")), b"").unwrap();
        }
        std::fs::write(day.join("stray.txt"), b"x").unwrap();

        let ids = snapshot_ids(&root);
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(A) && ids.contains(B));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_rollout_meta_handles_a_fat_header_and_rejects_non_meta() {
        let root = unique_tmp("eldrun-bind-head");
        std::fs::create_dir_all(&root).unwrap();

        // Real headers inline ~20 KB of base instructions ahead of nothing in
        // particular — the fields must still come out.
        let filler = "x".repeat(30_000);
        let good = root.join("good.jsonl");
        std::fs::write(
            &good,
            format!(
                "{{\"timestamp\":\"t\",\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{A}\",\"cwd\":\"/home/u/proj\",\"base_instructions\":{{\"text\":\"{filler}\"}}}}}}\n{{\"type\":\"turn\"}}\n"
            ),
        )
        .unwrap();
        let m = read_rollout_meta(&good, SystemTime::UNIX_EPOCH).unwrap();
        assert_eq!(m.id, A);
        assert_eq!(m.cwd, PathBuf::from("/home/u/proj"));

        // Not a session_meta first line.
        let other = root.join("other.jsonl");
        std::fs::write(&other, "{\"type\":\"turn_context\",\"payload\":{}}\n").unwrap();
        assert_eq!(read_rollout_meta(&other, SystemTime::UNIX_EPOCH), None);

        // Torn line (we may read while Codex is still writing) → no panic, no id.
        let torn = root.join("torn.jsonl");
        std::fs::write(&torn, "{\"type\":\"session_meta\",\"payl").unwrap();
        assert_eq!(read_rollout_meta(&torn, SystemTime::UNIX_EPOCH), None);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pick_binding_takes_the_oldest_unclaimed_rollout_in_the_tab_cwd() {
        let cwd = PathBuf::from("/home/u/proj");
        let candidates = vec![
            meta(A, "/home/u/other", 10), // wrong cwd
            meta(B, "/home/u/proj", 30),  // right cwd, but younger than C
            meta(C, "/home/u/proj", 20),  // ← the tab's own: first to appear
        ];
        assert_eq!(
            pick_binding(&candidates, &cwd, &HashSet::new(), &HashSet::new()).as_deref(),
            Some(C)
        );
    }

    #[test]
    fn pick_binding_ignores_rollouts_that_predate_the_tab() {
        // Ids present at spawn live in `known` and are never ours.
        let cwd = PathBuf::from("/home/u/proj");
        let candidates = vec![meta(A, "/home/u/proj", 10)];
        let known: HashSet<String> = [A.to_string()].into_iter().collect();
        assert_eq!(pick_binding(&candidates, &cwd, &known, &HashSet::new()), None);
    }

    #[test]
    fn pick_binding_never_steals_a_sibling_tabs_session() {
        // Two tabs, one cwd: the only new rollout is already bound to tab A, so
        // tab B must come away with nothing rather than hijack it.
        let cwd = PathBuf::from("/home/u/proj");
        let candidates = vec![meta(A, "/home/u/proj", 10)];
        let claimed: HashSet<String> = [A.to_string()].into_iter().collect();
        assert_eq!(pick_binding(&candidates, &cwd, &HashSet::new(), &claimed), None);
    }
}
