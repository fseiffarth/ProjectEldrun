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
- New/imported projects receive `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
  `.claude/settings.json`, `.gitignore`, `TODO.md`, `ROADMAP.md`, `STATUS.md`,
  and `README.md` when missing.
- `TODO.md` uses grouped IDs such as `G1.1`. When adding a TODO, put it in the
  matching group, create a new group if no current group fits, or merge groups
  if the TODO depends on distinct areas that should be tracked together.

### Topic docs (read only when the task touches them)

Each `docs/context/*.md` file below holds the full design rationale for one
subsystem — load-bearing detail on *why* it works the way it does, not
discoverable from the code alone. Don't read these speculatively; open the one
matching the area you're touching.

- **Usage stats** — local-only rolling counters behind the daily recap; what's counted where and why. `docs/context/usage_stats.md`
- **Remote projects** — SSH/SFTP-native, mount-free: how files/git/terminals work with no sshfs. `docs/context/remote_projects.md`
- **Git lockstep + byte-sync** — the two transports keeping a remote mirror in step, local-loss warnings, lockstep's safe-default rules, byte-sync's opt-in scope and big-folder census. `docs/context/git_sync.md`
- **Remote credentials & host security** — locked-keychain handling, password persistence opt-in, SSH_ASKPASS argv hardening, first-contact host-key confirmation. `docs/context/remote_credentials.md`
- **Remote auto-connect** — when a remote project connects itself on launch/activation, headless vs. non-headless behavior, VPN-needed probing. `docs/context/remote_autoconnect.md`
- **OpenVPN tunnel** — machine-wide (not project-scoped) lifecycle, connect-on-launch, pre-flight silent-connect check, single-polkit-prompt teardown. `docs/context/openvpn.md`
- **Agent session persistence** — how resumable Claude/Codex tabs survive relaunch via the SessionStart hook mechanism. `docs/context/agent_sessions.md`
- **Multi-host remote (compute hosts)** — a remote project's worker machines: push-only code sync, read-only files, pull-outputs, shared-filesystem mode. `docs/context/multi_host_remote.md`
- **tmux session persistence** — shell/script tabs surviving SSH drops and Eldrun crashes; the Sessions view. `docs/context/tmux_sessions.md`
- **Docker project containers** — per-project session container, toggle semantics, lifecycle. `docs/context/docker_containers.md`
- **Agent authority axes** — sandbox / tab location / agentMode (Plan vs Auto) and how they compose. `docs/context/agent_authority.md`
- **Careful mode on HPC hosts** — what the monitor/usage probes stop collecting on a cluster login node and why (usage rules, login-node load), how a host is classified. `docs/context/hpc_careful_mode.md`

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
