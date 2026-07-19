# ProjectEldrun

## Purpose

ProjectEldrun, or Eldrun, is a Tauri 2 desktop workspace for AI-assisted
development. It manages a root control terminal, one terminal per active
project, a bottom project switcher, a right-side project file viewer, global
app launching, file opening, time tracking, and optional workspace/backend
integration in one window.

The product thesis is project-scoped desktop context: opening a project should
swap the relevant terminals, files, apps, downloads/default-app behavior, and
time tracking together.

## Load-Bearing Docs

- Root project context: `CLAUDE.md`.
- Frontend file map: `src/CLAUDE.md`.
- Backend file map: `src-tauri/CLAUDE.md`.
- Architecture/user documentation: `DOCUMENTATION.md`.
- Work plan and grouped TODO conventions: `TODO.md` and `todo/`.
- Remote/multi-host plan: `docs/multi_host_remote_plan.md`.
- Remote lockstep case matrix: `docs/git_lockstep_case_matrix.md`.
- Container plan: `docs/docker_projects_plan.md`.

Read the relevant map before editing unfamiliar code. The maps intentionally
list only load-bearing files; the tree is still the source of truth.

## Current Architecture

- The frontend is React/TypeScript under `src/`.
- The Tauri/Rust backend is under `src-tauri/`.
- Frontend layout lives mainly in `src/components/layout/`, especially
  `AppShell.tsx`, `HeaderBar.tsx`, `CenterPanel.tsx`, `RightPanel.tsx`,
  `ProjectSwitcher.tsx`, and `GlobalAppBar.tsx`.
- Terminal UI lives in `src/components/terminal/TerminalView.tsx`; terminal
  backend commands live in `src-tauri/src/commands/terminal.rs` and
  `src-tauri/src/terminal/`.
- File browsing/viewing UI lives in `src/components/files/` and is shared by
  the right panel, Files tabs, and per-subwindow file sidebars.
- Filesystem commands live mostly in `src-tauri/src/commands/projects.rs` and
  `src-tauri/src/commands/fs.rs`.
- External app launching and tracked windows live in
  `src-tauri/src/commands/apps.rs`.
- Settings and persisted schema types live in `src/stores/`, `src/types/`, and
  `src-tauri/src/schema/`.
- Workspace integration lives in `src-tauri/src/platform/`. X11 and KDE
  Wayland paths are best-effort; unsupported desktops fall back to the null
  backend.

## State And Project Conventions

- Managed projects normally live under `~/eldrun/projects/<sanitized-name>/`.
  The root terminal uses `~/eldrun/root/`.
- Global state lives in `~/.local/share/eldrun/`, especially `projects.json`,
  `settings.json`, `default_apps.json`, `time_log.json`,
  `active_session.json`, and `usage_stats.json`.
- Usage stats are local-only rolling hour/day counters behind the daily recap.
  Do not mix them with time (`time_summary.json`), network bytes
  (`net_usage.json`), or git stats, which are read from their own sources.
- Project-local state lives in each project's `project.json`. This includes
  `open_apps`, `tab_layout`, `tab_groups`, remote specs, runtime/container
  settings, and per-project file-viewer settings.
- New/imported projects are scaffolded with `AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`, `.claude/settings.json`, `.gitignore`, `TODO.md`, `ROADMAP.md`,
  `STATUS.md`, and `README.md` when missing.
- Box agent docs contain generated link blocks between
  `<!-- eldrun:box-links:start -->` and `<!-- eldrun:box-links:end -->`; preserve
  user edits outside those blocks.
- `TODO.md` uses grouped IDs such as `G1.1`. When adding a TODO, place it in
  the matching group, create a new group if no current group fits, or merge
  groups if the TODO depends on distinct areas that should be tracked together.
- Avoid unrelated rewrites in docs, generated state, built assets, project
  metadata, `dist/`, `target/`, and backup files.

## Runtime Safety

- Do not launch Eldrun from an agent terminal for verification. Opening a
  second Eldrun instance can corrupt workspace state.
- Do not run `npm run tauri`, `npm run dev`, `cargo tauri dev`, or
  `./start-eldrun-tauri.sh` unless the user explicitly asks and confirms it is
  safe to launch a new instance.
- Frontend (`src/`) changes hot-reload in the running instance, so do not ask
  the user to restart just to see TSX/CSS edits.
- Backend (`src-tauri/`) changes require the user to rebuild/restart the
  existing instance for runtime validation. Ask for that only when runtime QA is
  needed.
- Runtime launch commands are human-only by default.

## Development Workflow

- Use `rtk` before shell commands, per the included RTK instructions.
- Prefer small, focused changes that match the existing React/TypeScript and
  Rust/Tauri style.
- Use `rg` for code search.
- When changing frontend behavior, prefer local component state and existing
  Zustand stores over adding new global state.
- When changing backend commands, keep Tauri command payload names compatible
  with the camelCase keys used by the frontend.
- Preserve Python-era JSON shapes where the Rust schema already supports them;
  existing user state should round-trip cleanly.
- Keep service modules `AppHandle`-free and unit-testable where that is the
  established boundary.
- Git commit authors for this public-bound repo must use the GitHub noreply
  email, never the user's real address.

## Remote, Sync, And Runtime Model

- Remote SSH projects are mount-free. Agent/terminal tabs run on the host over
  SSH, file browsing/I/O goes over SFTP, and git runs on the host over SSH, all
  using pooled ControlMaster/SFTP sessions in `services::remote`.
- Remoteness is explicit: use `services::remote::remote_target_for{,_dir}` and
  host-aware variants. Do not infer it from path conventions.
- A remote project's `remote` is the primary host. Extra `compute_hosts` are
  worker machines for experiments; each has its own pool entry, connection lamp,
  and tab locality (`host:<id>`).
- Worker sync is one-way code fan-out from the mirror to the worker for tracked
  files only. It uses git bundle/reset, never `git clean`, and avoids the
  bidirectional divergence/local-loss path.
- Shared-filesystem workers are the default in the add-machine UI. They see the
  primary folder at their own `remote_path`; do not run git init/reset/fan-out on
  them. Tabs simply `cd` into the shared folder.
- Git lockstep owns git-tracked files and moves commits/refs semantically via
  bundles. Byte-sync owns everything else and moves raw bytes. Keep the
  `drop_tracked` split intact so the two transports never race for one file.
- With lockstep on, a saved edit to a tracked file reaches the peer only after
  it is committed. Do not "fix" this back into continuous byte mirroring.
- Byte-sync is opt-in per path from the explicit manifest. It does not read
  `.gitignore`; preview and confirm large scopes before pulling big host trees.
- Local-loss warnings are file-backed, not events. Destructive background git or
  sync moves must record through `services::local_loss` so losses surface after
  relaunch.
- Passwords are never persisted by default. Saved SSH/OpenVPN credentials are
  keyed by host/config target, not project id; a blank password can mean "use
  saved credential".
- Remote auto-connect and VPN auto-connect must never prompt. Check the
  silent-connect predicates before attempting them.
- OpenVPN tunnels are machine-wide. The header `VpnIndicator` owns visibility
  and lifecycle across projects; project UI must not imply the tunnel is
  project-scoped.
- Never elevate for a connect that cannot succeed silently. `pkexec` prompts
  before OpenVPN validates config/credentials.
- Containerized projects use one session-lived Docker container per local
  project and bind-mount the project at the identical absolute path. File
  viewers/git/usage watchers keep reading host bytes. The toggle is local-only
  and hidden/refused on unsupported platforms.

## Tabs, Agents, And Restore

- Shell/files tabs restore on relaunch. Claude and Codex agent tabs with a
  `sessionId` are resumable and restored; Gemini and Vibe restore behavior is
  more limited unless the relevant code explicitly says otherwise.
- Eldrun installs Claude/Codex session hooks and also has hook-free Codex
  binding. Codex user hooks may need one-time trust via `/hooks`.
- Agent authority has three axes: project container sandbox, tab location
  (local/primary/worker), and optional Plan/Auto agent mode.
- `components/tabs/agentModes.ts` is a capability table. Add an agent there only
  if it has an absolute mode flag and a working resume path for the respawn that
  mode switching causes.
- Plan/Auto is a launch flag, persisted per tab, and re-applied when args are
  rebuilt from layout state. Do not persist raw args as the source of truth.

## Frontend Notes

- The right panel and Files (Project) tab share `ProjectFilesView`; keep file
  viewer features in the shared component so surfaces do not drift.
- `ProjectFilesPane` owns the tree/sort/source mechanics; panel/tab hosts own
  only identity, active state, browsed folder, and chrome slots.
- Remote/SFTP/git probes must be gated when disconnected; synchronous Tauri
  commands against a dead session can freeze the window.
- GPU UI reports whole-device memory and optional sensors from `gpustat`, not
  only Ollama model memory. Omit missing sensor readings; do not render fake
  zeroes.
- File viewer parsers such as YAML and table editing are text-preserving views.
  Keep edits surgical so comments, delimiters, quoting, and line endings survive.
- Python Run/Debug opens a terminal tab and asks the backend for interpreter
  precedence. Do not duplicate interpreter-ranking logic in the frontend.
- Experimental features should use `useExperimental`; unset flags fall back to
  debug mode.

## Backend Notes

- `commands/` expose Tauri command handlers; `services/` hold reusable runtime
  logic; `schema/` mirrors persisted JSON.
- `services::remote` is the source of truth for SSH/SFTP pooling and host-aware
  remote resolution.
- `services::worker_sync` is push-only source-to-worker code sync. Shared-FS
  workers must be skipped defensively even if a command reaches the service.
- `services::git_peer` owns lockstep and must preserve the tracked/untracked
  boundary with byte-sync.
- `services::openvpn` tracks both headless tunnels and interactive terminal
  tunnels armed with Eldrun-owned pid files.
- `services::sandbox` owns Docker runtime lifecycle. Tab close must reap
  in-container processes via the existing wrapper/pidfile mechanism.
- Terminal `kill`/`kill_all` must reap the child process subtree, not just the
  shell leader.
- Remote GPU snapshots are parsed through the same local `gpustat` parsers so
  host readings match local readings field-for-field.

## Verification

Run checks that apply to the files changed before handing off:

```bash
rtk npm run build
```

```bash
rtk cargo test --manifest-path src-tauri/Cargo.toml
```

For whitespace checks, also run:

```bash
rtk git diff --check
```

For frontend-only risky changes, also consider targeted Vitest/TypeScript
checks if faster than a full build. If `cargo` or another tool is unavailable,
state that clearly in the final handoff.

Before every push, run the privacy/secret scan on staged changes and stop if it
reports anything real:

```bash
rtk git add -A
rtk scripts/privacy-check.sh
```

Every push to GitHub should generate a new packaged artifact from
`.github/workflows/ci-cd.yml`. The local equivalent is `npm run package`, which
installs the packaged AppImage outside the checkout so branch switches do not
affect the running app.

Version bumping is automatic on push when `.githooks/` is enabled with
`git config core.hooksPath .githooks`: the pre-push hook patch-bumps
`package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, commits
that bump, and re-pushes. To bump minor/major, run
`scripts/bump-version.sh minor|major` and commit before pushing.

GitHub Releases are cut manually only when a `v*` tag is pushed; ordinary branch
pushes do not publish releases.

## Running Locally

Human-only by default. Agents must not run these while an Eldrun instance may
already be active.

Preferred Tauri launcher:

```bash
./start-eldrun-tauri.sh
```

Development run:

```bash
npm run tauri dev
```

Useful keys: `F11` toggles fullscreen; `Super` toggles panels while Eldrun is
focused.
