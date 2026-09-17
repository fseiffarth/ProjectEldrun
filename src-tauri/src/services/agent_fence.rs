//! Filesystem fence for locally-running agent tabs (Linux and macOS).
//!
//! The project container remains the stronger, opt-in boundary.  For ordinary
//! local agent tabs this module wraps the agent in the OS's unprivileged
//! sandbox: `bubblewrap` on Linux (the host root is read-only, `$HOME`, `/tmp`,
//! and `/run` are private, and only the owning project plus every box it
//! belongs to is mounted read-write) and `sandbox-exec` on macOS (a Seatbelt
//! profile that denies writes outside the same roots and hides the rest of
//! `$HOME` — see [`sandbox_exec_profile`] for what it can and cannot mirror).
//! Shell tabs, remote-host tabs, containerized tabs, and Windows hosts are
//! deliberately left alone and reported honestly by [`status_for_scope`].

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::schema::boxes::BoxesList;
use crate::schema::projects::{ProjectEntry, ProjectsList};
use crate::terminal::PtyOptions;
use crate::{paths, storage};

/// A package the fence may ask the user to install. Only bubblewrap for now: it
/// is the one missing tool that makes Eldrun fail closed.
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallPkg {
    Bubblewrap,
}

/// The distribution's own install command for `pkg`, chosen from an
/// `os-release` file: its `ID` first, then each `ID_LIKE` entry in order.
/// `None` for a distribution this does not recognize — the pill runs this
/// command with one click, and another package manager's command is worse than
/// no button.
#[cfg(any(target_os = "linux", test))]
pub fn package_install_cmd(os_release: &str, pkg: InstallPkg) -> Option<String> {
    let field = |key: &str| {
        os_release.lines().find_map(|line| {
            let (k, v) = line.split_once('=')?;
            (k.trim() == key)
                .then(|| v.trim().trim_matches(|c| c == '"' || c == '\'').to_ascii_lowercase())
        })
    };
    let mut ids: Vec<String> = field("ID").into_iter().collect();
    if let Some(like) = field("ID_LIKE") {
        ids.extend(like.split_whitespace().map(str::to_string));
    }
    let package = match pkg {
        InstallPkg::Bubblewrap => "bubblewrap",
    };
    ids.iter().find_map(|id| {
        let manager = match id.as_str() {
            "debian" | "ubuntu" | "linuxmint" | "pop" | "elementary" | "raspbian" | "kali"
            | "zorin" | "neon" => "sudo apt install -y",
            "fedora" | "rhel" | "centos" | "rocky" | "almalinux" | "nobara" => {
                "sudo dnf install -y"
            }
            "arch" | "manjaro" | "endeavouros" | "cachyos" => "sudo pacman -S --needed",
            "suse" | "sles" => "sudo zypper install -y",
            other if other.starts_with("opensuse") => "sudo zypper install -y",
            _ => return None,
        };
        Some(format!("{manager} {package}"))
    })
}

/// The install command for the fence tool on this machine, or `None` when there
/// is nothing honest to offer: not Linux (macOS ships `sandbox-exec`, Windows
/// has no fence), or a distribution [`package_install_cmd`] does not know.
pub fn fence_install_cmd() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        static CMD: OnceLock<Option<String>> = OnceLock::new();
        CMD.get_or_init(|| {
            let release = std::fs::read_to_string("/etc/os-release")
                .or_else(|_| std::fs::read_to_string("/usr/lib/os-release"))
                .unwrap_or_default();
            package_install_cmd(&release, InstallPkg::Bubblewrap)
        })
        .clone()
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// The spawn refusal when the fence tool is missing — one wording for both
/// places that refuse (`pty_spawn`'s decision and the bubblewrap wrapper).
pub fn fence_unavailable_message() -> String {
    let tool = fence_tool_name();
    if cfg!(target_os = "macos") {
        return format!(
            "Agent fence: {tool} is unavailable on this Mac, so this agent was not started. Turn the Agent fence off for this project."
        );
    }
    match fence_install_cmd() {
        Some(cmd) => format!(
            "Agent fence: {tool} is unavailable, so this agent was not started. Install it with `{cmd}`, or turn the Agent fence off for this project."
        ),
        None => format!(
            "Agent fence: {tool} is unavailable, so this agent was not started. Install the {tool} package with your distribution's package manager, or turn the Agent fence off for this project."
        ),
    }
}

/// The sandboxing tool this OS's fence is built on, for messages.
pub fn fence_tool_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "sandbox-exec"
    } else {
        "bubblewrap"
    }
}

/// Whether this OS has a fence implementation at all: Linux (bubblewrap) and
/// macOS (sandbox-exec). Windows has no unprivileged filesystem sandbox a
/// process can wrap another in, so agents there run unfenced and the pill says
/// so.
pub fn platform_fenceable() -> bool {
    cfg!(any(target_os = "linux", target_os = "macos"))
}

/// The backend authority decision.  `Unavailable` is fail-closed at spawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FenceDecision {
    Fenced { roots: Vec<PathBuf> },
    NotApplicable { reason: &'static str },
    /// The fence tool is missing or unusable. The install advice is not carried
    /// here: it depends on the distribution, and [`fence_unavailable_message`]
    /// reads it, which keeps this decision pure.
    Unavailable,
}

// The mount/symlink planners below feed the bubblewrap fence (Linux) and the
// Seatbelt profile inputs (macOS, `sandbox_exec_inputs`); Windows has no fence.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BindMount {
    pub src: String,
    pub dst: String,
    pub read_only: bool,
}

/// A symlink created inside the fence, pointing at a staged shadow copy.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FenceSymlink {
    pub target: String,
    pub link: String,
}

/// Where this scope's staging dir (the writable config shadows) is mounted
/// inside the fence.
///
/// The shadows are reached *through* this directory and symlinked into place
/// rather than bind-mounted onto their real paths, because `rename(2)` fails
/// with `EBUSY` when the destination is a mount point — and every agent that
/// rewrites its own config writes a sibling temp file and renames it over the
/// original. Codex surfaced that as `failed to persist config at
/// ~/.codex/config.toml` the first time it tried to record a newly trusted
/// project. A symlink into a bound *directory* is safe for either style of
/// writer: an in-place rewrite still lands in the throwaway copy, and a rename
/// simply replaces the symlink with a plain file in the home tmpfs. Neither
/// reaches the host original, which is the whole point of the shadow.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub(crate) const STAGE_MOUNT: &str = "/run/eldrun-agent-config";

#[derive(Debug, Clone, Serialize)]
pub struct AgentFenceStatus {
    pub enforced: bool,
    pub reason: String,
    pub roots: Vec<String>,
    pub bwrap_available: bool,
    /// The one-click install for the missing fence tool on this distribution;
    /// `None` when the tool works or there is no command worth running.
    pub install_cmd: Option<String>,
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
/// the policy is testable without touching the state directory. `fenceable` is
/// [`platform_fenceable`] and `tool_ok` is [`bwrap_available`] (the fence tool
/// probe, whichever tool that is on this OS).
pub fn decide(
    opts: &PtyOptions,
    roots: Vec<PathBuf>,
    remote_run: bool,
    policy_on: bool,
    fenceable: bool,
    tool_ok: bool,
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
    if !fenceable {
        return FenceDecision::NotApplicable { reason: "platform" };
    }
    if !policy_on {
        return FenceDecision::NotApplicable { reason: "off" };
    }
    if !tool_ok {
        return FenceDecision::Unavailable;
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
#[cfg(any(target_os = "linux", target_os = "macos", test))]
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
#[cfg(any(target_os = "linux", target_os = "macos", test))]
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

/// The part of the agent's own install that must be **writable** for the CLI
/// to update itself from inside the fence — `claude update`, and Claude's
/// background auto-update, which otherwise fails on every fenced tab.
///
/// Recognised is the native-installer layout only: a launcher link in
/// `~/.local/bin` pointing at a payload under `~/.local/share/<tool>/`. The
/// updater writes the new binary into `~/.local/share/claude/versions/` and
/// swaps the `~/.local/bin/claude` link by rename (measured 2026-09-13: those
/// two directories and nothing else), so both are handed back read-write —
/// the `~/.local/share/<tool>` root rather than `versions/`, so a lock or
/// staging file beside it is not refused either. An install that lives
/// anywhere else (npm/nvm, a package manager) stays read-only: making a Node
/// prefix's `bin/` writable would expose every global tool in it, and those
/// installs update from a plain terminal tab anyway.
///
/// This is a deliberate widening of the fence (user, 2026-09-13): an agent
/// that can update its own CLI can also replace it, and that binary is the one
/// the user runs everywhere. Pure over the filesystem, like
/// [`command_bind_paths`].
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub(crate) fn updatable_install_dirs(
    cmd: &str,
    path_dirs: &[PathBuf],
    home: &Path,
) -> Vec<String> {
    let hops = command_bind_paths(cmd, path_dirs, home, &[]);
    let bin = home.join(".local/bin");
    let share = home.join(".local/share");
    let mut out: Vec<String> = Vec::new();
    for hop in &hops {
        let hop = Path::new(hop);
        if let Ok(rest) = hop.strip_prefix(&share) {
            if let Some(tool) = rest.components().next() {
                let root = share
                    .join(tool.as_os_str())
                    .to_string_lossy()
                    .into_owned();
                if !out.contains(&root) {
                    out.push(root);
                }
            }
        }
    }
    // Only a native-installer payload earns the launcher dir: a link in
    // `~/.local/bin` that points somewhere else is left read-only.
    if !out.is_empty() && hops.iter().any(|h| Path::new(h) == bin) {
        out.insert(0, bin.to_string_lossy().into_owned());
    }
    out
}

/// PATH as the fenced command will see it: an explicit per-tab override wins,
/// otherwise the launcher-augmented PATH the PTY is spawned with.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn command_search_dirs(opts: &PtyOptions) -> Vec<PathBuf> {
    let path = opts
        .env
        .get("PATH")
        .map(std::ffi::OsString::from)
        .or_else(paths::effective_path)
        .unwrap_or_default();
    std::env::split_paths(&path).collect()
}

/// Cache successful probes only: installing/unblocking the tool must let the
/// next tab start without restarting Eldrun. Serialize probes across callers.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn probe_until_available(cache: &Mutex<bool>, probe: impl FnOnce() -> bool) -> bool {
    let mut available = cache.lock().unwrap_or_else(|e| e.into_inner());
    if !*available {
        *available = probe();
    }
    *available
}

/// Probe the actual unprivileged sandbox operation, rather than merely
/// checking that a binary named `bwrap` exists. On macOS the probe is the
/// equivalent `sandbox-exec` no-op profile (the tool ships with the OS, but a
/// managed Mac can have it policy-blocked). The name is kept for the frontend's
/// `bwrap_available` field, which on macOS means "sandbox-exec works".
pub fn bwrap_available() -> bool {
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        false
    }
    #[cfg(target_os = "macos")]
    {
        static AVAILABLE: Mutex<bool> = Mutex::new(false);
        probe_until_available(&AVAILABLE, || {
            crate::paths::command_no_window("/usr/bin/sandbox-exec")
                .args(["-p", "(version 1)(allow default)", "/usr/bin/true"])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
    }
    #[cfg(target_os = "linux")]
    {
        static AVAILABLE: Mutex<bool> = Mutex::new(false);
        probe_until_available(&AVAILABLE, || {
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

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn mount_pair(pair: &str, read_only: bool) -> Option<BindMount> {
    let (src, dst) = pair.split_once(':')?;
    Some(BindMount {
        src: src.to_string(),
        dst: dst.to_string(),
        read_only,
    })
}

/// Turn a `(staged copy, real path)` pair into the symlink that puts the copy
/// at the real path — see [`STAGE_MOUNT`] for why it is a link, not a mount.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn staged_symlink(src: &str, dst: &str) -> Option<FenceSymlink> {
    let leaf = Path::new(src).file_name()?.to_string_lossy().into_owned();
    Some(FenceSymlink {
        target: format!("{STAGE_MOUNT}/{leaf}"),
        link: dst.to_string(),
    })
}

/// The local-model tabs' own state: `<state_dir>/vibe_local`, where
/// `commands::ollama::prepare_local_agent` writes one `VIBE_HOME` per model
/// (`config.toml` naming the Ollama provider and the active model, `logs/`,
/// `.env`).
///
/// Unmounted it is hidden like everything else under the `$HOME` tmpfs, and a
/// fenced Mistral/vibe tab found no config at all: it fell back to vibe's cloud
/// default and opened asking for `MISTRAL_API_KEY` — "the local model doesn't
/// work", on every fenced scope, most visibly the root console, which has no
/// per-project fence override to turn off.
///
/// The **whole directory**, not the spawn's own `VIBE_HOME`: that value comes
/// from the renderer, and a read-write mount is never built from something the
/// renderer names. It holds no credential of the user's — Eldrun writes these
/// files itself, pointing at the local Ollama server.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub(crate) fn local_model_mounts(state_dir: &Path) -> Vec<BindMount> {
    let dir = state_dir.join("vibe_local");
    if !dir.is_dir() {
        // Nothing has prepared a local-model home yet. Mounting a directory
        // that does not exist fails the spawn, and a tab that never drives one
        // loses nothing by its absence.
        return Vec::new();
    }
    let path = dir.to_string_lossy().into_owned();
    vec![BindMount {
        src: path.clone(),
        dst: path,
        read_only: false,
    }]
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn agent_state_mounts(scope_id: &str, roots: &[PathBuf]) -> (Vec<BindMount>, Vec<FenceSymlink>) {
    let home = paths::home_dir_string();
    let state_dir = storage::state_dir();
    let live_root = crate::services::agent_session::live_sessions_dir();
    let live_own = crate::services::agent_session::project_live_sessions_dir(scope_id);
    let stage = crate::services::sandbox::stage_dir(scope_id);
    let _ = std::fs::create_dir_all(&live_own);
    let _ = std::fs::create_dir_all(&stage);

    let (home_rw, home_ro) = crate::services::sandbox::agent_home_mounts(
        &home,
        &live_own.to_string_lossy(),
        &live_root.to_string_lossy(),
        cfg!(target_os = "linux"),
    );
    let mut mounts: Vec<BindMount> = Vec::new();
    // A directory mount lets SQLite replace its WAL/SHM files normally. On
    // macOS Seatbelt cannot substitute paths, so it continues using the real
    // host directory under its deny/allow profile instead.
    #[cfg(target_os = "linux")]
    mounts.push(BindMount {
        src: crate::services::sandbox::prepare_codex_state(&home, scope_id)
            .to_string_lossy()
            .into_owned(),
        dst: format!("{home}/.codex"),
        read_only: false,
    });
    mounts.extend(
        home_rw
        .into_iter()
        .filter_map(|m| mount_pair(&m, false)),
    );
    // Hook/statusline scripts and global instruction files: readable, never
    // writable — a write there escapes the fence into an uncontained session.
    mounts.extend(home_ro.into_iter().filter_map(|m| mount_pair(&m, true)));
    // One writable mount of the whole staging dir; the shadows below are
    // symlinked into it rather than mounted over their real paths.
    mounts.push(BindMount {
        src: stage.to_string_lossy().into_owned(),
        dst: STAGE_MOUNT.to_string(),
        read_only: false,
    });
    let mut symlinks: Vec<FenceSymlink> =
        crate::services::sandbox::staged_config_mounts(&home, &stage)
            .iter()
            .filter_map(|(src, dst)| staged_symlink(src, dst))
            .collect();
    let roots_as_strings: Vec<String> = roots
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    // Without `~/.claude.json` (oauthAccount, onboarding) every fenced tab
    // demands a fresh login; see `staged_claude_json_mount` for why it is a
    // filtered copy rather than the host original.
    for (src, dst) in
        crate::services::sandbox::staged_claude_json_mounts(&home, &stage, &roots_as_strings)
    {
        symlinks.extend(staged_symlink(&src, &dst));
    }
    // Claude's credential file: a stable-inode mirror mounted at the real
    // path (on macOS the real path itself, kept writable). A mount, not a
    // symlink into the stage — Claude opens it `O_NOFOLLOW`; and a mirror, not
    // the host file — a file bind mount pins an inode and Claude rotates the
    // file by rename, which is how long-lived tabs came to read a stale token.
    // See `sandbox::claude_credential_mounts`.
    mounts.extend(
        crate::services::sandbox::claude_credential_mounts(&home)
            .into_iter()
            .map(|(src, dst)| BindMount {
                src,
                dst,
                read_only: false,
            }),
    );
    let (tx_rw, tx_ro) = crate::services::sandbox::claude_transcript_mounts(
        &home,
        &roots_as_strings,
        &crate::services::sandbox::claude_projects_stage(scope_id),
    );
    mounts.extend(tx_rw.into_iter().filter_map(|m| mount_pair(&m, false)));
    mounts.extend(tx_ro.into_iter().filter_map(|m| mount_pair(&m, true)));
    mounts.extend(
        crate::services::sandbox::ro_mounts_for_hooks(&state_dir.join("hooks"))
            .into_iter()
            .filter_map(|m| mount_pair(&m, true)),
    );
    mounts.extend(local_model_mounts(&state_dir));
    let bin = crate::services::agent_bin::bin_dir();
    let _ = std::fs::create_dir_all(&bin);
    let bin = bin.to_string_lossy().into_owned();
    mounts.push(BindMount { src: bin.clone(), dst: bin, read_only: true });
    (mounts, symlinks)
}

/// Executable/instruction content must not be writable in the host's Codex
/// home. Auth, session rollouts and the resume databases are deliberately not
/// in this list. Linux substitutes writable copies; Seatbelt denies writes.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
const CODEX_PRIVATE_CONTENT: &[&str] = &["skills", "plugins", "shell_snapshots"];

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn codex_content_paths(home: &Path) -> Vec<String> {
    let paths = CODEX_PRIVATE_CONTENT.iter().flat_map(|name| {
        let path = home.join(".codex").join(name);
        let canonical = path.canonicalize().ok();
        std::iter::once(path).chain(canonical)
    });
    dedupe_paths(paths).into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// Copy into a fresh destination, never one already writable by an agent.
/// Internal links are relocated within the copy (including directory cycles);
/// external links are materialized so they cannot write back into host content.
#[cfg(any(target_os = "linux", all(unix, test)))]
fn copy_private_content(src: &Path, dst: &Path) -> std::io::Result<()> {
    fn copy(src: &Path, dst: &Path, source_root: &Path, dest_root: &Path, ancestors: &mut Vec<PathBuf>) -> std::io::Result<()> {
        let canonical = match src.canonicalize() {
            Ok(path) => path,
            // A dangling optional plugin link must not prevent agent startup.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound
                && src.symlink_metadata()?.file_type().is_symlink() => return Ok(()),
            Err(e) => return Err(e),
        };
        #[cfg(unix)]
        if dst != dest_root && src.symlink_metadata()?.file_type().is_symlink() {
            if let Ok(relative) = canonical.strip_prefix(source_root) {
                let target = dest_root.join(relative);
                let parent = dst.parent().unwrap();
                let common = parent.components().zip(target.components()).take_while(|(a, b)| a == b).count();
                let mut link = PathBuf::new();
                for _ in parent.components().skip(common) {
                    link.push("..");
                }
                link.extend(target.components().skip(common));
                if link.as_os_str().is_empty() { link.push("."); }
                return std::os::unix::fs::symlink(link, dst);
            }
        }
        if ancestors.contains(&canonical) || ancestors.len() >= 64 {
            return Err(std::io::Error::other("external cycle or excessive depth in Codex content"));
        }
        let metadata = std::fs::metadata(&canonical)?;
        if metadata.is_dir() {
            ancestors.push(canonical.clone());
            std::fs::create_dir_all(dst)?;
            for entry in std::fs::read_dir(&canonical)? {
                let entry = entry?;
                copy(&entry.path(), &dst.join(entry.file_name()), source_root, dest_root, ancestors)?;
            }
            ancestors.pop();
        } else if metadata.is_file() {
            std::fs::copy(&canonical, dst)?;
        }
        Ok(())
    }
    copy(src, dst, &src.canonicalize()?, dst, &mut Vec::new())
}

/// Fresh per-spawn shadows keep startup writes and plugin/skill updates local.
/// Snapshots are regenerated by Codex; never copy another session's shell env.
/// Staging is discarded by Eldrun's existing startup stage cleanup.
#[cfg(any(target_os = "linux", all(unix, test)))]
fn private_codex_content(home: &Path, stage: &Path) -> Result<(tempfile::TempDir, Vec<BindMount>), String> {
    let shadow = tempfile::Builder::new().prefix("codex-content-").tempdir_in(stage)
        .map_err(|e| format!("Agent fence: create Codex content shadows: {e}"))?;
    let mut mounts = Vec::new();
    for name in CODEX_PRIVATE_CONTENT {
        let source = home.join(".codex").join(name);
        let dest = shadow.path().join(name);
        if *name != "shell_snapshots" && source.exists() {
            copy_private_content(&source, &dest)
                .map_err(|e| format!("Agent fence: copy Codex {name}: {e}"))?;
        } else {
            std::fs::create_dir_all(&dest)
                .map_err(|e| format!("Agent fence: create Codex {name}: {e}"))?;
        }
        mounts.push(BindMount {
            src: dest.to_string_lossy().into_owned(),
            dst: source.to_string_lossy().into_owned(),
            read_only: false,
        });
    }
    Ok((shadow, mounts))
}

/// Both Cargo credential spellings, including an explicit CARGO_HOME and
/// canonical aliases. Read-only toolchain mounts must not disclose tokens.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn cargo_credential_paths(home: &Path, cargo_home: Option<&Path>, cwd: &Path, allow_credentials: bool) -> Vec<String> {
    if allow_credentials {
        return Vec::new();
    }
    let mut homes = vec![home.join(".cargo")];
    if let Some(path) = cargo_home {
        homes.push(if path.is_absolute() { path.to_owned() } else { cwd.join(path) });
    }
    let mut paths = Vec::new();
    for home in homes {
        for name in ["credentials", "credentials.toml"] {
            let path = home.join(name);
            paths.push(path.clone());
            if let Ok(canonical) = path.canonicalize() {
                paths.push(canonical);
            }
        }
    }
    dedupe_paths(paths).into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn hidden_cargo_credentials(opts: &PtyOptions) -> Vec<String> {
    let cargo_home = opts.env.get("CARGO_HOME").map(PathBuf::from)
        .or_else(|| std::env::var_os("CARGO_HOME").map(PathBuf::from));
    cargo_credential_paths(&paths::home_dir(), cargo_home.as_deref(), Path::new(&opts.cwd),
        settings().agent_fence_cargo_credentials.unwrap_or(false))
}

#[cfg(any(target_os = "linux", test))]
fn mask_cargo_credentials(args: &mut Vec<String>, hidden: Vec<String>) {
    let separator = args.iter().position(|arg| arg == "--").unwrap();
    let masks = hidden.into_iter()
        .filter(|p| Path::new(p).is_file())
        .flat_map(|path| ["--ro-bind".to_string(), "/dev/null".to_string(), path]);
    args.splice(separator..separator, masks);
}

/// Pure bubblewrap argv builder.  Later mounts intentionally shadow earlier
/// ones: the empty home hides secrets, selected state/config is restored, and
/// project/box roots finally become read-write.  `symlinks` come last of the
/// filesystem setup, after the mount that holds what they point at.
#[cfg(any(target_os = "linux", test))]
#[allow(clippy::too_many_arguments)]
pub(crate) fn bwrap_args(
    home: &str,
    cwd: &str,
    cmd: &str,
    cmd_args: &[String],
    roots: &[PathBuf],
    extra_ro: &[String],
    mounts: &[BindMount],
    symlinks: &[FenceSymlink],
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
    for link in symlinks {
        args.extend(["--symlink".into(), link.target.clone(), link.link.clone()]);
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

/// State directories holding private data that the `$HOME` tmpfs does not hide,
/// because `ELDRUN_STATE_DIR` put them somewhere else.
///
/// The fence hides the user's data by shadowing `$HOME`, and the default state
/// dir lives there. Moved outside it, the mail store (`mail/`: the database,
/// attachments, and on an unencrypted store everything in the clear) would sit
/// under the read-only `/` bind, readable by every fenced agent.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn private_state_outside_home(home: &Path, state_dir: &Path) -> Vec<String> {
    if state_dir.starts_with(home) {
        return Vec::new();
    }
    ["mail"]
        .iter()
        .map(|name| state_dir.join(name))
        .filter(|dir| dir.is_dir())
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect()
}

/// Rewrite a local agent spawn into its outer bubblewrap boundary.
///
/// The agent's argv passes through untouched. Codex in particular gets no
/// sandbox-backend override: its own bubblewrap cannot nest under this fence
/// on Ubuntu (the stacked `unpriv_bwrap` AppArmor profile denies the uid-map
/// write of a second user namespace), and the Landlock fallback that used to
/// be forced here (`features.use_legacy_landlock`) is deprecated upstream and
/// warns on every start, so Codex is left to report the failed sandbox and
/// ask, as it does anywhere else its sandbox cannot spawn.
#[cfg(target_os = "linux")]
pub fn wrap_pty_options_bwrap(
    opts: &mut PtyOptions,
    roots: &[PathBuf],
    scope_id: &str,
) -> Result<tempfile::TempDir, String> {
    if !bwrap_available() {
        return Err(fence_unavailable_message());
    }
    let (mut mounts, symlinks) = agent_state_mounts(scope_id, roots);
    let protected = codex_content_paths(&paths::home_dir());
    mounts.retain(|m| !protected.contains(&m.dst));
    let (content_shadow, content_mounts) = private_codex_content(
        &paths::home_dir(), &crate::services::sandbox::stage_dir(scope_id),
    )?;
    mounts.extend(content_mounts);
    let mut extra_ro = configured_read_only_paths();
    let search_dirs = command_search_dirs(opts);
    // The agent's own install, read-write so it can update itself. These go
    // into `mounts`, which `bwrap_args` places after `extra_ro`, so they shadow
    // the allowlist's read-only `~/.local/bin` (later mounts win).
    let updatable = updatable_install_dirs(&opts.cmd, &search_dirs, &paths::home_dir());
    let mut visible = extra_ro.clone();
    visible.extend(updatable.iter().cloned());
    extra_ro.extend(command_bind_paths(
        &opts.cmd,
        &search_dirs,
        &paths::home_dir(),
        &visible,
    ));
    mounts.extend(updatable.into_iter().map(|dir| BindMount {
        src: dir.clone(),
        dst: dir,
        read_only: false,
    }));
    let mut args = bwrap_args(
        &paths::home_dir_string(),
        &opts.cwd,
        &opts.cmd,
        &opts.args,
        roots,
        &extra_ro,
        &mounts,
        &symlinks,
    );
    // Final masks follow every allowlist/project bind, so none re-exposes a
    // token. Missing files need no mask (their parent is read-only/hidden).
    mask_cargo_credentials(&mut args, hidden_cargo_credentials(opts));
    // Right after the home tmpfs, before any bind that could need to show
    // through it.
    let home = paths::home_dir_string();
    if let Some(i) = args
        .windows(2)
        .position(|w| w[0] == "--tmpfs" && w[1] == home)
    {
        let hidden = private_state_outside_home(&paths::home_dir(), &storage::state_dir());
        for (n, dir) in hidden.into_iter().enumerate() {
            let at = i + 2 + 2 * n;
            args.splice(at..at, ["--tmpfs".to_string(), dir]);
        }
    }
    opts.cmd = "bwrap".to_string();
    opts.args = args;
    opts.env
        .insert("ELDRUN_AGENT_FENCE".to_string(), "1".to_string());
    // The caller keeps the sources until tab teardown, or drops them on a
    // failed spawn. No accumulation of plugin copies between closed tabs.
    Ok(content_shadow)
}

/// Everything the macOS profile needs to know, resolved by
/// [`sandbox_exec_inputs`] and rendered by [`sandbox_exec_profile`] — split so
/// the rendering is pure and its invariants are unit tested on any OS.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SeatbeltInputs {
    pub home: String,
    /// Read-write roots: the project / box member trees.
    pub roots: Vec<String>,
    /// Read-write directories and files outside the roots (agent state the
    /// resume machinery needs, the live-session record, temp dirs).
    pub writable: Vec<String>,
    /// Read-only paths inside `$HOME` that stay visible (everything else under
    /// home is hidden, like the empty home tmpfs on Linux).
    pub readable: Vec<String>,
    /// Paths that must never be written even though a broader allow covers
    /// them: the agents' hook-registration files and the hook scripts.
    pub protected: Vec<String>,
    /// Final read/write denials, after all broad toolchain/root grants.
    pub hidden: Vec<String>,
}

/// Quote a path for the Seatbelt profile language: a Scheme string literal.
#[cfg(any(target_os = "macos", test))]
fn sbpl_string(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 2);
    out.push('"');
    for c in path.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Render the Seatbelt profile. Pure.
///
/// What it mirrors from the bubblewrap fence, and what it cannot:
/// - **Writes** are denied everywhere except the roots, the agent's own state
///   dirs, temp, and the live-session record — the same set Linux bind-mounts
///   read-write. Rules are evaluated last-match-wins, so the per-file
///   `protected` denials come after the directory allows that would otherwise
///   cover them.
/// - **Reads** under `$HOME` are denied except the listed `readable` paths and
///   the roots, which is the empty-home posture Linux gets from a tmpfs. The
///   home directory's own metadata stays readable so path resolution works.
/// - **Not mirrored:** the writable *shadow copies* of the hook-registration
///   files. Seatbelt can allow or deny a path but cannot redirect one, so those
///   files are simply read-only here — an agent that tries to rewrite its own
///   `settings.json` gets `EPERM` and carries on, rather than writing into a
///   throwaway copy. The hook scripts they point at are read-only in both.
/// - **Devices** fall under the write denial like any other path, except the
///   handful every ordinary tool writes to: `/dev/null` and `/dev/zero`, the
///   controlling terminal `/dev/tty` (git and ssh prompt through it),
///   `/dev/dtracehelper`, and `/dev/fd/*` (process substitution). Other
///   terminals' `/dev/ttys*` stay denied on purpose — allowing them would let a
///   fenced agent write into *another* tab's terminal. The agent's own PTY is an
///   inherited descriptor and needs no path rule.
/// - Network and process spawning are left at the platform default, as
///   bubblewrap leaves them (it unshares only the pid namespace).
#[cfg(any(target_os = "macos", test))]
const SEATBELT_DEVICE_WRITES: &str = "(allow file-write* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/tty\") (literal \"/dev/dtracehelper\") (subpath \"/dev/fd\"))\n";

#[cfg(any(target_os = "macos", test))]
pub(crate) fn sandbox_exec_profile(inputs: &SeatbeltInputs) -> String {
    let mut p = String::from("(version 1)\n(allow default)\n");
    // Reads: hide $HOME, then restore what the agent needs to see.
    p.push_str(&format!(
        "(deny file-read* (subpath {}))\n(allow file-read-metadata (literal {}))\n",
        sbpl_string(&inputs.home),
        sbpl_string(&inputs.home)
    ));
    for path in inputs.readable.iter().chain(&inputs.roots).chain(&inputs.writable) {
        p.push_str(&format!("(allow file-read* (subpath {}))\n", sbpl_string(path)));
    }
    // Writes: nothing, then the roots and the agent's own state.
    p.push_str("(deny file-write*)\n");
    p.push_str(SEATBELT_DEVICE_WRITES);
    for path in inputs.roots.iter().chain(&inputs.writable) {
        p.push_str(&format!("(allow file-write* (subpath {}))\n", sbpl_string(path)));
    }
    // Last, so they win over the directory allows above.
    for path in &inputs.protected {
        p.push_str(&format!(
            "(deny file-write* (subpath {}))\n",
            sbpl_string(path)
        ));
    }
    for path in &inputs.hidden {
        p.push_str(&format!("(deny file-read* file-write* (subpath {}))\n", sbpl_string(path)));
    }
    p
}

/// Resolve the profile inputs for a scope from the same mount planners the
/// bubblewrap fence uses, so the two fences agree on what an agent may touch.
#[cfg(target_os = "macos")]
fn sandbox_exec_inputs(opts: &PtyOptions, roots: &[PathBuf], scope_id: &str) -> SeatbeltInputs {
    let home = paths::home_dir_string();
    let state_dir = storage::state_dir();
    let (mounts, _symlinks) = agent_state_mounts(scope_id, roots);
    let mut writable: Vec<String> = Vec::new();
    let mut readable: Vec<String> = Vec::new();
    let mut protected: Vec<String> = Vec::new();
    for mount in &mounts {
        // On Linux the staged copies are mounted at STAGE_MOUNT and symlinked
        // over the originals; here the originals themselves stay in place, so
        // the stage dir is irrelevant and the originals are protected below.
        if mount.dst == STAGE_MOUNT {
            continue;
        }
        if mount.read_only {
            readable.push(mount.dst.clone());
        } else {
            writable.push(mount.dst.clone());
        }
    }
    // The hook-registration files the Linux fence shadows: read-only here.
    for rel in [
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".codex/config.toml",
    ] {
        protected.push(format!("{home}/{rel}"));
    }
    protected.push(state_dir.join("hooks").to_string_lossy().into_owned());
    protected.push(crate::services::agent_bin::bin_dir().to_string_lossy().into_owned());
    protected.extend(codex_content_paths(&paths::home_dir()));
    // Claude's identity/onboarding file: readable and writable so a fenced tab
    // is not a fresh install (see `staged_claude_json_mounts` for why Linux
    // stages a filtered copy instead — Seatbelt cannot substitute a file).
    for name in [".claude.json", ".claude/.claude.json"] {
        let path = format!("{home}/{name}");
        if Path::new(&path).is_file() {
            writable.push(path);
        }
    }
    // Temp dirs: macOS gives each user a private one under /var/folders.
    for tmp in ["/private/tmp", "/tmp", "/private/var/folders", "/var/folders"] {
        writable.push(tmp.to_string());
    }
    if let Some(dir) = std::env::var_os("TMPDIR") {
        writable.push(dir.to_string_lossy().into_owned());
    }
    readable.extend(configured_read_only_paths());
    let search_dirs = command_search_dirs(opts);
    // The agent's own install, writable so it can update itself — the same
    // native-installer layout the Linux fence hands back read-write.
    writable.extend(updatable_install_dirs(
        &opts.cmd,
        &search_dirs,
        &paths::home_dir(),
    ));
    let visible = readable.clone();
    readable.extend(command_bind_paths(
        &opts.cmd,
        &search_dirs,
        &paths::home_dir(),
        &visible,
    ));
    SeatbeltInputs {
        home,
        roots: roots.iter().map(|r| r.to_string_lossy().into_owned()).collect(),
        writable,
        readable,
        protected,
        hidden: hidden_cargo_credentials(opts),
    }
}

/// Rewrite a local agent spawn into its `sandbox-exec` boundary (macOS). The
/// profile is written per scope under the sandbox stage dir and handed to
/// `sandbox-exec -f`; the command is resolved to an absolute path first so the
/// exec inside the sandbox never depends on PATH lookup.
#[cfg(target_os = "macos")]
pub fn wrap_pty_options_sandbox_exec(
    opts: &mut PtyOptions,
    roots: &[PathBuf],
    scope_id: &str,
) -> Result<(), String> {
    if !bwrap_available() {
        return Err(
            "Agent fence: sandbox-exec is unavailable on this Mac, so this agent was not started. Turn the Agent fence off for this project."
                .to_string(),
        );
    }
    let inputs = sandbox_exec_inputs(opts, roots, scope_id);
    let profile = sandbox_exec_profile(&inputs);
    let stage = crate::services::sandbox::stage_dir(scope_id);
    std::fs::create_dir_all(&stage).map_err(|e| format!("Agent fence: {e}"))?;
    let profile_path = stage.join("fence.sb");
    std::fs::write(&profile_path, profile).map_err(|e| format!("Agent fence: {e}"))?;
    let resolved = if opts.cmd.contains('/') {
        PathBuf::from(&opts.cmd)
    } else {
        paths::resolve_executable(&opts.cmd).unwrap_or_else(|| PathBuf::from(&opts.cmd))
    };
    let mut args = vec![
        "-f".to_string(),
        profile_path.to_string_lossy().into_owned(),
        resolved.to_string_lossy().into_owned(),
    ];
    args.extend(opts.args.iter().cloned());
    opts.cmd = "/usr/bin/sandbox-exec".to_string();
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
    if cfg!(windows) {
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
    let install_cmd = if available { None } else { fence_install_cmd() };
    let Some(roots) = roots else {
        return AgentFenceStatus {
            enforced: false,
            reason: "unknown project or box".to_string(),
            roots: root_strings,
            bwrap_available: available,
            install_cmd,
        };
    };
    let decision = decide(
        &opts,
        roots,
        remote_run,
        policy_for_scope(&projects, Some(scope_id)),
        platform_fenceable(),
        available,
    );
    let (enforced, reason) = match decision {
        FenceDecision::Fenced { .. } => (true, "enforced".to_string()),
        FenceDecision::NotApplicable { reason: "platform" } => {
            (false, platform_reason().to_string())
        }
        FenceDecision::NotApplicable { reason } => (false, reason.to_string()),
        FenceDecision::Unavailable => (false, format!("{} unavailable", fence_tool_name())),
    };
    AgentFenceStatus {
        enforced,
        reason,
        roots: root_strings,
        bwrap_available: available,
        install_cmd,
    }
}

/// Whether a Claude tab spawned with these options reads the staged, filtered
/// `.claude.json` copy instead of the host file — the question
/// `sandbox::claude_folder_trusted` needs answered, because Eldrun's recorded
/// trust reaches Claude only through that copy. Mirrors `pty_spawn`: the same
/// spawn-authority resolution, then containerized (always staged) or the Linux
/// fence (macOS Seatbelt cannot substitute a file, so a fenced tab there uses
/// the host file).
pub fn claude_config_staged(scope_id: Option<&str>, sandbox: bool, local_only: bool) -> bool {
    let mut opts = PtyOptions {
        id: "claude-trust-probe".to_string(),
        cmd: "claude".to_string(),
        args: Vec::new(),
        env: HashMap::new(),
        cwd: String::new(),
        cols: 80,
        rows: 24,
        local_only,
        sandbox,
        agent: true,
        project_id: scope_id.map(str::to_string),
        remote_host_id: None,
        tmux_session: None,
        tmux_attach: None,
        host_bound_uid: None,
    };
    crate::services::sandbox::enforce_spawn_authority(&mut opts);
    let remote_run = !opts.local_only
        && scope_id.is_some_and(|id| crate::services::remote::remote_target_for(id).is_some());
    if opts.sandbox && !opts.local_only {
        return true;
    }
    if !cfg!(target_os = "linux") {
        return false;
    }
    let Some(roots) = roots_for_scope(scope_id, opts.local_only) else {
        return false;
    };
    matches!(
        decide(
            &opts,
            roots,
            remote_run,
            policy_enabled(scope_id),
            platform_fenceable(),
            bwrap_available(),
        ),
        FenceDecision::Fenced { .. }
    )
}

struct FencedTab {
    scope_id: String,
    // Dropped after transcript harvest at teardown.
    _content_shadow: Option<tempfile::TempDir>,
}

fn fenced_tabs() -> &'static Mutex<HashMap<String, FencedTab>> {
    static TABS: OnceLock<Mutex<HashMap<String, FencedTab>>> = OnceLock::new();
    TABS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register_tab(tab_id: &str, scope_id: &str, content_shadow: Option<tempfile::TempDir>) {
    if let Some(old) = fenced_tabs()
        .lock()
        .unwrap()
        .insert(tab_id.to_string(), FencedTab {
            scope_id: scope_id.to_string(),
            _content_shadow: content_shadow,
        })
    {
        crate::services::sandbox::harvest_project_transcripts(&old.scope_id);
    }
}

pub fn on_tab_gone(tab_id: &str) {
    if let Some(tab) = fenced_tabs().lock().unwrap().remove(tab_id) {
        crate::services::sandbox::harvest_project_transcripts(&tab.scope_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::boxes::ProjectBox;
    use serde_json::{json, Value};

    #[test]
    fn an_unavailable_tool_is_retried_and_success_is_cached() {
        let cache = Mutex::new(false);
        assert!(!probe_until_available(&cache, || false));
        assert!(probe_until_available(&cache, || true));
        assert!(probe_until_available(&cache, || panic!("successful probe must be cached")));
    }

    #[test]
    fn cargo_tokens_are_masked_after_root_grants_and_opt_in_removes_masks() {
        let home = tempfile::tempdir().unwrap();
        let cargo = home.path().join(".cargo");
        std::fs::create_dir(&cargo).unwrap();
        for name in ["credentials", "credentials.toml"] {
            std::fs::write(cargo.join(name), "fixture registry token").unwrap();
        }
        let hidden = cargo_credential_paths(home.path(), Some(Path::new("custom-cargo")), home.path(), false);
        assert!(hidden.contains(&home.path().join("custom-cargo/credentials.toml").to_string_lossy().into_owned()));
        let mut args = bwrap_args("/home/u", "/p", "codex", &[], &[home.path().to_owned()], &[], &[], &[]);
        mask_cargo_credentials(&mut args, hidden.clone());
        let grant = args.iter().position(|a| a == "--bind-try").unwrap();
        for name in ["credentials", "credentials.toml"] {
            let path = cargo.join(name).to_string_lossy().into_owned();
            let mask = args.iter().position(|a| a == &path).unwrap();
            assert!(mask > grant);
            assert_eq!(&args[mask - 2..mask], &["--ro-bind", "/dev/null"]);
            assert_eq!(std::fs::read_to_string(cargo.join(name)).unwrap(), "fixture registry token");
        }
        assert!(cargo_credential_paths(home.path(), Some(&cargo), home.path(), true).is_empty());
        let profile = sandbox_exec_profile(&SeatbeltInputs {
            home: home.path().to_string_lossy().into_owned(),
            readable: vec![cargo.to_string_lossy().into_owned()],
            hidden,
            ..Default::default()
        });
        assert!(profile.rfind("(deny file-read* file-write*").unwrap() > profile.rfind("(allow file-read*").unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn cargo_masks_include_symlink_targets() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".cargo")).unwrap();
        let target = home.path().join("registry-secret");
        std::fs::write(&target, "fixture").unwrap();
        std::os::unix::fs::symlink(&target, home.path().join(".cargo/credentials.toml")).unwrap();
        let paths = cargo_credential_paths(home.path(), None, home.path(), false);
        assert!(paths.contains(&target.canonicalize().unwrap().to_string_lossy().into_owned()));
    }

    #[test]
    fn seatbelt_protects_codex_content_after_broad_home_grants() {
        let paths = codex_content_paths(Path::new("/Users/fixture"));
        let profile = sandbox_exec_profile(&SeatbeltInputs {
            home: "/Users/fixture".into(),
            writable: vec!["/Users/fixture/.codex".into()],
            protected: paths.clone(),
            ..Default::default()
        });
        let grant = profile.find("(allow file-write* (subpath \"/Users/fixture/.codex\"))").unwrap();
        for path in paths {
            let deny = format!("(deny file-write* (subpath {}))", sbpl_string(&path));
            assert!(profile.find(&deny).unwrap() > grant);
        }
    }

    #[cfg(unix)]
    #[test]
    fn codex_content_shadows_are_writable_without_changing_login_or_resume_mounts() {
        let home = tempfile::tempdir().unwrap();
        let stage = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex");
        for dir in ["skills/example", "plugins/example", "shell_snapshots", "sessions"] {
            std::fs::create_dir_all(codex.join(dir)).unwrap();
        }
        for file in ["skills/example/SKILL.md", "plugins/example/tool.sh", "shell_snapshots/host.sh", "auth.json", "sessions/resume.jsonl"] {
            std::fs::write(codex.join(file), "host fixture").unwrap();
        }
        let (shadow, mounts) = private_codex_content(home.path(), stage.path()).unwrap();
        for file in ["skills/example/SKILL.md", "plugins/example/tool.sh"] {
            std::fs::write(shadow.path().join(file), "tab change").unwrap();
            assert_eq!(std::fs::read_to_string(codex.join(file)).unwrap(), "host fixture");
        }
        assert!(!shadow.path().join("shell_snapshots/host.sh").exists());
        std::fs::write(shadow.path().join("shell_snapshots/tab.sh"), "tab snapshot").unwrap();
        assert!(!codex.join("shell_snapshots/tab.sh").exists());
        let (rw, _) = crate::services::sandbox::agent_home_mounts(
            &home.path().to_string_lossy(), "/live/own", "/live", true,
        );
        for name in ["auth.json", "sessions"] {
            let path = codex.join(name).to_string_lossy().into_owned();
            assert!(rw.contains(&format!("{path}:{path}")));
            assert!(!mounts.iter().any(|m| m.dst == path));
        }
        // Another new tab receives fresh host content, never a previous tab's edits.
        let (next, _) = private_codex_content(home.path(), stage.path()).unwrap();
        assert_eq!(std::fs::read_to_string(next.path().join("skills/example/SKILL.md")).unwrap(), "host fixture");
        let path = shadow.path().to_owned();
        drop(shadow);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn private_content_relocates_internal_links_and_materializes_external_links() {
        let source = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let script = source.path().join("tool.sh");
        std::fs::write(&script, "host script").unwrap();
        std::os::unix::fs::symlink(&script, source.path().join("linked.sh")).unwrap();
        std::os::unix::fs::symlink(source.path(), source.path().join("loop")).unwrap();
        let external = tempfile::tempdir().unwrap();
        std::fs::write(external.path().join("external.sh"), "external script").unwrap();
        std::os::unix::fs::symlink(external.path().join("external.sh"), source.path().join("external.sh")).unwrap();
        std::os::unix::fs::symlink("missing-optional", source.path().join("dangling")).unwrap();
        copy_private_content(source.path(), &dest.path().join("copy")).unwrap();
        let copy = dest.path().join("copy/linked.sh");
        assert!(copy.canonicalize().unwrap().starts_with(dest.path()));
        assert!(dest.path().join("copy/loop").canonicalize().unwrap().starts_with(dest.path()));
        std::fs::write(copy, "private edit").unwrap();
        assert_eq!(std::fs::read_to_string(script).unwrap(), "host script");
        let external_copy = dest.path().join("copy/external.sh");
        assert!(!external_copy.symlink_metadata().unwrap().file_type().is_symlink());
        std::fs::write(external_copy, "private external edit").unwrap();
        assert_eq!(std::fs::read_to_string(external.path().join("external.sh")).unwrap(), "external script");
        let alias = dest.path().join("source-link");
        std::os::unix::fs::symlink(source.path(), &alias).unwrap();
        copy_private_content(&alias, &dest.path().join("linked-root-copy")).unwrap();
        assert!(dest.path().join("linked-root-copy/tool.sh").is_file());
    }

    #[test]
    fn a_state_dir_outside_home_has_its_mail_store_hidden() {
        let home = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        std::fs::create_dir(elsewhere.path().join("mail")).unwrap();
        assert_eq!(
            private_state_outside_home(home.path(), elsewhere.path()),
            vec![elsewhere.path().join("mail").to_string_lossy().into_owned()]
        );
        // Under home the home tmpfs already covers it.
        let inside = home.path().join(".local/share/eldrun");
        std::fs::create_dir_all(inside.join("mail")).unwrap();
        assert!(private_state_outside_home(home.path(), &inside).is_empty());
    }

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
    fn seatbelt_profile_denies_writes_then_restores_roots_and_protects_hooks() {
        let inputs = SeatbeltInputs {
            home: "/Users/a".into(),
            roots: vec!["/Users/a/eldrun/projects/p".into()],
            writable: vec!["/Users/a/.claude".into(), "/private/tmp".into()],
            readable: vec!["/Users/a/.gitconfig".into()],
            protected: vec![
                "/Users/a/.claude/settings.json".into(),
                "/Users/a/.local/share/eldrun/hooks".into(),
            ],
            hidden: Vec::new(),
        };
        let profile = sandbox_exec_profile(&inputs);
        let lines: Vec<&str> = profile.lines().collect();
        assert_eq!(lines[0], "(version 1)");
        assert_eq!(lines[1], "(allow default)");
        let pos = |needle: &str| {
            lines
                .iter()
                .position(|l| l.contains(needle))
                .unwrap_or_else(|| panic!("missing: {needle}"))
        };
        // Home is hidden before anything under it is restored.
        assert!(pos("(deny file-read* (subpath \"/Users/a\"))") < pos("(allow file-read* (subpath \"/Users/a/.gitconfig\"))"));
        assert!(profile.contains("(allow file-read-metadata (literal \"/Users/a\"))"));
        // Writes are denied globally, then the root and the agent state come back.
        assert!(pos("(deny file-write*)") < pos("(allow file-write* (subpath \"/Users/a/eldrun/projects/p\"))"));
        assert!(pos("(deny file-write*)") < pos("(allow file-write* (subpath \"/Users/a/.claude\"))"));
        // The device allowlist comes right after the global deny, before any
        // protected deny, and never opens other terminals' ttys.
        let devices = pos("(literal \"/dev/null\")");
        assert_eq!(devices, pos("(deny file-write*)") + 1);
        for dev in ["/dev/zero", "/dev/tty\"", "/dev/dtracehelper"] {
            assert!(lines[devices].contains(dev), "missing {dev}");
        }
        assert!(lines[devices].contains("(subpath \"/dev/fd\")"));
        assert!(devices < pos("(deny file-write* (subpath \"/Users/a/.claude/settings.json\"))"));
        assert!(!profile.contains("ttys"), "no /dev/ttys* rule");
        // The protected paths are denied LAST so they win over the .claude allow.
        let hook_deny = pos("(deny file-write* (subpath \"/Users/a/.claude/settings.json\"))");
        assert!(hook_deny > pos("(allow file-write* (subpath \"/Users/a/.claude\"))"));
        assert_eq!(lines.last().unwrap(), &"(deny file-write* (subpath \"/Users/a/.local/share/eldrun/hooks\"))");
        // Quoting: a path with a quote or backslash stays one Scheme string.
        assert_eq!(sbpl_string("/a/b\"c\\d"), "\"/a/b\\\"c\\\\d\"");
    }

    #[test]
    fn fence_install_command_follows_the_distribution() {
        let cmd = |release: &str| package_install_cmd(release, InstallPkg::Bubblewrap);
        assert_eq!(
            cmd("NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n").as_deref(),
            Some("sudo apt install -y bubblewrap")
        );
        assert_eq!(cmd("ID=debian\n").as_deref(), Some("sudo apt install -y bubblewrap"));
        assert_eq!(cmd("ID=fedora\n").as_deref(), Some("sudo dnf install -y bubblewrap"));
        assert_eq!(cmd("ID=arch\n").as_deref(), Some("sudo pacman -S --needed bubblewrap"));
        assert_eq!(
            cmd("ID=\"opensuse-tumbleweed\"\nID_LIKE=\"opensuse suse\"\n").as_deref(),
            Some("sudo zypper install -y bubblewrap")
        );
        // An unrecognized ID falls through to ID_LIKE, in its order.
        assert_eq!(
            cmd("ID=\"someforge\"\nID_LIKE=\"rhel fedora\"\n").as_deref(),
            Some("sudo dnf install -y bubblewrap")
        );
        // ID wins over ID_LIKE.
        assert_eq!(
            cmd("ID=ubuntu\nID_LIKE=\"arch\"\n").as_deref(),
            Some("sudo apt install -y bubblewrap")
        );
        // Unknown distributions and an empty file offer nothing to run.
        assert_eq!(cmd("ID=nixos\n"), None);
        assert_eq!(cmd("ID=gentoo\n"), None);
        assert_eq!(cmd(""), None);
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
            FenceDecision::Unavailable
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
            src: "/stage/p".into(),
            dst: STAGE_MOUNT.into(),
            read_only: false,
        }];
        let symlinks = vec![FenceSymlink {
            target: format!("{STAGE_MOUNT}/home_u_.codex_config.toml"),
            link: "/home/u/.codex/config.toml".into(),
        }];
        let out = bwrap_args(
            "/home/u",
            "/home/u/work/p",
            "codex",
            &["resume".into(), "abc".into()],
            &roots,
            &["/home/u/.cargo".into()],
            &mounts,
            &symlinks,
        );
        let home_tmpfs = out
            .windows(2)
            .position(|p| p == ["--tmpfs", "/home/u"])
            .unwrap();
        let cargo = out.iter().position(|p| p == "/home/u/.cargo").unwrap();
        let stage = out.iter().position(|p| p == STAGE_MOUNT).unwrap();
        let config = out
            .iter()
            .position(|p| p == "/home/u/.codex/config.toml")
            .unwrap();
        let root = out.iter().rposition(|p| p == "/home/u/work/p").unwrap();
        // The staging dir must be mounted before the links into it are made.
        assert!(home_tmpfs < cargo && cargo < stage && stage < config && config < root);
        // And the config path is a symlink, never a mount destination: a
        // rename onto a mount point is EBUSY (see `STAGE_MOUNT`).
        assert_eq!(out[config - 2], "--symlink");
        assert!(!out.iter().any(|p| p == "--new-session"));
        let separator = out.iter().position(|p| p == "--").unwrap();
        assert_eq!(&out[separator + 1..], &["codex", "resume", "abc"]);
        assert_eq!(out[separator - 2], "--chdir");
        assert_eq!(out[separator - 1], "/home/u/work/p");
    }

    #[test]
    fn staged_shadow_becomes_a_link_into_the_stage_mount() {
        let link = staged_symlink(
            "/state/sandbox-stage/p1/home_u_.codex_config.toml",
            "/home/u/.codex/config.toml",
        )
        .unwrap();
        assert_eq!(
            link,
            FenceSymlink {
                target: format!("{STAGE_MOUNT}/home_u_.codex_config.toml"),
                link: "/home/u/.codex/config.toml".into(),
            }
        );
        assert!(staged_symlink("/", "/home/u/.codex/config.toml").is_none());
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

    #[cfg(unix)]
    #[test]
    fn native_installer_layout_is_writable_other_installs_are_not() {
        let tmp = std::env::temp_dir().join(format!(
            "eldrun-fence-upd-{}-{}",
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
        std::fs::write(versions.join("2.1.270"), "#!/bin/sh\n").unwrap();
        std::os::unix::fs::symlink(versions.join("2.1.270"), bin.join("claude")).unwrap();
        // An nvm-style install: a link in the Node prefix's bin/ into its
        // node_modules — nothing under ~/.local/share, so nothing opens up.
        let node_bin = home.join(".nvm/versions/node/v22/bin");
        let pkg = home.join(".nvm/versions/node/v22/lib/node_modules/@openai/codex/bin");
        std::fs::create_dir_all(&node_bin).unwrap();
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("codex.js"), "").unwrap();
        std::os::unix::fs::symlink(pkg.join("codex.js"), node_bin.join("codex")).unwrap();
        // A launcher link in ~/.local/bin that points OUTSIDE ~/.local/share
        // does not earn the launcher dir either.
        std::os::unix::fs::symlink(pkg.join("codex.js"), bin.join("codex-link")).unwrap();
        let dirs = vec![bin.clone(), node_bin];

        let bin_s = bin.to_string_lossy().into_owned();
        let root_s = home
            .join(".local/share/claude")
            .to_string_lossy()
            .into_owned();
        // The launcher dir first, then the install root — not `versions/`.
        assert_eq!(
            updatable_install_dirs("claude", &dirs, &home),
            vec![bin_s, root_s]
        );
        assert!(updatable_install_dirs("codex", &dirs, &home).is_empty());
        assert!(updatable_install_dirs("codex-link", &dirs, &home).is_empty());
        assert!(updatable_install_dirs("no-such-agent", &dirs, &home).is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn later_rw_mount_shadows_the_allowlist_read_only_bin() {
        let bin = "/home/u/.local/bin".to_string();
        let mounts = vec![BindMount {
            src: bin.clone(),
            dst: bin.clone(),
            read_only: false,
        }];
        let out = bwrap_args(
            "/home/u",
            "/p",
            "claude",
            &[],
            &[],
            std::slice::from_ref(&bin),
            &mounts,
            &[],
        );
        let ro = out
            .iter()
            .position(|a| a == "--ro-bind-try")
            .expect("allowlist bind");
        let rw = out
            .iter()
            .enumerate()
            .position(|(i, a)| a == "--bind" && out.get(i + 1) == Some(&bin))
            .expect("read-write bind");
        // bubblewrap applies mounts in order; the later read-write bind of the
        // same path is the one the agent sees.
        assert!(rw > ro, "{out:?}");
    }

    #[test]
    fn the_local_model_home_is_mounted_read_write_when_one_exists() {
        let state = tempfile::tempdir().unwrap();
        // Nothing prepared yet: no mount, and no directory created either.
        assert!(local_model_mounts(state.path()).is_empty());
        assert!(!state.path().join("vibe_local").exists());

        std::fs::create_dir_all(state.path().join("vibe_local/gemma4-e4b")).unwrap();
        let mounts = local_model_mounts(state.path());
        let dir = state
            .path()
            .join("vibe_local")
            .to_string_lossy()
            .into_owned();
        // Identical src/dst — `VIBE_HOME` names this absolute path — and
        // writable, since vibe keeps its session logs and cache beside the
        // config Eldrun writes.
        assert_eq!(
            mounts,
            vec![BindMount {
                src: dir.clone(),
                dst: dir,
                read_only: false,
            }]
        );
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
