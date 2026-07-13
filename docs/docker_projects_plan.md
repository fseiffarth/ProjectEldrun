# Project Containers — Implementation Plan (TODO #38, v2)

Status: **implemented** (Phases 0–4, 2026-07-13; Phase 5 remains deferred).
Code-complete and unit-tested (`cargo test` argv/state suites, tsc); live
Docker QA is the user's (Done ≠ Tested) — see the runtime checklist under
Tests. This v2 supersedes the original docker-exec
plan (see git history of this file): that plan predates the shipped agent
sandbox (`services/sandbox.rs`) and, followed literally, would have built a
second containerization feature next to it. **There is exactly one such
feature.** The project container is an *evolution of the existing sandbox*,
not a sibling: same toggle, same spec, same storage keys, same spawn seam —
widened from "ephemeral container per agent tab" to "one session-lived
container per project that every tab execs into".

## What the toggle means (target behavior)

A project with the toggle on runs **everything** in one closed container:

- All terminal/agent tabs (`shell` and `agent` kinds) exec into a single
  long-lived container named `eldrun-<project-id>`. `local_only` tabs (e.g.
  Ollama `local_agent`) stay on the host verbatim, as today.
- The project directory stays on the **host** and is bind-mounted at its
  **identical absolute path**. The file tree, git UI, viewers, usage watcher,
  and privacy scan keep reading host bytes unchanged — which is what makes
  this a *toggle* (instantly reversible, nothing migrates) rather than a
  data move.
- "Closed" means the container's **reach** is closed — capability-dropped,
  `--init`, pids-limited, optional `--network`/memory/cpu/read-only knobs,
  only the project dir plus the minimal agent auth/state mounts — not that
  the bytes are sealed in a volume. (An agent that must not even *see* host
  bytes is the remote-project shape, out of scope here.)
- Container lifetime = **project session**: created on activation/first
  containerized spawn, torn down (stop + rm) on deactivation and app exit.
  Every session starts from a fresh container, preserving most of the old
  per-tab ephemerality while giving tabs a shared environment (installed
  deps, dev servers) within a session. Persistent-across-restarts containers
  are a later opt-in, not the default.

## Why identical-path mounting (decision, was `/workspace` in v1)

`services/sandbox.rs` already proved the contract: mount `<dir>:<dir>`, run
`--user <uid>:<gid>`, set `-e HOME=<host home>`. Keeping it:

- deletes v1's entire `container_workdir()` path-translation layer;
- keeps **agent session resume** working — Claude/Codex transcripts and the
  SessionStart hook record host-absolute cwds, so the *same* session resumes
  correctly whether the toggle is on or off (with `/workspace`, flipping the
  toggle would invalidate every recorded session);
- keeps `-w <cwd>` per tab trivially correct for subdir tabs.

## Data model — `SandboxSpec` grows, no new struct

`schema/project.rs::SandboxSpec` (and its `types/index.ts` mirror) is the one
spec. Same serde key (`sandbox`) in `project.json` and the `projects.json`
entry `extra`, so **already-enabled sandbox projects upgrade in place** — no
migration. Additions:

```rust
pub struct SandboxSpec {
    pub enabled: bool,
    pub image: Option<String>,          // existing
    /// NEW: in-repo Dockerfile (path relative to the project dir); when set,
    /// `up` builds `eldrun-<id>:latest` from it instead of pulling `image`.
    pub dockerfile: Option<String>,
    pub pids_limit: Option<u32>,        // existing
    pub memory: Option<String>,         // existing
    pub cpus: Option<String>,           // existing
    pub network: Option<String>,        // existing
    pub readonly_rootfs: bool,          // existing
    // compose / pre-existing-container variants: deferred (Phase 5).
}
```

Behavior change to document for existing users: with the toggle on, plain
shell tabs now also run in the container, and the container is shared and
session-lived rather than per-tab ephemeral.

## Module layout — evolve, don't add

- `services/sandbox.rs` keeps its name and its public seam
  (`wrap_pty_options_docker`, called from `commands/terminal.rs::pty_spawn`).
  It gains the lifecycle half; split into `services/sandbox/{mod,lifecycle}.rs`
  only if it outgrows one file.
- **No** `docker_runtime.rs` / `docker_exec.rs` / `commands/docker.rs` from
  the v1 plan. The `pty_spawn` dispatch keeps its current two-way shape
  (sandbox else ssh, `commands/terminal.rs:116-136`) — no third rewriter, so
  the "factor a target-agnostic spawn-rewrite layer first" prerequisite
  (`todo/group-g.md`, #38 preamble) shrinks to a nice-to-have.
- Lifecycle template is `services/remote.rs` (per-project connection opened on
  activation, torn down on deactivate/exit), not `ssh_mount.rs`.

## Phase 0 — fixes to the shipped sandbox (independently shippable)

Bugs found in review that the lifecycle rewrite would touch anyway; land them
first so they're testable in isolation:

- **Preflight misdiagnosis** (`sandbox.rs:384-408`): `docker image inspect`
  fails identically for "image missing" and "daemon down" (`docker --version`
  succeeds daemon-less). Distinguish (check stderr or `docker info`) and say
  "Docker isn't running" when it isn't.
- **Spec-preserving toggle** (`commands/projects.rs::set_project_sandbox`):
  re-enabling currently writes `SandboxSpec::default()`, wiping hand-tuned
  `image`/`memory`/`network`/… . Flip `enabled` only; keep the rest.
- **`--init` + labels** on every container we start (ephemeral ones too):
  `--init` so PID 1 reaps zombies; `--label eldrun.owner=eldrun
  --label eldrun.project=<id>` so anything we started is enumerable.
- **Windows UI gate**: hide/disable the toggle on Windows (backend already
  refuses per #86; the pill menu currently still offers it,
  `ProjectPill.tsx` Runtime group).

## Phase 1 — container lifecycle (the genuinely new code)

`services/sandbox.rs` gains, all argv-building pure and unit-testable:

- `container_name_for(project_id) -> String` — `eldrun-<sanitized-id>`.
- `spec_fingerprint(spec, image) -> String` — stable hash of everything baked
  into `create` (image, mounts, hardening). Stored as a label
  (`eldrun.spec=<hash>`) so `up` can detect a stale container.
- `up(project_id, spec, project_dir) -> Result<String, String>` — idempotent
  three-state machine, returns the container name:
  - **running + fingerprint matches** → no-op;
  - **exists but stopped or fingerprint mismatch** → `rm -f`, then create
    (fresh mounts/spec; also covers crash leftovers);
  - **missing** → create:
    `docker run -d --name <name> --init <labels> <hardening flags>
     --user <uid>:<gid> -e HOME=<home> -w <project_dir>
     -v <project_dir>:<project_dir> <auth/state mounts> <image>
     sleep infinity`.
  - `dockerfile` variant: `docker build -t eldrun-<id>:latest -f <df>
    <project_dir>` first, then run that tag.
- `down(project_id)` / `down_all()` — `docker rm -f` by name / by
  `eldrun.owner` label. Idempotent, best-effort.
- `sweep_orphans()` — at startup, `docker ps -aq --filter
  label=eldrun.owner=eldrun` and remove everything (previous run's containers
  are by definition stale). Also clears `<state_dir>/sandbox-stage/` (fixes
  today's per-tab stage-dir leak; copies are recreated at `up`).

Mount/identity code **reused from today's sandbox**, with two shifts:

- `rw_mounts` / `ro_mounts` / hook shadowing move from per-tab spawn to the
  `create` step (mounts are fixed at `docker run`). Staged config copies
  (`staged_config_mounts`) become **per-project** —
  `<state_dir>/sandbox-stage/<project-id>/` — refreshed from the host
  originals at each `up`.
- Agent-auth env (`host_auth_env`) moves to the **exec** step, not create, so
  rotated tokens are picked up per tab spawn.

## Phase 2 — spawn path: run → exec, and the tab-kill contract

`wrap_pty_options_docker` becomes: resolve spec → `up()` → rewrite to

```
docker exec -i -t -w <opts.cwd> [-e K=V …] <name> <cmd> <args…>
```

(per-tab env: `opts.env`, `TERM`/`COLORTERM`, auth env, `ELDRUN_TAB_UID`).
Session resolution still runs first in `pty_spawn`, unchanged — resume args
ride into the exec argv exactly as they ride into `docker run` today.

**Tab-kill contract (required, not optional).** Killing the PTY child kills
the `docker exec` *client*; Docker does not kill the exec'd process when its
client dies, so a closed tab would leave the agent running inside the
container until session end. Wrap the command so Eldrun can kill it:

```
docker exec … <name> sh -c 'echo $$ > /tmp/eldrun-tab-$ELDRUN_TAB_UID.pid; exec "$@"' sh <cmd> <args…>
```

and on tab close (PtyRegistry kill path, containerized tabs only) run
`docker exec <name> sh -c 'kill -TERM -- -$(cat /tmp/eldrun-tab-<uid>.pid)'`
best-effort. (`/tmp` is in-container, ephemeral with it.) The same signal gap
exists for today's per-tab sandbox (`--rm` relies on the *container* exiting,
and TTY-mode docker doesn't proxy signals) — the session-scoped `down()` +
startup sweep is what finally bounds it.

## Phase 3 — wiring + frontend scope change

- `services/project_runtime.rs::switch` — best-effort `up()` when activating
  a toggled project, `down()` for the project being left. Runs on the
  existing worker thread (never the main thread — cf. the remote sync-command
  freeze lesson). Spawn-path `up()` remains the fallback for tabs opened
  before activation completes.
- `lib.rs` `RunEvent::Exit` — `down_all()`; startup — `sweep_orphans()`.
- `CenterPanel.tsx` — the per-tab flag changes gate from
  `tab.kind === "agent"` to *any* non-`local_only` tab of a toggled,
  non-remote project. Prop/field can keep the name `sandbox`.
- `ProjectPill.tsx` — label becomes "Run this project in a container";
  keep it hidden for remote projects (and on Windows, Phase 0).
- **Respawn caveat**: the flag is in `TerminalView`'s spawn-effect deps, so
  flipping the toggle respawns every live tab. Claude/Codex resume; Gemini/
  Vibe would lose their conversation — confirm before flipping when such tabs
  are live (same hazard class `tabs/agentModes.ts` exists for).

## Phase 4 — spec sources & UX

- Auto-detect an in-repo `Dockerfile` / `.devcontainer/devcontainer.json`
  (image field only) as the container source when the toggle is first
  enabled; else default image (`eldrun-agent-sandbox:latest` — the existing
  reference image already fits: agent CLIs, no ENTRYPOINT).
- Preflight "image missing" failure offers the one-click
  **open-new-tab-paste-run** build flow (house convention — never a
  copy-it-yourself message), building from `docker/agent-sandbox` when
  present in-repo or from an embedded copy of the reference Dockerfile
  otherwise (an installed app has no repo checkout).
- Minimal spec UI (project context menu or dialog section): image override,
  network (`none`/custom), memory/cpus, read-only rootfs — the knobs exist in
  `SandboxSpec` today but are hand-edit-only, and Phase 0's spec-preserving
  toggle is what makes exposing them safe.

## Phase 5 — deferred

- **Compose / pre-existing container** variants (exec into a named service /
  an externally managed container; no lifecycle owned).
- **Persistent containers** (opt-in: skip `down()` on deactivate; needs a
  "recreate container" action for spec changes).
- **Remote Docker** (container on an SSH host): compose the exec argv with
  `ssh_exec`'s wrapping (`ssh -tt <host> docker exec …`); bind-mount source
  is the remote path. Only at this point does the target-agnostic
  spawn-rewrite refactor (`todo/group-g.md` #38 preamble) become load-bearing.
- **Windows** (#86): path mapping into a Linux container + `--user` story;
  needs a Docker Desktop box; stays refused until then.

## Security notes (carried + new)

- Keep all of today's hardening at create: `--security-opt
  no-new-privileges`, `--cap-drop ALL`, `--pids-limit`, socket never mounted,
  hooks dir ro, settings shadow-copied.
- Known residual (pre-existing): the rw `~/.claude` mount lets a compromised
  agent persist host-loaded content (`commands/`, `skills/`, `plugins/`,
  `CLAUDE.md`) even though hook registration is shadowed. Consider ro-mounting
  those subpaths at create; decide before, not after, shells share the
  container.
- Default bridge network reaches host-bound services via the gateway IP
  (Ollama, dev servers). Document next to the `network` knob; "closed" users
  set `network: none` (breaks cloud agents) or a custom allowlist network.
- Verify live (Done ≠ Tested): container `$HOME` itself is a root-owned
  auto-created dir — check `~/.claude.json` / `~/.gitconfig` writes from
  inside; if broken, add them to the staged/ro mounts.

## Tests

`cargo test` (no daemon — pure argv/state assertions):

- `container_name_for` / label / `spec_fingerprint` derivation + stability.
- `up` decision table (running-match / stopped / mismatch / missing) with
  injected probe results.
- Create argv: identical-path mount, `--init`, labels, hardening flags,
  per-project staged mounts; exec argv: `-w`, per-tab/auth env, kill-wrapper
  shape, resume args preserved in order.
- Per-project stage dir: refresh-at-up, single copy per file.
- `SandboxSpec` round-trip with `dockerfile`; legacy specs (no new fields)
  parse unchanged.
- Toggle preserves spec fields (Phase 0).
- `local_only` and remote projects bypass wrapping (existing tests keep
  passing).

`npx tsc --noEmit` for the frontend gate change. Runtime QA is the user's
(agents must not launch Eldrun): toggle on → shell tab runs in-container
(hostname differs), agent resumes across toggle flips, host edits show in the
file tree, tab close kills the in-container process, project switch and app
exit remove the container, `docker ps -a` clean after relaunch.

## Open questions — resolved at implementation

- Confirm-before-respawn UX: a **native confirm dialog** (plugin-dialog
  `confirm`, warning kind) listing the doomed non-resumable agent tabs by
  command, shown on both flip directions; cancel aborts the flip.
- `down()` on deactivate is **immediate, but guarded on liveness**: it is
  skipped while any PTY of the leaving project is still alive
  (`PtyRegistry::any_live_for_scope`) — a background agent keeps its container
  until its tabs end or the app exits. That guard, not a debounce, is what
  keeps rapid switching from churning a container someone is still inside;
  an *idle* project's container is torn down at once (cheap to recreate, and
  `up()` at activation warms it again).
- Podman: **deferred until someone asks** (no `engine` field; nothing in the
  implementation would resist adding one).
