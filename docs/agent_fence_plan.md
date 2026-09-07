# Agent Fence — confine agents to their project (or their box)

Status: implemented 2026-08-31. The durable design rationale now lives in
`docs/context/agent_authority.md` (4th axis) and live QA is tracked in
`todo/group-s-agents.md` #204. This file remains the implementation record and
verification matrix.

---

## 1. Context

Today an agent tab (Claude, Codex, Gemini, …) spawned in a project runs as an
ordinary host process: it can read and write anything the user can — other
projects, `~/.ssh`, the keyring socket. The only existing confinement is the
opt-in Docker container tier (`services::sandbox`), which is heavy and off by
default. Now that **project boxes** define the one legitimate cross-project
set (box folder + member roots, `commands::boxes::box_allowed_roots`), the
policy becomes:

> An agent may touch **its project**, or — when the project is a box member —
> **the whole box** (read+write, union over every box it is in). Everything
> else is out of reach, enforced by the OS, on by default.

Decisions taken with the user (2026-08-31):

- **Box reach** = whole box, read+write, for member-scoped *and* box-scoped
  agent tabs; a project in several boxes gets the union.
- **Default** = on: global setting default ON, per-project inherit/off/on
  override (the `remote_control` pattern, O#59). Running tabs are untouched
  until they respawn.
- **Enforcement** = bubblewrap on Linux for local runs. macOS, Windows and
  agents running on a remote SSH host are *not* fenced; the UI says so plainly
  instead of pretending. Box `--add-dir`/`--include-directories` are passed on
  every platform so agents know their working roots.

Verified on the dev machine (Ubuntu 26.04, bwrap 0.11.1): an outer
`bwrap --ro-bind / / --tmpfs $HOME --bind <proj> <proj> --unshare-pid …` works
unprivileged; `~/.ssh` vanishes, `/` is read-only. A **nested** bwrap fails
(`bwrap-userns-restrict` AppArmor profile), so Claude Code's own bubblewrap
sandbox cannot run inside the fence — it falls back to unsandboxed *inside*
the fence (harmless: the outer boundary holds), and `docker` commands inside a
fenced agent fail. Both go in the docs.

Scope is agents only (tab kind `agent`/`local_agent`, or a recognised agent
binary by `cmd`). Shell tabs stay the user's own, unfenced. The fence is
filesystem-only: network is shared (no `--unshare-net`), stated in the docs.

## 2. Design

### 2.1 Authority: a 4th axis, decided in the backend

`services::agent_fence` (new, AppHandle-free, unit-testable like
`services::sandbox`). `pty_spawn` (`src-tauri/src/commands/terminal.rs`)
already resolves `sandbox`/`local_only` from the state-dir `projects.json`
(`enforce_spawn_authority`); the fence is resolved the same way, never from
the renderer.

```
FenceDecision = Fenced { roots } | NotApplicable { reason } | Unavailable { install_hint }
```

`decide(opts, policy_on, platform_linux, bwrap_ok)` (pure, tested):

- not an agent → `NotApplicable("shell")`. Agent = `sandbox::is_agent_cmd(cmd)`
  || `HOST_BOUND_LOCAL_AGENT_CMDS` contains the basename || new
  `opts.agent: bool` (renderer-declared kind; restriction-only, so a lying
  renderer can only *lose* the fence for a shell — same posture as today);
- `opts.sandbox` (container on) → `NotApplicable("container")` — already confined;
- remote run (`remote_target_for(pid).is_some() && !local_only`) →
  `NotApplicable("remote host")`;
- non-Linux → `NotApplicable("platform")`;
- policy off → `NotApplicable("off")`;
- bwrap missing / probe failed → `Unavailable` → **fail closed**: `pty_spawn`
  returns an error naming `sudo apt install bubblewrap` (the container tier's
  "docker missing → error, never silently run on the host" posture; the user
  can flip the project override off).

Policy: `fence_effective(list, project_id, global_default)` — a copy of
`agent_remote_control_effective` (`commands/terminal.rs:42`) reading
`entry.extra["agent_fence"]`; global from `Settings::agent_fence()` (default
`true`). Box scopes (`box:<id>`) use the global only (a box has no entry).

### 2.2 Roots

`compute_fence_roots(boxes, projects, scope_id) -> Option<Vec<PathBuf>>` (pure):

- `box:<id>` → `boxes::box_allowed_roots(id)` (box folder, member roots,
  remote members' mirrors — already `pub(crate)`).
- project id → own dir (`sandbox::project_dir_for`, or
  `remote_sync::mirror_dir` for a `local_only` tab of a remote project) ∪
  `box_allowed_roots(b.id)` for every box with `member_ids.contains(id)`.
  Dedupe; `None` for an unknown project/box → fail closed (spawn error), same
  as the O#149 cwd gate above it.

### 2.3 The wrapper (Linux only)

`wrap_pty_options_bwrap(opts, roots, extra_ro, mounts)` rewrites
`opts.cmd/args` to `bwrap … -- <cmd> <args>` (`opts.env` stays — bwrap
inherits it; add `ELDRUN_AGENT_FENCE=1`). Argv built by a pure `bwrap_args(..)`
with a golden test. Order matters (later mounts shadow earlier):

```
--ro-bind / /                       whole host read-only (toolchain in /usr,/opt,/etc)
--dev /dev  --proc /proc
--tmpfs /tmp                        private; hides X11/ssh-agent sockets, gives $TMPDIR
--tmpfs /run                        hides /run/user/<uid> (keyring, dbus), docker.sock
--ro-bind-try /run/systemd/resolve /run/systemd/resolve   keeps DNS (resolv.conf symlink)
--tmpfs $HOME                       empty home; writes anywhere in it succeed and vanish
--ro-bind-try <p> <p>               each allowlisted toolchain/config path
                                    (Settings.agent_fence_paths, defaults below)
--bind <src> <dst> / --ro-bind …    agent state: REUSE the sandbox.rs mount builders
--ro-bind <state_dir>/hooks         hook script immutable (same RCE note as the container)
--bind <root> <root>                each fence root, rw (--bind-try: a missing member is skipped)
--unshare-pid --die-with-parent --chdir <cwd>
-- <cmd> <args…>
```

Never `--new-session` (setsid would detach the PTY's controlling tty).

Default `agent_fence_paths` (ro): `~/.local/bin`, `~/.local/share/pnpm`,
`~/.nvm`, `~/.cargo`, `~/.rustup`, `~/anaconda3`, `~/miniconda3`, `~/.pyenv`,
`~/.bun`, `~/go`, `~/.gitconfig`, `~/.config/git`. Not included by design:
`~/.ssh`, `~/.config/gh`, `~/.aws`, `~/.config/gcloud` — the user adds them
per machine if an agent must push over SSH (documented in the settings help).

Agent state reuses `services::sandbox` verbatim (make these `pub(crate)`):
`rw_mounts` (narrowed `~/.claude`, `~/.codex`, Gemini creds, per-project
`live_sessions` remap), `ro_mounts` (hooks), `staged_config_mounts` +
`stage_dir` (writable shadow copies of `~/.claude/settings*.json` and
`~/.codex/config.toml` — closes the repoint-the-SessionStart-hook escape),
`claude_transcript_mounts` + `claude_projects_stage` (this project's
transcript dirs rw, every other project's ro, stage dir as mount parent so a
brand-new transcript dir lands on the host). Two small refactors:

- `claude_transcript_mounts` takes `roots: &[String]` ("ours" = cwd within
  *any* root); the docker caller passes one.
- Harvest: use `sandbox::stage_dir(scope_id)` so the existing
  `harvest_all_transcripts` (app exit + startup sweep) already covers fence
  stages; additionally harvest on tab exit — `agent_fence` keeps
  `fenced_tabs: tab_id → scope_id` (like `sandbox::exec_tabs`) and the
  exit/kill paths (`terminal/mod.rs` `terminal-exit`, `pty_kill`) call
  `agent_fence::on_tab_gone(id)` → `harvest_project_transcripts`.
  `sanitize_key(scope_id)` works for `box:<id>` too.

Integration point in `pty_spawn`: after the docker/ssh branch and **before**
the tmux wrap (so the tmux server stays on the host and the command *inside*
tmux is the bwrap line), guarded `#[cfg(target_os = "linux")]` and
`opts.cmd != "ssh" && opts.cmd != "docker"`. Trash tabs run containerized
(`sandbox: true`) → not fenced (already contained).

### 2.4 Box working roots for the agents themselves (all platforms)

The OS fence lets an agent *reach* a sibling, but Claude's `Edit` refuses paths
outside its working dirs unless told. In `pty_spawn`, next to the
`--remote-control` injection (before wrapping, after session resolution), for a
**local** run whose fence roots have >1 entry: append per root ≠ own dir —
`claude`/`codex`: `--add-dir <root>`; `gemini`: `--include-directories <root>`.
Idempotent (skip if already present). Table lives in `agent_fence`
(`box_root_args(cmd) -> Option<&str>`), tested. Skipped for remote runs (local
paths mean nothing there) and for unknown agents.

### 2.5 Persistence / schema

- `schema/settings.rs`: `agent_fence: Option<bool>` (accessor default `true`),
  `agent_fence_paths: Option<Vec<String>>` (accessor → defaults when absent;
  `~` expanded at use via `paths::home_dir()`).
- Per-project override in `projects.json` entry `extra["agent_fence"]` +
  mirrored `Project.agent_fence: Option<bool>` (`schema/project.rs`, next to
  `remote_control`). New command `set_project_agent_fence` cloning
  `set_project_remote_control` (`commands/projects.rs`,
  `patch_project_entry_mirrored`); registered in `lib.rs`.
- New command `agent_fence_status(project_id) -> { enforced, reason, roots,
  bwrap_available }` for honest UI (runs `decide` with a synthetic agent
  spawn; bwrap probe cached in a `OnceLock`).
- `PtyOptions.agent: bool` (`terminal/mod.rs`, `#[serde(default)]`).

### 2.6 Frontend

- `TerminalView.tsx` spawn payload: `agent: kind === "agent" || kind === "local_agent"`
  (thread `kind` in like `sandbox`; the detached/attach paths pass the same Props).
- `types/index.ts`: `Settings.agent_fence?`, `Settings.agent_fence_paths?`,
  `Project.agent_fence?`.
- `stores/projects.ts`: `setProjectAgentFence` cloning `setProjectRemoteControl`.
- Settings → Manage Agents (`SettingsSubPanels.tsx`, beside
  `ClaudeRemoteControlNotice`): `AgentFenceCard` — global toggle, allowlist
  editor (one path per line, "reset to defaults"), help text stating what is
  hidden (`~/.ssh`, tokens, keyring, other projects), that box members are
  shared, that it is Linux-only/local-only, and that Claude's own sandbox and
  `docker` don't work inside it. `UntestedTag`.
- Project pill menu (`ProjectPill.tsx`): a cycling "Agent fence
  (default)/on/off" button copying the remote-control button; label suffix
  from `agent_fence_status` when not enforceable ("not enforced: remote host"
  / "…: macOS"); when `bwrap_available === false` an extra row "Install
  bubblewrap…" → `runInstallInTab("bubblewrap", "sudo apt install -y bubblewrap", "bash")`
  (install-via-tab policy).
- Box editor: reword `boxEditor.trustNotice` — box tabs are fenced to the
  box's roots (not "uncontained"); members' container/VM still don't apply.
- All strings via `i18n.ts` (English keys; other dicts fall back).

### 2.7 Docs / backlog

- `docs/context/agent_authority.md`: the fence as the 4th axis and how it
  composes (container ⇒ fence skipped; remote ⇒ not enforced; box ⇒ union).
- `AGENTS.md` Backend notes: one line (`services::agent_fence` is the bwrap
  fence; roots come from `box_allowed_roots`; fail closed on missing bwrap).
- `src-tauri/CLAUDE.md` file map: `services/agent_fence.rs`.
- `todo/group-s-agents.md`: the feature item + QA sub-items (§4);
  `todo/group-a-boxes.md`: cross-reference.

## 3. Files

Backend (new): `src-tauri/src/services/agent_fence.rs` (+ `services/mod.rs`).
Backend (edit): `commands/terminal.rs` (decide + add-dir injection + wrap +
status command + exit harvest), `services/sandbox.rs` (visibility, multi-root
transcripts), `terminal/mod.rs` (`agent` field), `schema/settings.rs`,
`schema/project.rs`, `commands/projects.rs`, `lib.rs`.
Frontend (edit): `components/terminal/TerminalView.tsx`, `types/index.ts`,
`stores/projects.ts`, `components/layout/SettingsSubPanels.tsx`,
`components/projects/ProjectPill.tsx`, `lib/i18n.ts`, the box editor holding
`boxEditor.trustNotice`.
Docs: `docs/context/agent_authority.md`, `AGENTS.md`, `src-tauri/CLAUDE.md`,
`todo/group-s-agents.md`, `todo/group-a-boxes.md`.

## 4. Tests and verification

Rust (`agent_fence` tests + `commands/terminal.rs` tests):

- `bwrap_args` golden: `--tmpfs $HOME` precedes every `$HOME/…` bind; each
  root bound rw; hooks ro; `--chdir cwd`; no `--new-session`; `--` before cmd.
- `compute_fence_roots`: plain project → own dir only; member of two boxes →
  union incl. box folders + remote mirrors; `box:<id>` → box roots; unknown → None.
- `decide` matrix: shell → NotApplicable; container on → NotApplicable; remote
  non-local → NotApplicable; local_only tab of remote project → Fenced(mirror);
  policy off → NotApplicable; agent + bwrap missing → Unavailable;
  `agent: true` with a custom cmd → Fenced.
- `fence_effective`: override precedence (project false beats global true, …).
- add-dir injection: per-agent flag; idempotent; skipped when one root.
- `claude_transcript_mounts` multi-root: a transcript cwd inside root #2 is rw.
- Existing `sandbox.rs` tests keep passing after the visibility/refactor.

Frontend (vitest): pill menu label states from `agent_fence_status`; settings
card round-trips `agent_fence_paths`.

Automated gates: `npm run build`, `npm test`, `cargo test --manifest-path
src-tauri/Cargo.toml`, `npm run lint`, `cargo clippy … -D warnings`,
`git diff --check`. Then `npm run backend:stale` and report it — backend edits
are not live until the user restarts; agents never launch or restart Eldrun.

Live QA (user, after a deliberate restart):

1. Plain local project, Claude tab: `ls ~` shows only allowlisted dirs;
   `cat ~/.ssh/id_ed25519` → No such file; `ls ~/eldrun/projects/<other>` →
   missing; an edit inside the project works; `/rename` + the SessionStart
   hook still record the id (the tab resumes after a respawn).
2. Same in a Codex tab and a Gemini tab.
3. Box with two members: an agent tab in member A lists and edits member B and
   the box folder; `--add-dir` visible in the `claude` args; a box-scoped tab
   likewise.
4. Pill menu: inherit → off → on cycles; an "off" project's agent sees `~`.
5. Remote project agent tab: the menu says "not enforced: remote host"; the
   spawn works.
6. Container-toggled project: the fence is skipped, the container still applies.
7. With bwrap absent (or `agent_fence_paths` hiding `~/.local/bin`), the spawn
   error is readable and the "Install bubblewrap…" row appears only when bwrap
   is missing.
8. A shell tab of the same project is unfenced.

Until each passes, the feature carries `UntestedTag`.

## 5. Out of scope (stated, not silently dropped)

- macOS `sandbox-exec` / Windows fence; fencing agents on remote SSH hosts
  (bwrap on the far host, often disallowed on HPC login nodes).
- Agent-native confinement flags as a portable floor (Claude `--settings`
  sandbox, Codex `--sandbox workspace-write`) — user chose bwrap-only.
- Network isolation; per-project allowlist paths (global list only in v1).
- Fencing shell tabs.
