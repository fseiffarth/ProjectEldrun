# Docker Projects — Implementation Plan (TODO #38)

Status: **planned** (not started).

Run a project inside a Docker/Podman container instead of (or in addition to)
directly on the host: the project's terminal/agent tabs run via `docker exec`
into a container, with the project directory **bind-mounted** as the working dir
so the file tree and git keep working against the host's bytes.

This plan mirrors the two-mechanism shape that the SSH feature settled on
(see `docs/ssh_projects_plan.md`):

| SSH concern            | SSH file                       | Docker analogue          |
|------------------------|--------------------------------|--------------------------|
| Lifecycle (up/down)    | `services/ssh_mount.rs`        | `services/docker_runtime.rs` |
| Spawn rewrite          | `services/ssh_exec.rs`         | `services/docker_exec.rs`    |
| Browse/connect commands| `commands/ssh.rs`              | `commands/docker.rs`         |
| Spec on the project    | `schema::project::RemoteSpec`  | `schema::project::DockerSpec` |

The key difference from SSH: **the bytes are already local.** We do not need a
filesystem mount to make the file tree work — the host project directory *is* the
source of truth and is bind-mounted into the container. So the file tree, git,
and `list_dir` all keep running unchanged against the **host** `directory`; only
**terminal/agent spawns** are rewritten to execute inside the container. This is
the inverse of SSH (where the bytes were remote and we mounted them locally) and
it makes Phase 1 considerably simpler than the SSH work.

The work is split into **two phases**: **Phase 1 — local Docker** (a container on
the same host), then **Phase 2 — remote Docker** (a container on an SSH host,
composing with the existing work-remote axis). Phase 1 is independently
shippable and useful; Phase 2 builds on it.

---

## Data model (shared by both phases)

A project is "containerized" iff `docker` is present on `Project`.

`schema/project.rs` — new struct + field on `Project`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerSpec {
    /// How the container is provided. Exactly one of the variants below is
    /// "active"; the others are None.
    /// 1) Existing image to `docker run` from.
    pub image: Option<String>,
    /// 2) In-repo Dockerfile (path relative to the project dir) to build.
    pub dockerfile: Option<String>,
    /// 3) In-repo compose file (path relative to the project dir); `service`
    ///    names which compose service the tabs exec into.
    pub compose_file: Option<String>,
    pub service: Option<String>,
    /// 4) Pre-existing container to `docker exec` into (no lifecycle managed).
    pub container: Option<String>,

    /// Absolute path *inside the container* where the project dir is mounted.
    /// Defaults to "/workspace" when None.
    pub workdir: Option<String>,
    /// Extra `docker run` args (e.g. published ports, --gpus). Validated like
    /// every other argv item (no leading '-' surprises beyond what we add).
    #[serde(default)]
    pub run_args: Vec<String>,
    /// "docker" (default) or "podman".
    pub engine: Option<String>,

    /// Phase 2 only: when set, the engine runs on this SSH host. The container
    /// lives remotely; bind-mount source is the remote project path.
    pub remote: Option<RemoteSpec>,

    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}
```

`Project` gains
`#[serde(skip_serializing_if = "Option::is_none")] pub docker: Option<DockerSpec>`.
`ProjectEntry` carries `docker` inside the existing `extra` map (same as
`remote`), so the pill list / `resolveProjectDirectory` need no structural
change. `types/index.ts` mirrors `DockerSpec` and adds `docker?` to
`ProjectEntry`.

**`directory` stays the host project path** in Phase 1 (no mountpoint
indirection). The container's view of that path is `workdir` (default
`/workspace`), bind-mounted `-v <directory>:<workdir>`.

---

## Phase 1 — Local Docker

A container on the same host as Eldrun. The project's host directory is
bind-mounted in; terminal/agent tabs exec into the container; file tree and git
run on the host as today.

### Container lifecycle — `services/docker_runtime.rs` (new)

Mirror `ssh_mount.rs`'s shape: a lifecycle service keyed by project id, with a
single source of truth for validation/argv helpers, idempotent up/down, and
best-effort teardown on exit.

- **Container name convention:** `eldrun-<project-id>`. `container_name_for(id)`
  is the analogue of `mountpoint_for(id)`. (For the "pre-existing container"
  variant we use `DockerSpec.container` verbatim and manage no lifecycle.)
- **`engine_available(engine) -> bool`** — `which docker`/`which podman` (cf.
  `sshfs_available`). Missing engine ⇒ clear, actionable error
  ("docker not found — install Docker or Podman to use container projects").
- **`is_running(name) -> bool`** — `docker ps --filter name=^/<name>$ --format '{{.Names}}'`
  exact match (analogue of `is_mounted`).
- **`up(spec, project_id, host_dir) -> Result<String, String>`** — ensure the
  container exists and is running; return its name/id. No-op if already running.
  Build strategy by variant:
  - `image`: `docker run -d --name <name> -v <host_dir>:<workdir> -w <workdir>
    <run_args…> <image> sleep infinity` (long-lived; tabs `exec` into it).
  - `dockerfile`: `docker build -t eldrun-<id>:latest -f <dockerfile> <host_dir>`
    then run as above.
  - `compose_file`: `docker compose -f <file> up -d`; tabs target `<service>`
    via `docker compose exec` (or resolve the service container id and `exec`).
  - `container`: assume managed externally; only verify it is running.
- **`down(spec, project_id)`** — `docker stop`/`docker rm` for managed
  containers (image/dockerfile), `docker compose down` for compose; **no-op for
  the pre-existing `container` variant** (we did not create it). Idempotent.
- **`down_all()`** — analogue of `unmount_all`: enumerate running
  `eldrun-*` containers (and tracked compose projects) and stop them. Called at
  app exit.

All argv built as `Vec<String>` (unit-testable without a daemon), every value
passed as a separate argv item, `validate_arg` reused from the shared helper to
reject leading-`-` / control chars.

### Spawn rewrite — `services/docker_exec.rs` (new)

Mirror `ssh_exec.rs`. A tab whose project is containerized has its `PtyOptions`
rewritten to run inside the container:

- **Detection:** the project for `opts.cwd` has a `DockerSpec`. Reuse the same
  `project_id_from_cwd` style resolution; for local docker the cwd is under the
  normal host project dir, so resolution is by project-dir prefix rather than
  the mounts root.
- **`container_workdir(spec, host_dir, local_cwd)`** — translate the host cwd to
  the in-container path: strip `host_dir` prefix, join onto `workdir`. Analogue
  of `remote_subdir`.
- **`docker_pty_args(spec, name, in_cwd, cmd, args, env)`** — build:
  `docker exec -it -w <in_cwd> [-e K=V…] <name> <cmd> <args…>`, or
  `docker exec -it -w <in_cwd> <name> "${SHELL:-/bin/bash}" -l` when `cmd` is
  empty. Compose variant uses `docker compose -f <file> exec <service> …`.
- **`wrap_pty_options(opts)`** — if the project is containerized and not
  `local_only`, rewrite `opts.cmd`/`opts.args` to the `docker exec` invocation
  and set `opts.cwd` to a stable host dir (the docker client runs on the host).
  Honor the existing **`local_only`** flag verbatim — locally-bound tabs (e.g.
  Ollama `local_agent` tabs) must never be pushed into the container.
- This must compose cleanly with `ssh_exec::wrap_pty_options`: for Phase 1 the
  two are mutually exclusive (a project is either remote-via-ssh or
  local-docker). The call site applies docker-wrap for docker projects, ssh-wrap
  for remote projects.

### Wiring (Phase 1)

- `services/project_runtime.rs::switch` — best-effort `docker_runtime::up(...)`
  when switching to a docker project (mirrors the best-effort remote mount).
  Non-panicking; a daemon-down/host-offline does not block the switch.
- `commands/projects.rs` — `CreateProjectRequest`/`ImportProjectRequest` gain an
  optional `docker` field; persist it in `project.json` and the `projects.json`
  entry `extra`. Scaffolding still happens on the **host** dir (unchanged).
- `lib.rs` — register the new docker commands; in the `RunEvent::Exit` closure
  call `docker_runtime::down_all()` alongside `unmount_all()`.
- `commands/docker.rs` (new):
  - `docker_available(engine) -> Result<(), String>`
  - `docker_list_images() -> Result<Vec<String>, String>` (for the dialog
    picker: `docker images --format '{{.Repository}}:{{.Tag}}'`)
  - `ensure_project_container(project_id) -> Result<String, String>` (up if
    needed, return name; called before terminal spawn — analogue of
    `ensure_project_mounted`).

### Frontend (Phase 1)

`ProjectSwitcher.tsx` project dialog: a **"Run in container"** section (collapsed by
default). When enabled, the user picks the container source:

- **Image** (text field + optional `docker_list_images` dropdown),
- **Dockerfile** (path within the project),
- **Compose** (compose file path + service name),
- **Existing container** (name/id).

Plus optional advanced fields: workdir (default `/workspace`), extra run args,
engine (docker/podman). Submit passes `docker: {...}` to create/import.
`stores/projects.ts::load()` best-effort calls `ensure_project_container` for the
initially-active docker project (startup, non-blocking), mirroring the remote
case.

### Tests (Phase 1)

`cargo test` (no daemon required — assert on built argv and parsing):
- `container_name_for` derivation.
- `docker_pty_args` shape per variant (image/compose), `-w`, `-e`, fallback
  shell, leading-`-`/control-char rejection.
- `container_workdir` prefix translation (incl. cwd == project root, cwd outside
  project → fallback to workdir).
- `run`/`build` argv construction for each variant.
- schema round-trip (docker present/absent), request deserialization.
- `local_only` short-circuits `wrap_pty_options`.

`npx tsc --noEmit` for the dialog. Runtime QA by the user (agents must not launch
Eldrun): create image-based + compose-based projects, open a terminal, confirm
it runs inside the container, edits on the host show in the file tree, git works,
container is cleaned up on exit.

---

## Phase 2 — Remote Docker

A container running on an **SSH host** (the work-remote axis), composing Phase 1
with the existing SSH feature. Activated when `DockerSpec.remote` is set.

### How it composes

The two axes stack: the bytes live remotely (SSH), and the runtime is a
container on that remote host.

- **Bytes:** as today for remote projects — sshfs-mount the remote project dir
  locally so the file tree/git/`list_dir` keep working against the mount
  (`ssh_mount.rs`, unchanged). `directory` = the local mountpoint.
- **Container bind-mount source:** the **remote** project path
  (`remote.remote_path`), *not* the local mountpoint — the remote docker daemon
  bind-mounts the remote bytes directly. So host edits → sshfs → remote file →
  container all see the same bytes.
- **Runtime:** terminal/agent spawns run `ssh -tt <host> docker exec …`. This is
  literally `ssh_exec`'s remote-command wrapping with `docker exec …` as the
  remote command. Implementation = compose the two existing wrappers rather than
  duplicate either:
  1. `docker_exec` builds the `docker exec -w <in_cwd> … <cmd>` argv as a string.
  2. `ssh_exec::remote_command`/`ssh_pty_args` wrap that to run over `ssh -tt`.

### Work in Phase 2

- `docker_runtime` gains a `remote: Option<&RemoteSpec>` path: each engine call
  (`run`/`build`/`ps`/`stop`/compose) is prefixed with the SSH base argv
  (`ssh_base_args`) when remote, so it executes on the remote host. The argv
  builders stay unit-testable (assert the `ssh … docker …` shape).
- `docker_exec::wrap_pty_options` detects `remote` and routes through
  `ssh_exec`'s remote wrapping instead of a bare local `docker exec`.
- `down_all()` must also tear down remote containers for known remote-docker
  projects (enumerate from the project list, not just local `docker ps`).
- Frontend: in the dialog, "Run in container" becomes available **after** an SSH
  connection is established (the remote-browse flow from Phase 1 of SSH); the
  container source fields then describe the remote container.

### Tests (Phase 2)

- `docker_runtime` argv builders produce `ssh <base> -- docker …` when remote.
- `docker_exec` remote path produces `ssh -tt … cd … && exec docker exec …`.
- Round-trip of a `DockerSpec` with `remote` present.
- Runtime QA: remote host with docker; create a remote-docker project; terminal
  execs into the remote container; host file tree (over sshfs) reflects edits.

---

## Open questions to resolve when picking this up

- **Compose multi-service:** v1 targets a single named `service`; multi-service
  topologies (db + app) are started by `compose up` but tabs only exec into the
  one `service`. Good enough for v1?
- **Long-lived vs ephemeral:** plan keeps a long-lived container
  (`sleep infinity` + `exec`) so tab restarts are instant and state persists
  across switches. Alternative (`docker run` per tab) is simpler but loses
  in-container state — rejected for v1.
- **Engine default:** auto-detect docker, fall back to podman, or require the
  user to choose? Plan: default docker, allow `engine: "podman"` override.
- **Rootless/permissions:** bind-mounted file ownership (uid mapping) can bite
  with rootful docker. Document the `--user $(id -u):$(id -g)` escape hatch via
  `run_args`; do not auto-inject in v1.
```
