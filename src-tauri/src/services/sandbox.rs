//! Project containers (TODO #38): one closed Docker container per project.
//!
//! When a project's container toggle is on, every terminal/agent tab of the
//! project (`shell` and `agent` kinds) execs into a single long-lived container
//! named `eldrun-<project-id>`. `local_only` tabs (e.g. Ollama `local_agent`)
//! stay on the host verbatim. The container mounts **only the project
//! directory** plus the minimal agent auth/state paths, so a process inside it
//! physically cannot reach unrelated host files.
//!
//! Lifecycle: container lifetime = **project session**. It is created on
//! activation (`project_runtime::switch`) or on the first containerized spawn,
//! and torn down on deactivation (unless tabs are still live inside it), at app
//! exit (`down_all`), and at startup (`sweep_orphans` — a previous run's
//! containers are by definition stale). Every session starts from a fresh
//! container; installed deps and dev servers are shared between tabs *within*
//! a session.
//!
//! ## Identical-path mounting (correctness-critical)
//!
//! The project directory stays on the host and is bind-mounted at its
//! **identical absolute path**; the container runs `--user <uid>:<gid>` with
//! `-e HOME=<host home>`. This is what keeps the file tree, git UI, viewers and
//! usage watcher reading host bytes unchanged, keeps `-w <cwd>` trivially
//! correct for subdir tabs, and — most importantly — keeps **agent session
//! resume** working: Claude/Codex transcripts and the SessionStart hook record
//! host-absolute cwds, so the *same* session resumes correctly whether the
//! toggle is on or off.
//!
//! ## What the container can reach (blast radius)
//!
//! Only these host paths are bind-mounted, each at its identical absolute path:
//! - the **project directory** (rw) — the sole project bytes exposed;
//! - `~/.claude`, `~/.codex` (rw, when present) — agent auth + session transcripts;
//! - `<state_dir>/live_sessions` (rw) — where the in-container SessionStart hook
//!   records a tab's live session id for resume;
//! - Gemini creds (`~/.gemini`, `~/.config/gemini`, rw, when present) — narrowed
//!   from the whole `~/.config` so `gh`/`gcloud`/etc. secrets are *not* exposed;
//! - `<state_dir>/hooks` mounted **read-only** (see the RCE note below);
//! - the agents' hook-registration files (`~/.claude/settings.json[.local]`,
//!   `~/.codex/config.toml`) as **per-project writable copies** shadowing the
//!   host originals (see the RCE note below), staged under
//!   `<state_dir>/sandbox-stage/<project-id>/` and refreshed from the host
//!   originals at each `up`.
//!
//! Nothing else under `$HOME` or `state_dir` (notably `projects.json`, other
//! projects' conversation history, `time_log.json`) is mounted.
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
//!   **per-project writable copies** rather than the host originals: the
//!   container gets a real, writable file it can freely rewrite (so agents that
//!   persist config don't error), but its writes land in the throwaway copy —
//!   the host's real settings can never be repointed at an attacker command.
//!   The copy still carries the hook registration, so resume recording works.
//!
//! ## The exec step and the tab-kill contract
//!
//! Tabs are spawned as `docker exec -i -t -w <cwd> … <name> sh -c '…' sh <cmd>
//! <args…>`. Per-tab env (`opts.env`, `TERM`/`COLORTERM`) and **agent-auth env**
//! (`ssh_exec::AGENT_AUTH_ENV`, read off the host process at exec time so
//! rotated tokens are picked up per spawn) ride as `-e` flags. The `sh -c`
//! wrapper records the process's pid into an in-container pidfile before
//! exec'ing the real command: Docker does **not** kill an exec'd process when
//! its client dies, so closing a tab would otherwise leave the agent running
//! inside the container until session end. `PtyRegistry::kill` calls
//! [`kill_tab_process`], which TERMs that recorded pid (group) best-effort.
//!
//! ## Hardening
//!
//! Every container is created with `--init` (PID 1 reaps zombies),
//! `--security-opt no-new-privileges`, `--cap-drop ALL`, a `--pids-limit`
//! (fork-bomb guard), and `--label eldrun.owner=eldrun` so anything we started
//! is enumerable (and sweepable). Optional per-project knobs (`SandboxSpec`):
//! `--memory`, `--cpus`, `--network` (e.g. `none` for no egress), and
//! `--read-only` rootfs (+ `--tmpfs /tmp`). Docker's own socket is never
//! mounted. Note the default bridge network still reaches host-bound services
//! via the gateway IP (Ollama, dev servers); "closed" users set `network: none`
//! (breaks cloud agents) or a custom allowlist network.
//!
//! All paths are built from Rust path helpers as absolute strings — never
//! relying on `$HOME` shell-expansion, because `docker` is exec'd directly.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::paths;
use crate::schema::project::SandboxSpec;
use crate::storage;
use crate::terminal::PtyOptions;

/// Default image used when a project does not override it. Building/providing
/// this image is the user's responsibility; the toggle-time preflight offers a
/// one-click build (see `preflight_report` / `docker/agent-sandbox/`).
pub const DEFAULT_IMAGE: &str = "eldrun-agent-sandbox:latest";

/// Default `--pids-limit` when a project does not override it. Generous enough
/// for node + git + ripgrep + child processes, tight enough to blunt a fork bomb.
pub const DEFAULT_PIDS_LIMIT: u32 = 1024;

/// `--label` marking every container Eldrun starts, so anything we own is
/// enumerable (`docker ps --filter label=…`) and sweepable at startup/exit.
pub const OWNER_LABEL: &str = "eldrun.owner=eldrun";

/// The reference sandbox image's Dockerfile, embedded so an installed app (no
/// repo checkout) can still materialize it for the one-click build flow.
const REFERENCE_DOCKERFILE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../docker/agent-sandbox/Dockerfile"
));

/// Runtime hardening flags for a project container. Built from a project's
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

// ── Naming ────────────────────────────────────────────────────────────────

/// Reduce an id to a docker-name/shell/path-safe key (`[A-Za-z0-9_-]`, never
/// empty). Shared by the container name, the per-project stage dir, and the
/// per-tab pidfile so all three stay derivable from the same id.
fn sanitize_key(id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        "x".to_string()
    } else {
        safe
    }
}

/// Name of the session container for a project: `eldrun-<sanitized-id>`.
pub fn container_name_for(project_id: &str) -> String {
    format!("eldrun-{}", sanitize_key(project_id))
}

/// Image tag to run for a project: a `dockerfile` spec builds a per-project tag,
/// otherwise the spec's `image` override, otherwise the built-in default.
pub fn image_for(project_id: &str, spec: Option<&SandboxSpec>) -> String {
    if spec.is_some_and(|s| s.dockerfile.is_some()) {
        return format!("eldrun-{}:latest", sanitize_key(project_id));
    }
    spec.and_then(|s| s.image.clone())
        .unwrap_or_else(|| DEFAULT_IMAGE.to_string())
}

// ── Fingerprint + up decision (pure) ──────────────────────────────────────

/// Stable FNV-1a hash of everything baked into `docker run` at create time
/// (image, mounts, hardening — i.e. the create argv built with no fingerprint
/// label). Stored on the container as `--label eldrun.spec=<hash>` so `up` can
/// detect a stale container whose spec/mounts no longer match and recreate it.
/// Deliberately not `DefaultHasher` (unstable across Rust releases — a false
/// mismatch would needlessly recreate on every app upgrade… of the hasher).
pub fn spec_fingerprint(create_args: &[String]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for a in create_args {
        for b in a.as_bytes() {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        // Separator step so ["ab","c"] and ["a","bc"] hash differently.
        h ^= 0x1f;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// What `up` observed about the named container.
#[derive(Debug, Clone, Default)]
pub struct ContainerProbe {
    pub exists: bool,
    pub running: bool,
    /// The `eldrun.spec` label recorded at create, when present.
    pub fingerprint: Option<String>,
}

/// What `up` should do, given a probe and the wanted fingerprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpAction {
    /// Running and the spec still matches — no-op.
    UseExisting,
    /// Exists but stopped, or the spec/mounts changed — `rm -f`, then create.
    /// (Also covers crash leftovers.)
    Recreate,
    /// No such container — create.
    Create,
}

/// The idempotent three-state decision at the heart of `up`.
pub fn up_decision(probe: &ContainerProbe, want_fingerprint: &str) -> UpAction {
    if !probe.exists {
        return UpAction::Create;
    }
    if probe.running && probe.fingerprint.as_deref() == Some(want_fingerprint) {
        return UpAction::UseExisting;
    }
    UpAction::Recreate
}

// ── Argv builders (pure, unit-testable) ───────────────────────────────────

/// Build the `docker run -d … <image> sleep infinity` argv that creates a
/// project's session container. Pure: all host-derived inputs are passed in.
/// `rw_mounts`/`ro_mounts` are `src:dst` pairs (the project dir is always
/// mounted rw regardless); each `ro_mounts` entry gets a `:ro` suffix appended.
/// `fingerprint` is `None` while computing the fingerprint itself (the argv is
/// its own hash input), then `Some` for the real create.
#[allow(clippy::too_many_arguments)]
pub fn docker_create_args(
    name: &str,
    project_id: &str,
    image: &str,
    home: &str,
    uid: u32,
    gid: u32,
    project_dir: &str,
    rw_mounts: &[String],
    ro_mounts: &[String],
    harden: &HardenOpts,
    fingerprint: Option<&str>,
) -> Vec<String> {
    let mut a = vec![
        "run".to_string(),
        "-d".to_string(),
        "--name".to_string(),
        name.to_string(),
        // PID 1 reaps zombies — tabs come and go for the container's whole life.
        "--init".to_string(),
        "--label".to_string(),
        OWNER_LABEL.to_string(),
        "--label".to_string(),
        format!("eldrun.project={project_id}"),
    ];
    if let Some(fp) = fingerprint {
        // Keep the label out of its own hash input: it is appended only on the
        // second, real build of this argv.
        a.push("--label".to_string());
        a.push(format!("eldrun.spec={fp}"));
    }
    a.extend([
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
        project_dir.to_string(),
    ]);
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
        // Writable scratch so tools that need /tmp (npm cache, the per-tab
        // pidfiles below) still work under a read-only rootfs.
        a.push("--tmpfs".to_string());
        a.push("/tmp".to_string());
    }
    // The project dir (the only project bytes exposed), always mounted rw at
    // its identical path.
    a.push("-v".to_string());
    a.push(format!("{project_dir}:{project_dir}"));
    for m in rw_mounts {
        a.push("-v".to_string());
        a.push(m.clone());
    }
    // Read-only mounts (the hook script dir). A nested `:ro` file mount over an
    // rw parent dir works regardless of argv order: docker applies bind mounts
    // parent-first by destination depth.
    for m in ro_mounts {
        a.push("-v".to_string());
        a.push(format!("{m}:ro"));
    }
    a.push(image.to_string());
    // The container's sole job is to exist; tabs are `docker exec`s into it.
    a.push("sleep".to_string());
    a.push("infinity".to_string());
    a
}

/// Build the `docker exec …` argv that runs a tab's command inside the session
/// container. Per-tab env rides as `-e` flags (the exec inherits the container
/// env, notably `HOME`, from create). The `sh -c` wrapper writes the process's
/// pid to `pidfile` before exec'ing the real command — the tab-kill contract
/// (see the module doc and [`kill_tab_process`]).
pub fn docker_exec_args(
    name: &str,
    cwd: &str,
    env: &BTreeMap<String, String>,
    auth_env: &BTreeMap<String, String>,
    pidfile: &str,
    cmd: &str,
    cmd_args: &[String],
) -> Vec<String> {
    let mut a = vec![
        "exec".to_string(),
        "-i".to_string(),
        "-t".to_string(),
        "-w".to_string(),
        cwd.to_string(),
        "-e".to_string(),
        "TERM=xterm-256color".to_string(),
        "-e".to_string(),
        "COLORTERM=truecolor".to_string(),
    ];
    for (k, v) in env {
        a.push("-e".to_string());
        a.push(format!("{k}={v}"));
    }
    for (k, v) in auth_env {
        a.push("-e".to_string());
        a.push(format!("{k}={v}"));
    }
    a.push(name.to_string());
    a.push("sh".to_string());
    a.push("-c".to_string());
    // `pidfile` is built from sanitize_key output — shell-safe by construction.
    a.push(format!("echo $$ > {pidfile}; exec \"$@\""));
    a.push("sh".to_string());
    a.push(cmd.to_string());
    a.extend(cmd_args.iter().cloned());
    a
}

// ── Spawn-path entry point ────────────────────────────────────────────────

/// Rewrite `opts` to run its command inside the project's session container:
/// resolve the spec → `up()` (idempotent) → `docker exec`. No-op when
/// `opts.sandbox` is false. Errors (so `pty_spawn` surfaces the message in the
/// terminal) when docker, the daemon, or the image is unavailable, rather than
/// silently running the command on the host.
pub fn wrap_pty_options_docker(opts: &mut PtyOptions) -> Result<(), String> {
    if !opts.sandbox {
        return Ok(());
    }
    // Defence-in-depth: containers are local-only. Never docker-wrap a remote
    // project (resolved explicitly from the tab's owning project id).
    if opts
        .project_id
        .as_deref()
        .is_some_and(|id| crate::services::remote::remote_target_for(id).is_some())
    {
        return Ok(());
    }
    let project_id = opts
        .project_id
        .clone()
        .ok_or_else(|| "Project container: this tab has no owning project.".to_string())?;

    let spec = sandbox_spec_for(&project_id);
    // The container mounts the project ROOT; a subdir tab keeps its cwd via -w.
    let project_dir = project_dir_for(&project_id).unwrap_or_else(|| opts.cwd.clone());
    let name = up(&project_id, spec.as_ref(), &project_dir)?;

    // A shell tab spawns with an empty cmd (host default shell) — resolve the
    // *in-container* shell instead: bash when the image has it, else sh.
    let (cmd, cmd_args) = if opts.cmd.is_empty() {
        (
            "sh".to_string(),
            vec![
                "-c".to_string(),
                "command -v bash >/dev/null 2>&1 && exec bash; exec sh".to_string(),
            ],
        )
    } else {
        (opts.cmd.clone(), opts.args.clone())
    };

    // opts.env is already resolved (ELDRUN_TAB_UID, resume args' env, etc.).
    let env: BTreeMap<String, String> = opts.env.clone().into_iter().collect();
    // Auth env is read at exec (not create) so rotated tokens are picked up
    // per tab spawn.
    let auth_env = host_auth_env();
    let pidfile = register_exec_tab(&opts.id, &name);

    opts.args = docker_exec_args(&name, &opts.cwd, &env, &auth_env, &pidfile, &cmd, &cmd_args);
    opts.cmd = "docker".to_string();
    // Env now rides inside the docker argv as `-e` flags; the docker client
    // itself needs nothing from opts.env.
    opts.env.clear();
    Ok(())
}

// ── Container lifecycle ───────────────────────────────────────────────────

/// Serializes every create/remove so racing project switches (or a switch
/// racing a tab spawn) never interleave an `rm -f` with a `run` for the same
/// container.
fn lifecycle_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Container names created by THIS app run — bounds who `down_for_project`
/// spawns docker for (a project that never went up needs no teardown attempt),
/// and whether exit needs a `down_all` at all.
fn created_set() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Idempotent "make the project's session container exist and match the spec".
/// Returns the container name. Three-state: running+fingerprint-match → no-op;
/// exists-but-stopped or fingerprint-mismatch → `rm -f` + create; missing →
/// create. Called from the activation warm-up and from every containerized
/// spawn (the fallback for tabs opened before activation completes).
pub fn up(project_id: &str, spec: Option<&SandboxSpec>, project_dir: &str) -> Result<String, String> {
    let _guard = lifecycle_lock().lock().unwrap();
    preflight_docker()?;
    preflight_daemon()?;

    let name = container_name_for(project_id);
    let home = paths::home_dir_string();
    let (uid, gid) = host_uid_gid();
    let state_dir = storage::state_dir();
    let live_sessions = state_dir.join("live_sessions");
    let hooks_dir = state_dir.join("hooks");
    // Ensure the hook's write target and the staging dir exist so their bind
    // mounts map real host paths rather than docker-auto-created (root-owned)
    // ones. Best effort.
    let _ = std::fs::create_dir_all(&live_sessions);
    let stage = stage_dir(project_id);
    let _ = std::fs::create_dir_all(&stage);

    // Refresh the staged config copies from the host originals at every up.
    // `fs::copy` overwrites in place (same inode), so a running container's
    // bind mounts see the refreshed content too.
    let mut rw_mounts = rw_mounts(&home, &live_sessions.to_string_lossy());
    rw_mounts.extend(staged_config_mounts(&home, &stage));
    let ro_mounts = ro_mounts(&hooks_dir);
    let harden = harden_opts(spec);
    let image = image_for(project_id, spec);

    // The create argv (sans fingerprint label) is its own fingerprint input.
    let base = docker_create_args(
        &name, project_id, &image, &home, uid, gid, project_dir, &rw_mounts, &ro_mounts, &harden,
        None,
    );
    let fingerprint = spec_fingerprint(&base);

    match up_decision(&probe_container(&name), &fingerprint) {
        UpAction::UseExisting => {
            created_set().lock().unwrap().insert(name.clone());
            return Ok(name);
        }
        UpAction::Recreate => {
            let _ = docker(&["rm", "-f", &name]);
        }
        UpAction::Create => {}
    }

    ensure_image(spec, project_dir, &image)?;

    let args = docker_create_args(
        &name,
        project_id,
        &image,
        &home,
        uid,
        gid,
        project_dir,
        &rw_mounts,
        &ro_mounts,
        &harden,
        Some(&fingerprint),
    );
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = docker(&argv)?;
    if !out.status.success() {
        return Err(format!(
            "Project container: docker run failed: {}",
            stderr_tail(&out)
        ));
    }
    created_set().lock().unwrap().insert(name.clone());
    Ok(name)
}

/// Activation warm-up: `up()` for a project *iff* it is a container-toggled,
/// local project. `Ok(None)` when the toggle is off / the project is remote /
/// not on Unix — callers treat that as "nothing to do".
pub fn up_for_project(project_id: &str) -> Result<Option<String>, String> {
    #[cfg(not(unix))]
    {
        let _ = project_id;
        Ok(None)
    }
    #[cfg(unix)]
    {
        if crate::services::remote::remote_target_for(project_id).is_some() {
            return Ok(None);
        }
        let Some(spec) = sandbox_spec_for(project_id) else {
            return Ok(None);
        };
        if !spec.enabled {
            return Ok(None);
        }
        let dir = project_dir_for(project_id)
            .ok_or_else(|| format!("project '{project_id}' has no directory"))?;
        up(project_id, Some(&spec), &dir).map(Some)
    }
}

/// Tear down a project's session container (`rm -f` by name). Idempotent,
/// best-effort. Only spawns docker when this run actually created the container
/// or the toggle is currently on — a never-containerized project costs nothing.
pub fn down_for_project(project_id: &str) {
    let name = container_name_for(project_id);
    let created = created_set().lock().unwrap().contains(&name);
    if !created && !sandbox_spec_for(project_id).is_some_and(|s| s.enabled) {
        return;
    }
    let _guard = lifecycle_lock().lock().unwrap();
    let _ = docker(&["rm", "-f", &name]);
    created_set().lock().unwrap().remove(&name);
    exec_tabs()
        .lock()
        .unwrap()
        .retain(|_, t| t.container != name);
}

/// App-exit teardown: remove every eldrun-owned container. Skipped entirely
/// when this run never created one (a crash's leftovers are `sweep_orphans`'s
/// job next startup).
pub fn down_all() {
    if created_set().lock().unwrap().is_empty() {
        return;
    }
    remove_all_owned();
    created_set().lock().unwrap().clear();
    exec_tabs().lock().unwrap().clear();
}

/// Startup sweep: remove every container labelled `eldrun.owner=eldrun` (a
/// previous run's containers are by definition stale) and clear the staged
/// config copies (recreated at each `up`). Best-effort; cheap no-op when
/// docker is absent.
pub fn sweep_orphans() {
    let stage_root = storage::state_dir().join("sandbox-stage");
    let _ = std::fs::remove_dir_all(&stage_root);
    if preflight_docker().is_err() {
        return;
    }
    remove_all_owned();
}

/// `docker rm -f` every container carrying our owner label. Best-effort.
fn remove_all_owned() {
    let _guard = lifecycle_lock().lock().unwrap();
    let Ok(out) = docker(&[
        "ps",
        "-aq",
        "--filter",
        &format!("label={OWNER_LABEL}"),
    ]) else {
        return;
    };
    let ids: Vec<&str> = std::str::from_utf8(&out.stdout)
        .unwrap_or("")
        .split_whitespace()
        .collect();
    if ids.is_empty() {
        return;
    }
    let mut args = vec!["rm", "-f"];
    args.extend(ids);
    let _ = docker(&args);
}

/// Inspect the named container: does it exist, is it running, and which spec
/// fingerprint was it created with?
fn probe_container(name: &str) -> ContainerProbe {
    let out = match docker(&[
        "inspect",
        "--format",
        "{{.State.Running}}\t{{index .Config.Labels \"eldrun.spec\"}}",
        name,
    ]) {
        Ok(o) if o.status.success() => o,
        _ => return ContainerProbe::default(),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.trim();
    let (running, fp) = line.split_once('\t').unwrap_or((line, ""));
    ContainerProbe {
        exists: true,
        running: running == "true",
        fingerprint: (!fp.is_empty()).then(|| fp.to_string()),
    }
}

/// Make the image runnable: build it from the project's in-repo Dockerfile when
/// the spec says so, otherwise require it to already exist locally.
fn ensure_image(spec: Option<&SandboxSpec>, project_dir: &str, image: &str) -> Result<(), String> {
    if let Some(df) = spec.and_then(|s| s.dockerfile.as_deref()) {
        let df_path = Path::new(project_dir).join(df);
        let out = docker(&[
            "build",
            "-t",
            image,
            "-f",
            &df_path.to_string_lossy(),
            project_dir,
        ])?;
        if !out.status.success() {
            return Err(format!(
                "Project container: building '{df}' failed: {}",
                stderr_tail(&out)
            ));
        }
        return Ok(());
    }
    if image_exists(image) {
        return Ok(());
    }
    Err(format!(
        "Project container: image '{image}' not found. Toggle the container off and on again \
         to get a one-click build, or provide the image yourself (`docker build -t {image} \
         docker/agent-sandbox` from the Eldrun repo, or `docker pull` for a registry image)."
    ))
}

// ── Preflight ─────────────────────────────────────────────────────────────

/// `docker` binary present and runnable?
fn preflight_docker() -> Result<(), String> {
    match crate::paths::command_no_window("docker").arg("--version").output() {
        Ok(o) if o.status.success() => Ok(()),
        _ => Err(
            "Project container: 'docker' not found. Install Docker, or turn the container \
             toggle off for this project."
                .to_string(),
        ),
    }
}

/// Daemon actually up? `docker --version` succeeds daemon-less, so a dead
/// daemon must be diagnosed separately — "image missing" and "Docker isn't
/// running" are different user actions.
fn preflight_daemon() -> Result<(), String> {
    match docker(&["info", "--format", "{{.ServerVersion}}"]) {
        Ok(o) if o.status.success() => Ok(()),
        _ => Err(
            "Project container: Docker isn't running. Start the Docker service (e.g. \
             `systemctl start docker`), or turn the container toggle off for this project."
                .to_string(),
        ),
    }
}

fn image_exists(image: &str) -> bool {
    docker(&["image", "inspect", image])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Toggle-time preflight verdict, surfaced to the frontend so a missing image
/// becomes a one-click open-new-tab-paste-run build (house convention — never a
/// copy-it-yourself message) instead of an error at the next tab spawn.
#[derive(Debug, Clone, Serialize)]
pub struct PreflightReport {
    /// "ok" | "no_docker" | "daemon_down" | "image_missing"
    pub status: String,
    pub image: String,
    /// For "image_missing": the shell command that provides the image — a
    /// `docker build` of the in-repo/embedded reference Dockerfile for eldrun
    /// images, a `docker pull` for registry images.
    pub build_command: Option<String>,
}

/// Run the preflight for a project and describe the outcome (never errors —
/// the caller renders the status).
pub fn preflight_report(project_id: &str) -> PreflightReport {
    let spec = sandbox_spec_for(project_id);
    let image = image_for(project_id, spec.as_ref());
    let report = |status: &str, build: Option<String>| PreflightReport {
        status: status.to_string(),
        image: image.clone(),
        build_command: build,
    };
    if preflight_docker().is_err() {
        return report("no_docker", None);
    }
    if preflight_daemon().is_err() {
        return report("daemon_down", None);
    }
    // A dockerfile spec builds at `up`; nothing to pre-provide.
    if spec.as_ref().is_some_and(|s| s.dockerfile.is_some()) {
        return report("ok", None);
    }
    if image_exists(&image) {
        return report("ok", None);
    }
    let build = build_command(project_id, &image);
    report("image_missing", build)
}

/// The command that provides a missing image. Eldrun's own images build from
/// `docker/agent-sandbox` when the project carries a checkout, else from an
/// embedded copy of the reference Dockerfile materialized under the state dir
/// (an installed app has no repo checkout). Anything else is a registry pull.
fn build_command(project_id: &str, image: &str) -> Option<String> {
    if image != DEFAULT_IMAGE && !image.starts_with("eldrun-") {
        return Some(format!("docker pull {image}"));
    }
    if let Some(dir) = project_dir_for(project_id) {
        let in_repo = Path::new(&dir).join("docker").join("agent-sandbox");
        if in_repo.join("Dockerfile").is_file() {
            return Some(format!("docker build -t {image} '{}'", in_repo.display()));
        }
    }
    let stage = storage::state_dir().join("agent-sandbox");
    std::fs::create_dir_all(&stage).ok()?;
    std::fs::write(stage.join("Dockerfile"), REFERENCE_DOCKERFILE).ok()?;
    Some(format!("docker build -t {image} '{}'", stage.display()))
}

// ── Tab-kill contract ─────────────────────────────────────────────────────

/// A containerized tab's kill handle: which container it execs into and the
/// in-container pidfile its kill-wrapper wrote.
#[derive(Debug, Clone)]
struct ExecTab {
    container: String,
    pidfile: String,
}

fn exec_tabs() -> &'static Mutex<HashMap<String, ExecTab>> {
    static MAP: OnceLock<Mutex<HashMap<String, ExecTab>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register a containerized tab at spawn and mint its per-spawn pidfile path.
/// The nonce keeps a respawn's pidfile distinct from its predecessor's, so
/// killing the OLD process (below) can never race the NEW spawn's pidfile
/// write. A previous registration for the same tab id (this is a respawn) is
/// killed here — Docker does not kill an exec'd process when its client dies.
fn register_exec_tab(tab_id: &str, container: &str) -> String {
    static NONCE: AtomicU64 = AtomicU64::new(0);
    let n = NONCE.fetch_add(1, Ordering::Relaxed);
    let pidfile = format!("/tmp/eldrun-tab-{}-{n}.pid", sanitize_key(tab_id));
    let tab = ExecTab {
        container: container.to_string(),
        pidfile: pidfile.clone(),
    };
    if let Some(old) = exec_tabs().lock().unwrap().insert(tab_id.to_string(), tab) {
        spawn_kill(old);
    }
    pidfile
}

/// Kill the in-container process of a (possibly former) containerized tab.
/// Called from `PtyRegistry::kill` on tab close — killing the PTY child only
/// kills the `docker exec` *client*; the agent inside would otherwise keep
/// running until session end. Cheap no-op for tabs that never containerized.
pub fn kill_tab_process(tab_id: &str) {
    if let Some(tab) = exec_tabs().lock().unwrap().remove(tab_id) {
        spawn_kill(tab);
    }
}

/// TERM the recorded pid (preferring its process group) inside the container,
/// then drop the pidfile. Own thread + best-effort: the container may already
/// be gone, which is fine — teardown is what bounds stragglers.
fn spawn_kill(tab: ExecTab) {
    std::thread::spawn(move || {
        let script = format!(
            "p=$(cat {pf} 2>/dev/null); [ -n \"$p\" ] && \
             (kill -TERM -- \"-$p\" 2>/dev/null || kill -TERM \"$p\" 2>/dev/null); rm -f {pf}",
            pf = tab.pidfile
        );
        let _ = docker(&["exec", &tab.container, "sh", "-c", &script]);
    });
}

// ── Spec / project resolution ─────────────────────────────────────────────

/// Read the sandbox spec for `project_id` from the always-local `projects.json`
/// entry's flattened `extra["sandbox"]`. `None` when unknown/unparseable — the
/// caller then falls back to defaults. Mirrors `remote::remote_target_for`.
pub fn sandbox_spec_for(project_id: &str) -> Option<SandboxSpec> {
    let entry_value = project_entry_value(project_id, "sandbox")?;
    serde_json::from_value(entry_value).ok()
}

/// The project's directory (the bind-mount root), from the `projects.json`
/// entry's flattened `extra["directory"]`, falling back to `project.json`.
pub fn project_dir_for(project_id: &str) -> Option<String> {
    if let Some(v) = project_entry_value(project_id, "directory") {
        if let Some(s) = v.as_str() {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    let list_path = storage::state_dir().join("projects.json");
    let list: crate::schema::projects::ProjectsList = storage::read_json(&list_path).ok()?;
    let entry = list.iter().find(|e| e.id == project_id)?;
    let project: crate::schema::project::Project =
        storage::read_json(Path::new(&entry.local_file)).ok()?;
    (!project.directory.is_empty()).then_some(project.directory)
}

fn project_entry_value(project_id: &str, key: &str) -> Option<serde_json::Value> {
    let list_path = storage::state_dir().join("projects.json");
    let list: crate::schema::projects::ProjectsList = storage::read_json(&list_path).ok()?;
    let entry = list.iter().find(|e| e.id == project_id)?;
    entry.extra.get(key).cloned()
}

/// Detect in-repo container sources for a project whose toggle is being enabled
/// for the first time: a root `Dockerfile` wins, else a
/// `.devcontainer/devcontainer.json` `image` field. Leaves `spec` untouched
/// when neither is present (the default image applies).
pub fn detect_spec_sources(project_dir: &Path, spec: &mut SandboxSpec) {
    if project_dir.join("Dockerfile").is_file() {
        spec.dockerfile = Some("Dockerfile".to_string());
        return;
    }
    let devcontainer = project_dir.join(".devcontainer").join("devcontainer.json");
    if let Ok(text) = std::fs::read_to_string(&devcontainer) {
        // devcontainer.json is JSONC; strip line comments so serde can parse
        // the common case. (A devcontainer that only names a Dockerfile/compose
        // setup has no `image` and is simply not auto-detected.)
        let stripped: String = text
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stripped) {
            if let Some(image) = v.get("image").and_then(|i| i.as_str()) {
                if !image.is_empty() {
                    spec.image = Some(image.to_string());
                }
            }
        }
    }
}

// ── Mounts / identity (shared helpers) ────────────────────────────────────

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
    // The in-container SessionStart hook writes a tab's live id here.
    m.push(format!("{live_sessions}:{live_sessions}"));
    // Gemini credentials only — narrowed from the whole `~/.config` so unrelated
    // secrets (`gh`, `gcloud`, …) are never exposed to the container.
    for cand in [format!("{home}/.gemini"), format!("{home}/.config/gemini")] {
        if Path::new(&cand).is_dir() {
            m.push(format!("{cand}:{cand}"));
        }
    }
    m
}

/// Read-only identical-path mounts: just the hook *script* dir, which is shared
/// with host-run agents and so must be immutable from inside the container (see
/// the module doc). Mounted only when it exists on the host.
fn ro_mounts(hooks_dir: &Path) -> Vec<String> {
    let mut m = Vec::new();
    if hooks_dir.is_dir() {
        let h = hooks_dir.to_string_lossy();
        m.push(format!("{h}:{h}"));
    }
    m
}

/// Per-project staging dir for the writable hook-config copies:
/// `<state_dir>/sandbox-stage/<sanitized project id>`. One dir per project
/// (mounts are fixed at create), refreshed at each `up` — no per-tab leak.
fn stage_dir(project_id: &str) -> PathBuf {
    storage::state_dir()
        .join("sandbox-stage")
        .join(sanitize_key(project_id))
}

/// Copy the agents' hook-registration files into the per-project `stage` dir
/// and return rw mounts of the *copies* at the files' identical container
/// paths. The container thus gets writable settings it can freely rewrite (so
/// agents that persist config don't error) while the host originals are
/// shadowed and never touched — a compromised agent cannot repoint the host's
/// SessionStart hook. Best effort: a file that is absent or fails to copy is
/// simply not mounted.
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

/// Agent-auth env vars present on the host process, forwarded into the
/// container at exec time (which inherits none of the host env). Sorted for
/// determinism.
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

fn docker(args: &[&str]) -> Result<std::process::Output, String> {
    crate::paths::command_no_window("docker")
        .args(args)
        .output()
        .map_err(|e| format!("run docker: {e}"))
}

/// Last non-empty stderr line — docker's errors are one-liners at the tail.
fn stderr_tail(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr)
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("(no error output)")
        .to_string()
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
            format!("/state/sandbox-stage/p1/_home_alice_.claude_settings.json:{home}/.claude/settings.json"),
        ]
    }
    fn ro() -> Vec<String> {
        // Only the hook script dir is read-only; registration files are
        // writable per-project copies (see `staged_config_mounts`).
        vec!["/state/hooks:/state/hooks".to_string()]
    }

    fn create(fingerprint: Option<&str>) -> Vec<String> {
        docker_create_args(
            "eldrun-p1",
            "p1",
            "img:latest",
            "/home/alice",
            1000,
            1000,
            "/home/alice/eldrun/projects/p1",
            &rw("/home/alice"),
            &ro(),
            &HardenOpts::default(),
            fingerprint,
        )
    }

    // ── Naming / fingerprint ──────────────────────────────────────────────

    #[test]
    fn container_name_is_sanitized_and_prefixed() {
        assert_eq!(container_name_for("p1"), "eldrun-p1");
        assert_eq!(container_name_for("my proj/α"), "eldrun-my_proj__");
        assert_eq!(container_name_for(""), "eldrun-x");
    }

    #[test]
    fn fingerprint_is_stable_and_input_sensitive() {
        let a = spec_fingerprint(&create(None));
        let b = spec_fingerprint(&create(None));
        assert_eq!(a, b, "same argv must hash identically");
        assert_eq!(a.len(), 16);

        let mut other = create(None);
        let img = pos(&other, "img:latest").unwrap();
        other[img] = "img:v2".to_string();
        assert_ne!(a, spec_fingerprint(&other), "image change must change the hash");

        // Boundary sensitivity: ["ab","c"] vs ["a","bc"].
        assert_ne!(
            spec_fingerprint(&args(&["ab", "c"])),
            spec_fingerprint(&args(&["a", "bc"]))
        );
    }

    // ── up decision table ─────────────────────────────────────────────────

    #[test]
    fn up_decision_table() {
        let fp = "abc123";
        let missing = ContainerProbe::default();
        assert_eq!(up_decision(&missing, fp), UpAction::Create);

        let running_match = ContainerProbe {
            exists: true,
            running: true,
            fingerprint: Some(fp.to_string()),
        };
        assert_eq!(up_decision(&running_match, fp), UpAction::UseExisting);

        let stopped = ContainerProbe {
            exists: true,
            running: false,
            fingerprint: Some(fp.to_string()),
        };
        assert_eq!(up_decision(&stopped, fp), UpAction::Recreate);

        let mismatch = ContainerProbe {
            exists: true,
            running: true,
            fingerprint: Some("other".to_string()),
        };
        assert_eq!(up_decision(&mismatch, fp), UpAction::Recreate);

        let unlabeled = ContainerProbe {
            exists: true,
            running: true,
            fingerprint: None,
        };
        assert_eq!(up_decision(&unlabeled, fp), UpAction::Recreate);
    }

    // ── create argv ───────────────────────────────────────────────────────

    #[test]
    fn create_argv_has_mounts_identity_hardening_labels_and_sleeps() {
        let out = create(Some("deadbeef00000000"));

        assert_eq!(out[0], "run");
        assert!(out.contains(&"-d".to_string()));
        assert!(out.contains(&"--init".to_string()));
        assert!(has_flag_value(&out, "--name", "eldrun-p1"));
        assert!(has_flag_value(&out, "--label", OWNER_LABEL));
        assert!(has_flag_value(&out, "--label", "eldrun.project=p1"));
        assert!(has_flag_value(&out, "--label", "eldrun.spec=deadbeef00000000"));
        assert!(has_flag_value(&out, "--user", "1000:1000"));
        assert!(has_flag_value(&out, "-e", "HOME=/home/alice"));
        assert!(has_flag_value(&out, "-w", "/home/alice/eldrun/projects/p1"));
        // Hardening always on.
        assert!(has_flag_value(&out, "--security-opt", "no-new-privileges"));
        assert!(has_flag_value(&out, "--cap-drop", "ALL"));
        assert!(has_flag_value(&out, "--pids-limit", &DEFAULT_PIDS_LIMIT.to_string()));
        // Project dir always mounted rw at its identical path.
        assert!(has_flag_value(
            &out,
            "-v",
            "/home/alice/eldrun/projects/p1:/home/alice/eldrun/projects/p1"
        ));
        // rw auth mounts.
        assert!(has_flag_value(&out, "-v", "/home/alice/.claude:/home/alice/.claude"));
        assert!(has_flag_value(&out, "-v", "/state/live_sessions:/state/live_sessions"));
        // The hook script dir is read-only (:ro suffix)...
        assert!(has_flag_value(&out, "-v", "/state/hooks:/state/hooks:ro"));
        // ...but settings.json is a writable per-PROJECT copy shadowing the
        // host path: mounted rw (no :ro), source is the staged copy.
        assert!(has_flag_value(
            &out,
            "-v",
            "/state/sandbox-stage/p1/_home_alice_.claude_settings.json:/home/alice/.claude/settings.json"
        ));
        assert!(
            !out.iter().any(|s| s.ends_with(
                "/home/alice/.claude/settings.json:/home/alice/.claude/settings.json:ro"
            )),
            "host settings.json must not be mounted read-only in place"
        );
        // The container's sole job is to exist: image, then `sleep infinity`.
        let img = pos(&out, "img:latest").expect("image present");
        assert_eq!(&out[img + 1..], &["sleep", "infinity"]);
        // No `--rm`: lifetime is owned by up/down, not by process exit.
        assert!(pos(&out, "--rm").is_none());
    }

    #[test]
    fn create_argv_without_fingerprint_omits_spec_label_only() {
        let bare = create(None);
        let labeled = create(Some("feedface00000000"));
        assert!(!bare.iter().any(|s| s.starts_with("eldrun.spec=")));
        assert_eq!(labeled.len(), bare.len() + 2, "fingerprint adds exactly --label + value");
        assert!(has_flag_value(&labeled, "--label", "eldrun.spec=feedface00000000"));
    }

    #[test]
    fn optional_resource_and_network_caps_appear_only_when_set() {
        let none = create(None);
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
        let out = docker_create_args(
            "eldrun-p1", "p1", "img", "/h", 1, 1, "/p", &[], &[], &harden, None,
        );
        assert!(has_flag_value(&out, "--pids-limit", "256"));
        assert!(has_flag_value(&out, "--memory", "4g"));
        assert!(has_flag_value(&out, "--cpus", "2"));
        assert!(has_flag_value(&out, "--network", "none"));
        assert!(has_flag_value(&out, "--tmpfs", "/tmp"));
        assert!(out.contains(&"--read-only".to_string()));
    }

    // ── exec argv ─────────────────────────────────────────────────────────

    #[test]
    fn exec_argv_has_cwd_env_killwrapper_and_preserves_resume_args() {
        let envs = env(&[("ELDRUN_TAB_UID", "tab-1")]);
        let auth = env(&[("ANTHROPIC_API_KEY", "sk-test")]);
        let out = docker_exec_args(
            "eldrun-p1",
            "/home/alice/eldrun/projects/p1/sub",
            &envs,
            &auth,
            "/tmp/eldrun-tab-t1-0.pid",
            "claude",
            &args(&["--resume", "uuid-1"]),
        );

        assert_eq!(out[0], "exec");
        assert!(out.contains(&"-i".to_string()));
        assert!(out.contains(&"-t".to_string()));
        // Per-tab cwd (subdir tabs stay correct under identical-path mounting).
        assert!(has_flag_value(&out, "-w", "/home/alice/eldrun/projects/p1/sub"));
        assert!(has_flag_value(&out, "-e", "TERM=xterm-256color"));
        assert!(has_flag_value(&out, "-e", "ELDRUN_TAB_UID=tab-1"));
        // Auth env rides at exec (rotated tokens per spawn), before the name.
        assert!(has_flag_value(&out, "-e", "ANTHROPIC_API_KEY=sk-test"));
        let key = out.iter().position(|s| s == "ANTHROPIC_API_KEY=sk-test").unwrap();
        let name = pos(&out, "eldrun-p1").unwrap();
        assert!(key < name, "env must precede the container name");
        // Kill-wrapper shape: name, sh -c '<pidfile script>' sh <cmd> <args…>.
        assert_eq!(out[name + 1], "sh");
        assert_eq!(out[name + 2], "-c");
        assert_eq!(out[name + 3], "echo $$ > /tmp/eldrun-tab-t1-0.pid; exec \"$@\"");
        assert_eq!(out[name + 4], "sh");
        // Original command + resume args preserved in order after the wrapper.
        assert_eq!(&out[name + 5..], &["claude", "--resume", "uuid-1"]);
    }

    #[test]
    fn exec_argv_codex_resume_order_preserved() {
        let out = docker_exec_args(
            "eldrun-p1",
            "/p",
            &BTreeMap::new(),
            &BTreeMap::new(),
            "/tmp/eldrun-tab-t2-1.pid",
            "codex",
            &args(&["resume", "live-id"]),
        );
        // `-c <script> sh` precede the real command ($0 is the literal "sh").
        let sh = pos(&out, "-c").unwrap();
        assert_eq!(out[sh + 2], "sh");
        assert_eq!(&out[sh + 3..], &["codex", "resume", "live-id"]);
    }

    // ── stage dir ─────────────────────────────────────────────────────────

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

        // Refresh-at-up: a second pass overwrites the same single copy in
        // place (same path, new content) — never a second file.
        std::fs::write(&settings, b"{\"hooks\":{\"v\":2}}").unwrap();
        let again = staged_config_mounts(&home_str, &stage);
        assert_eq!(again, mounts, "mount list must be stable across refreshes");
        assert_eq!(std::fs::read(src).unwrap(), b"{\"hooks\":{\"v\":2}}");
        assert_eq!(
            std::fs::read_dir(&stage).unwrap().count(),
            1,
            "one staged copy per file, refreshed in place"
        );

        std::fs::remove_dir_all(&base).ok();
    }

    // ── spec sources ──────────────────────────────────────────────────────

    #[test]
    fn detect_spec_sources_prefers_dockerfile_then_devcontainer_image() {
        let base = std::env::temp_dir().join(format!("eldrun-det-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();

        // Nothing present → spec untouched.
        let mut spec = SandboxSpec::default();
        detect_spec_sources(&base, &mut spec);
        assert_eq!(spec.dockerfile, None);
        assert_eq!(spec.image, None);

        // devcontainer image (JSONC comments tolerated).
        let dc = base.join(".devcontainer");
        std::fs::create_dir_all(&dc).unwrap();
        std::fs::write(
            dc.join("devcontainer.json"),
            b"{\n  // dev image\n  \"image\": \"mcr.example/devbox:1\"\n}",
        )
        .unwrap();
        let mut spec = SandboxSpec::default();
        detect_spec_sources(&base, &mut spec);
        assert_eq!(spec.image.as_deref(), Some("mcr.example/devbox:1"));
        assert_eq!(spec.dockerfile, None);

        // A root Dockerfile wins over the devcontainer.
        std::fs::write(base.join("Dockerfile"), b"FROM debian:stable").unwrap();
        let mut spec = SandboxSpec::default();
        detect_spec_sources(&base, &mut spec);
        assert_eq!(spec.dockerfile.as_deref(), Some("Dockerfile"));
        assert_eq!(spec.image, None);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn image_for_prefers_dockerfile_tag_then_override_then_default() {
        assert_eq!(image_for("p1", None), DEFAULT_IMAGE);
        let with_image = SandboxSpec {
            image: Some("python:3.12".to_string()),
            ..Default::default()
        };
        assert_eq!(image_for("p1", Some(&with_image)), "python:3.12");
        let with_df = SandboxSpec {
            image: Some("python:3.12".to_string()),
            dockerfile: Some("Dockerfile".to_string()),
            ..Default::default()
        };
        assert_eq!(image_for("p1", Some(&with_df)), "eldrun-p1:latest");
    }

    // ── wrap ──────────────────────────────────────────────────────────────

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

    #[test]
    fn register_exec_tab_mints_unique_pidfiles_per_respawn() {
        let a = register_exec_tab("tab/α:1", "eldrun-p1");
        let b = register_exec_tab("tab/α:1", "eldrun-p1");
        assert_ne!(a, b, "a respawn must never reuse its predecessor's pidfile");
        assert!(a.starts_with("/tmp/eldrun-tab-tab___1-"));
        assert!(a.ends_with(".pid"));
        // Cleanup so other tests never see this entry.
        exec_tabs().lock().unwrap().remove("tab/α:1");
    }
}
