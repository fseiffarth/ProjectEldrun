//! Eldrun-owned agent homes: one persistent `$HOME` per scope.
//!
//! Every locally-run agent tab sees `<state_dir>/agent-homes/<scope>/` as its
//! home directory instead of the user's (bound over `$HOME` by the Linux
//! fence, `HOME=` on macOS and Windows). A scope is a project, a box
//! (`box:<id>`) or the root console (`root`); the Host session has its own
//! home, `host`, which no fence ever mounts. Homes are per scope rather than
//! per CLI so that config written by an agent in one project (hooks, MCP
//! servers, skills) can only ever run in that project; what the user wants in
//! every project comes from the Eldrun-wide layer (`services::agent_global`),
//! which no agent can write. Each home holds the
//! agent's own config, transcripts, session stores and trust answers; logins
//! are not kept here but hard-linked in from the per-CLI store
//! (`services::agent_auth`), so a login made anywhere sticks everywhere.
//! `~/.cache` of every home is a throwaway tmpfs on Linux.
//!
//! Design and rationale: `docs/context/agent_authority.md`. AppHandle-free.

use std::io;
use std::path::{Path, PathBuf};

use crate::storage;

/// The directory under the state dir holding every scope's home.
pub const HOMES_DIR: &str = "agent-homes";
/// The scope key of the Host session's home. A project id is a UUID and a box
/// scope is `box:<id>`, so it collides with neither; `root` is the console's.
pub const HOST_SCOPE_KEY: &str = "host";
/// Written once a home has been seeded, so the one-time imports (an existing
/// per-scope Codex store, the scope's Claude transcripts) never run twice.
const SEEDED_MARKER: &str = ".eldrun-home";

/// `<state_dir>/agent-homes/`.
pub fn homes_root_in(state_dir: &Path) -> PathBuf {
    state_dir.join(HOMES_DIR)
}

pub fn homes_root() -> PathBuf {
    homes_root_in(&storage::state_dir())
}

/// The home of `scope_id` under `state_dir`, keyed by [`storage::project_key`]
/// like the scope's session dir and live-session slice.
pub fn scope_home_in(state_dir: &Path, scope_id: &str) -> PathBuf {
    homes_root_in(state_dir).join(storage::project_key(scope_id))
}

/// The home of a scope (`None` is the root console). A path only; see
/// [`prepare_scope_home`] for the directory itself.
pub fn scope_home(scope_id: Option<&str>) -> PathBuf {
    scope_home_in(&storage::state_dir(), scope_id.unwrap_or(storage::ROOT_SCOPE))
}

/// The Host session's home.
pub fn host_home_in(state_dir: &Path) -> PathBuf {
    homes_root_in(state_dir).join(HOST_SCOPE_KEY)
}

pub fn host_home() -> PathBuf {
    host_home_in(&storage::state_dir())
}

/// The scope id of a local spawn: its project or box, else the root console.
pub fn scope_of(project_id: Option<&str>) -> String {
    project_id.unwrap_or(storage::ROOT_SCOPE).to_string()
}

/// Create `dir` private to the user (`0700` on unix); a no-op when present.
pub(crate) fn create_private_dir(dir: &Path) -> io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

/// What a spawn needs to know about the home it got.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedHome {
    pub dir: PathBuf,
    /// The home was created by this call (its seeding just ran).
    pub fresh: bool,
}

/// Create (or reuse) the home of `scope_id` and bring it up to date: seeded
/// once ([`seed_home`]), the Eldrun-wide config layer laid in
/// (`services::agent_global`), Eldrun's session hooks registered, the shared logins
/// linked in, the `.cache` mount point present. `roots` are the scope's
/// writable roots, used only by the one-time transcript seeding. Called at
/// every local agent spawn.
pub fn prepare_scope_home(scope_id: &str, roots: &[PathBuf]) -> io::Result<PreparedHome> {
    let state_dir = storage::state_dir();
    let home = scope_home_in(&state_dir, scope_id);
    prepare_home_in(&state_dir, &home, scope_id, roots, true)
}

/// The Host session's home: same preparation, but nothing is seeded from a
/// fenced scope's state and no transcripts are copied in.
pub fn prepare_host_home() -> io::Result<PreparedHome> {
    let state_dir = storage::state_dir();
    let home = host_home_in(&state_dir);
    prepare_home_in(&state_dir, &home, HOST_SCOPE_KEY, &[], false)
}

fn prepare_home_in(
    state_dir: &Path,
    home: &Path,
    scope_id: &str,
    roots: &[PathBuf],
    seed_scope_state: bool,
) -> io::Result<PreparedHome> {
    create_private_dir(&homes_root_in(state_dir))?;
    let fresh = !home.join(SEEDED_MARKER).is_file();
    create_private_dir(home)?;
    if fresh {
        seed_home(state_dir, home, scope_id, roots, seed_scope_state);
        std::fs::write(home.join(SEEDED_MARKER), b"")?;
    }
    // The tmpfs the Linux fence mounts over it needs a mount point on disk.
    let _ = std::fs::create_dir_all(home.join(".cache"));
    // The user's Eldrun-wide instructions, skills, hooks and MCP servers,
    // before Eldrun's own hooks so a merge never displaces those.
    if let Err(e) = crate::services::agent_global::apply_to_home(state_dir, home) {
        eprintln!("agent_home: apply the global agent config to {}: {e}", home.display());
    }
    crate::services::agent_session::register_hooks_in_home(home);
    // Copilot signs in through a keyring the fence hides: its home gets the
    // plain-text token setting Eldrun's keeper collects from (`copilot_auth`).
    #[cfg(target_os = "linux")]
    let _ = crate::services::copilot_auth::prepare_home(scope_id);
    crate::services::agent_auth::link_into_home(state_dir, home);
    Ok(PreparedHome {
        dir: home.to_path_buf(),
        fresh,
    })
}

/// One-time seeding of a new home:
///
/// - the scope's existing Eldrun-kept Codex store (`codex-state/<key>`) and
///   Copilot home (`copilot-home/<key>`) move in as `.codex` / `.copilot`, so
///   sessions those tabs had keep resuming;
/// - the Claude transcripts of the scope's own roots are **copied** from the
///   user's `~/.claude/projects`, so every tab that was open before this home
///   existed still resumes; the user's own copy is left untouched;
/// - `.claude.json` gets its identity keys and the `projects` entries under
///   the scope's roots from the user's file, so the first tab is not a fresh
///   install and keeps the folder trust it already had.
///
/// Instructions, skills, hooks and MCP entries of the user's home are not
/// brought in here: they reach every home through the Eldrun-wide layer
/// (`services::agent_global`) once the user imports them there.
fn seed_home(state_dir: &Path, home: &Path, scope_id: &str, roots: &[PathBuf], scope_state: bool) {
    let user_home = crate::paths::home_dir();
    if scope_state {
        let key = storage::project_key(scope_id);
        for (legacy, into) in [("codex-state", ".codex"), ("copilot-home", ".copilot")] {
            let src = state_dir.join(legacy).join(&key);
            let dst = home.join(into);
            if src.is_dir() && !dst.exists() {
                if let Err(e) = std::fs::rename(&src, &dst) {
                    eprintln!("agent_home: adopt {}: {e}", src.display());
                }
            }
        }
        let roots: Vec<String> = roots.iter().map(|r| r.to_string_lossy().into_owned()).collect();
        seed_claude_transcripts(&user_home.join(".claude").join("projects"), home, &roots);
        seed_claude_json(&user_home.join(".claude.json"), &home.join(".claude.json"), &roots);
    }
}

/// Copy every transcript dir of `user_projects` that belongs to one of `roots`
/// into `<home>/.claude/projects`. Dirs the home already has are left alone.
pub(crate) fn seed_claude_transcripts(user_projects: &Path, home: &Path, roots: &[String]) {
    let Ok(entries) = std::fs::read_dir(user_projects) else {
        return;
    };
    let dest_root = home.join(".claude").join("projects");
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_dir() {
            continue;
        }
        let Some(name) = src.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !crate::services::sandbox::transcript_dir_belongs_to(&src, name, roots) {
            continue;
        }
        let dst = dest_root.join(name);
        if dst.exists() {
            continue;
        }
        if let Err(e) = copy_tree(&src, &dst) {
            eprintln!("agent_home: seed transcripts {}: {e}", src.display());
        }
    }
}

/// Recursive copy of regular files and directories; symlinks are skipped
/// (a transcript tree holds none of Claude's own making).
fn copy_tree(src: &Path, dst: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// Top-level `~/.claude.json` keys that make a home "not a fresh install":
/// who is signed in and that onboarding is done. Nothing that grants a tool.
pub(crate) const CLAUDE_JSON_IDENTITY_KEYS: &[&str] = &[
    "oauthAccount",
    "hasCompletedOnboarding",
    "lastOnboardingVersion",
    "userID",
    "installMethod",
    "autoUpdates",
    "theme",
];

/// Seed `<home>/.claude.json` from the user's file: the identity keys and the
/// `projects` entries at or under `roots` (prompt history, folder trust). The
/// destination is written only when absent.
pub(crate) fn seed_claude_json(user_file: &Path, dst: &Path, roots: &[String]) {
    if dst.exists() {
        return;
    }
    let Some(value) = std::fs::read(user_file)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
    else {
        return;
    };
    let seeded = filtered_claude_json(&value, roots);
    if let Some(parent) = dst.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(body) = serde_json::to_vec_pretty(&seeded) {
        let _ = std::fs::write(dst, body);
    }
}

/// Pure: the identity keys plus the `projects` map filtered to `roots`.
pub(crate) fn filtered_claude_json(value: &serde_json::Value, roots: &[String]) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    if let Some(obj) = value.as_object() {
        for key in CLAUDE_JSON_IDENTITY_KEYS {
            if let Some(v) = obj.get(*key) {
                out.insert((*key).to_string(), v.clone());
            }
        }
        if let Some(projects) = obj.get("projects").and_then(|p| p.as_object()) {
            let kept: serde_json::Map<String, serde_json::Value> = projects
                .iter()
                .filter(|(cwd, _)| roots.iter().any(|root| Path::new(cwd).starts_with(root)))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            out.insert("projects".into(), serde_json::Value::Object(kept));
        }
    }
    serde_json::Value::Object(out)
}

/// Remove a scope's home for good — a project forgotten or deleted.
pub fn delete_scope_home(scope_id: &str) -> io::Result<()> {
    let home = scope_home_in(&storage::state_dir(), scope_id);
    if home.exists() {
        std::fs::remove_dir_all(&home)?;
    }
    Ok(())
}

/// Every scope key that has a home, for the login keeper's sweep.
pub(crate) fn existing_homes_in(state_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(homes_root_in(state_dir)) else {
        return Vec::new();
    };
    let mut homes: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    homes.sort();
    homes
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scope_homes_are_keyed_like_session_dirs_and_host_is_apart() {
        let state = Path::new("/s");
        assert_eq!(scope_home_in(state, "root"), PathBuf::from("/s/agent-homes/root"));
        assert_eq!(scope_home_in(state, "box:b1"), PathBuf::from("/s/agent-homes/box_b1"));
        assert_eq!(host_home_in(state), PathBuf::from("/s/agent-homes/host"));
        assert_ne!(scope_home_in(state, "host"), host_home_in(state).join("x"));
    }

    #[test]
    fn claude_json_seed_keeps_identity_and_only_the_scopes_projects() {
        let value = json!({
            "oauthAccount": {"emailAddress": "a@b"},
            "hasCompletedOnboarding": true,
            "mcpServers": {"evil": {"command": "x"}},
            "projects": {
                "/work/p": {"hasTrustDialogAccepted": true, "allowedTools": ["Bash"]},
                "/work/p/sub": {"history": []},
                "/other": {"hasTrustDialogAccepted": true}
            }
        });
        let out = filtered_claude_json(&value, &["/work/p".into()]);
        assert_eq!(out["oauthAccount"]["emailAddress"], "a@b");
        assert_eq!(out["hasCompletedOnboarding"], true);
        assert!(out.get("mcpServers").is_none());
        let projects = out["projects"].as_object().unwrap();
        assert!(projects.contains_key("/work/p"));
        assert!(projects.contains_key("/work/p/sub"));
        assert!(!projects.contains_key("/other"));
    }

    #[test]
    fn transcript_seeding_copies_only_the_scopes_dirs_and_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("user-projects");
        let home = tmp.path().join("home");
        let ours = user.join("-work-p");
        let theirs = user.join("-other");
        std::fs::create_dir_all(&ours).unwrap();
        std::fs::create_dir_all(&theirs).unwrap();
        std::fs::write(ours.join("s.jsonl"), "{\"cwd\":\"/work/p\"}\n").unwrap();
        std::fs::write(theirs.join("t.jsonl"), "{\"cwd\":\"/other\"}\n").unwrap();
        seed_claude_transcripts(&user, &home, &["/work/p".into()]);
        let dest = home.join(".claude/projects");
        assert!(dest.join("-work-p/s.jsonl").is_file());
        assert!(!dest.join("-other").exists());
        // The user's copy stays where it was.
        assert!(ours.join("s.jsonl").is_file());
        std::fs::write(dest.join("-work-p/s.jsonl"), "changed").unwrap();
        seed_claude_transcripts(&user, &home, &["/work/p".into()]);
        assert_eq!(std::fs::read_to_string(dest.join("-work-p/s.jsonl")).unwrap(), "changed");
    }

    #[test]
    fn a_home_is_seeded_once_and_adopts_the_legacy_codex_store() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let legacy = state.join("codex-state").join("p1");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("state_5.sqlite"), "db").unwrap();
        let home = scope_home_in(state, "p1");
        let first = prepare_home_in(state, &home, "p1", &[], true).unwrap();
        assert!(first.fresh);
        assert!(home.join(".codex/state_5.sqlite").is_file());
        assert!(!legacy.exists());
        assert!(home.join(".cache").is_dir());
        assert!(home.join(SEEDED_MARKER).is_file());
        let again = prepare_home_in(state, &home, "p1", &[], true).unwrap();
        assert!(!again.fresh);
        assert!(existing_homes_in(state).contains(&home));
    }
}
