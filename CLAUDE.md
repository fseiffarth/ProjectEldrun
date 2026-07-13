# ProjectEldrun — Claude Context

Eldrun is a Tauri 2 + React + TypeScript desktop workspace for AI-assisted
development. It keeps a root control terminal, one terminal per active project,
a bottom project switcher, a right-side file tree overlay, app launching, time
tracking, and optional KDE/X11 workspace integration in one window.

## Running

Do not launch Eldrun from Claude or any other agent terminal for verification.
Opening a second Eldrun instance can corrupt workspace state.

Frontend (`src/`) changes hot-reload in the running instance, so no restart is
needed to see TSX/CSS edits — do not ask the user to restart for these. Only
backend (`src-tauri/`) changes require the user to rebuild/restart the existing
instance; ask them to do that when runtime validation of Rust changes is needed.

Runtime launch commands are intentionally omitted from this Claude context.

## File Map

Frontend file map: `src/CLAUDE.md`. Backend file map: `src-tauri/CLAUDE.md`.
Both list only the load-bearing files; the tree is the source of truth.

## Persistence

- Managed projects normally live under `~/eldrun/projects/<sanitized-name>/`.
- The root terminal spawns in `~/eldrun/root/`.
- Global Eldrun state lives in `~/.local/share/eldrun/`:
  `projects.json`, `settings.json`, `default_apps.json`, `time_log.json`, and
  `active_session.json`.
- **Usage stats are local-only** (`usage_stats.json`, `schema::usage_stats`): a
  rolling hour+day counter store behind the daily recap (which agents/models you
  used, prompts asked, shell commands, file churn, tabs). It clones
  `schema::net_usage`'s bucket+prune shape but its payload is an **open
  string-keyed counter map**, so adding a statistic costs one const in `metric`
  (mirrored in `src/lib/usageMetrics.ts`) and one render line — no migration.
  Deliberately NOT counted into it: **time** (`time_summary.json`), **network
  bytes** (`net_usage.json`) and **git** (re-derived from `git log` on demand) —
  the recap reads those at their source so they can never drift. Tab opens are
  counted in the frontend's `addTab`, *not* at `pty_spawn`, because the backend
  spawn fires again for every resumable agent tab respawned on relaunch. File
  churn comes from a recursive `notify` watcher on the **active** project
  (`services::usage_stats`); it cannot see an SFTP tree, so a remote project is
  counted only via its local mirror. The recap (`components/stats/`) opens on the
  first launch of each day (`daily_stats_recap`, default on) and from Settings.
- Remote (SSH) projects are **mount-free** (no sshfs/FUSE): they are SSH/SFTP-
  native. Agent/terminal tabs run on the host over `ssh -tt`, file browsing and
  file I/O go over SFTP, and git runs on the host over SSH — all riding one
  pooled ControlMaster + `Sftp` session per active remote project (opened via
  `remote_connect`, see `services::remote`). Such projects carry a `remote` spec
  (`user?`, `host`, `port?`, `remote_path`, `openvpn?`) in their `project.json`
  and mirrored into the `projects.json` entry's `extra` (the always-local source
  of truth `remote_target_for` reads). Their `directory` is a **local** per-
  project state dir (`~/.local/share/eldrun/remote-projects/<id>/`) that holds
  `project.json`; the actual tree lives on `host:remote_path`. Remoteness is
  resolved explicitly by `services::remote::remote_target_for{,_dir}`, never by a
  path convention. Plan/history: `docs/mountfree_remote_plan.md`.
- **Two transports keep a remote project in step, and they split the tree by
  git.** *Git lockstep* (`services::git_peer`) owns the **git-tracked** files and
  moves them **semantically** — commits and refs via `git bundle`, never `.git`
  bytes. *Byte-sync* (`services::sync_auto`) owns **everything else** and moves raw
  bytes. `drop_tracked` enforces the split so the two never race for one file. One
  consequence to internalize: with lockstep on, a saved edit to a **tracked** file
  no longer reaches the host until it is **committed** (`docs/git_lockstep_case_matrix.md`
  #5/#7). Live-QA log: `docs/git_lockstep_live_qa.md`.
- **Anything the sync destroys on the local side says so** (#28q, `services::local_loss`).
  Byte-sync is non-destructive *by construction* — it pulls only when the local side is
  unchanged, pushes only when the host is, and skips a both-sides-changed file rather than
  pick a winner — so every local **deletion** comes from the git side: a fast-forward,
  `reset --hard` or checkout on the mirror drops the tracked files the incoming commit no
  longer carries, and the `git clean` that un-blocks a refused fast-forward removes
  untracked ones outright. Correct, git-recoverable, and *silent* — which is the problem,
  because it happens during background passes nobody triggered. Each site now files a
  warning that `LocalLossDialog` raises. The exception that is **not** recoverable, and is
  labelled as such: `sync_now`/`sync_pull` overwriting a mirror file that held unsynced
  local edits ("clears amber → green" means the host wins). It is a **log file**, not an
  event: the services are `AppHandle`-free and a background pass can delete with no window
  listening, so a loss recorded while the app was closed still surfaces on next launch.
- **Lockstep is ON by default for a new git-backed remote project** — set at
  creation by both `create_project` and `extend_project_to_remote` (gated on the
  mirror actually being a repo). It is safe as a default precisely there: the host
  root was just created empty, so the first pass can only seed one direction, and a
  host dir that already holds *differing* files makes pairing **refuse** and ask
  (`pairing_conflict`) rather than clobber. It is written as explicit per-project
  state, never as `GitPeerState::default()` — `load_state` falls back to that
  default for every project with no state file, so flipping it there would silently
  enable lockstep on existing projects that never opted in.
- **Byte-sync is opt-in per path and does not read `.gitignore`.** Scope comes from
  an explicit manifest (`is_auto`: nearest marker wins, root `""` = project-wide);
  no marker ⇒ nothing crosses. This is what leaves a remote project's *deliberately
  host-side* data — experiment output, checkpoints, everything gitignored and hence
  invisible to lockstep — on the host. The corollary is that the two systems have
  **different notions of scope**, so marking a folder auto-sync is the one click
  that can haul a multi-GB tree into the mirror; the file tree prices the host
  subtree first (`sync_auto_preview`) and confirms when it is large.
- **Passwords are never persisted by default**, and the opt-in that persists them is
  the same in every remote menu — the Connect modal *and* the new-project /
  extend-to-remote dialogs (`useRemoteSession`, rendered by `RemoteProjectSection`).
  It can be, because the keychain is keyed by **host target** (`ssh:user@host:port`)
  and **config path**, never by project id: there is one saved credential per host and
  per tunnel, whichever menu saved it. Hence the toggle is *pre-ticked* when the target
  already has one (an untick is an explicit delete, so connecting with it unticked
  would clear another project's saved password), and a blank password field means "use
  the saved one", not "authenticate with nothing". The credential a create/extend
  dialog authenticated with is also handed to that project's **first pooled connect**
  (`stashRemotePassword`, single-use, never written to disk): connecting it
  password-less would work — it rides the ControlMaster the dialog left up — but the
  backend reads "no password given, none saved" as *key* auth and would record
  `key_auth: true` on a password host, which auto-connect later believes.
- A remote project connects **on demand** (the pill's connection lamp opens the
  `RemoteConnectDialog`) — *unless* it opts into `remote.auto_connect`, which
  connects it on launch and on activation and **never prompts**. The toggle is only
  offered when that promise can be kept: a saved SSH password, or a host the backend
  recorded as `remote.key_auth` (it authenticated with no password at all). Whether
  the OpenVPN tunnel is needed is a property of the *network*, not the project — the
  same host is often reachable directly at one site and only through the tunnel at
  another — so `autoConnectRemote` (`src/stores/projects.ts`) probes (`ssh_probe`)
  and brings the tunnel up only when the host is genuinely *unreachable*, never when
  it merely rejected a credential.
- The **OpenVPN tunnel is machine-wide, not project-scoped.** It runs elevated
  (`pkexec openvpn`) and Eldrun passes it no routing flags, so a config that pushes
  `redirect-gateway` reroutes *the whole computer's* traffic — browser included — for
  as long as it is up, whichever project asked for it. Two consequences are baked in:
  it is tracked machine-level in `src/stores/vpnStatus.ts` (keyed by config path, with
  a holder refcount — `releaseVpn` means a project logging out never pulls a tunnel out
  from under another project) and surfaced in the header by `VpnIndicator`, which is
  always present, lists every stored `.ovpn`, and can bring a tunnel **up or down with
  no project behind it**. Every UI that can start a tunnel says so before it does —
  and none of them offers a *second* one: while a tunnel is up machine-wide, every
  project-scoped OpenVPN block (the Connect modal, and the SSH section the
  new-project and extend-to-remote dialogs share) collapses to a one-line
  "tunnel already up" notice pointing at the header, via the shared
  `useVpnSectionVisible` gate + `VpnTunnelUpNotice`. The exception the gate keeps:
  a tunnel *that* dialog itself brought up stays expanded, so its log and its
  Disconnect remain where the user started it.
  Interactive (non-headless) tunnels are *armed* at command-build time —
  `interactive_connect_command` appends a `--writepid` Eldrun owns and registers it —
  so a tunnel typed into a terminal tab is as visible and as killable as a headless
  one, and no longer outlives the app still owning the routing. Split-tunnelling is
  **not** implemented: whatever the `.ovpn` pushes still applies (TODO #82).
- A tunnel can also be armed to **connect on launch** (`settings.vpn_auto_connect`,
  toggled per config in the `VpnIndicator` menu; `src/lib/vpnAutoConnect.ts`). It is
  the machine-level twin of a project's `remote.auto_connect` and keeps the same
  promise — *it never prompts*: the opt-in is only offered when the credentials make
  the connect silent, and it is re-checked at launch, so a stale opt-in leaves the
  tunnel down. One config, not a set: two would be two claims on one machine's routing.
  With `connections_headless` off it instead opens the connect command in the root
  terminal, since Eldrun handles no passwords in that mode.
- **Never elevate on a connect that cannot succeed.** `pkexec` authenticates the user
  *before* OpenVPN reads the config, so a doomed attempt is not a cheap failure — it
  costs a polkit dialog, and the modal that then collects the missing credential costs
  a second one. Every silent-connect path therefore asks `vpn_can_connect_silently`
  first (`src/lib/vpnConnect.ts`) and goes straight to the modal when the answer is no.
  The missing credential was usually the `auth-user-pass` **username**: it lived only
  on a project's `OpenVpnSpec`, so a tunnel started from the header had none — the
  backend now keeps a copy beside the saved password (`openvpn_user_account`), saved
  and cleared by the same opt-in checkbox as the secrets.
- Project-local state lives in each project's `project.json`. This includes the
  per-project tab layout (`tab_layout`/`tab_groups`). Shell/files tabs are always
  restored on relaunch; agent tabs are normally dropped, **except resumable agent
  tabs** — Claude and Codex tabs that carry a `sessionId` are persisted (with
  their `sessionId`) and restored, respawning the agent so the prior conversation
  comes back (see `isRestorableTab`/`RESUMABLE_AGENTS` in `src/stores/tabs.ts`).
  Mechanism (`services/agent_session.rs`, installed at startup): Eldrun installs a
  `SessionStart` hook — into `~/.claude/settings.json` (JSON) and
  `~/.codex/config.toml` (TOML text-append) — that records each tab's live
  `session_id` under `~/.local/share/eldrun/live_sessions/<key>`, keyed by the
  `ELDRUN_TAB_UID` env var Eldrun sets on the agent. At spawn,
  `terminal::resolve_{claude,codex}_session` reads that to resume the *current*
  session, following a `/clear`. For Claude the key is its launch id
  (`--session-id`); Codex mints its own id so the key is a separate per-tab uuid
  and the backend injects `codex resume <live-id>`. **Codex caveat:** user-level
  Codex hooks need a one-time trust (`/hooks` in Codex) before they run. Gemini
  and Vibe are still dropped (TODO 39d).
- **A project can run in a container** (#38, `services::sandbox`,
  `docs/docker_projects_plan.md`): with the pill's "Run this project in a
  container" toggle on, every shell/agent tab `docker exec`s into ONE
  session-lived, capability-dropped container (`eldrun-<id>`); `local_agent`
  tabs stay on the host. The project dir stays on the host, bind-mounted at its
  **identical absolute path** — file tree/git/viewers/usage watcher keep reading
  host bytes, and agent resume keeps working — which is what makes it a toggle,
  not a data move. Container lifetime = project session (created on
  activation/first spawn; removed on deactivate *unless tabs are still live in
  it*, at exit, and swept at startup). The toggle is spec-preserving (knobs in
  the pill's "Container settings…" survive off/on), the first enable
  auto-adopts an in-repo `Dockerfile`/devcontainer image, and a missing image
  becomes a one-click build tab. Flipping the toggle respawns every live tab —
  the pill confirms when a non-resumable agent conversation would be lost.
  Local projects only; hidden on Windows.
- **Agent authority has three axes**, and they compose: the project container
  `sandbox` (OS containment), the tab's `location` (where the process runs), and — behind the
  experimental `agent_mode_toggle` setting, default off — its `agentMode`: **Plan**
  (`--permission-mode plan`) vs **Auto** (`acceptEdits`). The mode is a *launch
  flag*, so flipping it rewrites the tab's `args`, which respawns the PTY
  (`TerminalView`'s spawn effect keys on them) — non-destructive only because the
  backend rewrites `--session-id` → `--resume` and the conversation comes back.
  That is exactly why `components/tabs/agentModes.ts` is a **capability table, not
  a universal field**: an agent belongs in it only if it has both an absolute mode
  flag *and* a working resume. Claude has both; Gemini has the flag but no resume
  (a toggle would destroy the chat), Codex resumes but has no plan mode. The mode
  is persisted per tab, and re-applied onto the rebuilt args in `loadFromLayout` —
  args are NOT persisted, so without that the split would silently die on restart.
- New/imported projects receive `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
  `.claude/settings.json`, `.gitignore`, `TODO.md`, `ROADMAP.md`, `STATUS.md`,
  and `README.md` when missing.
- `TODO.md` uses grouped IDs such as `G1.1`. When adding a TODO, put it in the
  matching group, create a new group if no current group fits, or merge groups
  if the TODO depends on distinct areas that should be tracked together.

## Dev Workflow

1. Edit files under `src/` (frontend) or `src-tauri/src/` (backend).
2. Run Rust tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

3. **Privacy check before every push.** This repo is intended to go public, so
   before pushing run the privacy/secret scan on the staged changes and stop if
   it reports anything real:

   ```bash
   git add -A && scripts/privacy-check.sh
   ```

   The patterns and the blocker-vs-expected guidance live in the script itself
   (it derives private values at runtime and excludes its own file, so neither
   this doc nor the script hardcodes or self-matches the literals it catches).
   Commits must use the GitHub `noreply` author email, never the real address.

4. Every push to GitHub should produce a fresh packaged artifact from the
   workflow in `.github/workflows/ci-cd.yml`; use `npm run package` locally if
   you need to install the same release build under `~/.local/share/eldrun/`.

   **Version bumping is automatic on push.** The tracked `pre-push` hook in
   `.githooks/` auto-bumps the patch version across `package.json`,
   `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` (via
   `scripts/bump-version.sh`), commits it, and re-pushes so every push carries a
   distinct version. Enable it once per clone with
   `git config core.hooksPath .githooks` (`core.hooksPath` is not itself tracked).
   To bump minor/major instead, run `scripts/bump-version.sh minor|major` and
   commit before pushing (the hook only patch-bumps when the version is otherwise
   unchanged for that push).

   **Releases are cut manually.** A GitHub Release is published only when a `v*`
   tag is pushed (e.g. `v0.1.5`) — the `release` job is gated on `refs/tags/v*`,
   so ordinary branch pushes never publish. The hook deliberately skips tag
   pushes, so to ship a release: `git tag v<version> && git push origin v<version>`.

Useful keys: `F11` toggles fullscreen; `Super` toggles panels while Eldrun is
focused.
