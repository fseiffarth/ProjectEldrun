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

pub const INSTALL_HINT: &str = "sudo apt install bubblewrap";

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
    Unavailable { install_hint: &'static str },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BindMount {
    pub src: String,
    pub dst: String,
    pub read_only: bool,
}

/// A symlink created inside the fence, pointing at a staged shadow copy.
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
pub(crate) const STAGE_MOUNT: &str = "/run/eldrun-agent-config";

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

/// Probe the actual unprivileged sandbox operation once, rather than merely
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
        static AVAILABLE: OnceLock<bool> = OnceLock::new();
        *AVAILABLE.get_or_init(|| {
            crate::paths::command_no_window("/usr/bin/sandbox-exec")
                .args(["-p", "(version 1)(allow default)", "/usr/bin/true"])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
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

/// Turn a `(staged copy, real path)` pair into the symlink that puts the copy
/// at the real path — see [`STAGE_MOUNT`] for why it is a link, not a mount.
fn staged_symlink(src: &str, dst: &str) -> Option<FenceSymlink> {
    let leaf = Path::new(src).file_name()?.to_string_lossy().into_owned();
    Some(FenceSymlink {
        target: format!("{STAGE_MOUNT}/{leaf}"),
        link: dst.to_string(),
    })
}

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
    );
    let mut mounts: Vec<BindMount> = home_rw
        .into_iter()
        .filter_map(|m| mount_pair(&m, false))
        .collect();
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
    (mounts, symlinks)
}

/// Pure bubblewrap argv builder.  Later mounts intentionally shadow earlier
/// ones: the empty home hides secrets, selected state/config is restored, and
/// project/box roots finally become read-write.  `symlinks` come last of the
/// filesystem setup, after the mount that holds what they point at.
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
    let (mounts, symlinks) = agent_state_mounts(scope_id, roots);
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
        &symlinks,
    );
    opts.cmd = "bwrap".to_string();
    opts.args = args;
    opts.env
        .insert("ELDRUN_AGENT_FENCE".to_string(), "1".to_string());
    Ok(())
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
/// - Network, process spawning and the device tree are left at the platform
///   default, as bubblewrap leaves them (it unshares only the pid namespace).
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
    let visible = readable.clone();
    readable.extend(command_bind_paths(
        &opts.cmd,
        &command_search_dirs(opts),
        &paths::home_dir(),
        &visible,
    ));
    SeatbeltInputs {
        home,
        roots: roots.iter().map(|r| r.to_string_lossy().into_owned()).collect(),
        writable,
        readable,
        protected,
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
        platform_fenceable(),
        available,
    );
    let (enforced, reason) = match decision {
        FenceDecision::Fenced { .. } => (true, "enforced".to_string()),
        FenceDecision::NotApplicable { reason: "platform" } => {
            (false, platform_reason().to_string())
        }
        FenceDecision::NotApplicable { reason } => (false, reason.to_string()),
        FenceDecision::Unavailable { .. } => (false, format!("{} unavailable", fence_tool_name())),
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
        // The protected paths are denied LAST so they win over the .claude allow.
        let hook_deny = pos("(deny file-write* (subpath \"/Users/a/.claude/settings.json\"))");
        assert!(hook_deny > pos("(allow file-write* (subpath \"/Users/a/.claude\"))"));
        assert_eq!(lines.last().unwrap(), &"(deny file-write* (subpath \"/Users/a/.local/share/eldrun/hooks\"))");
        // Quoting: a path with a quote or backslash stays one Scheme string.
        assert_eq!(sbpl_string("/a/b\"c\\d"), "\"/a/b\\\"c\\\\d\"");
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
