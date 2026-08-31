//! Linux filesystem fence for locally-running agent tabs.
//!
//! The project container remains the stronger, opt-in boundary.  For ordinary
//! local agent tabs this module wraps the agent in `bubblewrap`: the host root is
//! read-only, `$HOME`, `/tmp`, and `/run` are private, and only the owning
//! project (plus every box it belongs to) is mounted read-write.  Shell tabs,
//! remote-host tabs, containerized tabs, and non-Linux hosts are deliberately
//! left alone and reported honestly by [`status_for_scope`].

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::schema::boxes::BoxesList;
use crate::schema::projects::{ProjectEntry, ProjectsList};
use crate::terminal::PtyOptions;
use crate::{paths, storage};

pub const INSTALL_HINT: &str = "sudo apt install bubblewrap";

/// The backend authority decision.  `Unavailable` is fail-closed at spawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FenceDecision {
    Fenced { roots: Vec<PathBuf> },
    NotApplicable { reason: &'static str },
    Unavailable { install_hint: &'static str },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BindMount {
    pub src: String,
    pub dst: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentFenceStatus {
    pub enforced: bool,
    pub reason: String,
    pub roots: Vec<String>,
    pub bwrap_available: bool,
}

/// Default read-only host paths made visible inside the otherwise-empty home.
pub const DEFAULT_PATHS: &[&str] = crate::schema::settings::DEFAULT_AGENT_FENCE_PATHS;

fn basename(cmd: &str) -> &str {
    let base = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    base.strip_suffix(".exe").unwrap_or(base)
}

pub fn is_agent(opts: &PtyOptions) -> bool {
    opts.agent
        || crate::services::sandbox::is_agent_cmd(&opts.cmd)
        || crate::services::sandbox::HOST_BOUND_LOCAL_AGENT_CMDS.contains(&basename(&opts.cmd))
}

/// Pure decision matrix.  Root resolution and remote detection are passed in so
/// the policy is testable without touching the state directory.
pub fn decide(
    opts: &PtyOptions,
    roots: Vec<PathBuf>,
    remote_run: bool,
    policy_on: bool,
    platform_linux: bool,
    bwrap_ok: bool,
) -> FenceDecision {
    if !is_agent(opts) {
        return FenceDecision::NotApplicable { reason: "shell" };
    }
    if opts.sandbox {
        return FenceDecision::NotApplicable {
            reason: "container",
        };
    }
    if remote_run {
        return FenceDecision::NotApplicable {
            reason: "remote host",
        };
    }
    if !platform_linux {
        return FenceDecision::NotApplicable { reason: "platform" };
    }
    if !policy_on {
        return FenceDecision::NotApplicable { reason: "off" };
    }
    if !bwrap_ok {
        return FenceDecision::Unavailable {
            install_hint: INSTALL_HINT,
        };
    }
    FenceDecision::Fenced { roots }
}

/// Per-project override beats the global default.  Box scopes have no project
/// record and therefore always use the global value.
pub fn fence_effective(
    list: &[ProjectEntry],
    project_id: Option<&str>,
    global_default: bool,
) -> bool {
    let Some(id) = project_id else {
        return global_default;
    };
    if crate::commands::boxes::box_id_of_scope(id).is_some() {
        return global_default;
    }
    list.iter()
        .find(|p| p.id == id)
        .and_then(|p| p.extra.get("agent_fence"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(global_default)
}

fn entry_directory(entry: &ProjectEntry) -> Option<PathBuf> {
    if let Some(dir) = entry.extra.get("directory").and_then(|v| v.as_str()) {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir.trim()));
        }
    }
    entry
        .local_file
        .strip_suffix("/project.json")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn entry_mirror(entry: &ProjectEntry) -> Option<PathBuf> {
    entry
        .extra
        .get("mirror")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn dedupe_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .collect()
}

/// Pure root computation.  Explicit remote mirrors are included here; the
/// state-backed wrapper below adds legacy projects' derived default mirrors.
pub fn compute_fence_roots(
    boxes: &BoxesList,
    projects: &ProjectsList,
    scope_id: &str,
    local_only: bool,
) -> Option<Vec<PathBuf>> {
    if let Some(box_id) = crate::commands::boxes::box_id_of_scope(scope_id) {
        return crate::commands::boxes::compute_box_allowed_roots(boxes, projects, box_id)
            .map(dedupe_paths);
    }

    let project = projects.iter().find(|p| p.id == scope_id)?;
    let is_remote = project.extra.contains_key("remote");
    let own = if is_remote && local_only {
        entry_mirror(project).or_else(|| entry_directory(project))?
    } else {
        entry_directory(project)?
    };
    let mut roots = vec![own];
    for b in boxes
        .iter()
        .filter(|b| b.member_ids.iter().any(|id| id == scope_id))
    {
        if let Some(box_roots) =
            crate::commands::boxes::compute_box_allowed_roots(boxes, projects, &b.id)
        {
            roots.extend(box_roots);
        }
    }
    Some(dedupe_paths(roots))
}

fn read_lists() -> (BoxesList, ProjectsList) {
    let boxes = storage::read_json(&storage::state_dir().join("boxes.json")).unwrap_or_default();
    let projects =
        storage::read_json(&storage::state_dir().join("projects.json")).unwrap_or_default();
    (boxes, projects)
}

/// State-backed roots used by spawn.  Unknown project/box scopes return `None`
/// and are refused by the caller.
pub fn roots_for_scope(scope_id: Option<&str>, local_only: bool) -> Option<Vec<PathBuf>> {
    let Some(scope_id) = scope_id else {
        return Some(vec![storage::root_work_dir()]);
    };
    let (boxes, projects) = read_lists();
    let mut roots = compute_fence_roots(&boxes, &projects, scope_id, local_only)?;

    if let Some(box_id) = crate::commands::boxes::box_id_of_scope(scope_id) {
        roots = crate::commands::boxes::box_allowed_roots(box_id)?;
    } else {
        let project = projects.iter().find(|p| p.id == scope_id)?;
        if local_only && project.extra.contains_key("remote") {
            roots[0] = crate::services::remote_sync::mirror_dir(scope_id);
        }
        for b in boxes
            .iter()
            .filter(|b| b.member_ids.iter().any(|id| id == scope_id))
        {
            roots.extend(crate::commands::boxes::box_allowed_roots(&b.id)?);
        }
    }
    Some(dedupe_paths(roots))
}

fn settings() -> crate::schema::Settings {
    storage::read_json(&storage::state_dir().join("settings.json")).unwrap_or_default()
}

pub fn policy_for_scope(projects: &[ProjectEntry], scope_id: Option<&str>) -> bool {
    let settings = settings();
    fence_effective(projects, scope_id, settings.agent_fence())
}

pub fn policy_enabled(scope_id: Option<&str>) -> bool {
    let (_, projects) = read_lists();
    policy_for_scope(&projects, scope_id)
}

pub fn configured_read_only_paths() -> Vec<String> {
    let home = paths::home_dir();
    let settings = settings();
    let mut seen = HashSet::new();
    settings
        .agent_fence_paths()
        .into_iter()
        .filter_map(|raw| {
            let value = raw.trim();
            if value.is_empty() {
                return None;
            }
            let path = if value == "~" {
                home.clone()
            } else if let Some(rest) = value.strip_prefix("~/") {
                home.join(rest)
            } else {
                PathBuf::from(value)
            };
            path.is_absolute()
                .then(|| path.to_string_lossy().into_owned())
        })
        .filter(|p| seen.insert(p.clone()))
        .collect()
}

/// Directories the fence must restore read-only for `cmd` to be launchable
/// at all: the directory the command is found in on `path_dirs`, plus the
/// directory of every symlink hop down to the real executable. The empty home
/// tmpfs hides everything under `home`, so an installer's `~/.local/bin/claude`
/// → `~/.local/share/claude/versions/<v>` link would otherwise dangle inside
/// the sandbox and `bwrap` fails with `execvp claude: No such file or
/// directory`. Only hops under `home` matter (the host root is already visible
/// read-only), and directories already covered by `visible` are skipped.
///
/// Pure over the filesystem: it reads links but never mounts anything, and a
/// command that cannot be found on the host yields nothing — bubblewrap then
/// reports the same not-found error the shell would.
pub(crate) fn command_bind_paths(
    cmd: &str,
    path_dirs: &[PathBuf],
    home: &Path,
    visible: &[String],
) -> Vec<String> {
    let start = if cmd.contains('/') {
        Some(PathBuf::from(cmd))
    } else {
        path_dirs
            .iter()
            .map(|dir| dir.join(cmd))
            .find(|cand| cand.is_file())
    };
    let Some(mut cur) = start else {
        return Vec::new();
    };
    let covered = |dir: &Path| {
        visible
            .iter()
            .any(|v| dir == Path::new(v) || dir.starts_with(v))
    };
    let mut out: Vec<String> = Vec::new();
    // A symlink loop is not launchable anyway; bound the walk instead of hanging.
    for _ in 0..40 {
        if let Some(dir) = cur.parent() {
            if dir.starts_with(home) && dir != home && !covered(dir) {
                let dir = dir.to_string_lossy().into_owned();
                if !out.contains(&dir) {
                    out.push(dir);
                }
            }
        }
        match std::fs::read_link(&cur) {
            Ok(target) if target.is_absolute() => cur = target,
            Ok(target) => {
                cur = normalize_lexically(
                    &cur.parent().map(|d| d.join(&target)).unwrap_or(target),
                );
            }
            Err(_) => break,
        }
    }
    out
}

/// Collapse `.` and `..` without touching the filesystem, so a relative link
/// target like `../share/claude/versions/2.1.251` yields a clean mount path.
fn normalize_lexically(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// PATH as the fenced command will see it: an explicit per-tab override wins,
/// otherwise the launcher-augmented PATH the PTY is spawned with.
#[cfg(target_os = "linux")]
fn command_search_dirs(opts: &PtyOptions) -> Vec<PathBuf> {
    let path = opts
        .env
        .get("PATH")
        .map(std::ffi::OsString::from)
        .or_else(paths::effective_path)
        .unwrap_or_default();
    std::env::split_paths(&path).collect()
}

/// Probe the actual unprivileged sandbox operation once, rather than merely
/// checking that a binary named `bwrap` exists.
pub fn bwrap_available() -> bool {
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
    #[cfg(target_os = "linux")]
    {
        static AVAILABLE: OnceLock<bool> = OnceLock::new();
        *AVAILABLE.get_or_init(|| {
            crate::paths::command_no_window("bwrap")
                .args([
                    "--ro-bind",
                    "/",
                    "/",
                    "--dev",
                    "/dev",
                    "--proc",
                    "/proc",
                    "--unshare-pid",
                    "--die-with-parent",
                    "--",
                    "/bin/true",
                ])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
    }
}

fn mount_pair(pair: &str, read_only: bool) -> Option<BindMount> {
    let (src, dst) = pair.split_once(':')?;
    Some(BindMount {
        src: src.to_string(),
        dst: dst.to_string(),
        read_only,
    })
}

fn agent_state_mounts(scope_id: &str, roots: &[PathBuf]) -> Vec<BindMount> {
    let home = paths::home_dir_string();
    let state_dir = storage::state_dir();
    let live_root = crate::services::agent_session::live_sessions_dir();
    let live_own = crate::services::agent_session::project_live_sessions_dir(scope_id);
    let stage = crate::services::sandbox::stage_dir(scope_id);
    let _ = std::fs::create_dir_all(&live_own);
    let _ = std::fs::create_dir_all(&stage);

    let mut mounts: Vec<BindMount> = crate::services::sandbox::rw_mounts(
        &home,
        &live_own.to_string_lossy(),
        &live_root.to_string_lossy(),
    )
    .into_iter()
    .filter_map(|m| mount_pair(&m, false))
    .collect();
    mounts.extend(
        crate::services::sandbox::staged_config_mounts(&home, &stage)
            .into_iter()
            .map(|(src, dst)| BindMount {
                src,
                dst,
                read_only: false,
            }),
    );
    let roots_as_strings: Vec<String> = roots
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let (tx_rw, tx_ro) = crate::services::sandbox::claude_transcript_mounts(
        &home,
        &roots_as_strings,
        &crate::services::sandbox::claude_projects_stage(scope_id),
    );
    mounts.extend(tx_rw.into_iter().filter_map(|m| mount_pair(&m, false)));
    mounts.extend(tx_ro.into_iter().filter_map(|m| mount_pair(&m, true)));
    mounts.extend(
        crate::services::sandbox::ro_mounts(&state_dir.join("hooks"))
            .into_iter()
            .filter_map(|m| mount_pair(&m, true)),
    );
    mounts
}

/// Pure bubblewrap argv builder.  Later mounts intentionally shadow earlier
/// ones: the empty home hides secrets, selected state/config is restored, and
/// project/box roots finally become read-write.
pub(crate) fn bwrap_args(
    home: &str,
    cwd: &str,
    cmd: &str,
    cmd_args: &[String],
    roots: &[PathBuf],
    extra_ro: &[String],
    mounts: &[BindMount],
) -> Vec<String> {
    let mut args = vec![
        "--ro-bind".into(),
        "/".into(),
        "/".into(),
        "--dev".into(),
        "/dev".into(),
        "--proc".into(),
        "/proc".into(),
        "--tmpfs".into(),
        "/tmp".into(),
        "--tmpfs".into(),
        "/run".into(),
        "--ro-bind-try".into(),
        "/run/systemd/resolve".into(),
        "/run/systemd/resolve".into(),
        "--tmpfs".into(),
        home.into(),
    ];
    for path in extra_ro {
        args.extend(["--ro-bind-try".into(), path.clone(), path.clone()]);
    }
    for mount in mounts {
        args.push(if mount.read_only {
            "--ro-bind".into()
        } else {
            "--bind".into()
        });
        args.push(mount.src.clone());
        args.push(mount.dst.clone());
    }
    for root in roots {
        let root = root.to_string_lossy().into_owned();
        args.extend(["--bind-try".into(), root.clone(), root]);
    }
    args.extend([
        "--unshare-pid".into(),
        "--die-with-parent".into(),
        "--chdir".into(),
        cwd.into(),
        "--".into(),
        cmd.into(),
    ]);
    args.extend(cmd_args.iter().cloned());
    args
}

/// Rewrite a local agent spawn into its outer bubblewrap boundary.
#[cfg(target_os = "linux")]
pub fn wrap_pty_options_bwrap(
    opts: &mut PtyOptions,
    roots: &[PathBuf],
    scope_id: &str,
) -> Result<(), String> {
    if !bwrap_available() {
        return Err(format!(
            "Agent fence: bubblewrap is unavailable, so this agent was not started. Install it with `{INSTALL_HINT}`, or turn the Agent fence off for this project."
        ));
    }
    let mounts = agent_state_mounts(scope_id, roots);
    let mut extra_ro = configured_read_only_paths();
    extra_ro.extend(command_bind_paths(
        &opts.cmd,
        &command_search_dirs(opts),
        &paths::home_dir(),
        &extra_ro,
    ));
    let args = bwrap_args(
        &paths::home_dir_string(),
        &opts.cwd,
        &opts.cmd,
        &opts.args,
        roots,
        &extra_ro,
        &mounts,
    );
    opts.cmd = "bwrap".to_string();
    opts.args = args;
    opts.env
        .insert("ELDRUN_AGENT_FENCE".to_string(), "1".to_string());
    Ok(())
}

pub fn box_root_arg(cmd: &str) -> Option<&'static str> {
    match basename(cmd) {
        "claude" | "codex" => Some("--add-dir"),
        "gemini" => Some("--include-directories"),
        _ => None,
    }
}

/// Add agent-native working roots without duplicating an existing flag/value.
pub fn add_box_root_args(opts: &mut PtyOptions, roots: &[PathBuf], own_dir: &Path) {
    if roots.len() <= 1 {
        return;
    }
    let Some(flag) = box_root_arg(&opts.cmd) else {
        return;
    };
    for root in roots.iter().filter(|root| root.as_path() != own_dir) {
        let value = root.to_string_lossy().into_owned();
        let already = opts
            .args
            .windows(2)
            .any(|pair| pair[0] == flag && pair[1] == value);
        if !already {
            opts.args.push(flag.to_string());
            opts.args.push(value);
        }
    }
}

fn platform_reason() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(windows) {
        "Windows"
    } else {
        "this platform"
    }
}

pub fn status_for_scope(scope_id: &str) -> AgentFenceStatus {
    let (_, projects) = read_lists();
    let mut opts = PtyOptions {
        id: "agent-fence-status".to_string(),
        cmd: "claude".to_string(),
        args: Vec::new(),
        env: HashMap::new(),
        cwd: String::new(),
        cols: 80,
        rows: 24,
        local_only: false,
        sandbox: false,
        agent: true,
        project_id: Some(scope_id.to_string()),
        remote_host_id: None,
        tmux_session: None,
        tmux_attach: None,
        host_bound_uid: None,
    };
    crate::services::sandbox::enforce_spawn_authority(&mut opts);
    let remote_run =
        !opts.local_only && crate::services::remote::remote_target_for(scope_id).is_some();
    let roots = roots_for_scope(Some(scope_id), opts.local_only);
    let root_strings = roots
        .as_ref()
        .map(|r| r.iter().map(|p| p.to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    let available = bwrap_available();
    let Some(roots) = roots else {
        return AgentFenceStatus {
            enforced: false,
            reason: "unknown project or box".to_string(),
            roots: root_strings,
            bwrap_available: available,
        };
    };
    let decision = decide(
        &opts,
        roots,
        remote_run,
        policy_for_scope(&projects, Some(scope_id)),
        cfg!(target_os = "linux"),
        available,
    );
    let (enforced, reason) = match decision {
        FenceDecision::Fenced { .. } => (true, "enforced".to_string()),
        FenceDecision::NotApplicable { reason: "platform" } => {
            (false, platform_reason().to_string())
        }
        FenceDecision::NotApplicable { reason } => (false, reason.to_string()),
        FenceDecision::Unavailable { .. } => (false, "bubblewrap unavailable".to_string()),
    };
    AgentFenceStatus {
        enforced,
        reason,
        roots: root_strings,
        bwrap_available: available,
    }
}

fn fenced_tabs() -> &'static Mutex<HashMap<String, String>> {
    static TABS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    TABS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register_tab(tab_id: &str, scope_id: &str) {
    if let Some(old) = fenced_tabs()
        .lock()
        .unwrap()
        .insert(tab_id.to_string(), scope_id.to_string())
    {
        crate::services::sandbox::harvest_project_transcripts(&old);
    }
}

pub fn on_tab_gone(tab_id: &str) {
    if let Some(scope_id) = fenced_tabs().lock().unwrap().remove(tab_id) {
        crate::services::sandbox::harvest_project_transcripts(&scope_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::boxes::ProjectBox;
    use serde_json::{json, Value};

    fn project(id: &str, dir: &str) -> ProjectEntry {
        let mut extra = HashMap::new();
        extra.insert("directory".into(), Value::String(dir.into()));
        ProjectEntry {
            id: id.into(),
            name: id.into(),
            status: "active".into(),
            position: 0,
            local_file: format!("{dir}/project.json"),
            extra,
        }
    }

    fn opts(cmd: &str) -> PtyOptions {
        PtyOptions {
            id: "p:t".into(),
            cmd: cmd.into(),
            args: Vec::new(),
            env: HashMap::new(),
            cwd: "/p".into(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            agent: false,
            project_id: Some("p".into()),
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
        }
    }

    #[test]
    fn decision_matrix() {
        let roots = vec![PathBuf::from("/p")];
        assert_eq!(
            decide(&opts("bash"), roots.clone(), false, true, true, true),
            FenceDecision::NotApplicable { reason: "shell" }
        );
        let mut container = opts("claude");
        container.sandbox = true;
        assert_eq!(
            decide(&container, roots.clone(), false, true, true, true),
            FenceDecision::NotApplicable {
                reason: "container"
            }
        );
        assert_eq!(
            decide(&opts("claude"), roots.clone(), true, true, true, true),
            FenceDecision::NotApplicable {
                reason: "remote host"
            }
        );
        let mut local_mirror = opts("claude");
        local_mirror.local_only = true;
        assert!(matches!(
            decide(
                &local_mirror,
                vec![PathBuf::from("/mirror/p")],
                false,
                true,
                true,
                true
            ),
            FenceDecision::Fenced { roots }
                if roots == vec![PathBuf::from("/mirror/p")]
        ));
        assert_eq!(
            decide(&opts("claude"), roots.clone(), false, false, true, true),
            FenceDecision::NotApplicable { reason: "off" }
        );
        assert!(matches!(
            decide(&opts("claude"), roots.clone(), false, true, true, false),
            FenceDecision::Unavailable { .. }
        ));
        let mut custom = opts("my-agent-wrapper");
        custom.agent = true;
        assert!(matches!(
            decide(&custom, roots, false, true, true, true),
            FenceDecision::Fenced { .. }
        ));
    }

    #[test]
    fn fence_override_precedence() {
        let mut off = project("off", "/off");
        off.extra.insert("agent_fence".into(), json!(false));
        let mut on = project("on", "/on");
        on.extra.insert("agent_fence".into(), json!(true));
        let inherit = project("inherit", "/inherit");
        let list = vec![off, on, inherit];
        assert!(!fence_effective(&list, Some("off"), true));
        assert!(fence_effective(&list, Some("on"), false));
        assert!(fence_effective(&list, Some("inherit"), true));
        assert!(!fence_effective(&list, Some("inherit"), false));
        assert!(fence_effective(&list, Some("box:b"), true));
    }

    #[test]
    fn roots_cover_plain_multi_box_and_box_scope() {
        let p1 = project("p1", "/work/p1");
        let mut p2 = project("p2", "/remote/p2");
        p2.extra.insert("remote".into(), json!({"host":"h"}));
        p2.extra.insert("mirror".into(), json!("/mirrors/p2"));
        let boxes = vec![
            ProjectBox {
                id: "a".into(),
                name: "A".into(),
                member_ids: vec!["p1".into(), "p2".into()],
                folder: Some("/boxes/a".into()),
                ..ProjectBox::default()
            },
            ProjectBox {
                id: "b".into(),
                name: "B".into(),
                member_ids: vec!["p1".into()],
                folder: Some("/boxes/b".into()),
                ..ProjectBox::default()
            },
        ];
        let projects = vec![p1, p2];
        assert_eq!(
            compute_fence_roots(&Vec::new(), &projects, "p2", true).unwrap(),
            vec![PathBuf::from("/mirrors/p2")]
        );
        let p1_roots = compute_fence_roots(&boxes, &projects, "p1", false).unwrap();
        for expected in [
            "/work/p1",
            "/boxes/a",
            "/remote/p2",
            "/mirrors/p2",
            "/boxes/b",
        ] {
            assert!(p1_roots.contains(&PathBuf::from(expected)), "{p1_roots:?}");
        }
        let box_roots = compute_fence_roots(&boxes, &projects, "box:a", false).unwrap();
        assert!(box_roots.contains(&PathBuf::from("/boxes/a")));
        assert!(compute_fence_roots(&boxes, &projects, "ghost", false).is_none());
        assert!(compute_fence_roots(&boxes, &projects, "box:ghost", false).is_none());
    }

    #[test]
    fn bwrap_argv_orders_home_mounts_roots_and_command() {
        let roots = vec![PathBuf::from("/home/u/work/p")];
        let mounts = vec![BindMount {
            src: "/stage/config".into(),
            dst: "/home/u/.codex/config.toml".into(),
            read_only: false,
        }];
        let out = bwrap_args(
            "/home/u",
            "/home/u/work/p",
            "codex",
            &["resume".into(), "abc".into()],
            &roots,
            &["/home/u/.cargo".into()],
            &mounts,
        );
        let home_tmpfs = out
            .windows(2)
            .position(|p| p == ["--tmpfs", "/home/u"])
            .unwrap();
        let cargo = out.iter().position(|p| p == "/home/u/.cargo").unwrap();
        let config = out
            .iter()
            .position(|p| p == "/home/u/.codex/config.toml")
            .unwrap();
        let root = out.iter().rposition(|p| p == "/home/u/work/p").unwrap();
        assert!(home_tmpfs < cargo && cargo < config && config < root);
        assert!(!out.iter().any(|p| p == "--new-session"));
        let separator = out.iter().position(|p| p == "--").unwrap();
        assert_eq!(&out[separator + 1..], &["codex", "resume", "abc"]);
        assert_eq!(out[separator - 2], "--chdir");
        assert_eq!(out[separator - 1], "/home/u/work/p");
    }

    #[cfg(unix)]
    #[test]
    fn command_bind_paths_follow_installer_symlinks_under_home() {
        let tmp = std::env::temp_dir().join(format!(
            "eldrun-fence-bind-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let home = tmp.join("home");
        let bin = home.join(".local/bin");
        let versions = home.join(".local/share/claude/versions");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&versions).unwrap();
        let real = versions.join("2.1.251");
        std::fs::write(&real, "#!/bin/sh\n").unwrap();
        // ~/.local/bin/claude -> ../share/claude/versions/2.1.251 (relative hop)
        std::os::unix::fs::symlink("../share/claude/versions/2.1.251", bin.join("claude"))
            .unwrap();
        // /usr/bin-style link outside home -> under home (absolute hop)
        let usr_bin = tmp.join("usr/bin");
        std::fs::create_dir_all(&usr_bin).unwrap();
        std::os::unix::fs::symlink(bin.join("claude"), usr_bin.join("claude")).unwrap();
        let dirs = vec![usr_bin.clone(), bin.clone()];

        let bin_s = bin.to_string_lossy().into_owned();
        let versions_s = versions.to_string_lossy().into_owned();
        // Nothing visible yet: both home-side hops are restored, the usr hop is
        // already covered by the read-only host root and stays out.
        assert_eq!(
            command_bind_paths("claude", &dirs, &home, &[]),
            vec![bin_s.clone(), versions_s.clone()]
        );
        // The default allowlist already covers ~/.local/bin; only the target is added.
        assert_eq!(
            command_bind_paths("claude", &dirs, &home, std::slice::from_ref(&bin_s)),
            vec![versions_s.clone()]
        );
        // An ancestor in the allowlist covers the whole chain.
        let share = home.join(".local/share").to_string_lossy().into_owned();
        assert_eq!(
            command_bind_paths("claude", &dirs, &home, &[bin_s.clone(), share]),
            Vec::<String>::new()
        );
        // Explicit path and an unknown command.
        assert_eq!(
            command_bind_paths(&bin.join("claude").to_string_lossy(), &[], &home, &[]),
            vec![bin_s, versions_s]
        );
        assert!(command_bind_paths("no-such-agent", &dirs, &home, &[]).is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn add_dir_flags_are_agent_specific_and_idempotent() {
        let roots = vec![PathBuf::from("/p"), PathBuf::from("/sibling")];
        let mut claude = opts("claude");
        add_box_root_args(&mut claude, &roots, Path::new("/p"));
        add_box_root_args(&mut claude, &roots, Path::new("/p"));
        assert_eq!(claude.args, vec!["--add-dir", "/sibling"]);
        let mut gemini = opts("gemini");
        add_box_root_args(&mut gemini, &roots, Path::new("/p"));
        assert_eq!(gemini.args, vec!["--include-directories", "/sibling"]);
        let mut shell = opts("bash");
        add_box_root_args(&mut shell, &roots, Path::new("/p"));
        assert!(shell.args.is_empty());
        let mut one = opts("codex");
        add_box_root_args(&mut one, &roots[..1], Path::new("/p"));
        assert!(one.args.is_empty());
    }
}
