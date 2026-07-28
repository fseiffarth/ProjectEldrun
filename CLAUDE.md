# ProjectEldrun — Claude Context

Eldrun is a Tauri 2 + React + TypeScript desktop workspace for AI-assisted
development: a root control terminal, one terminal per active project, a project
switcher, a file tree overlay, app launching, time tracking, and optional
KDE/X11 workspace integration in one window.

## Running

Claude may launch Eldrun itself to click through the UI and verify a change
(explicit user permission, 2026-07-28). **Two concurrent instances corrupt
workspace state**, so this is conditional on one rule: before starting a new
instance, first shut down whatever instance is already running. Check for a
live one (`pgrep -fal 'tauri dev|start-eldrun-tauri-hotreload'`, or the
packaged `eldrun` binary) and stop it — do not just assume none is running.
Launch via `./start-eldrun-tauri-hotreload.sh` (backgrounded; logs to
`~/.local/share/eldrun/hotreload.log`) or `npm run tauri:dev`. Shut the
instance you started back down when you're done verifying, rather than
leaving it running.

`src/` changes hot-reload in the running instance; don't ask for a restart.
Only `src-tauri/` changes need the user to rebuild/restart.

## File maps

`src/CLAUDE.md` (frontend), `src-tauri/CLAUDE.md` (backend). Both list only
load-bearing files; the tree is the source of truth.

## Persistence

- Managed projects: `~/eldrun/projects/<sanitized-name>/`; root terminal:
  `~/eldrun/root/`.
- Global state in `~/.local/share/eldrun/`: `projects.json`, `settings.json`,
  `default_apps.json`, `time_log.json`, `active_session.json`.
- New/imported projects get `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
  `.claude/settings.json`, `.gitignore`, `TODO.md`, `ROADMAP.md`, `STATUS.md`,
  `README.md` when missing.
- `TODO.md` uses grouped IDs (`G1.1`). Add a TODO to the matching group; create
  a group if none fits, or merge groups when it spans areas tracked together.

## Topic docs

Each `docs/context/*.md` holds one subsystem's design rationale — *why* it works
that way, not discoverable from the code. Open only the one matching the area
you're touching; never read speculatively.

| Doc | Covers |
|-----|--------|
| `usage_stats.md` | Local-only rolling counters behind the daily recap. |
| `remote_projects.md` | SSH/SFTP-native, mount-free remote projects (no sshfs). |
| `git_sync.md` | Git lockstep + byte-sync: the two transports keeping a remote mirror in step. |
| `remote_credentials.md` | Locked keychain, password-persistence opt-in, SSH_ASKPASS hardening, host-key confirmation. |
| `remote_autoconnect.md` | When a remote project connects itself; headless vs. not; VPN probing. |
| `openvpn.md` | Machine-wide tunnel lifecycle, connect-on-launch, single-polkit teardown. |
| `agent_sessions.md` | Resumable Claude/Codex tabs surviving relaunch via the SessionStart hook. |
| `multi_host_remote.md` | Worker/compute hosts: push-only sync, read-only files, pull-outputs. |
| `tmux_sessions.md` | Shell/script tabs surviving SSH drops and crashes; Sessions view. |
| `docker_containers.md` | Per-project session container: toggle semantics, lifecycle. |
| `agent_authority.md` | How sandbox / tab location / agentMode compose. |
| `hpc_careful_mode.md` | What probes stop collecting on a cluster login node, and how hosts are classified. |
| `mail_encryption.md` | The sealed local store and the OpenPGP track: what each actually protects, and the invariants that make them worth having. |
| `caldav.md` | CalDAV accounts: why a sync merges by resource URL instead of replacing, and what read-only actually buys. |

## Dev workflow

1. Edit `src/` (frontend) or `src-tauri/src/` (backend).
2. `cargo test --manifest-path src-tauri/Cargo.toml`
3. **Before every push** — this repo is public — run the privacy/secret scan on
   staged changes and stop if it flags anything real:
   `git add -A && scripts/privacy-check.sh` (patterns and
   blocker-vs-expected guidance live in the script). Commits must use the
   GitHub `noreply` author email, never the real address.
4. Pushes are auto-patch-bumped and packaged by CI. Enable the version hook once
   per clone: `git config core.hooksPath .githooks`. See `.githooks/pre-push`,
   `scripts/bump-version.sh` (`minor|major` for a bigger bump), and
   `.github/workflows/ci-cd.yml`. Releases are manual: push a `v*` tag.
   `npm run package` builds the same release artifact locally.

Keys: `F11` fullscreen; `Super` toggles panels while Eldrun is focused.
