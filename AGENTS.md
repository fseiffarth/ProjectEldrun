# ProjectEldrun — Agents

Canonical instructions for every AI coding agent working in this repository.
The agent-specific files are pointers to this one — write guidance **here** so
every agent reads the same text instead of separate copies drifting apart.

## Project

Eldrun is a Tauri 2 + React + TypeScript desktop workspace for AI-assisted
development. Around the core — a root control terminal, per-project terminal
and agent tabs, a project switcher, file tree and viewers, app launching, time
tracking, and best-effort X11/KDE workspace integration — it has grown an
embedded mail client, a calendar/CalDAV + to-do board, an in-app browser, an
Agent Skills library, printing, a deck presenter, TeX/PDF workspaces, and
Ollama/GPU/SLURM monitoring. An opt-in companion PWA (`mobile-web/`) reaches
the same agent tabs from a phone through a loopback sidecar.

The product thesis is project-scoped desktop context: opening a project should
swap the relevant terminals, files, apps, default-app behavior, and time
tracking together.

## Running

**Agents must never start Eldrun** (user, 2026-07-29) — not via
`./start-eldrun-tauri-hotreload.sh`, not via `npm run tauri:dev`, not
backgrounded, not "just to check one thing". **Never stop an instance you did
not start**, either: a running window holds the user's open tabs and live
terminals. The app's lifecycle is the user's alone.

To verify something live, ask the user to launch Eldrun (or use a window they
already have open) and report back, or hand them the exact steps to click
through. Otherwise report the automated gates only, and say plainly that the
change was not run live.

- `src/` changes hot-reload into a running window — don't ask for a restart.
- `src-tauri/` changes do not: `tauri dev` runs with `--no-watch`, because its
  Rust watcher rebuilds *and relaunches the window* on any backend write,
  taking the user's open tabs with it. Backend edits accumulate harmlessly
  until the user restarts deliberately. `tauri:dev:watch` is the opt-in
  escape hatch.
- The cost is a backend fix that compiles and is silently not in the window.
  **Run `npm run backend:stale` after backend edits and report the result**;
  never restart the app to apply them.
- Double-starts are blocked by `scripts/guard-single-instance.sh` (wired into
  the launcher and the `pretauri:dev` hook). It also refuses when port 1420 is
  held by an orphaned vite — a second `tauri dev` would otherwise attach to the
  *first* session's dev server and silently render its stale module graph.

## Docs

`src/CLAUDE.md` (frontend) and `src-tauri/CLAUDE.md` (backend) are the file
maps — read the relevant one before editing unfamiliar code. Both list only
load-bearing files; the tree is the source of truth. `CLAUDE.md` and
`GEMINI.md` are thin pointers that `@AGENTS.md`-import this file.

Each `docs/context/*.md` holds one subsystem's design rationale — *why* it
works that way, not discoverable from the code. Open only the one matching the
area you're touching; never read speculatively.

| Doc | Covers |
|-----|--------|
| `usage_stats.md` | Local-only rolling counters behind the daily recap. |
| `remote_projects.md` | SSH/SFTP-native, mount-free remote projects (no sshfs). |
| `git_sync.md` | Git lockstep + byte-sync: the two transports keeping a mirror in step. |
| `remote_credentials.md` | Locked keychain, password-persistence opt-in, SSH_ASKPASS, host keys. |
| `remote_autoconnect.md` | When a remote project connects itself; headless vs. not; VPN probing. |
| `openvpn.md` | Machine-wide tunnel lifecycle, connect-on-launch, single-polkit teardown. |
| `agent_sessions.md` | Resumable Claude/Codex tabs surviving relaunch via the SessionStart hook. |
| `multi_host_remote.md` | Worker/compute hosts: push-only sync, read-only files, pull-outputs. |
| `tmux_sessions.md` | Shell/script tabs surviving SSH drops and crashes; Sessions view. |
| `docker_containers.md` | Per-project session container: toggle semantics, lifecycle. |
| `vm_projects.md` | The VM trust tier: no shared fs, inverse sync posture, egress knob. |
| `agent_authority.md` | How sandbox / tab location / agentMode compose. |
| `hpc_careful_mode.md` | What probes stop collecting on a login node; host classification. |
| `mail_encryption.md` | The sealed local store and the OpenPGP track: what each protects. |
| `caldav.md` | Why a sync merges by resource URL instead of replacing. |

Longer-lived plans and matrices live in `docs/` — e.g.
`multi_host_remote_plan.md`, `git_lockstep_case_matrix.md`,
`eldrun_mobile_agent_plan.md`. Project docs:
`README.md`, `DOCUMENTATION.md`, `ROADMAP.md`, `STATUS.md`, and `TODO.md` —
whose per-group files live in `todo/`.

## Architecture

- Frontend: React 18 + TypeScript + Vite + Tailwind, Zustand stores, xterm.js
  (fit/webgl/canvas/web-links addons) under `src/`.
- Backend: Rust + Tauri v2 under `src-tauri/`, with `portable-pty` for PTYs and
  `zbus` (DBus) / `xcb` (X11) for desktop integration.
- `commands/` expose Tauri command handlers; `services/` hold reusable runtime
  logic; `schema/` mirrors persisted JSON.
- The backend keeps a registry of live PTYs the frontend reconnects to by id —
  that is what lets tabs survive a reload. Tabs are scoped either to "root" or
  to a specific project id.
- Workspace integration lives in `src-tauri/src/platform/`: `x11.rs`
  (EWMH/NetWM, also the Cinnamon/Muffin path), `wayland_kde.rs` (KWin scripting
  over DBus), `windows.rs`, `macos.rs`. Best-effort; unsupported desktops fall
  back to `null.rs`.
- Activating a project switches the workspace (where supported) and restores
  that project's terminal tabs and open apps together.
- The phone PWA is a separate bundle under `mobile-web/`; `npm run build`
  builds it too, so a type error there fails the ordinary build.

## Persistence

- Managed projects: `~/eldrun/projects/<sanitized-name>/`; root terminal:
  `~/eldrun/root/`.
- Global state in `~/.local/share/eldrun/`: `projects.json`, `settings.json`,
  `boxes.json`, `default_apps.json`, `calendar.json`, `global_machines.json`,
  `time_log.json`, and `usage_stats.json`, alongside per-subsystem directories
  (`mail/`, `browser/`, `sessions/`, `vm/`, `remote-projects/`, …).
- **Session state lives outside the project tree**: tab layout and `open_apps`
  are stored per project id in `<state_dir>/sessions/<id>/terminals.json`. The
  copy inside a project folder is legacy/export-only and is adopted only on an
  explicit request — and `open_apps` is *never* adopted, since a folder-supplied
  list of host commands to launch is exactly what the move guarded against.
  Treat any in-project control file as attacker-controlled.
- `project.json` still holds project identity, remote specs, runtime/container
  settings, and per-project file-viewer settings.
- Usage stats are local-only rolling hour/day counters behind the daily recap.
  Do not mix them with time (`time_summary.json`), network bytes
  (`net_usage.json`), or git stats, which come from their own sources.
- New/imported projects get `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
  `.claude/settings.json`, `.gitignore`, `TODO.md`, `ROADMAP.md`, `STATUS.md`,
  `README.md` when missing. `AGENTS.md` is the canonical one. A scaffold repair
  upgrades an agent doc still holding its untouched pre-`AGENTS.md` stub, and
  never touches anything else.
- Box agent docs contain generated link blocks between
  `<!-- eldrun:box-links:start -->` and `<!-- eldrun:box-links:end -->`;
  preserve user edits outside those blocks.
- Add a TODO to the matching group file in `todo/`; create a group only if none
  fits, or merge groups when the item spans areas tracked together.
- Preserve Python-era JSON shapes where the Rust schema already supports them;
  existing user state must round-trip cleanly.
- Avoid unrelated rewrites in docs, generated state, built assets, project
  metadata, `dist/`, `target/`, and backup files.

## Dev workflow

1. Edit `src/` (frontend) or `src-tauri/src/` (backend).
2. `npm run build` (tsc + both bundles), `npm test`, and
   `cargo test --manifest-path src-tauri/Cargo.toml`. All three run in CI on
   all three platforms. `npm test` and ESLint do **not** type-check — only
   `npm run build` does, so a type error in `src/` or `mobile-web/` surfaces
   there and nowhere else.
3. `npm run lint` and `cargo clippy --manifest-path src-tauri/Cargo.toml
   --all-targets -- -D warnings`. Both are CI gates, both are at zero — keep
   them there. `cargo fmt` is deliberately not enforced.

   A green *local* clippy is not a green *CI* clippy: CI lints with today's
   stable while yours is whenever it was last `rustup update`d, and each release
   adds lints. Either update, or lint against CI's version with
   `cargo +<ver> clippy …`. `cargo clippy --version` says what you ran.
4. **Before every push** — this repo is public — the privacy/secret scan must
   pass. `.githooks/pre-push` runs it over the outgoing commits and a `privacy`
   CI job repeats it. By hand: `git add -A && scripts/privacy-check.sh`, or
   `scripts/privacy-check.sh <base> <head>` for a range. Never hardcode
   institution or lab hostnames. Commits must use the GitHub `noreply` author
   email, never the real address.
5. Enable the hooks once per clone — this arms **both** the version bump and the
   privacy scan: `git config core.hooksPath .githooks`. Pushes are auto-patch-
   bumped and packaged by CI (`scripts/bump-version.sh` takes `minor|major`).
   Releases are manual: push a `v*` tag. `npm run package` builds the same
   artifact locally, installing the AppImage outside the checkout.

`main` is the stable default branch; ongoing work lands on `develop` and
reaches `main` by PR. `git diff --check` catches whitespace damage. If a tool a
change needs is unavailable, say so plainly instead of skipping the gate
silently.

## Conventions

- Prefer small, focused changes matching the existing React/TypeScript and
  Rust/Tauri style. Use `rg` for code search; where the RTK hook/instructions
  apply, shell commands are proxied through `rtk` automatically.
- All user-facing strings go through `src/lib/i18n.ts` (`useT()`), the one
  place every language lives. English is the source of truth and holds every
  key; `de`/`es`/`fr`/`it` fall back to it. Never hardcode display text.
- Prefer local component state and existing Zustand stores over new global
  state.
- Keep Tauri command payload names compatible with the frontend's camelCase
  keys.
- Keep service modules `AppHandle`-free and unit-testable where that is the
  established boundary.
- Tag new, not-yet-live-verified features with the `UntestedTag` pill; remove
  it only when the user says that item is tested.

## Remote, sync, and runtime model

Four trust tiers share one code path: local, containerized, remote SSH, and VM.
A VM project *is* a remote project — it boots, exposes SSH on a forwarded
loopback port, and from there is an ordinary `RemoteSpec` with `vm: true`.

- Remote SSH projects are mount-free: tabs run on the host over SSH, files go
  over SFTP, git runs on the host, all through pooled ControlMaster/SFTP
  sessions in `services::remote`, the source of truth for host-aware resolution.
- Remoteness is explicit — use `remote_target_for{,_dir}` and the host-aware
  variants. Never infer it from path conventions.
- A remote project's `remote` is the primary host; extra `compute_hosts` are
  workers, each with its own pool entry, lamp, and tab locality (`host:<id>`).
- `services::worker_sync` is push-only, tracked-files-only code fan-out via git
  bundle/reset — never `git clean`, never the bidirectional divergence path.
  Shared-filesystem workers (the default in the add-machine UI) see the primary
  folder at their own `remote_path`: no git init/reset/fan-out, tabs just `cd`.
- `services::git_peer` owns lockstep, which moves git-tracked commits/refs
  semantically via bundles; byte-sync owns everything else and moves raw bytes.
  Keep the `drop_tracked` split intact so the two never race for one file.
  With lockstep on, a saved edit to a tracked file reaches the peer only after
  it is committed — do not "fix" this back into continuous byte mirroring.
- Byte-sync is opt-in per path from the explicit manifest and does not read
  `.gitignore`; preview and confirm before pulling big host trees.
- Local-loss warnings are file-backed, not events. Destructive background git or
  sync moves must record through `services::local_loss` so losses survive a
  relaunch.
- Passwords are never persisted by default. Saved SSH/OpenVPN credentials are
  keyed by host/config target, not project id; a blank password can mean "use
  the saved credential".
- Remote and VPN auto-connect must never prompt — check the silent-connect
  predicates first. Never elevate for a connect that cannot succeed silently:
  `pkexec` prompts before OpenVPN validates config or credentials.
- OpenVPN tunnels are machine-wide. The header `VpnIndicator` owns visibility
  and lifecycle; project UI must not imply the tunnel is project-scoped.
- Containerized projects use one session-lived Docker container per local
  project, bind-mounting the project at the identical absolute path. File
  viewers, git, and usage watchers keep reading host bytes. Local-only, and
  hidden or refused on unsupported platforms. `services::sandbox` owns the
  lifecycle; tab close must reap in-container processes via the existing
  wrapper/pidfile mechanism.
- `hpc_hosts` is user-set and gates *background behavior* (scans, sync and
  lockstep loops, auto-connect, login-node runs); `careful_hosts` gates how
  much is read. The tag outranks careful mode.
- Eldrun must never manipulate another application's paths or config. The
  agent-session hooks are the one deliberate exception.

## Tabs, agents, and restore

- Shell and files tabs restore on relaunch. Claude and Codex agent tabs with a
  `sessionId` are resumable and restored; Gemini and Vibe restore is more
  limited unless the code says otherwise.
- Eldrun installs Claude/Codex session hooks and also has hook-free Codex
  binding. Codex user hooks may need one-time trust via `/hooks`.
- Agent authority has three axes: project container sandbox, tab location
  (local/primary/worker), and optional Plan/Auto agent mode.
- `components/tabs/agentModes.ts` is a capability table. Add an agent there only
  if it has an absolute mode flag and a working resume path for the respawn that
  mode switching causes.
- Plan/Auto is a launch flag, persisted per tab and re-applied when args are
  rebuilt from layout state. Do not persist raw args as the source of truth.
- Terminal `kill`/`kill_all` must reap the child process subtree, not just the
  shell leader.

## Frontend notes

- The right panel and the Files (Project) tab share `ProjectFilesView`; keep
  viewer features in the shared component so the surfaces do not drift.
  `ProjectFilesPane` owns tree/sort/source mechanics; hosts own only identity,
  active state, browsed folder, and chrome slots.
- Remote/SFTP/git probes must be gated when disconnected; a synchronous Tauri
  command against a dead session can freeze the window.
- Work in a hidden pane must be gated (`PaneVisibleContext`) and caught up on
  show — mtime polls, animation loops, and terminal streaming all cost real
  time while invisible, and on a remote project each poll is an SFTP round trip.
- Never animate a blurred box-shadow: WebKitGTK renders it in software with
  DMABUF off. Use a static-shadow pseudo-element and animate opacity.
- File viewer parsers (YAML, table editing) are text-preserving views. Keep
  edits surgical so comments, delimiters, quoting, and line endings survive.
- GPU UI reports whole-device memory and optional `gpustat` sensors, not just
  Ollama model memory. Omit missing readings; never render fake zeroes.
- Python Run/Debug opens a terminal tab and asks the backend for interpreter
  precedence. Do not duplicate interpreter ranking in the frontend.
- Experimental features use `useExperimental`; unset flags fall back to debug
  mode.
- Any install-via-command flow (Ollama models, agents, LaTeX) is a one-click
  open-a-tab-and-run, never a copy-it-yourself instruction.
- Menus and dialogs share one canonical scheme (accent header + divider,
  `--text-primary`, `--bg-panel` chrome). Portaled dialogs must set an explicit
  color — `body` has none, so they inherit black.

## Backend notes

- Remote GPU snapshots are parsed through the same local `gpustat` parsers so
  host readings match local ones field-for-field.
- `services::openvpn` tracks both headless tunnels and interactive terminal
  tunnels armed with Eldrun-owned pid files.
- `services::mobile_control` is the AppHandle-free Eldrun Mobile sidecar core;
  raw project ids, paths, commands, and tmux targets never cross the browser
  API.

Keys: `F11` fullscreen; `Super` toggles panels while Eldrun is focused.
