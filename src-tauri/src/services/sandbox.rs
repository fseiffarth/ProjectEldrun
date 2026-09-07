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
//! **Windows** is the one host where "identical" cannot be literal: a Linux
//! container has no `C:\`. Every host path crossing into the container goes
//! through [`container_path`], the fixed, invertible Docker Desktop spelling
//! (`C:\Users\a\p` → `/c/Users/a/p`), and it is applied at exactly one layer —
//! the argv builders — so every mount planner above them keeps reasoning in
//! host paths. `--user` is omitted there (Docker Desktop maps bind-mounted
//! files to the Windows user regardless of the in-container uid), and the
//! SessionStart hook the staged configs point at is swapped for a POSIX twin
//! (see [`staged_config_mounts`]) because the registered one is PowerShell.
//!
//! ## What the container can reach (blast radius)
//!
//! Only these host paths are bind-mounted, each at its identical absolute path:
//! - the **project directory** (rw) — the sole project bytes exposed;
//! - selected subpaths of `~/.claude`, `~/.codex` (rw, when present) — the agent
//!   auth + transcript files resume needs, and **only** those (see [`rw_mounts`]);
//! - `~/.claude/projects` **per transcript dir**: this project's rw, every other
//!   project's read-only (see the transcript section below);
//! - `<state_dir>/live_sessions/<project-id>` (rw) — where the in-container
//!   SessionStart hook records a tab's live session id for resume. **Per project**,
//!   not the shared root: one flat directory let a contained agent overwrite
//!   another project's tab record and so choose which conversation an
//!   *uncontained* agent resumes;
//! - Gemini creds (`~/.gemini`, `~/.config/gemini`, rw, when present) — narrowed
//!   from the whole `~/.config` so `gh`/`gcloud`/etc. secrets are *not* exposed;
//! - `<state_dir>/hooks` mounted **read-only** (see the RCE note below);
//! - the agents' hook-registration files (`~/.claude/settings.json[.local]`,
//!   `~/.codex/config.toml`) as **per-project writable copies** shadowing the
//!   host originals (see the RCE note below), staged under
//!   `<state_dir>/sandbox-stage/<project-id>/` and refreshed from the host
//!   originals at each `up`.
//!
//! Nothing else under `$HOME` or `state_dir` (notably `projects.json`,
//! `time_log.json`, or another project's `live_sessions` record) is mounted.
//!
//! ## Claude transcripts: read every project, write only our own
//!
//! `~/.claude/projects` is the one mount whose contents span projects — Claude
//! keys transcripts by encoded cwd, not by Eldrun project. It is therefore
//! mounted **per entry, explicitly** ([`claude_transcript_mounts`]), never as one
//! dir: this project's transcript dirs rw, **every other project's `:ro`**. Reading
//! another project's history is allowed; rewriting one is not, because the
//! rewritten log is what an *uncontained* future session reads back as its own
//! history. Membership is decided by the `cwd` recorded **inside** a transcript,
//! not by decoding the directory name — that encoding maps both `/` and `.` to
//! `-`, so a name cannot distinguish a subdirectory from a sibling project.
//!
//! A cwd with no host dir at create time (a subdir tab, a fresh worktree) has
//! nothing to mount, so the mount *parent* is a per-project stage dir: the new
//! transcript lands there, on the host, and teardown harvests it into the real
//! `~/.claude/projects`.
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

use serde::{Deserialize, Serialize};

use crate::paths;
use crate::schema::project::{DetectedSpecKind, DetectedSpecSource, SandboxScope, SandboxSpec};
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
/// per-tab pidfile so all three stay derivable from the same id — and, via
/// [`crate::storage::project_key`], by the per-project session directory, so a
/// project's container and its session state are named by the same rule.
fn sanitize_key(id: &str) -> String {
    crate::storage::project_key(id)
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
    // `--user` carries the host identity in so files the container writes are
    // the user's. On Windows there is no host uid to carry (`host_uid_gid` is
    // `(0, 0)`) and Docker Desktop maps bind-mounted files to the Windows user
    // anyway, so the flag is simply not passed.
    if (uid, gid) != (0, 0) {
        a.extend(["--user".to_string(), format!("{uid}:{gid}")]);
    }
    a.extend([
        // Hardening: no privilege escalation, no Linux capabilities, bounded
        // process count. Docker's socket is deliberately never mounted.
        "--security-opt".to_string(),
        "no-new-privileges".to_string(),
        "--cap-drop".to_string(),
        "ALL".to_string(),
        "--pids-limit".to_string(),
        harden.pids_limit.to_string(),
        "-e".to_string(),
        format!("HOME={}", container_path(home)),
        "-w".to_string(),
        container_path(project_dir),
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
    // its identical path (its container spelling on Windows).
    a.push("-v".to_string());
    a.push(format!("{project_dir}:{}", container_path(project_dir)));
    for m in rw_mounts {
        a.push("-v".to_string());
        a.push(volume_arg(m, false));
    }
    // Read-only mounts (the hook script dir). A nested `:ro` file mount over an
    // rw parent dir works regardless of argv order: docker applies bind mounts
    // parent-first by destination depth.
    for m in ro_mounts {
        a.push("-v".to_string());
        a.push(volume_arg(m, true));
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
        container_path(cwd),
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

// ── Authority resolution (pure) ───────────────────────────────────────────
//
// `PtyOptions.sandbox` and `PtyOptions.local_only` arrive from the renderer,
// which derives them from the tab store — and the tab store is rehydrated from a
// layout file that lives INSIDE the project tree (`.eldrun/sessions/terminals.json`
// and `project.json`), i.e. inside the container's own writable mount and inside
// any cloned/imported repo. A persisted tab that declares `location: "local"`
// therefore used to defeat the container it was supposed to be confined by:
// `pty_spawn`'s gate is `if sandbox && !local_only { docker } else if !local_only
// { ssh }`, so `local_only == true` takes neither branch and the argv runs on the
// host.
//
// So the two flags are re-derived here from the trustworthy store (`projects.json`
// under `state_dir`, which is never mounted into a container) and the renderer's
// values are only honoured where they cannot lower authority.

/// The authority flags a spawn actually runs with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpawnAuthority {
    pub sandbox: bool,
    pub local_only: bool,
}

/// Env var Eldrun sets on every local-model tab (both the `vibe` per-model driver
/// and the `prepare_local_launch` drivers) to record which Ollama model it drives.
///
/// **A usage label, and nothing else.** It used to double as the marker that
/// granted a tab the right to skip the container, which was an authority decision
/// keyed on a telemetry string: `TabBar.tsx` sets it so the daily recap can break
/// local-agent tabs down by model, and *any* future surface that set it for a
/// display reason would silently have handed out container escapes. The authority
/// now comes from [`host_bound_marker_exists`].
pub const LOCAL_MODEL_ENV: &str = "ELDRUN_LOCAL_MODEL";

/// Directory of host-bound markers for a project:
/// `<state_dir>/sessions/<project key>/host_bound/`.
fn host_bound_dir(project_id: &str) -> std::path::PathBuf {
    crate::storage::project_session_dir(project_id).join("host_bound")
}

/// Whether `uid` is a well-formed marker name. A marker names a file, so it must
/// reduce to one path component and nothing else — this is the only validation
/// between a renderer-supplied string and a `join`.
fn valid_marker_uid(uid: &str) -> bool {
    !uid.is_empty()
        && uid.len() <= 64
        && uid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Record that a tab was genuinely created as a host-bound local-model tab.
///
/// Written when the user opens one (`TabBar`/`NewTabMenu` → the
/// `register_host_bound_tab` command), into the state dir — which no container
/// mounts, unlike the persisted layout this decision used to be re-derived from.
/// The uid is the frontend-minted, layout-persisted `hostBoundUid`, stable across
/// a relaunch (the tab's key and PTY id are both regenerated on restore), so a
/// legitimately restored Ollama tab keeps its exemption.
pub fn register_host_bound_tab(project_id: &str, uid: &str) -> Result<(), String> {
    if !valid_marker_uid(uid) {
        return Err("invalid host-bound tab id".to_string());
    }
    let dir = host_bound_dir(project_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create host_bound dir: {e}"))?;
    std::fs::write(dir.join(uid), b"1").map_err(|e| format!("write host_bound marker: {e}"))
}

/// Whether a marker exists for this (project, tab uid) pair.
pub fn host_bound_marker_exists(project_id: &str, uid: &str) -> bool {
    valid_marker_uid(uid) && host_bound_dir(project_id).join(uid).is_file()
}

/// Drop markers for tabs the project no longer has, so the directory does not
/// grow one file per local-model tab ever opened. Called after a layout save with
/// the uids the saved layout still carries.
pub fn prune_host_bound_markers(project_id: &str, keep: &std::collections::HashSet<String>) {
    let dir = host_bound_dir(project_id);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !keep.contains(&name) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The commands a **host-bound** local-model tab can spawn: `vibe`, `ollama`
/// (`ollama launch <agent> --model …`) and the direct fallbacks of
/// `commands::ollama::LOCAL_DRIVERS`. These tabs must not be containerized even
/// when the project's toggle is on — they depend on the host's Ollama server,
/// `VIBE_HOME`, and each agent's host-side wiring, none of which exists inside the
/// image. Kept as an explicit allowlist rather than "trust whatever says it is
/// local": several of these names (`claude`, `codex`, …) are also ordinary agent
/// CLIs, which is exactly why a registered marker is required too.
pub const HOST_BOUND_LOCAL_AGENT_CMDS: &[&str] = &[
    "vibe", "ollama", "claude", "codex", "opencode", "droid", "openclaw",
];

/// Whether this spawn is one of the host-bound local-model driver tabs (see
/// [`HOST_BOUND_LOCAL_AGENT_CMDS`]): the command is a known driver **and** the tab
/// holds a registered host-bound marker.
///
/// `marker` is the caller's answer to "does this tab's uid have a marker file?",
/// injected so the policy stays pure and testable; the state-dir lookup is
/// [`host_bound_marker_exists`].
///
/// **What this buys, precisely.** It removes an authority decision that was keyed
/// on `ELDRUN_LOCAL_MODEL` — a label `TabBar.tsx` sets for the usage recap, which
/// meant a display-only change elsewhere could hand out container escapes without
/// anyone noticing. It does *not* defend against a compromised renderer: the
/// registration is a command the renderer calls, so a renderer that can spawn can
/// also register. That case is the CSP's, and it is why the CSP is load-bearing.
pub fn is_host_bound_local_agent(cmd: &str, marker: bool) -> bool {
    marker && HOST_BOUND_LOCAL_AGENT_CMDS.contains(&cmd)
}

/// Whether a spawn's command launches an AI coding agent — the question
/// [`SandboxScope::Agents`] turns on. Mirrors `commands::agents::AGENTS` (the
/// registry the + menu lists) and the frontend's `AGENT_CMDS`; the three are the
/// same set by construction and `agent_registry_matches_classifier` fails if the
/// registry grows an entry this misses.
///
/// **Classified by the command that actually executes**, deliberately, and not by
/// a tab `kind` the renderer sends: `kind` is a label, `cmd` is the argv. A
/// renderer that lies about `cmd` does not win an exemption, it runs a different
/// program. The one thing this cannot see through is an agent launched
/// *indirectly* (`sh -c 'claude'`, a wrapper script), which under `Agents` runs on
/// the host — the same class of gap the host-bound marker documents, with the same
/// answer: it takes a renderer that can already spawn, which is the CSP's problem
/// and not this function's. Nothing in Eldrun's own UI opens an agent that way.
///
/// Matched on the **basename**, so a pinned `/usr/local/bin/claude` or a
/// `~/.local/bin/codex` is still an agent.
pub fn is_agent_cmd(cmd: &str) -> bool {
    let base = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    let base = base.strip_suffix(".exe").unwrap_or(base);
    crate::commands::agents::agent_bins().contains(&base)
}

/// The permanent Trash workspace is the strict isolation profile: its
/// container receives its project directory and no host-backed agent state.
/// API-key environment variables may still be forwarded at exec time, but a
/// contained process cannot inspect or alter any host file outside Trash.
pub fn is_strict_trash_project(project_id: &str) -> bool {
    paths::is_trash_project_id(project_id)
}

/// Re-derive a spawn's authority flags from the trustworthy project record.
///
/// - **No owning project** (root/global scope, connection terminals): pass through
///   — there is no project record to consult and no container to apply.
/// - **Remote project**: containers are local-only, so `sandbox` is forced off;
///   `local_only` is left to the renderer because it is a legitimate per-tab
///   choice there (run in the local mirror vs. on the host) and cannot escape a
///   container that was never going to apply.
/// - **Local project, toggle off**: `sandbox` forced off (the renderer must not be
///   able to invent a container spec); `local_only` is irrelevant — with no remote
///   to wrap, both values spawn on the host.
/// - **Local project, toggle on**: containerized, subject to `scope`. `local_only`
///   is ignored — the exceptions are a host-bound local-model driver tab, which
///   keeps running on the host exactly as before, and (under
///   [`SandboxScope::Agents`]) any spawn whose command is not an agent CLI.
///
/// **`scope` narrows, never widens.** It is read from the same trusted record as
/// `toggle_on` and is only ever consulted *after* the toggle has already said yes,
/// so a spec the renderer cannot write cannot be used to grant a container that
/// the project record does not.
pub fn resolve_spawn_authority(
    has_project: bool,
    is_remote: bool,
    toggle_on: bool,
    scope: SandboxScope,
    requested: SpawnAuthority,
    cmd: &str,
    host_bound_marker: bool,
) -> SpawnAuthority {
    if !has_project {
        return requested;
    }
    if is_remote || !toggle_on {
        return SpawnAuthority {
            sandbox: false,
            local_only: requested.local_only,
        };
    }
    if is_host_bound_local_agent(cmd, host_bound_marker) {
        return SpawnAuthority {
            sandbox: false,
            local_only: true,
        };
    }
    // Agents-only: a shell, a script, a viewer Run/Debug tab runs on the host with
    // the host's toolchain. `local_only` is left as the renderer asked, exactly as
    // in the toggle-off case — with no remote to wrap it changes nothing, and on a
    // remote project this branch is unreachable (handled above).
    if scope == SandboxScope::Agents && !is_agent_cmd(cmd) {
        return SpawnAuthority {
            sandbox: false,
            local_only: requested.local_only,
        };
    }
    SpawnAuthority {
        sandbox: true,
        local_only: false,
    }
}

/// State-dir-backed wrapper around [`resolve_spawn_authority`]: resolve the
/// project's remoteness and container toggle from `projects.json` and apply the
/// result to `opts` in place. Called from `pty_spawn` before any wrapping.
pub fn enforce_spawn_authority(opts: &mut PtyOptions) {
    let Some(project_id) = opts.project_id.clone() else {
        return;
    };
    // Box scopes (`box:<id>`) run local + uncontained by design (v1 trust
    // statement): a box has no container or VM of its own, and one member's
    // sandbox spec must not silently govern a tab that can also reach the
    // other members' trees — a half-applied boundary would read as a whole
    // one. The box editor surfaces the trust notice instead.
    if crate::commands::boxes::box_id_of_scope(&project_id).is_some() {
        if opts.sandbox {
            eprintln!(
                "sandbox: box-scoped tab '{}' resolved to sandbox: false (boxes run uncontained)",
                opts.id
            );
        }
        opts.sandbox = false;
        return;
    }
    let is_remote = crate::services::remote::remote_target_for(&project_id).is_some();
    let spec = sandbox_spec_for(&project_id);
    let toggle_on = spec.as_ref().is_some_and(|s| s.enabled);
    let scope = spec.as_ref().map(|s| s.scope).unwrap_or_default();
    // The container exemption is looked up in the state dir, never taken from the
    // spawn's own env — see `is_host_bound_local_agent`.
    let marker = opts
        .host_bound_uid
        .as_deref()
        .is_some_and(|uid| host_bound_marker_exists(&project_id, uid));
    let resolved = resolve_spawn_authority(
        true,
        is_remote,
        toggle_on,
        scope,
        SpawnAuthority {
            sandbox: opts.sandbox,
            local_only: opts.local_only,
        },
        &opts.cmd,
        marker,
    );
    if resolved.sandbox != opts.sandbox || resolved.local_only != opts.local_only {
        eprintln!(
            "sandbox: authority for tab '{}' resolved from the project record \
             (sandbox {} -> {}, local_only {} -> {})",
            opts.id, opts.sandbox, resolved.sandbox, opts.local_only, resolved.local_only
        );
    }
    opts.sandbox = resolved.sandbox;
    opts.local_only = resolved.local_only;
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
    //
    // This is reachable with the toggle showing ON: a local project that had the
    // container enabled and was later `extend_project_to_remote`d keeps its
    // `sandbox.enabled` spec while every tab now runs on the remote host — possibly
    // an HPC login node. Refusing the spawn would break exactly those projects, so
    // the case stays a no-op, but it is no longer a *silent* one: it is logged and
    // surfaced to the frontend so the pill can say the container is not applied
    // (`enforce_spawn_authority` has already cleared `opts.sandbox` for the same
    // reason, so in practice this branch is the belt to that braces).
    if let Some(id) = opts.project_id.as_deref() {
        if crate::services::remote::remote_target_for(id).is_some() {
            eprintln!(
                "sandbox: project '{id}' has the container toggle ON but is a REMOTE project — \
                 the container is NOT applied and tab '{}' runs unsandboxed on the remote host. \
                 Clear the toggle to make the pill honest.",
                opts.id
            );
            return Ok(());
        }
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
    // Trash agent tabs can live in a host tmux session for Eldrun Mobile. Their
    // PTY is only tmux's client, so registering it for normal tab-close cleanup
    // would kill the contained agent as soon as the desktop detaches. The
    // persistent container is itself the lifetime boundary instead.
    let persistent_trash = is_strict_trash_project(&project_id) && opts.tmux_session.is_some();
    let pidfile = if persistent_trash {
        format!("/tmp/eldrun-persist-{}.pid", sanitize_key(&opts.id))
    } else {
        register_exec_tab(&opts.id, &name)
    };

    opts.args = docker_exec_args(&name, &opts.cwd, &env, &auth_env, &pidfile, &cmd, &cmd_args);
    opts.cmd = "docker".to_string();
    // Env now rides inside the docker argv as `-e` flags; the docker client
    // itself needs nothing from opts.env.
    opts.env.clear();
    Ok(())
}

// ── Host → container paths ────────────────────────────────────────────────

/// The container-side spelling of a host path.
///
/// Linux/macOS: the path itself (identical-path mounting). Windows: Docker
/// Desktop's convention — the drive letter becomes a lowercase root
/// directory and separators turn forward (`C:\Users\a` → `/c/Users/a`); a UNC
/// path `\\server\share\x` becomes `/server/share/x`. Pure over `windows`
/// so the mapping is tested on every OS; [`container_path`] passes the real
/// target.
pub(crate) fn container_path_for(host: &str, windows: bool) -> String {
    if !windows {
        return host.to_string();
    }
    let forward = host.replace('\\', "/");
    let bytes = forward.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = forward[2..].trim_start_matches('/');
        if rest.is_empty() {
            format!("/{drive}")
        } else {
            format!("/{drive}/{rest}")
        }
    } else if let Some(unc) = forward.strip_prefix("//") {
        format!("/{unc}")
    } else {
        forward
    }
}

pub(crate) fn container_path(host: &str) -> String {
    container_path_for(host, cfg!(windows))
}

/// Split a `src:dst` mount pair. Every planner writes the pair with a host
/// path on both sides, and on Windows both carry a drive colon, so the
/// separator is the first `:` that is followed by a path start (`/`, `\`, or
/// another `X:` drive) — never the one at index 1 of a drive path.
pub(crate) fn split_mount_pair(pair: &str) -> (&str, &str) {
    let bytes = pair.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b != b':' || i < 2 {
            continue;
        }
        let next = bytes.get(i + 1).copied();
        let starts_path = matches!(next, Some(b'/') | Some(b'\\'))
            || (next.is_some_and(|c| c.is_ascii_alphabetic()) && bytes.get(i + 2) == Some(&b':'));
        if starts_path {
            return (&pair[..i], &pair[i + 1..]);
        }
    }
    // A pair with no recognisable separator (a plain POSIX `a:b` where `b` has
    // no leading slash): fall back to the first colon, the historical rule.
    pair.split_once(':').unwrap_or((pair, pair))
}

/// `-v` value for a planner pair: the host source verbatim, the destination in
/// the container's spelling.
fn volume_arg(pair: &str, read_only: bool) -> String {
    let (src, dst) = split_mount_pair(pair);
    let dst = container_path(dst);
    if read_only {
        format!("{src}:{dst}:ro")
    } else {
        format!("{src}:{dst}")
    }
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
pub fn up(
    project_id: &str,
    spec: Option<&SandboxSpec>,
    project_dir: &str,
) -> Result<String, String> {
    let _guard = lifecycle_lock().lock().unwrap();
    preflight_docker()?;
    preflight_daemon()?;

    let name = container_name_for(project_id);
    let home = paths::home_dir_string();
    let (uid, gid) = host_uid_gid();
    let state_dir = storage::state_dir();
    let strict_trash = is_strict_trash_project(project_id);
    // A strict Trash container deliberately does not mount the host home. Give
    // its agents a writable container-only home instead of a dangling host path
    // so browser/device-flow logins and CLI caches remain usable without
    // exposing host-backed credentials or session files.
    let container_home = if strict_trash {
        "/tmp/eldrun-home".to_string()
    } else {
        home.clone()
    };
    let live_sessions = state_dir.join("live_sessions");
    // This project's own slice of the live-session records — the only one the
    // container gets to see (see `rw_mounts`).
    let live_sessions_own = crate::services::agent_session::project_live_sessions_dir(project_id);
    let hooks_dir = state_dir.join("hooks");
    // Ensure the hook's write target and the staging dir exist so their bind
    // mounts map real host paths rather than docker-auto-created (root-owned)
    // ones. Best effort.
    if !strict_trash {
        let _ = std::fs::create_dir_all(&live_sessions_own);
    }
    let stage = stage_dir(project_id);
    if !strict_trash {
        let _ = std::fs::create_dir_all(&stage);
    }

    // Refresh the staged config copies from the host originals at every up.
    // `fs::copy` overwrites in place (same inode), so a running container's
    // bind mounts see the refreshed content too.
    let (mut rw_mounts, mut ro_mounts) = if strict_trash {
        (Vec::new(), Vec::new())
    } else {
        agent_home_mounts(
            &home,
            &live_sessions_own.to_string_lossy(),
            &live_sessions.to_string_lossy(),
        )
    };
    if !strict_trash {
        rw_mounts.extend(
            staged_config_mounts(&home, &stage)
                .into_iter()
                .map(|(src, dst)| format!("{src}:{dst}")),
        );
        rw_mounts.extend(
            staged_claude_json_mounts(&home, &stage, &[project_dir.to_string()])
                .into_iter()
                .map(|(src, dst)| format!("{src}:{dst}")),
        );
        // The credential file is a mirror with a stable inode, not the host
        // original a rename would orphan under the container — see
        // `claude_credential_mounts`.
        rw_mounts.extend(
            claude_credential_mounts(&home)
                .into_iter()
                .map(|(src, dst)| format!("{src}:{dst}")),
        );
        ro_mounts.extend(ro_mounts_for_hooks(&hooks_dir));
    }
    let harden = harden_opts(spec);
    let image = image_for(project_id, spec);

    // The create argv (sans fingerprint label) is its own fingerprint input —
    // and deliberately WITHOUT the transcript mounts. That set changes whenever
    // *any* project gains a transcript dir, and a fingerprint mismatch means
    // `rm -f` + recreate: folding it in would let an unrelated project's agent
    // kill every live tab of this one. Mounts are fixed at create anyway, so a
    // session simply runs with the set it started with.
    let base = docker_create_args(
        &name,
        project_id,
        &image,
        &container_home,
        uid,
        gid,
        project_dir,
        &rw_mounts,
        &ro_mounts,
        &harden,
        None,
    );
    let fingerprint = spec_fingerprint(&base);

    let (tx_rw, tx_ro) = if strict_trash {
        (Vec::new(), Vec::new())
    } else {
        claude_transcript_mounts(
            &home,
            &[project_dir.to_string()],
            &claude_projects_stage(project_id),
        )
    };
    let rw_mounts: Vec<String> = rw_mounts.into_iter().chain(tx_rw).collect();
    let ro_mounts: Vec<String> = ro_mounts.into_iter().chain(tx_ro).collect();

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
        &container_home,
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
/// local project. `Ok(None)` when the toggle is off / the project is remote —
/// callers treat that as "nothing to do".
pub fn up_for_project(project_id: &str) -> Result<Option<String>, String> {
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

/// Tear down a project's session container (`rm -f` by name). Idempotent,
/// best-effort. Only spawns docker when this run actually created the container
/// or the toggle is currently on — a never-containerized project costs nothing.
pub fn down_for_project(project_id: &str) {
    if is_strict_trash_project(project_id) {
        return;
    }
    let name = container_name_for(project_id);
    let created = created_set().lock().unwrap().contains(&name);
    if !created && !sandbox_spec_for(project_id).is_some_and(|s| s.enabled) {
        return;
    }
    let _guard = lifecycle_lock().lock().unwrap();
    let _ = docker(&["rm", "-f", &name]);
    // The mounts are gone with the container: anything the session recorded for
    // a cwd that had no host dir at create time is in the stage now.
    harvest_project_transcripts(project_id);
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
    remove_all_owned_except_trash();
    harvest_all_transcripts();
    created_set().lock().unwrap().clear();
    exec_tabs().lock().unwrap().clear();
}

/// Startup, **before the window can spawn anything**: harvest the transcripts a
/// previous run left in the stage and clear the stage root.
///
/// A crashed run never got to harvest, so whatever its fenced/contained agents
/// recorded for a cwd that had no host transcript dir yet is still here — and
/// the resolver's session probe reads the host dir. This used to run on the
/// [`sweep_orphans`] thread, racing the restored tabs: a restore that probed
/// before the harvest landed saw no log and launched `--session-id <launch>`,
/// which Claude refuses once a log for that id exists ("already in use"), and
/// a fenced spawn that set its stage up before the wipe had it pulled out from
/// under its mount. Plain renames, so it is cheap enough to block on.
pub fn harvest_and_clear_stage() {
    let stage_root = storage::state_dir().join("sandbox-stage");
    harvest_all_transcripts();
    harvest_all_claude_trust();
    let _ = std::fs::remove_dir_all(&stage_root);
}

/// Startup sweep: remove every container labelled `eldrun.owner=eldrun` (a
/// previous run's containers are by definition stale). The staged config
/// copies are cleared by [`harvest_and_clear_stage`], which must have run first
/// and synchronously. Best-effort; cheap no-op when docker is absent.
pub fn sweep_orphans() {
    // Containers are Unix-only (`up_for_project` is a no-op and spawn refuses on
    // Windows), so a previous run can't have left one behind — don't spawn
    // `docker --version`/`docker ps` at every Windows startup for nothing.
    if !cfg!(unix) || preflight_docker().is_err() {
        return;
    }
    remove_all_owned_except_trash();
}

/// `docker rm -f` every container carrying our owner label. Best-effort.
/// Preserve the strict Trash container across Eldrun restarts: host tmux owns
/// mobile-reachable agents there, while Docker remains the filesystem boundary.
fn remove_all_owned_except_trash() {
    let _guard = lifecycle_lock().lock().unwrap();
    let Ok(out) = docker(&[
        "ps",
        "-aq",
        "--filter",
        &format!("label={OWNER_LABEL}"),
        "--filter",
        &format!("label=eldrun.project={}", paths::TRASH_PROJECT_ID),
    ]) else {
        return;
    };
    let preserve: HashSet<&str> = std::str::from_utf8(&out.stdout)
        .unwrap_or("")
        .split_whitespace()
        .collect();
    let Ok(out) = docker(&["ps", "-aq", "--filter", &format!("label={OWNER_LABEL}")]) else {
        return;
    };
    let ids: Vec<&str> = std::str::from_utf8(&out.stdout)
        .unwrap_or("")
        .split_whitespace()
        .filter(|id| !preserve.contains(*id))
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

/// Resolve a spec's `dockerfile` to an absolute path **inside** the project.
///
/// `docker build` runs the Dockerfile's `RUN` steps as **root** with default
/// capabilities and full network — a strictly larger blast radius than the session
/// container (`--user <uid>` / `--cap-drop ALL` / `no-new-privileges`). The value
/// was joined onto `project_dir` with no traversal check, so an absolute path or a
/// `../..` chain pointed the build at a file outside the project entirely. Refuse
/// both, then confine the canonicalized result against the project root so a
/// symlinked Dockerfile cannot smuggle the same escape.
fn resolve_spec_dockerfile(project_dir: &Path, df: &str) -> Result<PathBuf, String> {
    let rel = Path::new(df);
    if rel.is_absolute() || df.starts_with('/') || df.starts_with('\\') {
        return Err(format!(
            "Project container: Dockerfile '{df}' must be a path inside the project, not absolute."
        ));
    }
    if rel
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!(
            "Project container: Dockerfile '{df}' must not contain '..'."
        ));
    }
    let joined = project_dir.join(rel);
    // Canonicalize both sides so the prefix check compares resolved paths (the
    // Dockerfile must exist to be built, so canonicalization is expected to work).
    let root = project_dir
        .canonicalize()
        .unwrap_or_else(|_| project_dir.to_path_buf());
    let resolved = joined.canonicalize().map_err(|e| {
        format!(
            "Project container: Dockerfile '{}' is unreadable: {e}",
            joined.display()
        )
    })?;
    crate::commands::fs::enforce_confinement(&root, &resolved)
        .map_err(|e| format!("Project container: {e}"))?;
    Ok(resolved)
}

/// Docker networks a project spec may name.
///
/// `bridge`/`none` are the two meaningful built-ins; a user-created network is any
/// `[A-Za-z0-9_.-]+` name. **`host` is refused**: it removes network isolation
/// outright (the container shares the host's stack, reaching every loopback-bound
/// service), and the spec can be written by a compromised renderer or — before the
/// `project.json` fallback was removed — from inside the project tree. Docker's own
/// `container:<id>` and `ns:<path>` forms are refused for the same reason.
pub fn validate_network(net: &str) -> Result<(), String> {
    let net = net.trim();
    if net.is_empty() {
        return Err("Project container: network name cannot be empty.".to_string());
    }
    if net.eq_ignore_ascii_case("host") {
        return Err(
            "Project container: network 'host' is not allowed — it removes the container's \
             network isolation. Use 'bridge', 'none', or a custom docker network."
                .to_string(),
        );
    }
    if net
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        Ok(())
    } else {
        Err(format!(
            "Project container: '{net}' is not a valid docker network name."
        ))
    }
}

/// Make the image runnable: build it from the project's in-repo Dockerfile when
/// the spec says so, otherwise require it to already exist locally.
fn ensure_image(spec: Option<&SandboxSpec>, project_dir: &str, image: &str) -> Result<(), String> {
    if let Some(df) = spec.and_then(|s| s.dockerfile.as_deref()) {
        let df_path = resolve_spec_dockerfile(Path::new(project_dir), df)?;
        let df_path = df_path.as_path();
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
    match crate::paths::command_no_window("docker")
        .arg("--version")
        .output()
    {
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
        _ => Err(if cfg!(target_os = "linux") {
            "Project container: Docker isn't running. Start the Docker service (e.g. \
             `systemctl start docker`), or turn the container toggle off for this project."
                .to_string()
        } else {
            "Project container: Docker isn't running. Start Docker Desktop, or turn the \
             container toggle off for this project."
                .to_string()
        }),
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

/// The project id whose tabs at `project_dir` would run **inside a container** —
/// i.e. the id to run an in-container probe against, or `None` when a tab opened
/// there runs on the host.
///
/// The reverse lookup is `remote_target_for_dir`'s (an entry's stored
/// `extra["directory"]`, matched verbatim), because the callers that need this
/// are the same ones: they hold a `project_dir`, not an id.
///
/// Three conditions, and the third is the point: the toggle is on, the project is
/// local (a container never applies to a remote one), **and** the scope is
/// [`SandboxScope::All`]. Under `Agents` a shell tab — which is what the viewer's
/// Run/Debug is — spawns on the host, so probing the container would answer a
/// question about the wrong machine. The rule that decides where the tab runs is
/// therefore the same rule that decides where we look for its interpreter, rather
/// than two conditions that can drift apart.
pub fn containerized_project_for_dir(project_dir: &str) -> Option<String> {
    let list_path = storage::state_dir().join("projects.json");
    let list: crate::schema::projects::ProjectsList = storage::read_json(&list_path).ok()?;
    let entry = list.iter().find(|e| {
        e.extra
            .get("directory")
            .and_then(|v| v.as_str())
            .is_some_and(|d| d == project_dir)
    })?;
    if crate::services::remote::remote_target_for(&entry.id).is_some() {
        return None;
    }
    let spec = sandbox_spec_for(&entry.id)?;
    (spec.enabled && spec.scope == SandboxScope::All).then(|| entry.id.clone())
}

/// Run a **constant** POSIX-`sh` script inside a project's session container and
/// return its stdout — the `docker exec` twin of
/// `ssh_exec::run_remote_script`, and bound by the same contract: nothing may be
/// interpolated into `script`, because it is handed to `sh -c` verbatim.
///
/// Deliberately **does not `up()` the container.** This serves probes (which
/// interpreter is in there?), and a probe must not be able to pull a multi-second
/// image start into a dialog that is merely being opened — nor start a container
/// for a project the user is only inspecting. A container that is not running
/// answers `None`, and the caller falls back rather than waiting.
pub fn run_in_container(project_id: &str, cwd: &str, script: &str) -> Option<String> {
    let name = container_name_for(project_id);
    if !probe_container(&name).running {
        return None;
    }
    let out = docker(&["exec", "-w", cwd, &name, "sh", "-c", script]).ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn project_entry_value(project_id: &str, key: &str) -> Option<serde_json::Value> {
    let list_path = storage::state_dir().join("projects.json");
    let list: crate::schema::projects::ProjectsList = storage::read_json(&list_path).ok()?;
    let entry = list.iter().find(|e| e.id == project_id)?;
    entry.extra.get(key).cloned()
}

/// Detect in-repo container sources for a project: a root `Dockerfile` wins,
/// else a `.devcontainer/devcontainer.json` `image` field. Returns `None` when
/// neither is present. Pure detection — reports what the repo declares, never
/// applies it (O#143: `commands::projects::set_project_sandbox` is the only
/// caller allowed to write a detected source into a spec, and only after an
/// explicit user decision).
pub fn detect_spec_source(project_dir: &Path) -> Option<DetectedSpecSource> {
    if project_dir.join("Dockerfile").is_file() {
        // Reuse the traversal-safe resolver so a symlinked/escaping Dockerfile
        // is refused here too rather than only at build time.
        let path = resolve_spec_dockerfile(project_dir, "Dockerfile").ok()?;
        let bytes = std::fs::read(&path).ok()?;
        return Some(DetectedSpecSource {
            kind: DetectedSpecKind::Dockerfile,
            value: "Dockerfile".to_string(),
            hash: sha256_hex(&bytes),
        });
    }
    let devcontainer = project_dir.join(".devcontainer").join("devcontainer.json");
    let text = std::fs::read_to_string(&devcontainer).ok()?;
    // devcontainer.json is JSONC; strip line comments so serde can parse the
    // common case. (A devcontainer that only names a Dockerfile/compose setup
    // has no `image` and is simply not detected.)
    let stripped: String = text
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    let v: serde_json::Value = serde_json::from_str(&stripped).ok()?;
    let image = v
        .get("image")
        .and_then(|i| i.as_str())
        .filter(|s| !s.is_empty())?;
    Some(DetectedSpecSource {
        kind: DetectedSpecKind::DevcontainerImage,
        value: image.to_string(),
        hash: sha256_hex(image.as_bytes()),
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Test/back-compat shim over [`detect_spec_source`]: writes straight into a
/// `SandboxSpec` the way the pre-#143 auto-adopt path did. Production code
/// no longer calls this — `commands::projects::set_project_sandbox` calls
/// `detect_spec_source` directly and gates the write on a user decision.
#[cfg(test)]
fn detect_spec_sources(project_dir: &Path, spec: &mut SandboxSpec) {
    match detect_spec_source(project_dir) {
        Some(DetectedSpecSource {
            kind: DetectedSpecKind::Dockerfile,
            value,
            ..
        }) => spec.dockerfile = Some(value),
        Some(DetectedSpecSource {
            kind: DetectedSpecKind::DevcontainerImage,
            value,
            ..
        }) => spec.image = Some(value),
        None => {}
    }
}

// ── Mounts / identity (shared helpers) ────────────────────────────────────

/// Entries of `~/.claude` that are deliberately **not** mounted into a container.
///
/// The whole dir used to be one rw mount, which handed a contained agent several
/// routes straight back to **host** code execution and to every project's history:
/// - `shell-snapshots/` — Claude sources a snapshot for each host Bash call, so one
///   appended line runs on the host the next time an *uncontained* session does;
/// - `plugins/`, `agents/`, `skills/` — register hook commands / steer every future
///   session. `skills/` is the personal half of the Skills Library
///   (`docs/skills_plan.md`): a `SKILL.md` is instructions every project on this
///   machine lazily loads, and a skill folder may bundle a `scripts/` directory,
///   so a contained agent that could write here would be writing code and
///   standing orders for every *uncontained* session of every other project —
///   the `agents/` hole exactly, one directory over;
/// - `backups/`, `file-history/` — copies of the config the staged shadow protects,
///   and a rewrite target with the same effect;
/// - `history.jsonl`, `sessions/`, `session-env/`, `stats-cache.json`, `daemon.*` —
///   cross-project state a project container has no business reading or writing;
/// - `telemetry/` — likewise.
///
/// `settings.json`/`settings.local.json` are excluded here because
/// [`staged_config_mounts`] mounts a writable per-project **copy** at those exact
/// paths; mounting the originals as well would be a duplicate destination.
/// `projects` (the transcripts) is excluded for the same reason — it is mounted
/// explicitly, per entry, by [`claude_transcript_mounts`], because *this*
/// project's transcripts must be writable and every other project's must not.
///
/// A trailing `*` matches by prefix (`daemon*`), a leading one by suffix
/// (`*.sh`). Everything not listed is still mounted — deliberately: an unknown
/// new entry breaking resume is worse than an unknown new entry being reachable,
/// and the named holes are the exploitable ones.
const CLAUDE_UNMOUNTED: &[&str] = &[
    "shell-snapshots",
    "plugins",
    "agents",
    "skills",
    "backups",
    "file-history",
    "telemetry",
    "history.jsonl",
    "sessions",
    "session-env",
    "stats-cache.json",
    // `daemon*`, not `daemon.*`: the prefix used to end in a dot, so the
    // `daemon/` **directory** itself — the one holding the daemon's private
    // state — fell through the hole and was mounted read-write.
    "daemon*",
    "settings.json",
    "settings.local.json",
    // Same cross-project `projects` map (prompt history, `allowedTools`) that
    // `staged_claude_json_mounts` exists to stage a *filtered* copy of, plus the
    // `.bak`/`.backup.<ts>` siblings a restore reads back. Staged, not mounted.
    ".claude.json*",
    // Cross-session content with no part in resume: debug logs, feedback
    // drafts, the paste cache, and uploaded files — the same class as
    // `history.jsonl`, which has been denied here since the beginning.
    "debug",
    "feedback",
    "paste-cache",
    "uploads",
    CLAUDE_PROJECTS_ENTRY,
    // Owned by [`claude_credential_mounts`], like `settings.json` is by the
    // staged shadow: this destination gets an Eldrun-owned **mirror** file, not
    // the host original. Mounted as a file here it was a pin on one inode, and
    // Claude rotates the file by rename — every tab already running kept
    // reading the orphaned old inode and reported "Login expired" while a new
    // tab worked (`services::agent_creds` has the whole story).
    ".credentials.json",
];

/// Entries of `~/.claude`/`~/.codex` mounted **read-only** rather than left out:
/// the agent genuinely reads them, but a write must never reach the host.
///
/// - `*.sh` — the statusline/hook scripts an agent's own `settings.json` points
///   at. [`staged_config_mounts`] stops a contained agent *repointing* a hook;
///   it does nothing about rewriting the script already pointed at, which the
///   host's **uncontained** CLI then executes on its next launch. That is a
///   straight fence-to-host code-execution path.
/// - `*.md` — the user's global instructions (`~/.claude/CLAUDE.md`,
///   `~/.codex/AGENTS.md`, and whatever they import). A write there is a
///   standing prompt injection into every future uncontained session.
const AGENT_READ_ONLY: &[&str] = &["*.sh", "*.md"];

/// Entries of `~/.codex` that are not mounted. Much shorter than
/// [`CLAUDE_UNMOUNTED`] on purpose: both places Codex keeps a conversation
/// **must** stay mounted, because `agent_session::codex_session_exists` reads
/// them back to decide whether a tab can resume — unmounting either silently
/// kills Codex resume in every container:
///
/// - `sessions/`, the rollout logs releases up to 0.153.4 wrote;
/// - `state_<n>.sqlite` (and its `-wal`/`-shm` siblings), the thread store
///   0.153.4 writes instead. Nothing names these explicitly — they are simply
///   entries that no rule excludes, which is the point of keeping this list
///   short.
///
/// `config.toml` is the staged-shadow destination (see [`staged_config_mounts`]).
const CODEX_UNMOUNTED: &[&str] = &["history.jsonl", "config.toml"];

/// Whether a directory entry name matches one of a pattern list. A pattern
/// ending in `*` matches by prefix, one starting with `*` by suffix; everything
/// else is an exact match.
fn matches_entry(name: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|p| {
        if let Some(prefix) = p.strip_suffix('*') {
            name.starts_with(prefix)
        } else if let Some(suffix) = p.strip_prefix('*') {
            name.ends_with(suffix)
        } else {
            *p == name
        }
    })
}

/// Per-entry identical-path mounts for one agent state dir as `(rw, ro)`,
/// skipping the excluded entries. Mounting the children rather than the parent
/// is what makes the exclusion real: an unmounted child is simply not reachable,
/// and the container cannot create new top-level entries in the host's dir
/// either. Entries matching [`AGENT_READ_ONLY`] land in the `ro` half.
fn narrowed_agent_mounts(dir: &str, unmounted: &[&str]) -> (Vec<String>, Vec<String>) {
    let base = Path::new(dir);
    if !base.is_dir() {
        return (Vec::new(), Vec::new());
    }
    let Ok(entries) = std::fs::read_dir(base) else {
        return (Vec::new(), Vec::new());
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| !matches_entry(n, unmounted))
        .collect();
    // Deterministic order so the spec fingerprint doesn't flap with readdir order.
    names.sort();
    let (mut rw, mut ro) = (Vec::new(), Vec::new());
    for name in &names {
        let pair = format!("{dir}/{name}:{dir}/{name}");
        if matches_entry(name, AGENT_READ_ONLY) {
            ro.push(pair);
        } else {
            rw.push(pair);
        }
    }
    (rw, ro)
}

/// The agent auth/state mounts the resume machinery depends on, as
/// `(read-write, read-only)` `src:dst` pairs.
///
/// `~/.claude`/`~/.codex` are mounted **per entry** with an exclusion list rather
/// than wholesale (see [`CLAUDE_UNMOUNTED`]); entries matching
/// [`AGENT_READ_ONLY`] come back in the read-only half instead. Gemini creds are
/// mounted only when they exist so we never auto-create empty root-owned dirs in
/// `$HOME`.
///
/// `live_sessions_src` is this project's **own** subdirectory of
/// `<state_dir>/live_sessions`, mounted at `live_sessions_dst` — the canonical root
/// path the hook script writes to. This is the one deliberately non-identical
/// mount: the hook's target path is baked into a read-only script shared with
/// host-run agents, so per-project isolation has to come from *what* is mounted
/// there. With the shared root mounted, a contained agent could overwrite another
/// project's tab record and thereby choose which conversation an **uncontained**
/// agent resumes.
pub(crate) fn agent_home_mounts(
    home: &str,
    live_sessions_src: &str,
    live_sessions_dst: &str,
) -> (Vec<String>, Vec<String>) {
    let (mut rw, mut ro) = (Vec::new(), Vec::new());
    for (dir, unmounted) in [
        (format!("{home}/.claude"), CLAUDE_UNMOUNTED),
        (format!("{home}/.codex"), CODEX_UNMOUNTED),
    ] {
        let (entry_rw, entry_ro) = narrowed_agent_mounts(&dir, unmounted);
        rw.extend(entry_rw);
        ro.extend(entry_ro);
    }
    // The in-container SessionStart hook writes a tab's live id here.
    rw.push(format!("{live_sessions_src}:{live_sessions_dst}"));
    // Gemini credentials only — narrowed from the whole `~/.config` so unrelated
    // secrets (`gh`, `gcloud`, …) are never exposed to the container.
    for cand in [format!("{home}/.gemini"), format!("{home}/.config/gemini")] {
        if Path::new(&cand).is_dir() {
            rw.push(format!("{cand}:{cand}"));
        }
    }
    (rw, ro)
}

/// The Claude credential mount as `(src, dst)` pairs (the same pair shape as
/// [`staged_config_mounts`], for the same colon-in-a-Windows-path reason):
/// `<state_dir>/agent-creds/claude/.credentials.json` mounted at the real
/// `~/.claude/.credentials.json`. Empty when the host holds no credential file
/// — a logged-out host mounts nothing rather than an empty file the agent
/// would write its login into and lose with the tab.
///
/// Why a **mirror** rather than the host file: a file bind mount pins an
/// inode, and Claude Code rotates its credentials by writing a temp file and
/// renaming it over the original, so every tab bound before a rotation kept
/// reading the orphaned old record (stale token → failed refresh → "Login
/// expired") while a freshly opened tab followed the path and worked. The
/// mirror's inode never changes: `services::agent_creds` rewrites it *in
/// place* whenever the host file changes and carries a refresh a tab persisted
/// back the same way. Why not a symlink into the staging dir like the config
/// shadows: Claude opens this file with `O_NOFOLLOW` and refuses a link.
///
/// The mirror is brought up to date **here**, at plan time, so a tab spawned a
/// second after a rotation starts with the token the host has now rather than
/// the one the keeper's last tick saw.
///
/// Linux only. Everywhere else the pair is the real path twice, which is
/// exactly what it was: on macOS Seatbelt can deny but not substitute,
/// `sandbox_exec_inputs` only reads the `dst` off this list to keep it
/// writable, and the real file is what the agent opens there; Windows fences
/// nothing and refuses the container. Neither creates a mirror — a second copy
/// of a secret nobody mounts. If the mirror cannot be written on Linux (an
/// unwritable state dir) the same identical-path mount is the fallback: a tab
/// that logs in and later expires beats a tab that cannot log in at all, and
/// the fallback is logged.
pub(crate) fn claude_credential_mounts(home: &str) -> Vec<(String, String)> {
    claude_credential_mounts_in(home, &crate::services::agent_creds::mirror_path())
}

/// [`claude_credential_mounts`] with the mirror location injected (tests).
pub(crate) fn claude_credential_mounts_in(home: &str, mirror: &Path) -> Vec<(String, String)> {
    let host = crate::services::agent_creds::host_path(Path::new(home));
    if !host.is_file() {
        return Vec::new();
    }
    let dst = host.to_string_lossy().into_owned();
    if !cfg!(target_os = "linux") {
        return vec![(dst.clone(), dst)];
    }
    match crate::services::agent_creds::ensure_mirror_current(&host, mirror) {
        Some(mirror) => vec![(mirror.to_string_lossy().into_owned(), dst)],
        None => {
            eprintln!(
                "agent_creds: mirror {} unavailable; mounting the host file itself",
                mirror.display()
            );
            vec![(dst.clone(), dst)]
        }
    }
}

// ── Claude transcripts: read every project, write only our own ────────────

/// The `~/.claude` entry holding **transcripts**
/// (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`). Kept out of the
/// [`CLAUDE_UNMOUNTED`] denylist's mounted-by-default set and mounted explicitly
/// instead — see [`claude_transcript_mounts`].
const CLAUDE_PROJECTS_ENTRY: &str = "projects";

/// How many transcript files / how many of each file's leading lines are read
/// when asking a transcript dir which cwd it belongs to. Bounded because this
/// runs for every dir at every container create, and a single transcript line
/// can carry a large tool result.
const TRANSCRIPT_PROBE_FILES: usize = 3;
const TRANSCRIPT_PROBE_LINES: usize = 32;

/// This project's stand-in for `~/.claude/projects` inside the container:
/// `<state_dir>/sandbox-stage/<project>/claude-projects`.
///
/// It is the mount *parent*, so a transcript dir the container creates for a cwd
/// nobody knew about at create time (a subdir tab, a fresh worktree) lands in a
/// real host directory instead of the container's throwaway layer — teardown
/// harvests it into `~/.claude/projects` (see [`harvest_claude_transcripts`]).
pub(crate) fn claude_projects_stage(project_id: &str) -> PathBuf {
    stage_dir(project_id).join("claude-projects")
}

/// The absolute cwd a transcript dir's sessions were recorded in, read out of a
/// transcript rather than decoded from the directory name.
///
/// The name is Claude's own encoding of the cwd and it is **lossy** — both `/`
/// and `.` become `-`, so `…-KeyboardLayouts-modular-panel` is either a
/// subdirectory `panel/` of the `modular` project or the *sibling* project
/// `modular-panel`, and nothing in the name says which. The transcript itself
/// carries the real `cwd`, so that is what decides.
fn transcript_cwd(dir: &Path) -> Option<String> {
    use std::io::BufRead as _;
    let entries = std::fs::read_dir(dir).ok()?;
    let mut logs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    logs.sort();
    for log in logs.iter().take(TRANSCRIPT_PROBE_FILES) {
        let Ok(file) = std::fs::File::open(log) else {
            continue;
        };
        for line in std::io::BufReader::new(file)
            .lines()
            .take(TRANSCRIPT_PROBE_LINES)
            .map_while(Result::ok)
        {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if let Some(cwd) = v.get("cwd").and_then(serde_json::Value::as_str) {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

/// Whether a recorded cwd is the project dir or something inside it. Compared
/// **component-wise** (`Path::starts_with`), so a sibling `…/proj2` is not read
/// as being inside `…/proj`.
fn cwd_is_within(cwd: &str, project_dir: &str) -> bool {
    Path::new(cwd).starts_with(Path::new(project_dir))
}

/// Name-only fallback for a transcript dir with no readable `cwd` (empty, or
/// a truncated log): Claude's encoding applied to the project dir, matched at a
/// `-` boundary. Lossy by construction (see [`transcript_cwd`]) — used only when
/// there is no transcript to ask, where the stake is a dir holding nothing.
fn transcript_name_matches(name: &str, project_dir: &str) -> bool {
    let encoded: String = project_dir
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == '.' {
                '-'
            } else {
                c
            }
        })
        .collect();
    name == encoded
        || name
            .strip_prefix(&encoded)
            .is_some_and(|rest| rest.starts_with('-'))
}

/// The `~/.claude/projects` mounts as `(rw, ro)` `src:dst` pairs — **an explicit
/// entry per transcript directory**, never one mount of the parent.
///
/// The policy, which the mount list states rather than implies:
/// - the per-project **stage** dir is mounted rw *at* `~/.claude/projects`, so it
///   is the parent every nested mount lands in and the only place a *new*
///   transcript dir can be created;
/// - every transcript dir belonging to **this** project is nested **rw** — a
///   containerized session has to append to its own log, and `--resume` has to
///   find it there next time;
/// - every **other** project's transcript dir is nested **`:ro`** — readable
///   (an agent may look at what was done elsewhere) but not writable, because a
///   rewritten transcript is a message an *uncontained* future session will read
///   back as its own history.
///
/// The whole dir used to be one rw mount, which made every project's history
/// rewritable from inside any container.
pub(crate) fn claude_transcript_mounts(
    home: &str,
    roots: &[String],
    stage: &Path,
) -> (Vec<String>, Vec<String>) {
    let dest_root = format!("{home}/.claude/{CLAUDE_PROJECTS_ENTRY}");
    // Created by us so the mount maps a real user-owned dir rather than a
    // docker-auto-created root-owned one (the container runs as --user uid:gid).
    let _ = std::fs::create_dir_all(stage);
    let mut rw = vec![format!("{}:{dest_root}", stage.to_string_lossy())];
    let mut ro = Vec::new();

    let real_root = Path::new(home).join(".claude").join(CLAUDE_PROJECTS_ENTRY);
    let Ok(entries) = std::fs::read_dir(&real_root) else {
        return (rw, ro);
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    // Deterministic order so the mount list doesn't flap with readdir order.
    names.sort();

    for name in names {
        let src = real_root.join(&name);
        // Pre-create the nested mountpoint inside the stage for the same
        // ownership reason as the stage itself.
        let _ = std::fs::create_dir_all(stage.join(&name));
        let pair = format!("{}:{dest_root}/{name}", src.to_string_lossy());
        let ours = match transcript_cwd(&src) {
            Some(cwd) => roots.iter().any(|root| cwd_is_within(&cwd, root)),
            None => roots
                .iter()
                .any(|root| transcript_name_matches(&name, root)),
        };
        if ours {
            rw.push(pair);
        } else {
            ro.push(pair);
        }
    }
    (rw, ro)
}

/// Move transcript dirs the container created in `stage` into the host's real
/// `~/.claude/projects`, so a session opened in a cwd that had no dir at create
/// time is still resumable (and still visible to `claude_session_exists`, which
/// scans the real dir) after teardown.
///
/// A dir that *was* mounted leaves an empty mountpoint behind, so "has anything
/// in it" is exactly the test for "the container made this". Never overwrites a
/// host file: same-named entries are left alone.
fn harvest_claude_transcripts(stage: &Path, real_root: &Path) {
    let Ok(entries) = std::fs::read_dir(stage) else {
        return;
    };
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_dir() {
            continue;
        }
        let empty = std::fs::read_dir(&src)
            .map(|mut d| d.next().is_none())
            .unwrap_or(true);
        if empty {
            let _ = std::fs::remove_dir(&src);
            continue;
        }
        let Some(name) = src.file_name() else {
            continue;
        };
        let dest = real_root.join(name);
        let _ = std::fs::create_dir_all(real_root);
        if !dest.exists() && std::fs::rename(&src, &dest).is_ok() {
            continue;
        }
        // The host already has that dir (or the rename crossed a filesystem):
        // move over only the files it doesn't have.
        let _ = std::fs::create_dir_all(&dest);
        if let Ok(files) = std::fs::read_dir(&src) {
            for file in files.flatten() {
                let target = dest.join(file.file_name());
                if target.exists() {
                    continue;
                }
                if std::fs::rename(file.path(), &target).is_err() {
                    let _ = std::fs::copy(file.path(), &target);
                }
            }
        }
        let _ = std::fs::remove_dir_all(&src);
    }
}

/// [`harvest_claude_transcripts`] for one project's stage.
pub(crate) fn harvest_project_transcripts(project_id: &str) {
    let real = paths::home_dir()
        .join(".claude")
        .join(CLAUDE_PROJECTS_ENTRY);
    harvest_claude_transcripts(&claude_projects_stage(project_id), &real);
}

/// [`harvest_claude_transcripts`] for every staged project — app exit, and the
/// startup sweep (where it is a previous *crashed* run's harvest, and so must
/// run before the stage root is cleared).
fn harvest_all_transcripts() {
    let real = paths::home_dir()
        .join(".claude")
        .join(CLAUDE_PROJECTS_ENTRY);
    let Ok(entries) = std::fs::read_dir(storage::state_dir().join("sandbox-stage")) else {
        return;
    };
    for entry in entries.flatten() {
        harvest_claude_transcripts(&entry.path().join("claude-projects"), &real);
    }
}

/// Read-only identical-path mounts: just the hook *script* dir, which is shared
/// with host-run agents and so must be immutable from inside the container (see
/// the module doc). Mounted only when it exists on the host.
pub(crate) fn ro_mounts_for_hooks(hooks_dir: &Path) -> Vec<String> {
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
pub(crate) fn stage_dir(project_id: &str) -> PathBuf {
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
///
/// The shadow is **unconditional**: a host file that does not exist yet is staged
/// as an empty default instead of being skipped. Skipping it was the hole the
/// shadow exists to close — with no mount at that path, the container's write went
/// *through* to the real host `~/.claude/settings.local.json` (or
/// `~/.codex/config.toml`), which is exactly the "repoint the host's SessionStart
/// hook at an attacker command" escape. Installs where the file simply hadn't been
/// created yet were therefore unprotected.
///
/// Returned as `(copy on host, original path)` **pairs**, not pre-joined
/// `src:dst` strings: a host path is not colon-free on every platform (a
/// Windows drive letter carries one), so joining here would hand the caller a
/// string it cannot split back apart unambiguously. The bubblewrap fence takes
/// the same pairs but symlinks rather than mounts them — see
/// [`crate::services::agent_fence::STAGE_MOUNT`] for why a mounted file cannot
/// be replaced by the rename every one of these agents writes with.
pub(crate) fn staged_config_mounts(home: &str, stage: &Path) -> Vec<(String, String)> {
    let home = Path::new(home);
    let mut mounts = Vec::new();
    for rel in [
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".codex/config.toml",
    ] {
        // Native separators: the container path is the host original's own path.
        let src_path = rel
            .split('/')
            .fold(home.to_path_buf(), |p, seg| p.join(seg));
        // Flatten the host path to a unique leaf so the three files never collide.
        let src = src_path.to_string_lossy().into_owned();
        let leaf = src
            .trim_start_matches(['/', '\\'])
            .replace(['/', '\\', ':'], "_");
        let dst = stage.join(&leaf);
        // The outgoing shadow, read before it is overwritten: the folder-trust
        // answers below are carried across from it.
        let previous = if rel == ".codex/config.toml" {
            std::fs::read_to_string(&dst).ok()
        } else {
            None
        };
        let staged = if src_path.is_file() {
            std::fs::copy(&src_path, &dst).is_ok()
        } else {
            // No host original: stage an empty default so the container still gets
            // a real, writable file at that path — and its writes stay in the
            // throwaway copy rather than creating the host's.
            std::fs::write(&dst, default_agent_config(rel)).is_ok()
        };
        if staged {
            #[cfg(windows)]
            rewrite_hook_for_container(&dst);
            // `previous` is `Some` only for the Codex config (above).
            if let Some(prev) = &previous {
                carry_codex_project_trust(&dst, prev);
            }
            mounts.push((dst.to_string_lossy().into_owned(), src));
        }
    }
    mounts
}

/// Carry the `[projects."…"]` tables of the outgoing Codex config shadow into
/// the freshly staged one.
///
/// Codex asks whether it may work in a folder and records the answer as
/// `[projects."<path>"] trust_level = "trusted"` in `~/.codex/config.toml`. In a
/// fenced tab that file is a throwaway copy of the host original (the whole
/// point — an agent must not be able to repoint the host's SessionStart hook),
/// and re-copying it at every spawn threw the answer away with it: the user was
/// asked about the same project root on every single Eldrun restart.
///
/// So the shadow keeps the answers the *user* gave inside it, and nothing else:
/// the rest of the file is still the host original, so an edit the user makes
/// to their real config (model, MCP servers, approval policy) reaches the next
/// fenced tab as before, and nothing here is ever written back to the host. A
/// table the host original already declares wins — that is the user's own
/// answer, on the file they can actually see.
///
/// The blast radius of an agent forging a trust entry is one Eldrun project's
/// fenced tabs, whose writable roots the fence pins independently.
fn carry_codex_project_trust(staged: &Path, previous: &str) {
    let Ok(fresh) = std::fs::read_to_string(staged) else {
        return;
    };
    fn header_of(block: &str) -> &str {
        block.lines().next().unwrap_or_default().trim()
    }
    let have: Vec<&str> = toml_tables(&fresh, "[projects.")
        .into_iter()
        .map(header_of)
        .collect();
    let carried: Vec<&str> = toml_tables(previous, "[projects.")
        .into_iter()
        .filter(|block| !have.contains(&header_of(block)))
        .collect();
    if carried.is_empty() {
        return;
    }
    let mut out = fresh;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    for block in carried {
        out.push('\n');
        out.push_str(block.trim_end());
        out.push('\n');
    }
    let _ = std::fs::write(staged, out);
}

/// The top-level TOML tables of `text` whose header line starts with `prefix`,
/// each returned with its body down to the next table header.
///
/// A line scanner rather than a parser: these files are written by Codex itself
/// and by us, the answer only has to be exact for machine-written tables, and a
/// dependency-free scan cannot reformat a config we hand back to an agent.
fn toml_tables<'a>(text: &'a str, prefix: &str) -> Vec<&'a str> {
    let mut blocks = Vec::new();
    let mut start: Option<usize> = None;
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            if let Some(from) = start.take() {
                blocks.push(&text[from..offset]);
            }
            if trimmed.starts_with(prefix) {
                start = Some(offset);
            }
        }
        offset += line.len();
    }
    if let Some(from) = start {
        blocks.push(&text[from..]);
    }
    blocks
}

/// Windows: point a staged config copy's SessionStart hook at the POSIX twin.
///
/// The host registers a PowerShell hook (`eldrun_session_start.ps1`), which a
/// Linux container cannot run — the record that lets a tab resume its session
/// would simply never be written. `agent_session` also writes the POSIX body
/// beside it (with the *container-side* live-sessions path baked in), and this
/// swaps the command in the copy — never the host original — so the same
/// hook contract holds inside the container. Both serializations are covered:
/// Claude's JSON (serde-escaped string) and Codex's TOML (literal string).
#[cfg(windows)]
fn rewrite_hook_for_container(staged: &Path) {
    let Ok(text) = std::fs::read_to_string(staged) else {
        return;
    };
    let host_cmd = crate::services::agent_session::hook_command();
    let container_cmd = crate::services::agent_session::container_hook_command();
    let rewritten = if staged.extension().and_then(|e| e.to_str()) == Some("json") {
        let (Ok(from), Ok(to)) = (
            serde_json::to_string(&host_cmd),
            serde_json::to_string(&container_cmd),
        ) else {
            return;
        };
        text.replace(&from, &to)
    } else {
        text.replace(&format!("'{host_cmd}'"), &format!("'{container_cmd}'"))
    };
    if rewritten != text {
        let _ = std::fs::write(staged, rewritten);
    }
}

/// Stage the `.claude.json` files and mount each copy at its real path.
///
/// This top-level file is Claude's identity and onboarding state: without it a
/// fenced/contained tab looks like a fresh install and demands login **every
/// tab**, even though `.credentials.json` itself is mounted. It is also
/// cross-project state — a `projects` map keyed by cwd holding every project's
/// prompt history and `allowedTools` — so neither hiding it nor mounting the
/// host original writable is acceptable: the former breaks login, the latter
/// would let a boxed agent read every project's history and write standing
/// permissions for *uncontained* sessions of other projects (the same class of
/// hole as [`CLAUDE_UNMOUNTED`]'s `plugins`/`agents`).
///
/// So: a per-project **copy**, with the `projects` map filtered to entries at
/// or under this box's own `roots`. Login and onboarding survive, foreign
/// history stays invisible, and writes die with the stage. Refreshed in place
/// at every up, like [`staged_config_mounts`]. A missing or unparsable host
/// file stages `{}` (fresh-install behavior, which is then accurate).
///
/// Two locations, because the file has moved between CLI versions:
/// `$HOME/.claude.json` (staged unconditionally — a write must never create the
/// host's) and `$HOME/.claude/.claude.json` (staged only when the host has it,
/// so a version that does not use it is not handed a spurious fresh-install
/// marker). `.claude.json*` is in [`CLAUDE_UNMOUNTED`] so the second one is
/// never mounted raw alongside its own filtered stage.
pub(crate) fn staged_claude_json_mounts(
    home: &str,
    stage: &Path,
    roots: &[String],
) -> Vec<(String, String)> {
    let home = Path::new(home);
    let nested = home.join(".claude").join(".claude.json");
    let mut out = Vec::new();
    out.extend(staged_claude_json_copy(&home.join(".claude.json"), stage, roots));
    if nested.is_file() {
        out.extend(staged_claude_json_copy(&nested, stage, roots));
    }
    out
}

/// One `.claude.json` staged copy: read, filter the `projects` map to `roots`,
/// write into `stage`, and return the `(copy, original path)` pair.
fn staged_claude_json_copy(
    src_path: &Path,
    stage: &Path,
    roots: &[String],
) -> Option<(String, String)> {
    let src = src_path.to_string_lossy().into_owned();
    let leaf = src
        .trim_start_matches(['/', '\\'])
        .replace(['/', '\\', ':'], "_");
    let dst = stage.join(&leaf);
    // The refresh below overwrites whatever the last tab left here, so take the
    // trust answers out of it first — see [`agent_trust_path`] for why they
    // cannot simply stay in the stage.
    harvest_claude_trust_file(&dst);
    let mut value: serde_json::Value = std::fs::read(src_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(projects) = value.get_mut("projects").and_then(|v| v.as_object_mut()) {
        projects.retain(|cwd, _| {
            roots
                .iter()
                .any(|root| Path::new(cwd).starts_with(root))
        });
    }
    apply_recorded_trust(&mut value, roots);
    let body = serde_json::to_vec(&value).ok()?;
    std::fs::write(&dst, body).ok()?;
    Some((dst.to_string_lossy().into_owned(), src))
}

// ── Trust the user granted from inside the fence ──────────────────────────

/// `<state_dir>/agent_trust.json` — the folders the user answered Claude's
/// "Is this a project you created or one you trust?" dialog for while inside a
/// fenced or contained tab.
///
/// Claude records that answer in `~/.claude.json`, which such a tab only ever
/// sees as the stage copy above — and that copy is rewritten from the host file
/// at **every** spawn, so the answer was gone before the next tab started and
/// the dialog came back every single time. Worse, the tab could not even be
/// used to answer it: Eldrun types an agent's `/rename` line and then a bare
/// Enter, which confirmed the dialog's default row, `No, exit`. The tab died
/// on launch and nothing could ever trust the folder.
///
/// So Eldrun remembers the answer in its OWN state and re-applies it to each
/// staged copy. The host `~/.claude.json` is never written — that is the rule
/// this whole shadow exists to keep (`AGENTS.md`: Eldrun must never manipulate
/// another application's config).
fn agent_trust_path() -> PathBuf {
    storage::state_dir().join("agent_trust.json")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AgentTrust {
    /// Absolute working directories accepted for Claude, in the order seen.
    #[serde(default)]
    claude: Vec<String>,
}

fn read_agent_trust() -> AgentTrust {
    storage::read_json(&agent_trust_path()).unwrap_or_default()
}

/// Record `paths` as Claude-trusted. Recording is deliberately *not* bounded to
/// any root — a fenced agent writes its stage copy freely, so a bound here
/// would be a bound on attacker-controlled input rather than on effect. The
/// bound that matters is applied at injection time
/// ([`apply_recorded_trust`]), where only paths inside the spawning tab's own
/// roots are ever re-applied.
fn record_claude_trust(paths: &[String]) {
    if paths.is_empty() {
        return;
    }
    let _ = storage::patch_json(&agent_trust_path(), AgentTrust::default(), |trust| {
        for path in paths {
            if !trust.claude.iter().any(|known| known == path) {
                trust.claude.push(path.clone());
            }
        }
        Ok(())
    });
}

/// The `projects` keys of a `.claude.json`-shaped value whose trust dialog has
/// been accepted. Absolute paths only, so a relative or empty key recorded by
/// anything cannot become a prefix-free entry in Eldrun's store.
fn accepted_trust_paths(value: &serde_json::Value) -> Vec<String> {
    let Some(projects) = value.get("projects").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    projects
        .iter()
        .filter(|(cwd, entry)| {
            Path::new(cwd).is_absolute()
                && entry
                    .get("hasTrustDialogAccepted")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
        })
        .map(|(cwd, _)| cwd.clone())
        .collect()
}

/// Take the trust answers out of one staged `.claude.json` copy before it is
/// overwritten or deleted. No-op for a missing or unparsable file.
fn harvest_claude_trust_file(staged: &Path) {
    let Ok(bytes) = std::fs::read(staged) else {
        return;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return;
    };
    record_claude_trust(&accepted_trust_paths(&value));
}

/// Startup counterpart to [`harvest_claude_trust_file`]: every stage dir's
/// staged `.claude.json` copies, harvested before the stage root is cleared.
/// A clean quit leaves the last tab's answer in the stage, so without this it
/// would be wiped by the very next launch.
fn harvest_all_claude_trust() {
    let Ok(stages) = std::fs::read_dir(storage::state_dir().join("sandbox-stage")) else {
        return;
    };
    for stage in stages.flatten() {
        let Ok(files) = std::fs::read_dir(stage.path()) else {
            continue;
        };
        for file in files.flatten() {
            // `settings.json` / `config.toml` shadows share this directory; only
            // the `.claude.json` copies (`<escaped host path>` + that suffix)
            // carry a `projects` map.
            if file.file_name().to_string_lossy().ends_with(".claude.json") {
                harvest_claude_trust_file(&file.path());
            }
        }
    }
}

/// Re-apply the recorded trust for paths inside `roots` to a staged copy, so a
/// folder the user has already accepted is not asked about again in every new
/// tab. Only the flag is set: history and `allowedTools` stay filtered out, and
/// an entry the host file does not have is created holding nothing else.
fn apply_recorded_trust(value: &mut serde_json::Value, roots: &[String]) {
    apply_trust_paths(value, &read_agent_trust().claude, roots);
}

/// Pure core of [`apply_recorded_trust`], so the root bound is unit-testable
/// without a state directory (`ELDRUN_STATE_DIR` is process-wide and this suite
/// runs in parallel).
fn apply_trust_paths(value: &mut serde_json::Value, trusted: &[String], roots: &[String]) {
    let recorded: Vec<&String> = trusted
        .iter()
        .filter(|cwd| roots.iter().any(|root| Path::new(cwd).starts_with(root)))
        .collect();
    if recorded.is_empty() {
        return;
    }
    let Some(root_obj) = value.as_object_mut() else {
        return;
    };
    let projects = root_obj
        .entry("projects")
        .or_insert_with(|| serde_json::json!({}));
    if !projects.is_object() {
        *projects = serde_json::json!({});
    }
    let Some(projects) = projects.as_object_mut() else {
        return;
    };
    for cwd in recorded {
        let entry = projects
            .entry(cwd.clone())
            .or_insert_with(|| serde_json::json!({}));
        if let Some(obj) = entry.as_object_mut() {
            obj.insert(
                "hasTrustDialogAccepted".to_string(),
                serde_json::Value::Bool(true),
            );
        }
    }
}

/// Whether Claude will skip its trust dialog in `cwd`: the host `~/.claude.json`
/// already records the answer, or Eldrun recorded one the user gave inside a
/// fenced/contained tab. Read-only.
///
/// The caller is the frontend's auto-`/rename`, which must not type a blind
/// Enter into a launch that is about to ask a question — the default answer is
/// `No, exit`.
pub fn claude_folder_trusted(cwd: &str) -> bool {
    let home = paths::home_dir();
    for candidate in [
        home.join(".claude.json"),
        home.join(".claude").join(".claude.json"),
    ] {
        let Ok(bytes) = std::fs::read(&candidate) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        if value
            .get("projects")
            .and_then(|projects| projects.get(cwd))
            .and_then(|entry| entry.get("hasTrustDialogAccepted"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            return true;
        }
    }
    read_agent_trust().claude.iter().any(|path| path == cwd)
}

/// Placeholder content for a shadowed agent-config file the host does not have
/// yet: a JSON file needs to parse, a TOML file may be empty.
fn default_agent_config(rel: &str) -> &'static [u8] {
    if rel.ends_with(".json") {
        b"{}\n"
    } else {
        b""
    }
}

/// Build the runtime hardening flags from a project's spec, applying built-in
/// defaults (always-on `--pids-limit`; other caps opt-in).
fn harden_opts(spec: Option<&SandboxSpec>) -> HardenOpts {
    HardenOpts {
        pids_limit: spec
            .and_then(|s| s.pids_limit)
            .unwrap_or(DEFAULT_PIDS_LIMIT),
        memory: spec.and_then(|s| s.memory.clone()),
        cpus: spec.and_then(|s| s.cpus.clone()),
        // A rejected network falls back to docker's default bridge rather than
        // failing the spawn: dropping it is the fail-CLOSED direction (the value
        // being refused is one that would *remove* isolation), and the loud
        // rejection lives at the point the spec is written
        // (`commands::projects::set_project_sandbox_spec`).
        network: spec
            .and_then(|s| s.network.clone())
            .filter(|n| match validate_network(n) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("sandbox: ignoring spec network '{n}': {e}");
                    false
                }
            }),
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

    // ── Host → container paths ────────────────────────────────────────────

    #[test]
    fn windows_host_paths_take_docker_desktops_spelling() {
        assert_eq!(container_path_for(r"C:\Users\a\p", true), "/c/Users/a/p");
        assert_eq!(container_path_for(r"D:\", true), "/d");
        assert_eq!(container_path_for("C:/Users/a", true), "/c/Users/a");
        assert_eq!(container_path_for(r"\\srv\share\x", true), "/srv/share/x");
        // Unix hosts are identical-path.
        assert_eq!(container_path_for("/home/a/p", false), "/home/a/p");
        assert_eq!(container_path_for(r"C:\odd", false), r"C:\odd");
    }

    #[test]
    fn mount_pairs_split_around_drive_colons() {
        assert_eq!(split_mount_pair("/a/b:/a/b"), ("/a/b", "/a/b"));
        assert_eq!(
            split_mount_pair(r"C:\Users\a\.claude:C:\Users\a\.claude"),
            (r"C:\Users\a\.claude", r"C:\Users\a\.claude")
        );
        // A staged copy under the state dir mounted over a home path.
        assert_eq!(
            split_mount_pair(r"C:\state\stage\x.json:C:\Users\a\.claude\settings.json"),
            (r"C:\state\stage\x.json", r"C:\Users\a\.claude\settings.json")
        );
        // Already-translated destination.
        assert_eq!(
            split_mount_pair(r"C:\Users\a\p:/c/Users/a/p"),
            (r"C:\Users\a\p", "/c/Users/a/p")
        );
    }

    #[test]
    fn create_argv_without_a_host_identity_omits_user() {
        let out = docker_create_args(
            "eldrun-p1",
            "p1",
            "img:latest",
            "/home/alice",
            0,
            0,
            "/home/alice/eldrun/projects/p1",
            &rw("/home/alice"),
            &ro(),
            &HardenOpts::default(),
            None,
        );
        assert!(!out.contains(&"--user".to_string()));
        assert!(has_flag_value(&out, "--cap-drop", "ALL"), "hardening stays");
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
        assert_ne!(
            a,
            spec_fingerprint(&other),
            "image change must change the hash"
        );

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
        assert!(has_flag_value(
            &out,
            "--label",
            "eldrun.spec=deadbeef00000000"
        ));
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
        assert_eq!(
            labeled.len(),
            bare.len() + 2,
            "fingerprint adds exactly --label + value"
        );
        assert!(has_flag_value(
            &labeled,
            "--label",
            "eldrun.spec=feedface00000000"
        ));
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
            "eldrun-p1",
            "p1",
            "img",
            "/h",
            1,
            1,
            "/p",
            &[],
            &[],
            &harden,
            None,
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
        assert!(has_flag_value(
            &out,
            "-w",
            "/home/alice/eldrun/projects/p1/sub"
        ));
        assert!(has_flag_value(&out, "-e", "TERM=xterm-256color"));
        assert!(has_flag_value(&out, "-e", "ELDRUN_TAB_UID=tab-1"));
        // Auth env rides at exec (rotated tokens per spawn), before the name.
        assert!(has_flag_value(&out, "-e", "ANTHROPIC_API_KEY=sk-test"));
        let key = out
            .iter()
            .position(|s| s == "ANTHROPIC_API_KEY=sk-test")
            .unwrap();
        let name = pos(&out, "eldrun-p1").unwrap();
        assert!(key < name, "env must precede the container name");
        // Kill-wrapper shape: name, sh -c '<pidfile script>' sh <cmd> <args…>.
        assert_eq!(out[name + 1], "sh");
        assert_eq!(out[name + 2], "-c");
        assert_eq!(
            out[name + 3],
            "echo $$ > /tmp/eldrun-tab-t1-0.pid; exec \"$@\""
        );
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

    /// The user answers Codex's "may I work in this folder?" inside a fenced
    /// tab; the next spawn re-copies the host original over the shadow. Without
    /// the carry-over that answer is gone and the question comes back on every
    /// Eldrun restart.
    #[test]
    fn staged_codex_config_keeps_the_folder_trust_answered_in_the_fence() {
        let base = std::env::temp_dir().join(format!("eldrun-sbx-trust-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let stage = base.join("stage");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(&stage).unwrap();
        let host = home.join(".codex").join("config.toml");
        std::fs::write(&host, "[projects.\"/home/u\"]\ntrust_level = \"trusted\"\n").unwrap();
        let home_str = home.to_string_lossy().into_owned();

        let shadow = PathBuf::from(
            staged_config_mounts(&home_str, &stage)
                .into_iter()
                .find(|(_, original)| original.ends_with("config.toml"))
                .unwrap()
                .0,
        );
        // Codex records the answer in the shadow, and the user edits the *host*
        // config meanwhile — both have to survive the next spawn.
        std::fs::write(
            &shadow,
            std::fs::read_to_string(&shadow).unwrap()
                + "\n[projects.\"/home/u/work/p\"]\ntrust_level = \"trusted\"\n",
        )
        .unwrap();
        std::fs::write(
            &host,
            "model = \"gpt-5-codex\"\n\n[projects.\"/home/u\"]\ntrust_level = \"trusted\"\n",
        )
        .unwrap();

        staged_config_mounts(&home_str, &stage);
        let after = std::fs::read_to_string(&shadow).unwrap();
        assert!(
            after.contains("[projects.\"/home/u/work/p\"]"),
            "the answer given in the fence must survive a restage: {after}"
        );
        assert!(
            after.contains("model = \"gpt-5-codex\""),
            "the host original must still reach the fence: {after}"
        );
        assert_eq!(
            after.matches("[projects.\"/home/u\"]").count(),
            1,
            "a table the host already declares must not be duplicated: {after}"
        );
        // Nothing is ever written back to the host.
        assert!(!std::fs::read_to_string(&host)
            .unwrap()
            .contains("/home/u/work/p"));

        // A third pass is a no-op, not a growing pile of repeated tables.
        staged_config_mounts(&home_str, &stage);
        let third = std::fs::read_to_string(&shadow).unwrap();
        assert_eq!(third, after, "restaging must be idempotent");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn toml_tables_reads_whole_tables_and_stops_at_the_next_header() {
        let text = "model = \"m\"\n\n[projects.\"/a\"]\ntrust_level = \"trusted\"\n\n\
                    [[hooks.SessionStart]]\nmatcher = \"startup\"\n\n[projects.\"/b\"]\nx = 1\n";
        let blocks = toml_tables(text, "[projects.");
        assert_eq!(blocks.len(), 2, "{blocks:?}");
        assert!(blocks[0].contains("trust_level"));
        assert!(!blocks[0].contains("hooks.SessionStart"));
        assert!(blocks[1].trim_end().ends_with("x = 1"));
        assert!(toml_tables("", "[projects.").is_empty());
        assert!(toml_tables("[tui]\nx = 1\n", "[projects.").is_empty());
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

        // All THREE registration files are shadowed — the two that don't exist on
        // this fake host included. That is the point: a missing shadow used to let
        // the container write through and create the real host file.
        assert_eq!(mounts.len(), 3, "got: {mounts:?}");
        let (src, dst) = (mounts[0].0.clone(), mounts[0].1.clone());
        assert_eq!(dst, settings.to_string_lossy());
        // Source is a real copy living under the stage dir, not the host file.
        assert!(Path::new(&src).starts_with(&stage));
        assert_ne!(Path::new(&src), settings.as_path());
        assert_eq!(std::fs::read(&src).unwrap(), b"{\"hooks\":{}}");
        // The absent ones are staged as parseable/empty defaults, and the host
        // originals are still absent (nothing wrote through).
        for (staged_src, original) in &mounts[1..] {
            assert!(
                Path::new(staged_src).is_file(),
                "{staged_src} must be staged"
            );
            assert!(
                !Path::new(original).exists(),
                "staging must never create the host original {original}"
            );
        }
        assert_eq!(std::fs::read(&mounts[1].0).unwrap(), b"{}\n");
        assert_eq!(std::fs::read(&mounts[2].0).unwrap(), b"");

        // Refresh-at-up: a second pass overwrites the same copies in place (same
        // paths, new content) — never a second set of files.
        std::fs::write(&settings, b"{\"hooks\":{\"v\":2}}").unwrap();
        let again = staged_config_mounts(&home_str, &stage);
        assert_eq!(again, mounts, "mount list must be stable across refreshes");
        assert_eq!(std::fs::read(src).unwrap(), b"{\"hooks\":{\"v\":2}}");
        assert_eq!(
            std::fs::read_dir(&stage).unwrap().count(),
            3,
            "one staged copy per file, refreshed in place"
        );

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn staged_claude_json_keeps_login_and_filters_foreign_projects() {
        let base = std::env::temp_dir().join(format!("eldrun-sbx-cj-{}", std::process::id()));
        let home = base.join("home");
        let stage = base.join("stage");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&stage).unwrap();
        let root = home.join("work/p").to_string_lossy().into_owned();
        let host = home.join(".claude.json");
        std::fs::write(
            &host,
            serde_json::json!({
                "oauthAccount": {"emailAddress": "u@example.org"},
                "hasCompletedOnboarding": true,
                "projects": {
                    root.clone(): {"allowedTools": ["Bash"]},
                    format!("{root}/sub"): {"history": ["own subdir survives"]},
                    "/elsewhere/secret": {"history": ["other project's prompts"]},
                },
            })
            .to_string(),
        )
        .unwrap();

        let home_str = home.to_string_lossy().into_owned();
        let staged_mounts = staged_claude_json_mounts(&home_str, &stage, std::slice::from_ref(&root));
        assert_eq!(staged_mounts.len(), 1, "no nested copy on this fake host");
        let (src, dst) = staged_mounts[0].clone();
        assert_eq!(dst, host.to_string_lossy());
        assert!(Path::new(&src).starts_with(&stage));
        let staged: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&src).unwrap()).unwrap();
        // Login + onboarding survive; foreign project entries do not.
        assert_eq!(
            staged["oauthAccount"]["emailAddress"], "u@example.org",
            "login state must survive into the box"
        );
        assert_eq!(staged["hasCompletedOnboarding"], true);
        let projects = staged["projects"].as_object().unwrap();
        assert_eq!(projects.len(), 2, "got: {projects:?}");
        assert!(projects.contains_key(&root));
        assert!(projects.contains_key(&format!("{root}/sub")));

        // The newer nested location is staged too, and only when the host has it.
        let claude_dir = home.join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();
        let nested = claude_dir.join(".claude.json");
        std::fs::write(
            &nested,
            serde_json::json!({"projects": {"/elsewhere/secret": {"history": ["x"]}}})
                .to_string(),
        )
        .unwrap();
        let both = staged_claude_json_mounts(&home_str, &stage, std::slice::from_ref(&root));
        assert_eq!(both.len(), 2, "got: {both:?}");
        assert_eq!(both[1].1, nested.to_string_lossy());
        assert_ne!(both[1].0, both[0].0, "the two copies must not collide");
        let nested_staged: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&both[1].0).unwrap()).unwrap();
        assert!(
            nested_staged["projects"].as_object().unwrap().is_empty(),
            "the nested copy is filtered the same way"
        );
        std::fs::remove_file(&nested).unwrap();

        // Missing host file: an empty object is staged, the original not created.
        std::fs::remove_file(&host).unwrap();
        let again = staged_claude_json_mounts(&home_str, &stage, &[root]);
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].0, src, "refreshed in place, not a second copy");
        assert_eq!(std::fs::read(&again[0].0).unwrap(), b"{}");
        assert!(!host.exists(), "staging must never create the host original");

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn accepted_trust_paths_takes_only_absolute_accepted_entries() {
        let value = serde_json::json!({
            "projects": {
                "/home/u/work/p": {"hasTrustDialogAccepted": true},
                "/home/u/work/q": {"hasTrustDialogAccepted": false},
                "/home/u/work/r": {"history": ["no answer yet"]},
                "relative/path": {"hasTrustDialogAccepted": true},
            },
        });
        let mut got = accepted_trust_paths(&value);
        got.sort();
        assert_eq!(got, vec!["/home/u/work/p".to_string()]);
        // A file with no `projects` map at all yields nothing rather than panicking.
        assert!(accepted_trust_paths(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn recorded_trust_is_reinjected_only_inside_the_tabs_own_roots() {
        let roots = vec!["/home/u/work/p".to_string(), "/home/u/boxes/b".to_string()];
        let trusted = vec![
            "/home/u/boxes/b".to_string(),      // a root itself
            "/home/u/work/p/sub".to_string(),   // inside a root
            "/home/u/other".to_string(),        // outside every root — must not appear
        ];
        let mut value = serde_json::json!({
            "oauthAccount": {"emailAddress": "u@example.org"},
            "projects": {"/home/u/work/p": {"allowedTools": ["Bash"]}},
        });
        apply_trust_paths(&mut value, &trusted, &roots);
        let projects = value["projects"].as_object().unwrap();
        assert_eq!(projects.len(), 3, "got: {projects:?}");
        assert_eq!(projects["/home/u/boxes/b"]["hasTrustDialogAccepted"], true);
        assert_eq!(projects["/home/u/work/p/sub"]["hasTrustDialogAccepted"], true);
        assert!(!projects.contains_key("/home/u/other"));
        // An entry the host file already had keeps everything else it carried,
        // and login state is untouched.
        assert_eq!(projects["/home/u/work/p"]["allowedTools"][0], "Bash");
        assert_eq!(value["oauthAccount"]["emailAddress"], "u@example.org");
        // Nothing recorded inside the roots leaves the value byte-identical, so
        // a staged `{}` stays `{}` (the "never create the host original" test).
        let mut empty = serde_json::json!({});
        apply_trust_paths(&mut empty, &["/home/u/other".to_string()], &roots);
        assert_eq!(empty, serde_json::json!({}));
        // A non-object staged file is left alone rather than indexed into.
        let mut weird = serde_json::json!([1, 2]);
        apply_trust_paths(&mut weird, &trusted, &roots);
        assert_eq!(weird, serde_json::json!([1, 2]));
    }

    #[test]
    fn agent_home_mounts_deny_the_named_holes_and_read_only_the_scripts() {
        let base = std::env::temp_dir().join(format!("eldrun-sbx-nar-{}", std::process::id()));
        let home = base.join("home");
        let claude = home.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        for dir in ["daemon", "debug", "feedback", "paste-cache", "uploads", "todos"] {
            std::fs::create_dir_all(claude.join(dir)).unwrap();
        }
        for file in [
            ".claude.json",
            ".claude.json.bak",
            ".claude.json.backup.1",
            ".credentials.json",
            "statusline-command.sh",
            "CLAUDE.md",
        ] {
            std::fs::write(claude.join(file), b"x").unwrap();
        }

        let home_str = home.to_string_lossy().into_owned();
        let (rw, ro) = agent_home_mounts(&home_str, "/state/ls/p1", "/state/ls");
        let mounted = |set: &[String], name: &str| {
            let want = format!("{home_str}/.claude/{name}:{home_str}/.claude/{name}");
            set.contains(&want)
        };

        // Denied outright: the daemon dir (the pattern used to be `daemon.*`,
        // which never matched it), the stale cross-project `.claude.json`
        // family, and the cross-session content dirs.
        for name in [
            "daemon",
            ".claude.json",
            ".claude.json.bak",
            ".claude.json.backup.1",
            "debug",
            "feedback",
            "paste-cache",
            "uploads",
        ] {
            assert!(!mounted(&rw, name), "{name} must not be writable");
            assert!(!mounted(&ro, name), "{name} must not be mounted at all");
        }
        // Readable, never writable: what the host executes or reads as
        // instructions.
        for name in ["statusline-command.sh", "CLAUDE.md"] {
            assert!(mounted(&ro, name), "{name} must stay readable");
            assert!(!mounted(&rw, name), "{name} must not be writable");
        }
        // Still mounted read-write: any entry nobody named (the deliberate
        // default).
        assert!(mounted(&rw, "todos"));
        // The credential file is owned by `claude_credential_mounts` (a
        // stable-inode mirror), never by the per-entry planner: mounted here it
        // would pin the inode Claude's rename-rotation leaves behind.
        assert!(!mounted(&rw, ".credentials.json"));
        assert!(!mounted(&ro, ".credentials.json"));

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn credential_mount_is_the_mirror_at_the_real_path_and_absent_when_logged_out() {
        let base = std::env::temp_dir().join(format!("eldrun-sbx-cred-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let claude = home.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        let home_str = home.to_string_lossy().into_owned();
        let mirror = crate::services::agent_creds::mirror_path_in(&base.join("state"));

        // No host credential file: nothing to mount, and no mirror is created.
        assert!(claude_credential_mounts_in(&home_str, &mirror).is_empty());
        assert!(!mirror.exists());

        let record = br#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":5}}"#;
        std::fs::write(claude.join(".credentials.json"), record).unwrap();
        let pairs = claude_credential_mounts_in(&home_str, &mirror);
        let dst = format!("{home_str}/.claude/.credentials.json");
        if !cfg!(target_os = "linux") {
            // Seatbelt cannot substitute, Windows fences nothing: the real
            // file, in place, and no mirror.
            assert_eq!(pairs, vec![(dst.clone(), dst)]);
            assert!(!mirror.exists());
        } else {
            assert_eq!(pairs, vec![(mirror.to_string_lossy().into_owned(), dst)]);
            // Seeded at plan time, so a fresh tab starts with the current token.
            assert_eq!(std::fs::read(&mirror).unwrap(), record);
        }

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn entry_patterns_match_prefix_suffix_and_exact() {
        assert!(matches_entry("daemon", &["daemon*"]));
        assert!(matches_entry("daemon.log", &["daemon*"]));
        assert!(!matches_entry("daemon", &["daemon.*"]));
        assert!(matches_entry("hook.sh", &["*.sh"]));
        assert!(!matches_entry("sh", &["*.sh"]));
        assert!(matches_entry("settings.json", &["settings.json"]));
        assert!(!matches_entry("settings.jsonc", &["settings.json"]));
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
            agent: true,
            project_id: None,
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
        };
        wrap_pty_options_docker(&mut opts).unwrap();
        assert_eq!(opts.cmd, "claude");
        assert_eq!(opts.args, args(&["--session-id", "x"]));
    }

    #[test]
    fn box_scope_never_resolves_sandboxed() {
        // A `box:<id>` tab is local + uncontained by design; the branch returns
        // before any state-dir read, so this is safe to exercise in a test.
        let mut opts = PtyOptions {
            id: "t".to_string(),
            cmd: "claude".to_string(),
            args: vec![],
            env: Default::default(),
            cwd: "/home/u/eldrun/boxes/b".to_string(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: true,
            agent: true,
            project_id: Some("box:abc".to_string()),
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
        };
        enforce_spawn_authority(&mut opts);
        assert!(!opts.sandbox, "box tabs must never spawn containerized");
        assert!(!opts.local_only, "local_only is left as requested");
    }

    // ── Authority resolution (S-2 / S-6) ──────────────────────────────────

    fn want(sandbox: bool, local_only: bool) -> SpawnAuthority {
        SpawnAuthority {
            sandbox,
            local_only,
        }
    }

    /// `resolve_spawn_authority` under the default (contain everything) scope —
    /// the shape every pre-`scope` test was written against.
    fn resolve_all(
        has_project: bool,
        is_remote: bool,
        toggle_on: bool,
        requested: SpawnAuthority,
        cmd: &str,
        marker: bool,
    ) -> SpawnAuthority {
        resolve_spawn_authority(
            has_project,
            is_remote,
            toggle_on,
            SandboxScope::All,
            requested,
            cmd,
            marker,
        )
    }

    #[test]
    fn a_toggled_local_project_containerizes_regardless_of_the_renderers_flags() {
        // The S-2 escape: a persisted tab declaring itself local (which makes
        // `pty_spawn` skip BOTH the docker and the ssh wrap) is overruled.
        let resolved = resolve_all(true, false, true, want(false, true), "bash", false);
        assert_eq!(resolved, want(true, false));

        // …including when it also claims to be a `local_agent` kind by naming an
        // agent CLI, but holds no registered host-bound marker.
        let resolved = resolve_all(true, false, true, want(false, true), "claude", false);
        assert_eq!(resolved, want(true, false));
    }

    #[test]
    fn host_bound_local_model_tabs_still_run_on_the_host() {
        for cmd in HOST_BOUND_LOCAL_AGENT_CMDS {
            let resolved = resolve_all(true, false, true, want(false, true), cmd, true);
            assert_eq!(resolved, want(false, true), "{cmd} must stay on the host");
        }
        // The marker alone is not enough — the command must be a known driver.
        let resolved = resolve_all(true, false, true, want(false, true), "/tmp/pwn.sh", true);
        assert_eq!(resolved, want(true, false));
        // …and a known driver alone is not enough either. This is #150: the grant
        // used to be the tab's `ELDRUN_LOCAL_MODEL` env var, which is a label the
        // usage recap sets, so anything that set it for a display reason handed
        // out a container escape. It is now a file in the state dir.
        assert!(!is_host_bound_local_agent("vibe", false));
        assert!(is_host_bound_local_agent("vibe", true));
    }

    #[test]
    fn a_host_bound_marker_is_a_single_path_component() {
        // The uid names a file, and it arrives from the renderer.
        for bad in ["", "../../etc/passwd", "a/b", "a\\b", "..", "x y", "é"] {
            assert!(
                !host_bound_marker_exists("p1", bad),
                "{bad:?} must not resolve"
            );
            assert!(
                register_host_bound_tab("p1", bad).is_err(),
                "{bad:?} must be refused"
            );
        }
        assert!(register_host_bound_tab("p1", &"x".repeat(65)).is_err());
    }

    #[test]
    fn toggle_off_and_remote_projects_can_never_be_told_they_are_sandboxed() {
        // Toggle off: the renderer cannot invent a container.
        assert_eq!(
            resolve_all(true, false, false, want(true, false), "bash", false),
            want(false, false)
        );
        // Remote project: containers are local-only, but `local_only` is a real
        // per-tab choice there (mirror vs. host) and is left alone.
        assert_eq!(
            resolve_all(true, true, true, want(true, true), "claude", false),
            want(false, true)
        );
        assert_eq!(
            resolve_all(true, true, true, want(true, false), "claude", false),
            want(false, false)
        );
    }

    #[test]
    fn a_projectless_spawn_passes_through_untouched() {
        // Root scope / connection terminals: no project record to consult.
        let requested = want(false, true);
        assert_eq!(
            resolve_all(false, false, false, requested, "", false),
            requested
        );
    }

    // ── Agents-only scope ─────────────────────────────────────────────────

    fn resolve_agents_only(cmd: &str) -> SpawnAuthority {
        resolve_spawn_authority(
            true,
            false,
            true,
            SandboxScope::Agents,
            want(false, false),
            cmd,
            false,
        )
    }

    #[test]
    fn agents_only_contains_the_agent_and_leaves_the_shell_alone() {
        // The whole point of the scope: the model's tab is boxed, the user's is not.
        for agent in ["claude", "codex", "gemini", "aider"] {
            assert_eq!(resolve_agents_only(agent), want(true, false), "{agent}");
        }
        // A shell tab spawns with an EMPTY cmd (the host default shell) — the case
        // that has to work, since it is what every `+ Shell` and every viewer
        // Run/Debug tab is.
        for host_side in ["", "bash", "sh", "python3", "/usr/bin/make", "npm"] {
            assert_eq!(
                resolve_agents_only(host_side),
                want(false, false),
                "{host_side:?} must run on the host"
            );
        }
    }

    #[test]
    fn agents_only_matches_an_agent_by_basename_not_by_the_bare_word() {
        // A pinned absolute path is still that agent; PATH layout is not a
        // containment decision.
        assert!(is_agent_cmd("/home/u/.local/bin/claude"));
        assert!(is_agent_cmd("claude.exe"));
        assert!(is_agent_cmd(r"C:\tools\codex.exe"));
        // …and a lookalike is not.
        assert!(!is_agent_cmd("claude-wrapper"));
        assert!(!is_agent_cmd("myclaude"));
        assert!(!is_agent_cmd(""));
    }

    #[test]
    fn the_scope_can_only_narrow_never_grant() {
        // Toggle off + agents-only must not containerize an agent: `scope` is read
        // only after the toggle already said yes.
        assert_eq!(
            resolve_spawn_authority(
                true,
                false,
                false,
                SandboxScope::Agents,
                want(true, false),
                "claude",
                false
            ),
            want(false, false)
        );
        // A remote project is still never docker-wrapped, whatever the scope says.
        assert_eq!(
            resolve_spawn_authority(
                true,
                true,
                true,
                SandboxScope::Agents,
                want(true, false),
                "claude",
                false
            ),
            want(false, false)
        );
    }

    #[test]
    fn a_host_bound_local_model_tab_outranks_the_scope() {
        // Both exemptions point the same way; check they compose rather than one
        // shadowing the other into a container.
        assert_eq!(
            resolve_spawn_authority(
                true,
                false,
                true,
                SandboxScope::Agents,
                want(false, true),
                "vibe",
                true
            ),
            want(false, true)
        );
    }

    #[test]
    fn an_older_spec_with_no_scope_key_still_contains_everything() {
        // The migration-free promise: a `sandbox` object written before `scope`
        // existed must not silently drop to agents-only on upgrade.
        let spec: SandboxSpec =
            serde_json::from_str(r#"{"enabled":true,"network":"none"}"#).unwrap();
        assert_eq!(spec.scope, SandboxScope::All);
        assert_eq!(
            resolve_spawn_authority(
                true,
                false,
                spec.enabled,
                spec.scope,
                want(false, true),
                "bash",
                false
            ),
            want(true, false)
        );
    }

    #[test]
    fn agent_registry_matches_classifier() {
        // `is_agent_cmd` reads `commands::agents::AGENTS`; this is the tripwire for
        // the frontend's `AGENT_CMDS`, which is a hand-kept copy of the same set.
        // An agent missing from the classifier runs OUTSIDE the container under
        // agents-only scope, which is exactly the silent failure worth a test.
        for bin in crate::commands::agents::agent_bins() {
            assert!(
                is_agent_cmd(bin),
                "{bin} is in the registry but not classified"
            );
        }
        // The registry is non-empty (a `Vec::new()` refactor would make every
        // assertion above vacuous and every agent escape the container).
        assert!(crate::commands::agents::agent_bins().len() >= 10);
    }

    // ── Mount narrowing (S-3) ─────────────────────────────────────────────

    #[test]
    fn unmounted_entry_matching_is_exact_with_a_star_prefix() {
        assert!(matches_entry("shell-snapshots", CLAUDE_UNMOUNTED));
        assert!(matches_entry("plugins", CLAUDE_UNMOUNTED));
        assert!(matches_entry("agents", CLAUDE_UNMOUNTED));
        // Personal skills are instructions + optional `scripts/` that every
        // *uncontained* session of every project loads — the `agents/` hole one
        // directory over, and the reason the personal install scope exists at all.
        assert!(matches_entry("skills", CLAUDE_UNMOUNTED));
        assert!(matches_entry("history.jsonl", CLAUDE_UNMOUNTED));
        // `daemon.*` is a prefix pattern.
        assert!(matches_entry("daemon.log", CLAUDE_UNMOUNTED));
        assert!(matches_entry("daemon.sock", CLAUDE_UNMOUNTED));
        // Not a prefix match for a non-star pattern.
        assert!(!matches_entry("plugins-of-mine", CLAUDE_UNMOUNTED));
        // Transcripts are excluded *here* because `claude_transcript_mounts`
        // owns that destination — per entry, rw for ours and `:ro` for the rest.
        assert!(matches_entry("projects", CLAUDE_UNMOUNTED));
        // The credential file is excluded here for the same reason: it is
        // `claude_credential_mounts`'s destination — a stable-inode mirror,
        // because a file mount of the host original pins the inode Claude's
        // rename-rotation leaves behind. What resume needs still gets there.
        assert!(matches_entry(".credentials.json", CLAUDE_UNMOUNTED));
        assert!(!matches_entry("todos", CLAUDE_UNMOUNTED));
        // Codex keeps `sessions/` — a containerized Codex writes its rollouts there
        // and the host reads them back to decide whether a tab can resume.
        assert!(!matches_entry("sessions", CODEX_UNMOUNTED));
        assert!(matches_entry("history.jsonl", CODEX_UNMOUNTED));
    }

    #[test]
    fn narrowed_agent_mounts_skips_the_excluded_entries_and_is_deterministic() {
        let base = std::env::temp_dir().join(format!("eldrun-narrow-{}", std::process::id()));
        let claude = base.join(".claude");
        std::fs::create_dir_all(claude.join("projects")).unwrap();
        std::fs::create_dir_all(claude.join("shell-snapshots")).unwrap();
        std::fs::create_dir_all(claude.join("plugins")).unwrap();
        std::fs::write(claude.join("history.jsonl"), b"{}").unwrap();
        std::fs::write(claude.join("daemon.log"), b"").unwrap();
        std::fs::write(claude.join(".credentials.json"), b"{}").unwrap();
        std::fs::write(claude.join("settings.json"), b"{}").unwrap();
        std::fs::create_dir_all(claude.join("todos")).unwrap();

        let dir = claude.to_string_lossy().into_owned();
        let (mounts, _) = narrowed_agent_mounts(&dir, CLAUDE_UNMOUNTED);

        // Compare whole mount strings rather than picking the entry name back
        // out of them. `dir` comes from `temp_dir()`, so on Windows it carries a
        // drive-letter colon and `\` separators — `split(':')` would read "C"
        // and `rsplit('/')` would never match. Building the expectation with the
        // same `{p}:{p}` shape also asserts the identical-path property (the one
        // agent resume depends on) by construction.
        let expected: Vec<String> = ["todos"]
            .iter()
            .map(|n| format!("{dir}/{n}:{dir}/{n}"))
            .collect();
        assert_eq!(mounts, expected);
        // `settings.json` is deliberately absent here — `staged_config_mounts`
        // owns that destination with a writable per-project copy. So is
        // `projects` — `claude_transcript_mounts` owns that one — and so is
        // `.credentials.json`, owned by `claude_credential_mounts` (a mirror
        // whose inode survives the host file's rename-rotation).
        assert!(!mounts.iter().any(|m| m.contains("settings.json")));
        assert!(!mounts.iter().any(|m| m.ends_with("/projects")));
        assert!(!mounts.iter().any(|m| m.contains(".credentials.json")));
        // Stable across calls, so the spec fingerprint doesn't flap.
        assert_eq!(narrowed_agent_mounts(&dir, CLAUDE_UNMOUNTED).0, mounts);
        // A dir that isn't there mounts nothing (never auto-created).
        assert_eq!(
            narrowed_agent_mounts(&base.join("nope").to_string_lossy(), CLAUDE_UNMOUNTED),
            (Vec::new(), Vec::new())
        );

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn live_sessions_is_mounted_per_project_at_the_canonical_path() {
        let (mounts, _) = agent_home_mounts(
            "/home/alice",
            "/state/live_sessions/p1",
            "/state/live_sessions",
        );
        // The ONE deliberately non-identical mount: the hook script's baked-in path
        // is served by this project's own slice.
        assert!(mounts.contains(&"/state/live_sessions/p1:/state/live_sessions".to_string()));
        assert!(!mounts.contains(&"/state/live_sessions:/state/live_sessions".to_string()));
    }

    // ── Claude transcripts: read all, write ours ──────────────────────────

    /// A transcript dir holding one log whose first line records `cwd`.
    fn transcript_dir(root: &Path, name: &str, cwd: Option<&str>) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        if let Some(cwd) = cwd {
            // First line without a `cwd` on purpose: real logs open with a
            // summary/title record, so the probe has to read past it.
            let log = format!(
                "{{\"type\":\"summary\",\"sessionId\":\"s\"}}\n{{\"type\":\"user\",\"cwd\":{}}}\n",
                serde_json::to_string(cwd).unwrap()
            );
            std::fs::write(dir.join("11111111-2222-3333-4444-555555555555.jsonl"), log).unwrap();
        }
    }

    #[test]
    fn every_transcript_dir_is_listed_and_only_ours_is_writable() {
        let base = std::env::temp_dir().join(format!("eldrun-tx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let projects = home.join(".claude").join("projects");
        let project_dir = base.join("work").join("proj");
        std::fs::create_dir_all(&project_dir).unwrap();
        let project = project_dir.to_string_lossy().into_owned();

        transcript_dir(&projects, "ours", Some(&project));
        transcript_dir(
            &projects,
            "ours-subdir",
            Some(&project_dir.join("sub").to_string_lossy()),
        );
        let second_root = base.join("work").join("box-sibling");
        transcript_dir(
            &projects,
            "ours-second-root",
            Some(&second_root.join("nested").to_string_lossy()),
        );
        transcript_dir(
            &projects,
            "sibling",
            // The encoding is lossy, so this name *could* be read as a subdir of
            // ours — the recorded cwd says it is a different project.
            Some(&base.join("work").join("proj-panel").to_string_lossy()),
        );
        transcript_dir(&projects, "elsewhere", Some("/somewhere/else"));
        // No log at all and a name that matches nothing: unknown ⇒ read-only.
        transcript_dir(&projects, "empty-unknown", None);

        let stage = base.join("stage");
        let home_str = home.to_string_lossy().into_owned();
        let roots = vec![project.clone(), second_root.to_string_lossy().into_owned()];
        let (rw, ro) = claude_transcript_mounts(&home_str, &roots, &stage);

        let src_of = |name: &str| projects.join(name).to_string_lossy().into_owned();
        let has = |v: &[String], name: &str| {
            let src = src_of(name);
            v.iter().any(|m| m.starts_with(&format!("{src}:")))
        };

        // The stage is the mount parent — the only place a *new* transcript dir
        // can be created, and it is ours.
        assert!(rw[0].starts_with(&format!("{}:", stage.to_string_lossy())));
        assert!(rw[0].ends_with(&format!("{home_str}/.claude/projects")));

        assert!(has(&rw, "ours"));
        assert!(has(&rw, "ours-subdir"));
        assert!(has(&rw, "ours-second-root"));
        assert!(
            has(&ro, "sibling"),
            "a sibling project must not be writable"
        );
        assert!(has(&ro, "elsewhere"));
        assert!(
            has(&ro, "empty-unknown"),
            "unknown must default to read-only"
        );
        // Nothing is writable that isn't ours, and nothing is silently dropped:
        // the read allowance is listed entry by entry.
        for name in ["sibling", "elsewhere", "empty-unknown"] {
            assert!(!has(&rw, name));
        }
        assert_eq!(rw.len() + ro.len(), 1 + 6);
        // Deterministic, so the mount list doesn't flap with readdir order.
        assert_eq!(
            claude_transcript_mounts(&home_str, &roots, &stage),
            (rw, ro)
        );

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn the_name_fallback_matches_at_a_separator_boundary_only() {
        // Claude's encoding of `/home/u/proj`.
        assert!(transcript_name_matches("-home-u-proj", "/home/u/proj"));
        // A subdirectory of it.
        assert!(transcript_name_matches("-home-u-proj-src", "/home/u/proj"));
        // A sibling whose name merely *starts* with ours — the `GNNGED` vs
        // `GNNGEDAnalysis` case.
        assert!(!transcript_name_matches(
            "-home-u-projAnalysis",
            "/home/u/proj"
        ));
        assert!(!transcript_name_matches("-home-u-other", "/home/u/proj"));
        // A dotted segment encodes like a separator does.
        assert!(transcript_name_matches(
            "-home-u-proj--hidden",
            "/home/u/proj"
        ));
    }

    #[test]
    fn cwd_containment_is_component_wise() {
        assert!(cwd_is_within("/home/u/proj", "/home/u/proj"));
        assert!(cwd_is_within("/home/u/proj/sub", "/home/u/proj"));
        // Not a string prefix match — this is the sibling that used to slip in.
        assert!(!cwd_is_within("/home/u/proj2", "/home/u/proj"));
    }

    #[test]
    fn harvest_moves_new_transcripts_home_and_never_overwrites() {
        let base = std::env::temp_dir().join(format!("eldrun-harvest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let stage = base.join("stage");
        let real = base.join("home").join(".claude").join("projects");
        std::fs::create_dir_all(&real).unwrap();

        // A dir that *was* mounted: the mountpoint is left behind empty.
        std::fs::create_dir_all(stage.join("mounted")).unwrap();
        // A cwd nobody knew about at create time — the container made this.
        std::fs::create_dir_all(stage.join("fresh")).unwrap();
        std::fs::write(stage.join("fresh").join("a.jsonl"), b"{}").unwrap();
        // A dir the host already has: keep its file, take the new one.
        std::fs::create_dir_all(stage.join("both")).unwrap();
        std::fs::write(stage.join("both").join("old.jsonl"), b"container").unwrap();
        std::fs::write(stage.join("both").join("new.jsonl"), b"container").unwrap();
        std::fs::create_dir_all(real.join("both")).unwrap();
        std::fs::write(real.join("both").join("old.jsonl"), b"host").unwrap();

        harvest_claude_transcripts(&stage, &real);

        assert!(real.join("fresh").join("a.jsonl").is_file());
        assert!(!stage.join("fresh").exists());
        // An empty mountpoint is not a transcript — dropped, not "harvested".
        assert!(!real.join("mounted").exists());
        assert_eq!(
            std::fs::read_to_string(real.join("both").join("old.jsonl")).unwrap(),
            "host",
            "a host transcript must never be overwritten by the container's copy"
        );
        assert!(real.join("both").join("new.jsonl").is_file());

        std::fs::remove_dir_all(&base).ok();
    }

    // ── Dockerfile confinement + network allowlist (S-8) ──────────────────

    #[test]
    fn spec_dockerfile_must_stay_inside_the_project() {
        let base = std::env::temp_dir().join(format!("eldrun-df-{}", std::process::id()));
        let proj = base.join("proj");
        std::fs::create_dir_all(proj.join("docker")).unwrap();
        std::fs::write(proj.join("Dockerfile"), b"FROM debian:stable").unwrap();
        std::fs::write(
            proj.join("docker").join("Dockerfile"),
            b"FROM debian:stable",
        )
        .unwrap();
        std::fs::write(base.join("evil.Dockerfile"), b"FROM debian\nRUN pwn").unwrap();

        assert!(resolve_spec_dockerfile(&proj, "Dockerfile").is_ok());
        assert!(resolve_spec_dockerfile(&proj, "docker/Dockerfile").is_ok());
        // Traversal out of the project — the build runs as root, so this mattered.
        assert!(resolve_spec_dockerfile(&proj, "../evil.Dockerfile").is_err());
        assert!(resolve_spec_dockerfile(&proj, "docker/../../evil.Dockerfile").is_err());
        // Absolute paths are refused outright.
        assert!(resolve_spec_dockerfile(&proj, "/etc/passwd").is_err());
        // A path that doesn't exist can't be built either.
        assert!(resolve_spec_dockerfile(&proj, "missing.Dockerfile").is_err());

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn network_allowlist_refuses_host_and_accepts_real_network_names() {
        assert!(validate_network("none").is_ok());
        assert!(validate_network("bridge").is_ok());
        assert!(validate_network("my-allowlist_net.1").is_ok());
        // The one value that removes the container's network isolation.
        assert!(validate_network("host").is_err());
        assert!(validate_network("HOST").is_err());
        // Docker's other isolation-sharing forms carry characters we reject.
        assert!(validate_network("container:deadbeef").is_err());
        assert!(validate_network("ns:/proc/1/ns/net").is_err());
        assert!(validate_network("").is_err());
        // And a rejected spec value falls back to docker's default bridge.
        let spec = SandboxSpec {
            network: Some("host".to_string()),
            ..Default::default()
        };
        assert_eq!(harden_opts(Some(&spec)).network, None);
        let spec = SandboxSpec {
            network: Some("none".to_string()),
            ..Default::default()
        };
        assert_eq!(harden_opts(Some(&spec)).network.as_deref(), Some("none"));
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
