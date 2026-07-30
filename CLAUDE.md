# ProjectEldrun — Claude Context

Eldrun is a Tauri 2 + React + TypeScript desktop workspace for AI-assisted
development: a root control terminal, one terminal per active project, a project
switcher, a file tree overlay, app launching, time tracking, and optional
KDE/X11 workspace integration in one window.

## Running

**Claude must never start Eldrun** (user, 2026-07-29) — not via
`./start-eldrun-tauri-hotreload.sh`, not via `npm run tauri:dev`, not
backgrounded, not "just to check one thing". This revokes the earlier
2026-07-28 permission. **Never stop an instance you did not start**, either: a
running window holds the user's open tabs and live terminals. The app's
lifecycle is the user's alone.

To verify something live, ask the user to launch Eldrun (or to use a window
they already have open) and report back, or hand them the exact steps to click
through. `src/` edits hot-reload into an already-open window, so usually
nothing needs launching at all. Otherwise report results from the automated
gates only, and say plainly that the change was not run live.

The user launches via `./start-eldrun-tauri-hotreload.sh` (backgrounded; logs
to `~/.local/share/eldrun/hotreload.log`) or `npm run tauri:dev`. Double-starts
are also blocked mechanically: `scripts/guard-single-instance.sh` runs from
both the launcher and the `pretauri:dev` npm hook, so either path refuses when
a session is live. It also refuses when port 1420 is held by an orphaned vite —
a second `tauri dev` whose own vite loses that race carries on regardless and
attaches to the *first* session's dev server, so the window silently renders
that session's stale module graph and looks like an old build.

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
2. `cargo test --manifest-path src-tauri/Cargo.toml` and `npm test`. Both run in
   CI now, on all three platforms, so a failure here is a failure there.
3. `npm run lint` (ESLint) and
   `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
   Both are CI gates and both are currently at zero — keep them there.
   `cargo fmt` is deliberately **not** enforced (see group Y #163).

   **A green local clippy does not mean a green CI clippy.** CI installs
   `dtolnay/rust-toolchain@stable`, so it lints with whatever stable is *today*
   while the local `stable` is whenever it was last `rustup update`d — and each
   release adds lints. A stale local toolchain passed a
   `useless_borrows_in_formatting` that 1.97 rejected, turning the lint job red
   after the push. Either `rustup update stable`, or lint against CI's exact
   version: `cargo +<ver> clippy --manifest-path src-tauri/Cargo.toml
   --all-targets -- -D warnings`. `cargo clippy --version` tells you what you
   actually ran.
4. **Before every push** — this repo is public — the privacy/secret scan must
   pass. `.githooks/pre-push` now runs it over the commits being pushed and
   aborts on a hit, and a `privacy` CI job repeats it (a fresh clone has the
   hook off). To scan by hand at any point:
   `git add -A && scripts/privacy-check.sh`, or
   `scripts/privacy-check.sh <base> <head>` for a range — patterns and
   blocker-vs-expected guidance live in the script. Commits must use the
   GitHub `noreply` author email, never the real address.
5. Pushes are auto-patch-bumped and packaged by CI. Enable the hooks once
   per clone — this is what arms **both** the version bump and the privacy
   scan: `git config core.hooksPath .githooks`. See `.githooks/pre-push`,
   `scripts/bump-version.sh` (`minor|major` for a bigger bump), and
   `.github/workflows/ci-cd.yml`. Releases are manual: push a `v*` tag.
   `npm run package` builds the same release artifact locally.

Keys: `F11` fullscreen; `Super` toggles panels while Eldrun is focused.
