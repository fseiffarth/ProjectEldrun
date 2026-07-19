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
- **A remote project can reach N machines, not one** (`docs/multi_host_remote_plan.md`,
  `services::worker_sync`). The project's `remote` is the **primary** — it still owns
  files, git, the mirror, and full bidirectional sync, unchanged. Extra **worker**
  hosts (`Project.compute_hosts`, mirrored into `projects.json`'s
  `extra["compute_hosts"]`) are experiment machines: their code is kept **one-way** in
  sync from the mirror (source→worker, tracked files only, `reset --hard`, **never
  `git clean`**), their files are read-only, and their experiment **outputs** (untracked
  paths) stay on the worker until a user-initiated, size-confirmed **Pull outputs** — the
  only worker→local byte path. Because worker sync is push-only it dodges the entire
  divergence/conflict/local-loss half of lockstep. Each host has its own pool entry
  (`remote::conn_key`, keyed `(project, host)`), its own pill lamp, and its own tab
  locality (`host:<id>`); the primary is the implicit `"primary"` id, so every existing
  file/git/sync caller keeps meaning "the primary" with no change. A tab runs on a host
  via its `host:<id>` location → `PtyOptions.remote_host_id`. Managed from the pill's
  "Remote machines…" (`RemoteMachinesWindow`).
  - **A worker can instead SHARE the primary's folder over a shared filesystem — and
    this is now the DEFAULT for a newly added machine** (`ComputeHost.shared_fs`,
    schema default `false` for back-compat but the "Add machine" form ticks it on;
    untick "Sync a copy" ⇒ shared). A shared-fs worker sees the primary's project
    folder at its own `remote_path` (an HPC compute node on a shared home), so Eldrun
    copies **nothing** and **never runs git on it** — a tab just `cd`s into that folder
    and runs there (`wrap_pty_options` already uses `spec.remote_path`, so tab spawn is
    unchanged). This is load-bearing for safety: the code path that would `git init` +
    `reset --hard` a synced worker's tree must **never** fire on a shared-fs host, or it
    corrupts the primary's real working tree. Three guards enforce it — `remote_connect`
    skips `on_worker_connect`, `worker_sync::fan_out` skips via `wants_code_fanout`
    (`!shared_fs && sync_code`), and `sync_worker` itself early-returns a no-op skip for a
    shared-fs host so even a stray `worker_sync_now` is harmless. "Sync code now" / "Pull
    outputs" / "Auto-sync code" are hidden for a shared-fs worker (its outputs are already
    in the primary's folder, moved by the primary's own sync).
- **A shell/script tab runs inside a tmux session so a long run survives** (#85,
  `docs/tmux_remote_plan.md`) — decoupled from the disposable channel, the tab
  **reattaches** on relaunch. It covers **two axes**:
  - **Remote** (on the SSH host): survives an SSH drop, a laptop sleep, a VPN drop,
    or Eldrun quitting. **Default ON** per remote project
    (`RemoteSpec.persist_sessions !== false`; opt out via the pill's "Persistent
    sessions (tmux)"). `ssh_exec::wrap_pty_options` nests the existing `exec …`
    inside `tmux new-session -A -D -s <name>`.
  - **Local** (on this machine, Unix only — no tmux on Windows): survives an
    **Eldrun crash** (the tmux server is a daemon; the PTY only holds a client).
    **Default ON** via `settings.persist_local_sessions`. `services::tmux_local`
    rewrites the local spawn's `{cmd,args}` into a `tmux` argv in
    `commands::terminal::pty_spawn`, *after* the ssh/docker branch so only a
    genuinely local tab is wrapped.
  Scoped to **shell tabs** (Python runs open one; a command runs inside the
  session's login shell, which outlives it → the run reattaches, not re-runs) and
  never the root scope — **agent tabs are excluded** (they resume via their own
  session). The session name is a **uuid the frontend mints once per shell tab and
  persists** (`TabEntry.tmuxSession`) — *not* derived from the PTY id, which
  `loadFromLayout` regenerates on restore (a derived name would fork a second
  session on relaunch instead of reattaching); `tmux_attach` overrides it for a
  Sessions-view attach. **Kill vs. detach**: an *explicit* tab close
  (`lib/closeRemoteTab.ts`) confirms and fires `remote_tmux_kill`/`local_tmux_kill`;
  an app-exit, disconnect, crash, or respawn deliberately **leaves the session
  alive**. Because a session outlives its tab, a host can hold runs no tab points at;
  the **Sessions view** (`☰` toggle in `ProjectFilesView`, mirrors the Orange view)
  makes them discoverable — **multi-host** (aggregated across the primary and every
  connected worker via `remote_tmux_list`, each row host-tagged), click a row to
  attach, per-row **Kill** and **Rename** (`remote_tmux_rename`, updates the owning
  tab's persisted name). tmux-absent falls back to today's plain `exec` + a notice.
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
  vs **Auto** (Claude `--permission-mode plan`/`acceptEdits`; Gemini
  `--approval-mode plan`/`auto_edit`). The mode is a *launch flag*, so flipping it
  rewrites the tab's `args`, which respawns the PTY (`TerminalView`'s spawn effect
  keys on them) — non-destructive only because the tab resumes its conversation on
  respawn. That is exactly why `components/tabs/agentModes.ts` is a **capability
  table, not a universal field**: an agent belongs in it only if it has both an
  absolute mode flag *and* a working resume. Claude (resume-by-id) and Gemini
  (continue-last) both qualify; Codex resumes but has no plan mode. Gemini's
  continue-last resume carries one accepted caveat — with two Gemini tabs in a
  project a respawn reattaches to the project's latest session, not necessarily
  this tab's (the same ambiguity their ordinary restore already has). The mode
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
