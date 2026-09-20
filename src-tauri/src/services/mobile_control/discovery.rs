use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

use base64ct::{Base64UrlUnpadded, Encoding};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

use super::protocol::TAB_COLORS;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Deserialize)]
struct ProjectRecord {
    id: String,
    name: String,
    status: String,
    #[serde(default)]
    directory: Option<String>,
    #[serde(default)]
    remote: Option<Value>,
    #[serde(default)]
    sandbox: Option<Value>,
    #[serde(default)]
    vm: Option<Value>,
    #[serde(default)]
    eldrun_mobile_access: bool,
    #[serde(default)]
    eldrun_trash: bool,
}

/// The slice of `boxes.json` the catalog reads (#31aa). A box is listed as a
/// scope of its own — its `box:<id>` scope has its own session file and tmux
/// names, and its tabs run locally whatever its members are — so it needs the
/// same three things a project does: a switch, a label and a root.
#[derive(Debug, Clone, Deserialize)]
struct BoxRecord {
    id: String,
    name: String,
    #[serde(default)]
    member_ids: Vec<String>,
    #[serde(default)]
    folder: Option<String>,
    #[serde(default)]
    eldrun_mobile_access: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFile {
    #[serde(default)]
    tab_layout: Vec<SavedTab>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedTab {
    label: String,
    cmd: String,
    cwd: String,
    kind: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    resume_args: Option<Vec<String>>,
    #[serde(default)]
    tmux_session: Option<String>,
    #[serde(default)]
    tmux_attach: Option<String>,
    #[serde(default)]
    ephemeral: bool,
    /// The user's tab colour, a palette id (see `protocol::TAB_COLORS`).
    #[serde(default)]
    color: Option<String>,
}

#[derive(Debug, Clone)]
struct LiveTmux {
    activity: u64,
    cwd: PathBuf,
}

/// What a scope row is. A box is not a project — it has no status of its own
/// and its tabs may live in several roots — and the phone says so on the row,
/// so a "Paper" box and a "Paper" project can be told apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeKind {
    Project,
    Box,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicProject {
    pub id: String,
    pub label: String,
    pub status: String,
    pub kind: ScopeKind,
    pub live_sessions: usize,
    pub last_activity: Option<u64>,
}

/// The one-line schedule summary the desktop's Agents view puts under an agent
/// tab, carried in the tab row itself so the phone's project overview reads the
/// same thing without a per-tab round trip.
#[derive(Debug, Clone, Serialize)]
pub struct TabSchedules {
    pub total: u32,
    pub enabled: u32,
    /// Desktop-local `YYYY-MM-DDTHH:MM` of the next run, when one is due.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

/// One prompt an agent tab was given, as the desktop read it off the agent's
/// own transcript. `at` is the record's ISO instant; the phone formats it in
/// its own zone, and a record that carried none arrives without one.
#[derive(Debug, Clone, Serialize)]
pub struct TabPrompt {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicTab {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_label: Option<String>,
    /// The desktop's derived state for an agent tab, if the desktop is online.
    /// This intentionally never stores or infers terminal text in the sidecar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_status: Option<String>,
    /// The model an agent tab's session is showing, in the words the session
    /// itself prints — the desktop reads them off the pane. A tab whose pane
    /// the desktop window does not hold falls back to the model it last
    /// answered with, shortened from the transcript's id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_model: Option<String>,
    /// Desktop wall clock (ms) of the tab's last working output and of its last
    /// finished turn — the two keys the phone's Agents list can sort by. The
    /// desktop's numbers travel untouched: they are compared with each other,
    /// never with the phone's clock.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_at: Option<u64>,
    /// How many prompts this agent tab has scheduled, and when the first fires.
    /// Absent for a shell tab and while the desktop is closed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedules: Option<TabSchedules>,
    /// The newest prompts this agent tab was given, oldest first, as the
    /// desktop read them off the agent's transcript. Unlike `agent_status` this
    /// is published for a quiet tab as well: "what was this session last asked"
    /// is the line the phone's lists are opened for, and a session nobody has
    /// prompted in an hour is exactly the one whose answer is worth showing.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub prompts: Vec<TabPrompt>,
    pub available: bool,
    pub viewer_busy: bool,
    pub last_activity: Option<u64>,
    /// The tab's user-set colour as a palette id, absent when it has none. The
    /// phone resolves the id to the same hex the desktop does, so a tab reads
    /// as one colour on both surfaces; an id this build does not know is
    /// dropped here rather than published for the phone to guess at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedTab {
    pub public: PublicTab,
    pub tmux_name: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedProject {
    pub public: PublicProject,
    /// The desktop's own id for the scope: a project id, or a `box:<id>` scope
    /// id, which the desktop bridge resolves the same way.
    pub raw_id: String,
    /// The scope's home: the project folder, or the box folder. The inbox
    /// lives here.
    pub root: PathBuf,
    /// Every canonical directory a tab of this scope may run in — `root`
    /// first, then (for a box) each local member's root, because a box's
    /// per-member agent tab deliberately starts in that member's tree.
    pub roots: Vec<PathBuf>,
    pub tabs: Vec<ResolvedTab>,
}

/// One scope to resolve, before its session file and tmux rows are read.
struct ScopeSource {
    raw_id: String,
    label: String,
    status: String,
    kind: ScopeKind,
    /// Uncanonicalized; the first entry is the home and must exist, the rest
    /// are best-effort.
    roots: Vec<PathBuf>,
}

#[derive(Debug, Clone, Default)]
pub struct Catalog {
    pub projects: Vec<ResolvedProject>,
}

/// A catalog load forks `tmux ls` and walks every mobile-enabled project's
/// session directory. It is on the path of every HTTP handler, every WebSocket
/// upgrade *and* the periodic authorization re-check of each open terminal
/// (every fifth second of `pty_bridge`'s tick), so without a TTL an idle phone
/// with one terminal open kept the workstation at roughly 1.7 tmux forks per
/// second forever.
const CATALOG_TTL: Duration = Duration::from_millis(1_000);

#[derive(Debug, Default)]
pub struct CatalogCache {
    last_valid: Option<Catalog>,
    loaded_at: Option<Instant>,
}

impl CatalogCache {
    /// Serves a snapshot up to `CATALOG_TTL` old.
    pub fn load(&mut self, state_dir: &Path, host_key: &[u8]) -> Result<Catalog, String> {
        if let (Some(catalog), Some(at)) = (self.last_valid.as_ref(), self.loaded_at) {
            if at.elapsed() < CATALOG_TTL {
                return Ok(catalog.clone());
            }
        }
        self.load_fresh(state_dir, host_key)
    }

    /// Bypasses the TTL, for the one caller that is waiting on a change it knows
    /// is not in the snapshot yet (a tab the desktop has just been told to open).
    pub fn load_fresh(&mut self, state_dir: &Path, host_key: &[u8]) -> Result<Catalog, String> {
        match Catalog::load(state_dir, host_key) {
            Ok(next) => {
                self.last_valid = Some(next.clone());
                self.loaded_at = Some(Instant::now());
                Ok(next)
            }
            // A failed read leaves `loaded_at` alone so the next call retries
            // rather than pinning a stale snapshot for the whole TTL.
            Err(error) => self.last_valid.clone().ok_or(error),
        }
    }

    /// Forget how old the snapshot is, so the next read goes to disk. For the
    /// caller that has just changed what the snapshot describes and knows the
    /// change is already written: a tab closed from the phone is out of the
    /// session file by the time the desktop answers, and serving the rest of
    /// the TTL from the pre-close snapshot puts the row back under the reader's
    /// thumb. The snapshot itself is kept as the fallback for a failed read.
    pub fn invalidate(&mut self) {
        self.loaded_at = None;
    }
}

fn enabled(value: &Option<Value>) -> bool {
    value
        .as_ref()
        .and_then(|v| v.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn key_id(key: &[u8], domain: &str, parts: &[&str]) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts all key sizes");
    mac.update(domain.as_bytes());
    mac.update(&[0]);
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            mac.update(&[0]);
        }
        mac.update(part.as_bytes());
    }
    Base64UrlUnpadded::encode_string(&mac.finalize().into_bytes()[..20])
}

/// Domains used by the mobile protocol's opaque identities.  Keep this allow
/// list narrow: callers may only derive IDs for the public objects the paired
/// device is permitted to receive or send back to the desktop bridge.
fn valid_opaque_control_domain(domain: &str) -> bool {
    matches!(
        domain,
        "agent" | "request" | "task" | "mail" | "calendar" | "event" | "project" | "subtask"
    )
}

pub fn opaque_control_id(state_dir: &Path, domain: &str, value: &str) -> Result<String, String> {
    if !valid_opaque_control_domain(domain) {
        return Err("invalid opaque id domain".into());
    }
    let key = fs::read(state_dir.join("mobile-control/host.key"))
        .map_err(|e| format!("read host key: {e}"))?;
    if key.len() != 32 {
        return Err("invalid host key".into());
    }
    Ok(key_id(&key, domain, &[value]))
}

/// The root scope's id, or anything that maps onto its session directory.
fn is_root_scope_id(id: &str) -> bool {
    project_key(id) == "root"
}

fn project_key(id: &str) -> String {
    let out: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        "x".into()
    } else {
        out
    }
}

fn expected_tmux(project_id: &str, kind: &str, name: &str) -> bool {
    let prefix = format!("eldrun-{}--{kind}-", project_key(project_id));
    name.starts_with(&prefix)
        && name.len() > prefix.len() + 8
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn resumable(tab: &SavedTab) -> bool {
    const BUILTIN: &[&str] = &[
        "claude",
        "codex",
        "qwen",
        "opencode",
        "copilot",
        "cursor-agent",
        "grok",
        "gemini",
        "agy",
        "vibe",
        "droid",
    ];
    tab.session_id.is_some()
        && (BUILTIN.contains(&tab.cmd.as_str())
            || tab.resume_args.as_ref().is_some_and(|v| !v.is_empty()))
}

/// Which agent an agent tab runs, as the phone names it: the registry's name
/// for the tab's CLI, so a tab renamed to "release review" still says it is
/// Claude — and the phone's per-agent readers (mode walk, paste, prompt echo)
/// still recognise it. The command itself never crosses the browser API; an
/// agent the registry does not list keeps its tab label, as before.
fn agent_label_of(tab: &SavedTab) -> String {
    crate::commands::agents::agent_label_for_bin(&tab.cmd)
        .map(str::to_string)
        .unwrap_or_else(|| tab.label.chars().take(120).collect())
}

fn canonical_below_any(path: &Path, roots: &[PathBuf]) -> bool {
    path.canonicalize()
        .ok()
        .is_some_and(|p| roots.iter().any(|root| p.starts_with(root)))
}

/// The trust-tier gate every mobile scope passes: a local project that is
/// neither a container (Trash excepted, as on the desktop) nor a VM. A box
/// applies it to each member before that member's root may host a box tab.
fn mobile_local(project: &ProjectRecord) -> bool {
    project.remote.is_none()
        && !(enabled(&project.sandbox) && !project.eldrun_trash)
        && !enabled(&project.vm)
}

/// `tmux ls` through Eldrun's effective PATH, the one the desktop's own tmux
/// spawns use (`services::tmux_local`). A headless sidecar (launchd/systemd
/// user service) inherits a bare PATH, so a bare `tmux` misses Homebrew's on a
/// Mac, or picks `/usr/bin/tmux` against a server a `~/.local/bin/tmux` started
/// — and tmux refuses a client of another protocol version.
fn tmux_ls_command(format: &str) -> Command {
    let mut command = crate::paths::command_no_window("tmux");
    command.args(["ls", "-F", format]);
    command
}

fn live_tmux() -> HashMap<String, LiveTmux> {
    // Windows has no tmux, and local tabs there are never wrapped in one
    // (`CenterPanel` disables local persistence on Windows), so there is nothing
    // to list — and a spawn per catalog read would only ever fail. The desktop's
    // Mobile settings say so rather than leaving an empty terminal list to explain
    // itself.
    if cfg!(target_os = "windows") {
        return HashMap::new();
    }
    let format ="#{session_name}\t#{session_activity}\t#{pane_current_path}";
    let Ok(out) = tmux_ls_command(format).output() else {
        return HashMap::new();
    };
    if !out.status.success() {
        return HashMap::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut p = line.splitn(3, '\t');
            let name = p.next()?.to_string();
            let activity = p.next()?.parse().ok()?;
            let cwd = PathBuf::from(p.next()?);
            Some((name, LiveTmux { activity, cwd }))
        })
        .collect()
}

impl Catalog {
    pub fn load(state_dir: &Path, host_key: &[u8]) -> Result<Self, String> {
        let bytes =
            fs::read(state_dir.join("projects.json")).map_err(|e| format!("read projects: {e}"))?;
        let projects: Vec<ProjectRecord> =
            serde_json::from_slice(&bytes).map_err(|e| format!("parse projects: {e}"))?;
        // Boxes are optional: no file, or one this build cannot read, costs the
        // boxes and never the projects — a corrupt `boxes.json` must not take
        // the whole catalog with it (see the session-file rule below).
        let boxes: Vec<BoxRecord> = fs::read(state_dir.join("boxes.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let live = live_tmux();
        let mut sources = Vec::new();
        for project in &projects {
            if !project.eldrun_mobile_access || !mobile_local(project) {
                continue;
            }
            // The root console is never the phone's (`services::root_mcp`): its
            // agents hold rights no project agent has. It is not a project, so
            // it cannot be listed honestly — this refuses a hand-edited record
            // that borrows its session directory by taking its id.
            if is_root_scope_id(&project.id) {
                continue;
            }
            let Some(root_raw) = project.directory.as_deref() else {
                continue;
            };
            sources.push(ScopeSource {
                raw_id: project.id.clone(),
                label: project.name.clone(),
                status: project.status.clone(),
                kind: ScopeKind::Project,
                roots: vec![PathBuf::from(root_raw)],
            });
        }
        for b in &boxes {
            // A box never opened on the desktop has no folder and so no tabs;
            // the desktop's switch resolves the folder on enable, so this only
            // skips a bit hand-edited onto a folder-less record.
            if !b.eldrun_mobile_access {
                continue;
            }
            let Some(folder) = b.folder.as_deref() else {
                continue;
            };
            let mut roots = vec![PathBuf::from(folder)];
            for id in &b.member_ids {
                let Some(member) = projects.iter().find(|p| &p.id == id) else {
                    continue;
                };
                // A member's own Mobile switch is not consulted: the box's
                // switch is the consent, and what it covers is the box's tabs
                // — which run locally, in the folder or a local member's root.
                // A remote/VM/container member contributes no root at all.
                if !mobile_local(member) {
                    continue;
                }
                if let Some(dir) = member.directory.as_deref() {
                    roots.push(PathBuf::from(dir));
                }
            }
            sources.push(ScopeSource {
                raw_id: format!("box:{}", b.id),
                label: b.name.clone(),
                // A box has no status of its own; listing it is what the
                // switch means, so it is always in the phone's active list.
                status: "active".into(),
                kind: ScopeKind::Box,
                roots,
            });
        }
        let resolved = sources
            .into_iter()
            .filter_map(|source| resolve_scope(state_dir, host_key, &live, source))
            .collect();
        Ok(Self { projects: resolved })
    }

    pub fn project(&self, id: &str) -> Option<&ResolvedProject> {
        self.projects.iter().find(|p| p.public.id == id)
    }
    pub fn tab(&self, id: &str) -> Option<(&ResolvedProject, &ResolvedTab)> {
        self.projects
            .iter()
            .find_map(|p| p.tabs.iter().find(|t| t.public.id == id).map(|t| (p, t)))
    }
}

/// Read one scope's saved tabs and join them to the live tmux rows. `None`
/// when the scope's home directory does not resolve — a scope with no home has
/// nowhere for an inbox and nothing a tab could be checked against.
fn resolve_scope(
    state_dir: &Path,
    host_key: &[u8],
    live: &HashMap<String, LiveTmux>,
    source: ScopeSource,
) -> Option<ResolvedProject> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for (index, raw) in source.roots.iter().enumerate() {
        match raw.canonicalize() {
            Ok(root) => roots.push(root),
            // The home must exist; a member root that does not simply hosts
            // no box tab, exactly as the fence's root list treats it.
            Err(_) if index == 0 => return None,
            Err(_) => {}
        }
    }
    let root = roots.first()?.clone();
    let session_path = state_dir
        .join("sessions")
        .join(project_key(&source.raw_id))
        .join("terminals.json");
    // One scope's session file is that scope's problem, not the catalog's.
    // The desktop writes it atomically, so a file that does not parse is real
    // corruption or a shape this build does not read — and it used to fail
    // the whole load, which the cache then answered from its last valid
    // snapshot on every request, forever: one bad file froze every project
    // the phone could see, with nothing anywhere to say why. Such a scope
    // simply has no attachable tabs until the desktop rewrites the file.
    let session = match fs::read(&session_path) {
        Ok(bytes) => serde_json::from_slice::<SessionFile>(&bytes)
            .unwrap_or_else(|_| SessionFile { tab_layout: vec![] }),
        Err(_) => SessionFile { tab_layout: vec![] },
    };
    let mut tabs = Vec::new();
    // project-tree-read: ok — this is the state-dir terminal-session snapshot.
    for tab in session.tab_layout {
        let eligible_kind = tab.kind == "shell" || (tab.kind == "agent" && resumable(&tab));
        if !eligible_kind
            || tab.ephemeral
            || tab.tmux_attach.is_some()
            || !canonical_below_any(Path::new(&tab.cwd), &roots)
        {
            continue;
        }
        let Some(tmux) = tab.tmux_session.as_deref() else {
            continue;
        };
        if !expected_tmux(&source.raw_id, &tab.kind, tmux) {
            continue;
        }
        let live_row = live
            .get(tmux)
            .filter(|row| canonical_below_any(&row.cwd, &roots));
        let public = PublicTab {
            id: key_id(host_key, "tab", &[&source.raw_id, tmux]),
            label: tab.label.chars().take(120).collect(),
            kind: tab.kind.clone(),
            agent_label: (tab.kind == "agent").then(|| agent_label_of(&tab)),
            agent_status: None,
            agent_model: None,
            working_at: None,
            done_at: None,
            schedules: None,
            prompts: Vec::new(),
            available: live_row.is_some(),
            viewer_busy: false,
            last_activity: live_row.map(|r| r.activity),
            color: tab
                .color
                .as_deref()
                .filter(|id| TAB_COLORS.contains(id))
                .map(str::to_string),
        };
        tabs.push(ResolvedTab {
            public,
            tmux_name: tmux.to_string(),
        });
    }
    let last_activity = tabs.iter().filter_map(|t| t.public.last_activity).max();
    let public = PublicProject {
        id: key_id(host_key, "project", &[&source.raw_id]),
        label: source.label.chars().take(120).collect(),
        status: source.status,
        kind: source.kind,
        live_sessions: tabs.iter().filter(|t| t.public.available).count(),
        last_activity,
    };
    Some(ResolvedProject {
        public,
        raw_id: source.raw_id,
        root,
        roots,
        tabs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmux_ls_runs_through_eldrun_path() {
        let command = tmux_ls_command("#{session_name}");
        let path = command
            .get_envs()
            .find(|(key, _)| *key == "PATH")
            .and_then(|(_, value)| value)
            .expect("PATH is set on the tmux ls spawn");
        let first = std::env::split_paths(path).next().expect("non-empty PATH");
        assert_eq!(first, crate::paths::extra_path_dirs()[0]);
    }

    #[test]
    fn opaque_ids_are_domain_separated_and_stable() {
        let key = [7u8; 32];
        assert_eq!(
            key_id(&key, "project", &["a"]),
            key_id(&key, "project", &["a"])
        );
        assert_ne!(key_id(&key, "project", &["a"]), key_id(&key, "tab", &["a"]));
        assert!(!key_id(&key, "project", &["secret-project"]).contains("secret"));
    }

    #[test]
    fn mobile_protocol_domains_are_accepted_but_arbitrary_ones_are_not() {
        for domain in [
            "agent", "request", "task", "mail", "calendar", "event", "project", "subtask",
        ] {
            assert!(valid_opaque_control_domain(domain), "{domain}");
        }
        assert!(!valid_opaque_control_domain("filesystem_path"));
    }

    #[test]
    fn exact_session_names_only() {
        assert!(expected_tmux("p1", "shell", "eldrun-p1--shell-123456789"));
        assert!(!expected_tmux("p1", "shell", "eldrun-p2--shell-123456789"));
        assert!(!expected_tmux("p1", "shell", "eldrun-p1--agent-123456789"));
    }

    #[test]
    fn one_corrupt_session_file_costs_that_project_its_tabs_not_the_whole_catalog() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        let root_a = state.join("a");
        let root_b = state.join("b");
        fs::create_dir_all(&root_a).expect("root a");
        fs::create_dir_all(&root_b).expect("root b");
        let project = |id: &str, name: &str, root: &Path| {
            serde_json::json!({
                "id": id,
                "name": name,
                "status": "active",
                "directory": root.to_string_lossy(),
                "eldrun_mobile_access": true,
            })
        };
        fs::write(
            state.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([
                project("p-a", "A", &root_a),
                project("p-b", "B", &root_b),
            ]))
            .expect("projects"),
        )
        .expect("write projects");
        let sessions = state.join("sessions");
        fs::create_dir_all(sessions.join("p-a")).expect("session a");
        fs::create_dir_all(sessions.join("p-b")).expect("session b");
        fs::write(
            sessions.join("p-a").join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({
                "tabLayout": [{
                    "label": "Shell",
                    "cmd": "bash",
                    "cwd": root_a.to_string_lossy(),
                    "kind": "shell",
                    "tmuxSession": "eldrun-p-a--shell-123456789",
                }]
            }))
            .expect("session"),
        )
        .expect("write session a");
        fs::write(sessions.join("p-b").join("terminals.json"), b"{ not json").expect("corrupt b");

        let catalog = Catalog::load(state, &[7; 32])
            .expect("one unreadable session file must not fail the whole catalog");
        assert_eq!(catalog.projects.len(), 2);
        let a = catalog.projects.iter().find(|p| p.raw_id == "p-a").expect("A");
        let b = catalog.projects.iter().find(|p| p.raw_id == "p-b").expect("B");
        assert_eq!(a.tabs.len(), 1, "the healthy project keeps its tabs");
        assert!(b.tabs.is_empty(), "the corrupt one has none, and is still listed");
    }

    /// The cache is what keeps an idle phone from forking `tmux ls` twice a
    /// second, and it is also what could answer a poll with a tab the reader
    /// has just closed: the desktop rewrites the session file before it says
    /// "closed", so the only stale thing left is the snapshot's remaining TTL.
    /// The close route drops it (`invalidate`) and the next read goes to disk.
    #[test]
    fn an_invalidated_cache_re_reads_within_the_ttl() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        let root = state.join("p");
        fs::create_dir_all(&root).expect("root dir");
        fs::write(
            state.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([{
                "id": "p-1",
                "name": "P",
                "status": "active",
                "directory": root.to_string_lossy(),
                "eldrun_mobile_access": true,
            }]))
            .expect("projects"),
        )
        .expect("write projects");
        let sessions = state.join("sessions").join("p-1");
        fs::create_dir_all(&sessions).expect("session dir");
        let write_tabs = |tabs: serde_json::Value| {
            fs::write(
                sessions.join("terminals.json"),
                serde_json::to_vec(&serde_json::json!({ "tabLayout": tabs })).expect("session"),
            )
            .expect("write session");
        };
        write_tabs(serde_json::json!([{
            "label": "Shell",
            "cmd": "bash",
            "cwd": root.to_string_lossy(),
            "kind": "shell",
            "tmuxSession": "eldrun-p-1--shell-123456789",
        }]));

        let mut cache = CatalogCache::default();
        let tabs = |catalog: &Catalog| catalog.projects[0].tabs.len();
        assert_eq!(tabs(&cache.load(state, &[7; 32]).expect("first read")), 1);

        // The close: the tab leaves the session file the catalog is read from.
        write_tabs(serde_json::json!([]));
        assert_eq!(
            tabs(&cache.load(state, &[7; 32]).expect("cached read")),
            1,
            "the snapshot is still young, so the closed tab is still in it"
        );
        cache.invalidate();
        assert_eq!(
            tabs(&cache.load(state, &[7; 32]).expect("re-read")),
            0,
            "an invalidated cache reads the file the close rewrote"
        );
    }

    /// A tab colour (#264) is published as the palette id the desktop stored, so
    /// the phone resolves it to the same hex — and an id this build does not have
    /// is dropped rather than passed on for the phone to guess at, which is the
    /// same posture `clean_tab_color` takes on the way in.
    #[test]
    fn a_tab_publishes_a_palette_colour_and_drops_anything_else() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        let root = state.join("p");
        fs::create_dir_all(&root).expect("root dir");
        fs::write(
            state.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([{
                "id": "p-1",
                "name": "P",
                "status": "active",
                "directory": root.to_string_lossy(),
                "eldrun_mobile_access": true,
            }]))
            .expect("projects"),
        )
        .expect("write projects");
        let sessions = state.join("sessions").join("p-1");
        fs::create_dir_all(&sessions).expect("session dir");
        let tab = |suffix: &str, color: serde_json::Value| {
            serde_json::json!({
                "label": format!("Shell {suffix}"),
                "cmd": "bash",
                "cwd": root.to_string_lossy(),
                "kind": "shell",
                "tmuxSession": format!("eldrun-p-1--shell-10000000{suffix}"),
                "color": color,
            })
        };
        fs::write(
            sessions.join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({
                "tabLayout": [
                    tab("1", serde_json::json!("teal")),
                    tab("2", serde_json::json!("chartreuse")),
                    tab("3", serde_json::Value::Null),
                ]
            }))
            .expect("session"),
        )
        .expect("write session");

        let catalog = Catalog::load(state, &[7; 32]).expect("catalog");
        let project = catalog.projects.first().expect("project");
        let colors: Vec<Option<&str>> = project
            .tabs
            .iter()
            .map(|t| t.public.color.as_deref())
            .collect();
        assert_eq!(colors, vec![Some("teal"), None, None]);
    }

    /// The root console never reaches the phone — not even through a
    /// `projects.json` record hand-edited to take the root scope's id (and with
    /// it `sessions/root/`, the root console's own tab layout).
    #[test]
    fn the_root_scope_is_never_in_the_catalog() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        let root = state.join("root");
        fs::create_dir_all(&root).expect("root dir");
        fs::write(
            state.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([{
                "id": "root",
                "name": "Root",
                "status": "active",
                "directory": root.to_string_lossy(),
                "eldrun_mobile_access": true,
            }]))
            .expect("projects"),
        )
        .expect("write projects");
        fs::create_dir_all(state.join("sessions").join("root")).expect("session dir");
        fs::write(
            state.join("sessions").join("root").join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({
                "tabLayout": [{
                    "label": "Claude",
                    "cmd": "claude",
                    "cwd": root.to_string_lossy(),
                    "kind": "agent",
                    "tmuxSession": "eldrun-root--agent-123456789",
                }]
            }))
            .expect("session"),
        )
        .expect("write session");

        let catalog = Catalog::load(state, &[7; 32]).expect("catalog");
        assert!(catalog.projects.is_empty());
        assert!(is_root_scope_id("root"));
        assert!(!is_root_scope_id("rooted"));
    }

    /// The phone learns which agent a tab runs from the registry, not from the
    /// tab's label, so a renamed tab still says "Claude"; an unlisted agent
    /// keeps its label, and the command itself is never what is published.
    #[test]
    fn agent_label_names_the_cli_not_the_tab() {
        let tab = |label: &str, cmd: &str| SavedTab {
            label: label.to_string(),
            cmd: cmd.to_string(),
            cwd: String::new(),
            kind: "agent".to_string(),
            session_id: None,
            resume_args: None,
            tmux_session: None,
            tmux_attach: None,
            ephemeral: false,
            color: None,
        };
        assert_eq!(agent_label_of(&tab("release review", "claude")), "Claude");
        assert_eq!(agent_label_of(&tab("Codex", "codex")), "Codex");
        assert_eq!(agent_label_of(&tab("My bot", "/opt/bot --x")), "My bot");
    }

    /// A mobile-enabled box is a scope of its own (#31aa): listed as `kind:
    /// box` under its own opaque id, with tabs from `sessions/box_<id>/` whose
    /// cwd is the box folder OR a local member's root. Its switch is the only
    /// consent consulted — a member's own Mobile bit is not — while a member
    /// outside the trust tiers contributes no root, and a box with the bit
    /// off or no folder is not listed at all.
    #[test]
    fn a_mobile_enabled_box_is_a_scope_with_the_folder_and_local_member_roots() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        let folder = state.join("boxes").join("paper");
        let member = state.join("lib");
        let remote_mirror = state.join("mirror");
        for d in [&folder, &member, &remote_mirror] {
            fs::create_dir_all(d).expect("dir");
        }
        fs::write(
            state.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([
                // The member has Mobile OFF itself: the box's switch covers it.
                { "id": "p-lib", "name": "Lib", "status": "inactive",
                  "directory": member.to_string_lossy() },
                { "id": "p-remote", "name": "Remote", "status": "active",
                  "directory": remote_mirror.to_string_lossy(),
                  "remote": { "host": "h" } },
            ]))
            .expect("projects"),
        )
        .expect("write projects");
        fs::write(
            state.join("boxes.json"),
            serde_json::to_vec(&serde_json::json!([
                { "id": "b1", "name": "Paper", "member_ids": ["p-lib", "p-remote", "p-gone"],
                  "folder": folder.to_string_lossy(), "eldrun_mobile_access": true },
                { "id": "b2", "name": "Off", "folder": folder.to_string_lossy() },
                { "id": "b3", "name": "Unopened", "eldrun_mobile_access": true },
            ]))
            .expect("boxes"),
        )
        .expect("write boxes");
        let sessions = state.join("sessions").join("box_b1");
        fs::create_dir_all(&sessions).expect("session dir");
        let tab = |label: &str, cwd: &Path, tmux: &str| {
            serde_json::json!({
                "label": label, "cmd": "bash", "kind": "shell",
                "cwd": cwd.to_string_lossy(), "tmuxSession": tmux,
            })
        };
        fs::write(
            sessions.join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({ "tabLayout": [
                tab("Box shell", &folder, "eldrun-box_b1--shell-123456789"),
                tab("Lib shell", &member, "eldrun-box_b1--shell-223456789"),
                tab("Remote shell", &remote_mirror, "eldrun-box_b1--shell-323456789"),
                tab("Foreign", &folder, "eldrun-p-lib--shell-423456789"),
            ]}))
            .expect("session"),
        )
        .expect("write session");

        let catalog = Catalog::load(state, &[7; 32]).expect("catalog");
        assert_eq!(catalog.projects.len(), 1, "only the enabled, opened box is listed");
        let b = &catalog.projects[0];
        assert_eq!(b.raw_id, "box:b1");
        assert_eq!(b.public.kind, ScopeKind::Box);
        assert_eq!(b.public.label, "Paper");
        assert_eq!(b.public.status, "active");
        assert_eq!(b.root, folder.canonicalize().unwrap());
        assert_eq!(b.roots.len(), 2, "the folder and the one local member: {:?}", b.roots);
        let labels: Vec<&str> = b.tabs.iter().map(|t| t.public.label.as_str()).collect();
        assert_eq!(labels, vec!["Box shell", "Lib shell"]);
        assert!(!b.public.id.contains("b1"), "the opaque id must not carry the box id");
    }

    #[test]
    fn cache_retains_last_valid_snapshot_during_partial_write() {
        let dir = tempfile::tempdir().expect("state dir");
        fs::write(dir.path().join("projects.json"), b"[]").expect("projects");
        let mut cache = CatalogCache::default();
        assert!(cache.load(dir.path(), &[7; 32]).is_ok());
        fs::write(dir.path().join("projects.json"), b"[").expect("partial projects");
        assert!(cache.load_fresh(dir.path(), &[7; 32]).is_ok());
    }

    #[test]
    fn repeat_loads_inside_the_ttl_do_not_touch_the_disk() {
        let dir = tempfile::tempdir().expect("state dir");
        fs::write(dir.path().join("projects.json"), b"[]").expect("projects");
        let mut cache = CatalogCache::default();
        cache.load(dir.path(), &[7; 32]).expect("first load");
        // Removing the file would fail an uncached load; the TTL must absorb it.
        fs::remove_file(dir.path().join("projects.json")).expect("remove");
        assert!(cache.load(dir.path(), &[7; 32]).is_ok());
        assert!(cache.load_fresh(dir.path(), &[7; 32]).is_ok());
    }
}
