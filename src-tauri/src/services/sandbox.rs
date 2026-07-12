//! Docker sandbox for agent tabs.
//!
//! When a project's sandbox toggle is on, each agent tab (Claude/Codex/Gemini/
//! Vibe) is launched inside an ephemeral `docker run --rm` container that mounts
//! **only the project directory** plus the minimal agent auth/state paths, so the
//! agent physically cannot reach unrelated host files. Plain shell/files tabs are
//! never sandboxed (the frontend only sets `PtyOptions.sandbox` for `kind:"agent"`
//! tabs of a sandbox-enabled, non-remote project).
//!
//! Lifecycle: one ephemeral container per agent tab; `--rm` reaps it when the
//! tab's PTY exits. No shared/long-lived container state to manage.
//!
//! ## What the container can reach (blast radius)
//!
//! Only these host paths are bind-mounted, each at its identical absolute path:
//! - the **project directory** (rw) — the sole project bytes exposed;
//! - `~/.claude`, `~/.codex` (rw, when present) — agent auth + session transcripts;
//! - `<state_dir>/live_sessions` (rw) — where the in-container SessionStart hook
//!   records this tab's live session id for resume;
//! - Gemini creds (`~/.gemini`, `~/.config/gemini`, rw, when present) — narrowed
//!   from the whole `~/.config` so `gh`/`gcloud`/etc. secrets are *not* exposed;
//! - `<state_dir>/hooks` mounted **read-only** (see the RCE note below);
//! - the agents' hook-registration files (`~/.claude/settings.json[.local]`,
//!   `~/.codex/config.toml`) as **per-tab writable copies** shadowing the host
//!   originals (see the RCE note below).
//!
//! Nothing else under `$HOME` or `state_dir` (notably `projects.json`, other
//! projects' conversation history, `time_log.json`) is mounted.
//!
//! ## Session-resume & auth mount contract (correctness-critical)
//!
//! Agent resume (`agent_session::resolve_{claude,codex}_session`) and the
//! SessionStart hook assume the agent process sees the **host's** `~/.claude`,
//! `~/.codex`, and `<state_dir>/live_sessions` **at identical absolute paths**,
//! as a user whose `$HOME` matches the host. If any of these is wrong, resume
//! silently degrades to a fresh session and auth silently fails. The container
//! therefore:
//! - runs `--user <host-uid>:<host-gid>` so files written under `~/.claude` stay
//!   host-owned and `*_session_exists` can read them back next launch;
//! - sets `-e HOME=<host home>` (absolute) since resolvers/hook compute from it;
//! - forwards `ELDRUN_TAB_UID`/`TERM`/`COLORTERM` and every `opts.env` entry, and
//!   re-exports agent-auth vars (`ssh_exec::AGENT_AUTH_ENV`) read off the host
//!   process env (the container inherits nothing).
//!
//! ## Hook mounts (host-RCE defence)
//!
//! The SessionStart hook *script* lives at `<state_dir>/hooks/…` and its absolute
//! path is baked into `~/.claude/settings.json` / `~/.codex/config.toml`. Two
//! distinct escape paths, each closed differently:
//! - **The script** is shared with host-run agents, so it is mounted
//!   **read-only**: a writable copy would let a compromised agent rewrite it and
//!   have arbitrary code run on the host next time an agent starts there.
//! - **The registration files** point *at* that script. They are mounted as
//!   **per-tab writable copies** (staged under `<state_dir>/sandbox-stage/<tab>`)
//!   rather than the host originals: the container gets a real, writable file it
//!   can freely rewrite (so agents that persist config don't error), but its
//!   writes land in the throwaway copy — the host's real settings can never be
//!   repointed at an attacker command. The copy still carries the hook
//!   registration, so resume recording keeps working.
//!
//! The hook's *write* target (`live_sessions`) stays rw, which is all it needs.
//!
//! ## Hardening
//!
//! Every container runs with `--security-opt no-new-privileges`, `--cap-drop ALL`,
//! and a `--pids-limit` (fork-bomb guard). Optional per-project knobs
//! (`SandboxSpec`): `--memory`, `--cpus`, `--network` (e.g. `none` for no egress),
//! and `--read-only` rootfs (+ `--tmpfs /tmp`). Docker's own socket is never
//! mounted.
//!
//! All paths are built from Rust path helpers as absolute strings — never relying
//! on `$HOME` shell-expansion, because `docker` is exec'd directly (no shell).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::paths;
use crate::schema::project::SandboxSpec;
use crate::storage;
use crate::terminal::PtyOptions;

/// Default image used when a project does not override it. Building/providing
/// this image is the user's responsibility; see `docker/agent-sandbox/`.
pub const DEFAULT_IMAGE: &str = "eldrun-agent-sandbox:latest";

/// Default `--pids-limit` when a project does not override it. Generous enough
/// for node + git + ripgrep + child processes, tight enough to blunt a fork bomb.
pub const DEFAULT_PIDS_LIMIT: u32 = 1024;

/// Runtime hardening flags for a sandbox container. Built from a project's
/// `SandboxSpec`; owns its strings so it has no lifetime ties to the spec.
#[derive(Debug, Clone)]
pub struct HardenOpts {
    pub pids_limit: u32,
    pub memory: Option<String>,
    pub cpus: Option<String>,
    pub network: Option<String>,
    pub readonly_rootfs: bool,
}

impl Default for HardenOpts {
    fn default() -> Self {
        HardenOpts {
            pids_limit: DEFAULT_PIDS_LIMIT,
            memory: None,
            cpus: None,
            network: None,
            readonly_rootfs: false,
        }
    }
}

/// Build the full `docker run …` argv that wraps `cmd cmd_args`. Pure: all
/// host-derived inputs are passed in, so this is unit-testable without touching
/// the environment, the filesystem, or docker. The resulting argv runs `cmd`
/// inside the container with only the mounts listed here. `rw_mounts`/`ro_mounts`
/// are `src:dst` pairs (the project dir is always mounted rw regardless); each
/// `ro_mounts` entry gets a `:ro` suffix appended.
#[allow(clippy::too_many_arguments)]
pub fn docker_run_args(
    image: &str,
    home: &str,
    uid: u32,
    gid: u32,
    cwd: &str,
    env: &BTreeMap<String, String>,
    auth_env: &BTreeMap<String, String>,
    rw_mounts: &[String],
    ro_mounts: &[String],
    harden: &HardenOpts,
    cmd: &str,
    cmd_args: &[String],
) -> Vec<String> {
    let mut a = vec![
        "run".to_string(),
        "--rm".to_string(),
        "-i".to_string(),
        "-t".to_string(),
        "--user".to_string(),
        format!("{uid}:{gid}"),
        // Hardening: no privilege escalation, no Linux capabilities, bounded
        // process count. Docker's socket is deliberately never mounted.
        "--security-opt".to_string(),
        "no-new-privileges".to_string(),
        "--cap-drop".to_string(),
        "ALL".to_string(),
        "--pids-limit".to_string(),
        harden.pids_limit.to_string(),
        "-e".to_string(),
        format!("HOME={home}"),
        "-w".to_string(),
        cwd.to_string(),
    ];
    if let Some(mem) = &harden.memory {
        a.push("--memory".to_string());
        a.push(mem.clone());
    }
    if let Some(cpus) = &harden.cpus {
        a.push("--cpus".to_string());
        a.push(cpus.clone());
    }
    if let Some(net) = &harden.network {
        a.push("--network".to_string());
        a.push(net.clone());
    }
    if harden.readonly_rootfs {
        a.push("--read-only".to_string());
        // Writable scratch so tools that need /tmp (e.g. the image's npm cache at
        // /tmp/.npm) still work under a read-only rootfs.
        a.push("--tmpfs".to_string());
        a.push("/tmp".to_string());
    }
    // The project dir (the only project bytes exposed), always mounted rw at its
    // identical path.
    a.push("-v".to_string());
    a.push(format!("{cwd}:{cwd}"));
    for m in rw_mounts {
        a.push("-v".to_string());
        a.push(m.clone());
    }
    // Read-only mounts (hook script dir + hook-registration files). A nested
    // `:ro` file mount over an rw parent dir works regardless of argv order:
    // docker applies bind mounts parent-first by destination depth.
    for m in ro_mounts {
        a.push("-v".to_string());
        a.push(format!("{m}:ro"));
    }
    a.push("-e".to_string());
    a.push("TERM=xterm-256color".to_string());
    a.push("-e".to_string());
    a.push("COLORTERM=truecolor".to_string());
    for (k, v) in env {
        a.push("-e".to_string());
        a.push(format!("{k}={v}"));
    }
    for (k, v) in auth_env {
        a.push("-e".to_string());
        a.push(format!("{k}={v}"));
    }
    a.push(image.to_string());
    a.push(cmd.to_string());
    a.extend(cmd_args.iter().cloned());
    a
}

/// Rewrite `opts` to run its command inside a Docker sandbox. No-op when
/// `opts.sandbox` is false. Errors (so `pty_spawn` surfaces the message in the
/// terminal) when docker or the image is unavailable, rather than silently
/// running the agent on the host.
pub fn wrap_pty_options_docker(opts: &mut PtyOptions) -> Result<(), String> {
    if !opts.sandbox {
        return Ok(());
    }
    // Defence-in-depth: sandbox is local-only. Never docker-wrap a remote
    // project (resolved explicitly from the tab's owning project id).
    if opts
        .project_id
        .as_deref()
        .is_some_and(|id| crate::services::remote::remote_target_for(id).is_some())
    {
        return Ok(());
    }

    let spec = opts.project_id.as_deref().and_then(sandbox_spec_for);
    let image = spec
        .as_ref()
        .and_then(|s| s.image.clone())
        .unwrap_or_else(|| DEFAULT_IMAGE.to_string());
    preflight(&image)?;

    let home = paths::home_dir_string();
    let state_dir = storage::state_dir();
    let live_sessions = state_dir.join("live_sessions");
    let hooks_dir = state_dir.join("hooks");
    let (uid, gid) = host_uid_gid();

    // Ensure the hook's write target and the per-tab config staging dir exist so
    // their bind mounts map real host paths rather than docker-auto-created
    // (root-owned) ones. Best effort.
    let _ = std::fs::create_dir_all(&live_sessions);
    let stage = stage_dir(&opts.id);
    let _ = std::fs::create_dir_all(&stage);

    // opts.env is already resolved (ELDRUN_TAB_UID, resume args' env, etc.).
    let env: BTreeMap<String, String> = opts.env.clone().into_iter().collect();
    let auth_env = host_auth_env();
    let mut rw_mounts = rw_mounts(&home, &live_sessions.to_string_lossy());
    // Writable per-tab copies of the hook-registration files shadow the host
    // originals: the container can rewrite them harmlessly; the host stays safe.
    rw_mounts.extend(staged_config_mounts(&home, &stage));
    let ro_mounts = ro_mounts(&hooks_dir);
    let harden = harden_opts(spec.as_ref());

    let args = docker_run_args(
        &image,
        &home,
        uid,
        gid,
        &opts.cwd,
        &env,
        &auth_env,
        &rw_mounts,
        &ro_mounts,
        &harden,
        &opts.cmd,
        &opts.args,
    );

    opts.cmd = "docker".to_string();
    opts.args = args;
    // Env now rides inside the docker argv as `-e` flags; the docker client
    // itself needs nothing from opts.env.
    opts.env.clear();
    Ok(())
}

/// Read the sandbox spec for `project_id` from the always-local `projects.json`
/// entry's flattened `extra["sandbox"]`. `None` when unknown/unparseable — the
/// caller then falls back to defaults. Mirrors `remote::remote_target_for`.
fn sandbox_spec_for(project_id: &str) -> Option<SandboxSpec> {
    let list_path = storage::state_dir().join("projects.json");
    let list: crate::schema::projects::ProjectsList = storage::read_json(&list_path).ok()?;
    let entry = list.iter().find(|e| e.id == project_id)?;
    let value = entry.extra.get("sandbox")?;
    serde_json::from_value(value.clone()).ok()
}

/// Read-write identical-path mounts: the agent auth/state dirs the resume
/// machinery depends on. `~/.claude`/`~/.codex` and Gemini creds are mounted only
/// when they exist so we never auto-create empty root-owned dirs in `$HOME`.
fn rw_mounts(home: &str, live_sessions: &str) -> Vec<String> {
    let mut m = Vec::new();
    for cand in [format!("{home}/.claude"), format!("{home}/.codex")] {
        if Path::new(&cand).is_dir() {
            m.push(format!("{cand}:{cand}"));
        }
    }
    // The in-container SessionStart hook writes this tab's live id here.
    m.push(format!("{live_sessions}:{live_sessions}"));
    // Gemini credentials only — narrowed from the whole `~/.config` so unrelated
    // secrets (`gh`, `gcloud`, …) are never exposed to the sandbox.
    for cand in [format!("{home}/.gemini"), format!("{home}/.config/gemini")] {
        if Path::new(&cand).is_dir() {
            m.push(format!("{cand}:{cand}"));
        }
    }
    m
}

/// Read-only identical-path mounts: just the hook *script* dir, which is shared
/// with host-run agents and so must be immutable from inside the sandbox (see the
/// module doc). Mounted only when it exists on the host.
fn ro_mounts(hooks_dir: &Path) -> Vec<String> {
    let mut m = Vec::new();
    if hooks_dir.is_dir() {
        let h = hooks_dir.to_string_lossy();
        m.push(format!("{h}:{h}"));
    }
    m
}

/// Per-tab staging dir for the writable hook-config copies:
/// `<state_dir>/sandbox-stage/<sanitized tab id>`.
fn stage_dir(tab_id: &str) -> PathBuf {
    let safe: String = tab_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let key = if safe.is_empty() {
        "tab".to_string()
    } else {
        safe
    };
    storage::state_dir().join("sandbox-stage").join(key)
}

/// Copy the agents' hook-registration files into the per-tab `stage` dir and
/// return rw mounts of the *copies* at the files' identical container paths. The
/// container thus gets writable settings it can freely rewrite (so agents that
/// persist config don't error) while the host originals are shadowed and never
/// touched — a compromised agent cannot repoint the host's SessionStart hook.
/// Best effort: a file that is absent or fails to copy is simply not mounted.
fn staged_config_mounts(home: &str, stage: &Path) -> Vec<String> {
    let mut mounts = Vec::new();
    for src in [
        format!("{home}/.claude/settings.json"),
        format!("{home}/.claude/settings.local.json"),
        format!("{home}/.codex/config.toml"),
    ] {
        let src_path = Path::new(&src);
        if !src_path.is_file() {
            continue;
        }
        // Flatten the host path to a unique leaf so the three files never collide.
        let leaf = src.trim_start_matches('/').replace(['/', '\\'], "_");
        let dst = stage.join(&leaf);
        if std::fs::copy(src_path, &dst).is_ok() {
            // `<copy on host>:<original path in container>` (rw, no `:ro`).
            mounts.push(format!("{}:{src}", dst.to_string_lossy()));
        }
    }
    mounts
}

/// Build the runtime hardening flags from a project's spec, applying built-in
/// defaults (always-on `--pids-limit`; other caps opt-in).
fn harden_opts(spec: Option<&SandboxSpec>) -> HardenOpts {
    HardenOpts {
        pids_limit: spec.and_then(|s| s.pids_limit).unwrap_or(DEFAULT_PIDS_LIMIT),
        memory: spec.and_then(|s| s.memory.clone()),
        cpus: spec.and_then(|s| s.cpus.clone()),
        network: spec.and_then(|s| s.network.clone()),
        readonly_rootfs: spec.map(|s| s.readonly_rootfs).unwrap_or(false),
    }
}

/// Verify docker is installed and the image is present locally.
fn preflight(image: &str) -> Result<(), String> {
    let version = crate::paths::command_no_window("docker")
        .arg("--version")
        .output();
    match version {
        Ok(o) if o.status.success() => {}
        _ => {
            return Err(
                "Docker sandbox: 'docker' not found or not runnable. Install Docker, or disable \
                 the sandbox toggle for this project."
                    .to_string(),
            )
        }
    }
    let inspect = crate::paths::command_no_window("docker")
        .args(["image", "inspect", image])
        .output();
    match inspect {
        Ok(o) if o.status.success() => Ok(()),
        _ => Err(format!(
            "Docker sandbox: image '{image}' not found. Build it with \
             `docker build -t {image} docker/agent-sandbox`, or disable the sandbox toggle."
        )),
    }
}

/// Agent-auth env vars present on the host process, forwarded into the
/// container (which inherits no environment). Sorted for determinism.
fn host_auth_env() -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for &k in crate::services::ssh_exec::AGENT_AUTH_ENV {
        if let Ok(v) = std::env::var(k) {
            if !v.is_empty() {
                out.insert(k.to_string(), v);
            }
        }
    }
    out
}

#[cfg(unix)]
fn host_uid_gid() -> (u32, u32) {
    // Safe: geteuid/getegid have no preconditions and cannot fail.
    unsafe { (libc::geteuid(), libc::getegid()) }
}

#[cfg(not(unix))]
fn host_uid_gid() -> (u32, u32) {
    (0, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn args(strs: &[&str]) -> Vec<String> {
        strs.iter().map(|s| s.to_string()).collect()
    }

    /// Index of `needle` in `v`, or None.
    fn pos(v: &[String], needle: &str) -> Option<usize> {
        v.iter().position(|s| s == needle)
    }

    /// True if `v` contains the consecutive pair `flag value`.
    fn has_flag_value(v: &[String], flag: &str, value: &str) -> bool {
        v.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    /// Standard rw/ro mount sets used by the argv tests. `rw` includes a staged
    /// (writable copy) settings.json mount whose dst is the container path.
    fn rw(home: &str) -> Vec<String> {
        vec![
            format!("{home}/.claude:{home}/.claude"),
            format!("{home}/.codex:{home}/.codex"),
            "/state/live_sessions:/state/live_sessions".to_string(),
            format!("/state/sandbox-stage/tab/_home_alice_.claude_settings.json:{home}/.claude/settings.json"),
        ]
    }
    fn ro(_home: &str) -> Vec<String> {
        // Only the hook script dir is read-only now; registration files are
        // writable per-tab copies (see `staged_config_mounts`).
        vec!["/state/hooks:/state/hooks".to_string()]
    }

    #[test]
    fn claude_tab_argv_has_mounts_user_home_hardening_and_preserves_args() {
        let envs = env(&[("ELDRUN_TAB_UID", "tab-1")]);
        let out = docker_run_args(
            "img:latest",
            "/home/alice",
            1000,
            1000,
            "/home/alice/eldrun/projects/p1",
            &envs,
            &BTreeMap::new(),
            &rw("/home/alice"),
            &ro("/home/alice"),
            &HardenOpts::default(),
            "claude",
            &args(&["--resume", "uuid-1"]),
        );

        assert_eq!(out[0], "run");
        assert!(out.contains(&"--rm".to_string()));
        assert!(has_flag_value(&out, "--user", "1000:1000"));
        assert!(has_flag_value(&out, "-e", "HOME=/home/alice"));
        assert!(has_flag_value(&out, "-w", "/home/alice/eldrun/projects/p1"));
        // Hardening always on.
        assert!(has_flag_value(&out, "--security-opt", "no-new-privileges"));
        assert!(has_flag_value(&out, "--cap-drop", "ALL"));
        assert!(has_flag_value(
            &out,
            "--pids-limit",
            &DEFAULT_PIDS_LIMIT.to_string()
        ));
        // Project dir always mounted rw at its identical path.
        assert!(has_flag_value(
            &out,
            "-v",
            "/home/alice/eldrun/projects/p1:/home/alice/eldrun/projects/p1"
        ));
        // rw auth mounts.
        assert!(has_flag_value(
            &out,
            "-v",
            "/home/alice/.claude:/home/alice/.claude"
        ));
        assert!(has_flag_value(
            &out,
            "-v",
            "/state/live_sessions:/state/live_sessions"
        ));
        // The hook script dir is read-only (:ro suffix)...
        assert!(has_flag_value(&out, "-v", "/state/hooks:/state/hooks:ro"));
        // ...but settings.json is a writable copy shadowing the host path: mounted
        // rw (no :ro), source is the staged copy, dst is the container path.
        assert!(has_flag_value(
            &out,
            "-v",
            "/state/sandbox-stage/tab/_home_alice_.claude_settings.json:/home/alice/.claude/settings.json"
        ));
        assert!(
            !out.iter().any(|s| s.ends_with(
                "/home/alice/.claude/settings.json:/home/alice/.claude/settings.json:ro"
            )),
            "host settings.json must not be mounted read-only in place"
        );
        // Tab uid forwarded.
        assert!(has_flag_value(&out, "-e", "ELDRUN_TAB_UID=tab-1"));
        // Image precedes the command, original args preserved in order after it.
        let img = pos(&out, "img:latest").expect("image present");
        assert_eq!(out[img + 1], "claude");
        assert_eq!(out[img + 2], "--resume");
        assert_eq!(out[img + 3], "uuid-1");
    }

    #[test]
    fn codex_tab_preserves_resume_args() {
        let out = docker_run_args(
            "img:latest",
            "/home/alice",
            1000,
            1000,
            "/home/alice/eldrun/projects/p1",
            &BTreeMap::new(),
            &BTreeMap::new(),
            &rw("/home/alice"),
            &ro("/home/alice"),
            &HardenOpts::default(),
            "codex",
            &args(&["resume", "live-id"]),
        );
        let img = pos(&out, "img:latest").expect("image present");
        assert_eq!(&out[img + 1..], &["codex", "resume", "live-id"]);
    }

    #[test]
    fn auth_env_forwarded_before_image() {
        let auth = env(&[("ANTHROPIC_API_KEY", "sk-test")]);
        let out = docker_run_args(
            "img:latest",
            "/home/alice",
            1000,
            1000,
            "/proj",
            &BTreeMap::new(),
            &auth,
            &[],
            &[],
            &HardenOpts::default(),
            "claude",
            &[],
        );
        assert!(has_flag_value(&out, "-e", "ANTHROPIC_API_KEY=sk-test"));
        let key = out
            .iter()
            .position(|s| s == "ANTHROPIC_API_KEY=sk-test")
            .unwrap();
        let img = pos(&out, "img:latest").unwrap();
        assert!(key < img, "auth env must precede the image");
    }

    #[test]
    fn optional_resource_and_network_caps_appear_only_when_set() {
        let base = HardenOpts::default();
        let none = docker_run_args(
            "img", "/h", 1, 1, "/p", &BTreeMap::new(), &BTreeMap::new(), &[], &[], &base, "c", &[],
        );
        assert!(pos(&none, "--memory").is_none());
        assert!(pos(&none, "--cpus").is_none());
        assert!(pos(&none, "--network").is_none());
        assert!(pos(&none, "--read-only").is_none());

        let harden = HardenOpts {
            pids_limit: 256,
            memory: Some("4g".to_string()),
            cpus: Some("2".to_string()),
            network: Some("none".to_string()),
            readonly_rootfs: true,
        };
        let out = docker_run_args(
            "img", "/h", 1, 1, "/p", &BTreeMap::new(), &BTreeMap::new(), &[], &[], &harden, "c", &[],
        );
        assert!(has_flag_value(&out, "--pids-limit", "256"));
        assert!(has_flag_value(&out, "--memory", "4g"));
        assert!(has_flag_value(&out, "--cpus", "2"));
        assert!(has_flag_value(&out, "--network", "none"));
        assert!(has_flag_value(&out, "--tmpfs", "/tmp"));
        assert!(out.contains(&"--read-only".to_string()));
    }

    #[test]
    fn ro_mounts_get_ro_suffix() {
        let out = docker_run_args(
            "img",
            "/h",
            1,
            1,
            "/p",
            &BTreeMap::new(),
            &BTreeMap::new(),
            &[],
            &["/state/hooks:/state/hooks".to_string()],
            &HardenOpts::default(),
            "gemini",
            &[],
        );
        assert!(has_flag_value(&out, "-v", "/state/hooks:/state/hooks:ro"));
    }

    #[test]
    fn staged_config_mounts_copies_and_shadows_host_originals() {
        // Fake home with a settings.json; a distinct stage dir. Both under the
        // OS temp dir, keyed by pid so parallel test runs don't collide.
        let base = std::env::temp_dir().join(format!("eldrun-sbx-{}", std::process::id()));
        let home = base.join("home");
        let stage = base.join("stage");
        let claude = home.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::create_dir_all(&stage).unwrap();
        let settings = claude.join("settings.json");
        std::fs::write(&settings, b"{\"hooks\":{}}").unwrap();

        let home_str = home.to_string_lossy().into_owned();
        let mounts = staged_config_mounts(&home_str, &stage);

        // Exactly one mount (only settings.json exists), dst == the host path.
        assert_eq!(mounts.len(), 1, "got: {mounts:?}");
        let (src, dst) = mounts[0].rsplit_once(':').unwrap();
        assert_eq!(dst, settings.to_string_lossy());
        // Source is a real copy living under the stage dir, not the host file.
        assert!(Path::new(src).starts_with(&stage));
        assert_ne!(Path::new(src), settings.as_path());
        assert_eq!(std::fs::read(src).unwrap(), b"{\"hooks\":{}}");

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn wrap_is_noop_when_sandbox_disabled() {
        let mut opts = PtyOptions {
            id: "t".to_string(),
            cmd: "claude".to_string(),
            args: args(&["--session-id", "x"]),
            env: Default::default(),
            cwd: "/proj".to_string(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            project_id: None,
        };
        wrap_pty_options_docker(&mut opts).unwrap();
        assert_eq!(opts.cmd, "claude");
        assert_eq!(opts.args, args(&["--session-id", "x"]));
    }
}
