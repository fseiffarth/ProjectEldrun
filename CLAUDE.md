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
- Remote (SSH) projects are **mount-free** (no sshfs/FUSE): they are SSH/SFTP-
  native. Agent/terminal tabs run on the host over `ssh -tt`, file browsing and
  file I/O go over SFTP, and git runs on the host over SSH — all riding one
  pooled ControlMaster + `Sftp` session per active remote project (opened on
  activation via `remote_connect`, see `services::remote`). Such projects carry a
  `remote` spec (`user?`, `host`, `port?`, `remote_path`) in their `project.json`
  and mirrored into the `projects.json` entry's `extra` (the always-local source
  of truth `remote_target_for` reads). Their `directory` is a **local** per-
  project state dir (`~/.local/share/eldrun/remote-projects/<id>/`) that holds
  `project.json`; the actual tree lives on `host:remote_path`. Remoteness is
  resolved explicitly by `services::remote::remote_target_for{,_dir}`, never by a
  path convention. Plan/history: `docs/mountfree_remote_plan.md`.
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
