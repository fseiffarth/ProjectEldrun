//! The shared tab set of a scope — the workspace service (headless owner plan,
//! H1, `docs/headless_owner_plan.md` §2).
//!
//! What every client must see identically is a scope's ordered tabs with
//! their persisted fields (`TerminalSession::tab_layout`). Until now each
//! client wrote that back **whole** (`save_tab_layout`): two writers erased
//! each other's tabs, and one client racing itself lost four. Here the file
//! carries a version, every tab a stable `id`, and a client sends its snapshot
//! together with the version it last saw. The difference between that
//! snapshot and what the client knew at that version is the per-operation
//! change it meant — create, close, edit, reorder — and only that is applied
//! onto the current set, so a tab another client created in the meantime
//! survives, and a tab another client closed stays closed.
//!
//! The desktop and the Mobile sidecar both run this against the same file,
//! serialised by the file's advisory lock, so no single owner *process* has to
//! be alive for a write to be safe — the versioned file is the authority.
//!
//! What stays a client's own: the pane tree, the focused tab and the open
//! session list (`tab_groups`, `active_tab_index`, `open_tab_sessions`). They
//! ride in the same file for now, written by the desktop as its layout; the
//! merge never reads them.
//!
//! Bookkeeping lives in the session's `extra` (`workspaceVersion`,
//! `workspaceClosed`) and each tab's (`id`, `createdVersion`), so a file
//! written by an older Eldrun reads as version 0 and is adopted on its first
//! sync — nothing about the on-disk shape changed for anyone else.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::schema::project::TabEntry;
use crate::schema::session::TerminalSession;
use crate::services::terminal_service;
use crate::storage;

/// What a whole-snapshot writer is told once a scope is versioned.
pub const OWNED_ERROR: &str =
    "this scope's tab set is held by the workspace service; save it through workspace_sync";

/// `TerminalSession.extra`: the scope's version, `0`/absent for a file no
/// revision-aware Eldrun has synced yet.
pub const VERSION_KEY: &str = "workspaceVersion";
/// `TerminalSession.extra`: `[{id, version}]` of the tabs closed most
/// recently, so a client that still carries one of them (it had not seen the
/// close) does not bring it back.
pub const CLOSED_KEY: &str = "workspaceClosed";
/// `TabEntry.extra`: the tab's stable identity across clients and restarts.
/// The persisted `key` is not one — every restore mints a fresh key.
pub const TAB_ID_KEY: &str = "id";
/// `TabEntry.extra`: the version the service first saw the tab at. A client
/// whose base is older never knew it, so its snapshot lacking the tab is not
/// a close.
pub const TAB_CREATED_KEY: &str = "createdVersion";
/// Tombstones kept per scope; the oldest fall off.
const MAX_TOMBSTONES: usize = 64;

/// The version a session carries (`0` = never synced).
pub fn version_of(session: &TerminalSession) -> u64 {
    session.extra.get(VERSION_KEY).and_then(Value::as_u64).unwrap_or(0)
}

/// Whether the workspace service holds this scope's tab set — from its first
/// sync on. A whole-snapshot save is refused from then on.
pub fn is_owned(session: &TerminalSession) -> bool {
    version_of(session) > 0
}

pub fn tab_id(tab: &TabEntry) -> Option<&str> {
    tab.extra.get(TAB_ID_KEY).and_then(Value::as_str).filter(|id| !id.is_empty())
}

fn created_version(tab: &TabEntry) -> u64 {
    tab.extra.get(TAB_CREATED_KEY).and_then(Value::as_u64).unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Tombstone {
    id: String,
    version: u64,
}

fn tombstones(session: &TerminalSession) -> Vec<Tombstone> {
    session
        .extra
        .get(CLOSED_KEY)
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn set_tombstones(session: &mut TerminalSession, mut stones: Vec<Tombstone>) {
    if stones.len() > MAX_TOMBSTONES {
        stones.drain(..stones.len() - MAX_TOMBSTONES);
    }
    if stones.is_empty() {
        session.extra.remove(CLOSED_KEY);
    } else if let Ok(value) = serde_json::to_value(&stones) {
        session.extra.insert(CLOSED_KEY.to_string(), value);
    }
}

fn set_version(session: &mut TerminalSession, version: u64) {
    session.extra.insert(VERSION_KEY.to_string(), Value::from(version));
}

/// Give every tab without one a stable id, and an unversioned session version
/// 1. Returns whether anything changed. Pure; the caller writes.
pub fn adopt(session: &mut TerminalSession) -> bool {
    let mut changed = false;
    let version = version_of(session).max(1);
    let mut ids: HashSet<String> = session.tab_layout.iter().filter_map(tab_id).map(str::to_string).collect();
    for tab in session.tab_layout.iter_mut() {
        if tab_id(tab).is_none() {
            let id = fresh_id(&ids);
            ids.insert(id.clone());
            tab.extra.insert(TAB_ID_KEY.to_string(), Value::String(id));
            changed = true;
        }
        if !tab.extra.contains_key(TAB_CREATED_KEY) {
            tab.extra.insert(TAB_CREATED_KEY.to_string(), Value::from(version));
            changed = true;
        }
    }
    if version_of(session) == 0 {
        set_version(session, 1);
        changed = true;
    }
    changed
}

fn fresh_id(taken: &HashSet<String>) -> String {
    let mut id = crate::commands::projects::uuid_v4();
    while taken.contains(&id) {
        id = crate::commands::projects::uuid_v4();
    }
    id
}

// ── The protocol ────────────────────────────────────────────────────────────

/// A client's view of a scope: what it sends to sync, the tab set it holds at
/// `base_version` plus its own layout. Tauri payloads use the frontend's
/// camelCase keys.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientSync {
    /// The version the client last received (a snapshot or a sync answer);
    /// `0` for a client that never did.
    #[serde(default)]
    pub base_version: u64,
    pub tabs: Vec<TabEntry>,
    /// The client's pane tree; `None` leaves the stored one alone.
    #[serde(default)]
    pub groups: Option<Value>,
    /// The open agent-session list; `Some([])` clears it, `None` keeps it.
    #[serde(default)]
    pub sessions: Option<Value>,
    #[serde(default)]
    pub active_tab_index: Option<usize>,
    /// What lets an **empty** `tabs` close every tab the client knew, rather
    /// than reading as a client that had nothing loaded (see
    /// `terminal_service::write_terminal_session`).
    #[serde(default)]
    pub allow_clear: bool,
}

/// One change the merge applied, for the `workspace:patch` event.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    Created { id: String },
    Closed { id: String },
    Updated { id: String },
    Reordered,
}

/// What a sync answers: the version now on disk and the tab set as stored,
/// each tab carrying its `id` (the client learns the ids of the tabs it
/// created) under the `key` the client sent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub version: u64,
    pub tabs: Vec<TabEntry>,
    pub ops: Vec<Op>,
    /// The client's base was behind: something else wrote in between, and
    /// its change was merged rather than applied verbatim.
    pub stale: bool,
}

/// A scope's state as a client receives it on connect.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u64,
    #[serde(flatten)]
    pub session: TerminalSession,
}

/// The tab minus the service's own bookkeeping — what "changed" compares.
fn comparable(tab: &TabEntry) -> Value {
    let mut value = serde_json::to_value(tab).unwrap_or(Value::Null);
    if let Some(obj) = value.as_object_mut() {
        obj.remove(TAB_CREATED_KEY);
    }
    value
}

/// Merge a client's snapshot onto `session` (already adopted), in memory.
///
/// - A client tab whose id the set holds is **kept** with the client's
///   fields (field edits are last-writer-wins).
/// - A client tab with no id, or an id the set never held, is **created** —
///   unless the id was closed after the client's base, in which case the
///   close stands.
/// - A held tab missing from the snapshot is **closed** if the client knew it
///   (`createdVersion <= base`) and **kept** if it was created after the
///   client's base, in its place next to the neighbour it had.
/// - The client's order applies to the tabs it knows.
///
/// An empty snapshot without `allow_clear` is a client with nothing loaded:
/// nothing changes.
fn merge(session: &TerminalSession, client: &ClientSync) -> (Vec<TabEntry>, Vec<Op>, Vec<Tombstone>) {
    let version = version_of(session);
    let next_version = version + 1;
    let base = client.base_version;
    let current = &session.tab_layout;
    let mut stones = tombstones(session);
    if client.tabs.is_empty() && !client.allow_clear {
        return (current.clone(), Vec::new(), stones);
    }
    let current_by_id: HashMap<&str, &TabEntry> = current.iter().filter_map(|t| tab_id(t).map(|id| (id, t))).collect();
    let closed_after_base: HashSet<String> =
        stones.iter().filter(|s| s.version > base).map(|s| s.id.clone()).collect();
    let mut taken: HashSet<String> = current_by_id.keys().map(|id| id.to_string()).collect();
    for stone in &stones {
        taken.insert(stone.id.clone());
    }

    let mut result: Vec<TabEntry> = Vec::with_capacity(client.tabs.len());
    let mut ops: Vec<Op> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for tab in &client.tabs {
        let mut next = tab.clone();
        match tab_id(tab).map(str::to_string) {
            Some(id) if current_by_id.contains_key(id.as_str()) => {
                if !seen.insert(id.clone()) {
                    continue; // the client listed one tab twice
                }
                let held = current_by_id[id.as_str()];
                next.extra.insert(TAB_CREATED_KEY.to_string(), Value::from(created_version(held)));
                if comparable(&next) != comparable(held) {
                    ops.push(Op::Updated { id });
                }
                result.push(next);
            }
            Some(id) if closed_after_base.contains(id.as_str()) => {
                // Closed elsewhere after this client last looked: the close wins.
                continue;
            }
            Some(id) => {
                if !seen.insert(id.clone()) {
                    continue;
                }
                // A client-minted id, or a tab this client re-opened: a create.
                taken.insert(id.clone());
                next.extra.insert(TAB_CREATED_KEY.to_string(), Value::from(next_version));
                stones.retain(|s| s.id != id);
                ops.push(Op::Created { id });
                result.push(next);
            }
            None => {
                let id = fresh_id(&taken);
                taken.insert(id.clone());
                seen.insert(id.clone());
                next.extra.insert(TAB_ID_KEY.to_string(), Value::String(id.clone()));
                next.extra.insert(TAB_CREATED_KEY.to_string(), Value::from(next_version));
                ops.push(Op::Created { id });
                result.push(next);
            }
        }
    }

    // Held tabs the client did not send: closed by it, or unknown to it.
    let mut inserted_after: Option<usize> = None;
    for (index, held) in current.iter().enumerate() {
        let Some(id) = tab_id(held) else { continue };
        if seen.contains(id) {
            continue;
        }
        if created_version(held) <= base {
            ops.push(Op::Closed { id: id.to_string() });
            stones.push(Tombstone { id: id.to_string(), version: next_version });
            continue;
        }
        // Created after the client's base: keep it where it was, after the
        // nearest earlier neighbour the result still holds.
        let neighbour = current[..index]
            .iter()
            .rev()
            .filter_map(tab_id)
            .find_map(|prev| result.iter().position(|t| tab_id(t) == Some(prev)));
        let at = match (neighbour, inserted_after) {
            (Some(n), _) => n + 1,
            (None, Some(last)) => last + 1,
            (None, None) => 0,
        };
        result.insert(at, held.clone());
        inserted_after = Some(at);
    }

    // Reordered: the tabs both sides hold, in a different order.
    let before: Vec<&str> = current.iter().filter_map(tab_id).filter(|id| seen.contains(*id)).collect();
    let after: Vec<&str> = result.iter().filter_map(tab_id).filter(|id| seen.contains(*id)).collect();
    if before != after {
        ops.push(Op::Reordered);
    }
    (result, ops, stones)
}

// ── File-level entry points ─────────────────────────────────────────────────

fn read_session(path: &Path) -> Result<TerminalSession, String> {
    if !path.exists() {
        return Ok(TerminalSession::default());
    }
    storage::read_json(path).map_err(|e| format!("read {}: {e}", path.display()))
}

fn write_session(path: &Path, session: &TerminalSession) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create session dir: {e}"))?;
    }
    storage::write_json_atomic(path, session).map_err(|e| e.to_string())
}

/// Read a scope's state for a client. A file with tabs that predates the
/// service is adopted (ids, version 1) and written back; an absent or empty
/// one stays version 0, so a scope nobody ever opened grows no file.
pub fn snapshot_in(path: &Path) -> Result<Snapshot, String> {
    let _lock = storage::FileLock::exclusive(path).map_err(|e| format!("lock {}: {e}", path.display()))?;
    let mut session = read_session(path)?;
    if !session.tab_layout.is_empty() && adopt(&mut session) {
        write_session(path, &session)?;
    }
    Ok(Snapshot { version: version_of(&session), session })
}

/// Apply a client's snapshot onto the file: read, adopt, merge, write — all
/// under the file's lock, so a second process cannot interleave. Nothing is
/// written when nothing changed.
pub fn sync_in(path: &Path, client: ClientSync) -> Result<SyncOutcome, String> {
    let _lock = storage::FileLock::exclusive(path).map_err(|e| format!("lock {}: {e}", path.display()))?;
    let mut session = read_session(path)?;
    let adopted = adopt(&mut session);
    let version = version_of(&session);
    let stale = client.base_version < version && client.base_version > 0;
    let (tabs, ops, stones) = merge(&session, &client);

    let mut next_groups = session.tab_groups.clone();
    if tabs.is_empty() {
        next_groups = None;
    } else if client.groups.is_some() {
        next_groups = client.groups.clone();
    }
    let next_sessions = match &client.sessions {
        Some(s) if s.as_array().is_some_and(|a| a.is_empty()) => None,
        Some(s) => Some(s.clone()),
        None => session.open_tab_sessions.clone(),
    };
    let next_active = client.active_tab_index.unwrap_or(session.active_tab_index);
    let layout_changed = next_groups != session.tab_groups
        || next_sessions != session.open_tab_sessions
        || next_active != session.active_tab_index;

    if ops.is_empty() && !layout_changed && !adopted {
        return Ok(SyncOutcome { version, tabs: session.tab_layout, ops, stale });
    }
    session.tab_layout = tabs;
    session.tab_groups = next_groups;
    session.open_tab_sessions = next_sessions;
    session.active_tab_index = next_active;
    set_tombstones(&mut session, stones);
    // A layout-only change moves the version too: the version names the file,
    // not just the tab set, so a client can tell any write from none.
    set_version(&mut session, version + 1);
    write_session(path, &session)?;
    Ok(SyncOutcome { version: version + 1, tabs: session.tab_layout, ops, stale })
}

/// A backend-side edit of the whole session (a path rewrite, an adoption from
/// a project folder): applied under the lock, ids assigned to new tabs, the
/// version bumped, tabs that vanished tombstoned. Returns what was stored.
pub fn edit_in(
    path: &Path,
    edit: impl FnOnce(&mut TerminalSession) -> Result<(), String>,
) -> Result<TerminalSession, String> {
    let _lock = storage::FileLock::exclusive(path).map_err(|e| format!("lock {}: {e}", path.display()))?;
    let mut session = read_session(path)?;
    adopt(&mut session);
    let version = version_of(&session);
    let before: Vec<String> = session.tab_layout.iter().filter_map(tab_id).map(str::to_string).collect();
    edit(&mut session)?;
    let mut ids: HashSet<String> = session.tab_layout.iter().filter_map(tab_id).map(str::to_string).collect();
    for tab in session.tab_layout.iter_mut() {
        if tab_id(tab).is_none() {
            let id = fresh_id(&ids);
            ids.insert(id.clone());
            tab.extra.insert(TAB_ID_KEY.to_string(), Value::String(id));
            tab.extra.insert(TAB_CREATED_KEY.to_string(), Value::from(version + 1));
        } else if !tab.extra.contains_key(TAB_CREATED_KEY) {
            tab.extra.insert(TAB_CREATED_KEY.to_string(), Value::from(version + 1));
        }
    }
    let mut stones = tombstones(&session);
    for id in before.into_iter().filter(|id| !ids.contains(id)) {
        stones.push(Tombstone { id, version: version + 1 });
    }
    set_tombstones(&mut session, stones);
    set_version(&mut session, version + 1);
    write_session(path, &session)?;
    Ok(session)
}

/// Bump the version of a session held as raw JSON (the path rewrite keeps
/// fields this build does not model). A no-op for an unversioned file.
pub fn bump_raw_version(session: &mut Value) {
    if let Some(version) = session.get(VERSION_KEY).and_then(Value::as_u64) {
        session[VERSION_KEY] = Value::from(version + 1);
    }
}

// ── Project-keyed wrappers ──────────────────────────────────────────────────

/// [`snapshot_in`] for a project scope, sanitized like every load.
pub fn snapshot(project_id: &str) -> Result<Snapshot, String> {
    let mut snapshot = snapshot_in(&terminal_service::state_session_path(project_id))?;
    terminal_service::sanitize_loaded_layout(&mut snapshot.session.tab_layout);
    Ok(snapshot)
}

/// [`sync_in`] for a project scope, then the state-dir write's companions:
/// stale host-bound markers pruned and the project-tree export copy refreshed
/// (`terminal_service::store_state_session`).
pub fn sync(project_id: &str, local_file: &str, client: ClientSync) -> Result<SyncOutcome, String> {
    let path = terminal_service::state_session_path(project_id);
    let outcome = sync_in(&path, client)?;
    if !outcome.ops.is_empty() {
        terminal_service::after_state_session_write(project_id, local_file);
    }
    Ok(outcome)
}

/// [`edit_in`] for a project scope, with the same companions as [`sync`].
pub fn edit(
    project_id: &str,
    local_file: &str,
    edit: impl FnOnce(&mut TerminalSession) -> Result<(), String>,
) -> Result<TerminalSession, String> {
    let session = edit_in(&terminal_service::state_session_path(project_id), edit)?;
    terminal_service::after_state_session_write(project_id, local_file);
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(key: &str, label: &str) -> TabEntry {
        let mut extra = HashMap::new();
        extra.insert("kind".to_string(), Value::String("shell".to_string()));
        TabEntry {
            key: key.to_string(),
            label: label.to_string(),
            cmd: String::new(),
            cwd: "/tmp".to_string(),
            session_id: None,
            extra,
        }
    }

    fn ids(tabs: &[TabEntry]) -> Vec<&str> {
        tabs.iter().filter_map(tab_id).collect()
    }

    fn labels(tabs: &[TabEntry]) -> Vec<&str> {
        tabs.iter().map(|t| t.label.as_str()).collect()
    }

    fn client(base: u64, tabs: Vec<TabEntry>) -> ClientSync {
        ClientSync { base_version: base, tabs, allow_clear: true, ..Default::default() }
    }

    fn file() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions").join("p").join("terminals.json");
        (dir, path)
    }

    #[test]
    fn a_legacy_file_is_adopted_once_with_ids_and_version_one() {
        let (_dir, path) = file();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"tabLayout":[{"key":"k1","label":"A","cmd":"","cwd":"/tmp","kind":"shell"},{"key":"k2","label":"B","cmd":"","cwd":"/tmp"}],"activeTabIndex":1,"tabGroups":{"type":"group","tabKeys":["k1","k2"],"activeKey":"k2"},"openApps":[]}"#,
        )
        .unwrap();
        let snap = snapshot_in(&path).unwrap();
        assert_eq!(snap.version, 1);
        assert_eq!(snap.session.tab_layout.len(), 2);
        assert!(snap.session.tab_layout.iter().all(|t| tab_id(t).is_some()));
        assert_eq!(snap.session.active_tab_index, 1, "the client's layout survived");
        assert!(snap.session.tab_groups.is_some());
        let again = snapshot_in(&path).unwrap();
        assert_eq!(ids(&again.session.tab_layout), ids(&snap.session.tab_layout), "ids are stable");
        assert_eq!(again.version, 1);
        // An absent file is version 0 and grows no file.
        let (_dir, empty) = file();
        assert_eq!(snapshot_in(&empty).unwrap().version, 0);
        assert!(!empty.exists());
    }

    #[test]
    fn a_first_sync_creates_the_tabs_and_hands_back_their_ids() {
        let (_dir, path) = file();
        let out = sync_in(&path, client(0, vec![tab("k1", "A"), tab("k2", "B")])).unwrap();
        assert_eq!(out.version, 2, "adopted (1) then written (2)");
        assert!(!out.stale);
        assert_eq!(out.tabs.iter().map(|t| t.key.as_str()).collect::<Vec<_>>(), ["k1", "k2"]);
        assert!(out.tabs.iter().all(|t| tab_id(t).is_some()));
        assert_eq!(out.ops.iter().filter(|op| matches!(op, Op::Created { .. })).count(), 2);
        // Nothing changed: nothing written, same version.
        let same = sync_in(&path, client(out.version, out.tabs.clone())).unwrap();
        assert_eq!(same.version, out.version);
        assert!(same.ops.is_empty());
    }

    /// The plan's owner test: two clients rename, reorder and close tabs
    /// concurrently, and the final set is the owner's, with no tab lost.
    #[test]
    fn two_clients_edit_the_same_scope_and_neither_loses_the_others_tabs() {
        let (_dir, path) = file();
        let seeded = sync_in(&path, client(0, vec![tab("a", "A"), tab("b", "B"), tab("c", "C")])).unwrap();
        let base = seeded.version;
        let [a, b, c] = [&seeded.tabs[0], &seeded.tabs[1], &seeded.tabs[2]].map(|t| t.clone());

        // Client 1 (the desktop) renames A, closes B, opens D.
        let mut a1 = a.clone();
        a1.label = "A renamed".into();
        let one = sync_in(&path, client(base, vec![a1.clone(), c.clone(), tab("d", "D")])).unwrap();
        assert_eq!(labels(&one.tabs), ["A renamed", "C", "D"]);
        assert!(one.ops.contains(&Op::Closed { id: tab_id(&b).unwrap().to_string() }));

        // Client 2 (a phone through the sidecar) still holds the seeded set:
        // it reorders C before A, colours C, and opens E — never having seen
        // client 1's changes.
        let mut c2 = c.clone();
        c2.extra.insert("color".into(), Value::String("blue".into()));
        let two = sync_in(&path, client(base, vec![c2, a.clone(), b.clone(), tab("e", "E")])).unwrap();
        assert!(two.stale, "its base was behind");
        let final_labels = labels(&two.tabs);
        assert!(!final_labels.contains(&"B"), "B stays closed: {final_labels:?}");
        assert!(final_labels.contains(&"D"), "D, created by client 1, survives: {final_labels:?}");
        assert!(final_labels.contains(&"E"), "E, created by client 2, lands: {final_labels:?}");
        assert!(
            final_labels.iter().position(|l| *l == "C") < final_labels.iter().position(|l| l.starts_with('A')),
            "client 2's order applies to the tabs it knew: {final_labels:?}"
        );
        let c_now = two.tabs.iter().find(|t| t.label == "C").unwrap();
        assert_eq!(c_now.extra["color"], "blue");
        // Field edits are last-writer-wins: client 2 sent A's old label.
        assert!(final_labels.contains(&"A"), "{final_labels:?}");
        assert_eq!(two.tabs.len(), 4);

        // Both clients converge on the stored set from here.
        let three = sync_in(&path, client(two.version, two.tabs.clone())).unwrap();
        assert!(three.ops.is_empty());
        assert_eq!(three.version, two.version);
    }

    #[test]
    fn a_tab_created_after_the_clients_base_keeps_its_place() {
        let (_dir, path) = file();
        let seeded = sync_in(&path, client(0, vec![tab("a", "A"), tab("b", "B")])).unwrap();
        let base = seeded.version;
        // Someone else inserts X between A and B.
        let mut with_x = seeded.tabs.clone();
        with_x.insert(1, tab("x", "X"));
        sync_in(&path, client(base, with_x)).unwrap();
        // The first client, unaware of X, only renames B.
        let mut renamed = seeded.tabs.clone();
        renamed[1].label = "B2".into();
        let out = sync_in(&path, client(base, renamed)).unwrap();
        assert_eq!(labels(&out.tabs), ["A", "X", "B2"]);
        assert!(out.ops.contains(&Op::Updated { id: tab_id(&seeded.tabs[1]).unwrap().to_string() }));
        assert!(!out.ops.iter().any(|op| matches!(op, Op::Closed { .. })));
    }

    #[test]
    fn an_empty_snapshot_only_clears_when_the_client_vouches_for_it() {
        let (_dir, path) = file();
        let seeded = sync_in(&path, client(0, vec![tab("a", "A")])).unwrap();
        let nothing_loaded = ClientSync { base_version: seeded.version, tabs: vec![], allow_clear: false, ..Default::default() };
        let out = sync_in(&path, nothing_loaded).unwrap();
        assert_eq!(labels(&out.tabs), ["A"]);
        assert_eq!(out.version, seeded.version);
        let out = sync_in(&path, client(seeded.version, vec![])).unwrap();
        assert!(out.tabs.is_empty());
        assert_eq!(out.ops, vec![Op::Closed { id: tab_id(&seeded.tabs[0]).unwrap().to_string() }]);
        let stored = read_session(&path).unwrap();
        assert!(stored.tab_groups.is_none(), "an empty set drops the tree");
        assert_eq!(tombstones(&stored).len(), 1);
    }

    #[test]
    fn a_close_by_another_client_is_not_undone_by_a_stale_snapshot() {
        let (_dir, path) = file();
        let seeded = sync_in(&path, client(0, vec![tab("a", "A"), tab("b", "B")])).unwrap();
        let base = seeded.version;
        sync_in(&path, client(base, vec![seeded.tabs[0].clone()])).unwrap(); // closes B
        // A stale client that still lists B does not bring it back...
        let out = sync_in(&path, client(base, seeded.tabs.clone())).unwrap();
        assert_eq!(labels(&out.tabs), ["A"]);
        // ...but a client that saw the close may deliberately re-open it.
        let out = sync_in(&path, client(out.version, seeded.tabs.clone())).unwrap();
        assert_eq!(labels(&out.tabs), ["A", "B"]);
        assert!(out.ops.iter().any(|op| matches!(op, Op::Created { .. })));
    }

    #[test]
    fn the_whole_snapshot_save_is_refused_once_the_scope_is_owned() {
        let (_dir, path) = file();
        assert!(!is_owned(&read_session(&path).unwrap()));
        sync_in(&path, client(0, vec![tab("a", "A")])).unwrap();
        let stored = read_session(&path).unwrap();
        assert!(is_owned(&stored));
        assert_eq!(version_of(&stored), 2);
    }

    #[test]
    fn a_backend_edit_bumps_the_version_and_tombstones_what_it_dropped() {
        let (_dir, path) = file();
        let seeded = sync_in(&path, client(0, vec![tab("a", "A"), tab("b", "B")])).unwrap();
        let stored = edit_in(&path, |session| {
            session.tab_layout.retain(|t| t.label != "B");
            session.tab_layout.push(tab("n", "New"));
            Ok(())
        })
        .unwrap();
        assert_eq!(version_of(&stored), seeded.version + 1);
        assert_eq!(labels(&stored.tab_layout), ["A", "New"]);
        assert!(stored.tab_layout.iter().all(|t| tab_id(t).is_some()));
        assert_eq!(tombstones(&stored)[0].id, tab_id(&seeded.tabs[1]).unwrap());
        let mut raw = serde_json::to_value(&stored).unwrap();
        bump_raw_version(&mut raw);
        assert_eq!(raw[VERSION_KEY], seeded.version + 2);
    }

    #[test]
    fn tombstones_are_bounded() {
        let mut session = TerminalSession::default();
        let stones: Vec<Tombstone> = (0..(MAX_TOMBSTONES as u64 + 10)).map(|i| Tombstone { id: i.to_string(), version: i }).collect();
        set_tombstones(&mut session, stones);
        let kept = tombstones(&session);
        assert_eq!(kept.len(), MAX_TOMBSTONES);
        assert_eq!(kept[0].id, "10", "the oldest fell off");
    }
}
