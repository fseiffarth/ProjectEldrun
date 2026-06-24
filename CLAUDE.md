# ProjectEldrun — Claude Context

Eldrun is a Tauri 2 + React + TypeScript desktop workspace for AI-assisted
development. It keeps a root control terminal, one terminal per active project,
a bottom project switcher, a right-side file tree overlay, app launching, time
tracking, and optional KDE/X11 workspace integration in one window.

Stack: Rust (Tauri 2), React 18, TypeScript, Zustand, xterm.js, Tailwind CSS.

## Running

Do not launch Eldrun from Claude or any other agent terminal for verification.
Opening a second Eldrun instance can corrupt workspace state.

Frontend (`src/`) changes hot-reload in the running instance, so no restart is
needed to see TSX/CSS edits — do not ask the user to restart for these. Only
backend (`src-tauri/`) changes require the user to rebuild/restart the existing
instance; ask them to do that when runtime validation of Rust changes is needed.

Runtime launch commands are intentionally omitted from this Claude context.

## File Map

### Frontend (`src/`)

Only the load-bearing files are listed; the tree is the source of truth.

**Entry & shell**

| File | Purpose |
|------|---------|
| `src/App.tsx` | Root component, theme injection, global key handlers. |
| `src/main.tsx` | React entry point. |
| `src/crashReporter.ts` | Captures/forwards WebKitGTK renderer crashes to the backend. |
| `src/types/index.ts` | Shared TypeScript types. |

**Layout (`src/components/layout/`)**

| File | Purpose |
|------|---------|
| `AppShell.tsx` | Top-level layout: header, center, right-panel wiring. |
| `HeaderBar.tsx` | Window drag handle + hosts the project switcher in the header. |
| `GlobalAppBar.tsx` | Global toolbar / app launcher (`GLOBAL_APP_ROLES`). |
| `GlobalAppMenu.tsx` | Context menu for a global-app toolbar button. |
| `CenterPanel.tsx` | Tab/subwindow tiling host; keeps all panes mounted across scope switches. |
| `DetachedCenterPanel.tsx` | Center-panel variant rendered inside a detached OS window. |
| `DetachedApp.tsx` | Root component for a popped-out/detached subwindow (#42). |
| `ProjectSwitcher.tsx` | Thin composition root: pill strip + search/dialog/settings wiring. Re-exports scaffold helpers. |
| `ProjectSearch.tsx` *(in `projects/`)* | Inactive-project/box search box + results popover. |
| `ProjectDialog.tsx` *(in `projects/`)* | New/Import project dialog incl. SSH + OpenVPN + scaffold-fill sub-flows. |
| `SettingsPanel.tsx` | Settings dialog + sub-panels (theme/git/layout, global apps, file-type apps, Ollama, shortcuts, help). |
| `RightPanel.tsx` | File-tree overlay panel (git status/history). |
| `VpnPasswordPrompt.tsx` | Modal prompting for an OpenVPN password on activation. |
| `LogoIcon.tsx` | Inline SVG logo. |

**Projects, header widgets, tabs, terminal, files, embed, common**

| File | Purpose |
|------|---------|
| `projects/ProjectPill.tsx` | Individual project pill (click/close/drag-reorder/group). |
| `projects/BoxPill.tsx` | Project-box pill (meta-grouping, #13/#41). |
| `projects/ActivityCalendar.tsx` | Per-project activity calendar heatmap. |
| `projects/scaffold.ts` | Pure helpers: name sanitize, SSH-address parse, scaffold/description fill prompts. |
| `header/Clock.tsx` | Header clock. |
| `header/AppTimerDisplay.tsx` | Active-project time-tracking readout. |
| `header/AppResourceDisplay.tsx` | Per-project CPU/resource readout. |
| `header/ConnTypeIcon.tsx` | Local/remote (SSH) connection-type icon. |
| `header/StatusLamp.tsx` | Status indicator lamp. |
| `header/WindowControls.tsx` | Minimize/maximize/close window buttons. |
| `tabs/TabBar.tsx` | Per-subwindow tab strip (add/rename/close, pointer-based DnD). |
| `tabs/Subwindow.tsx` | A single tiled subwindow (tab group). |
| `tabs/commitDrop.ts` / `tabs/commitFileDrop.ts` | Apply a tab/file drag-drop into the layout tree. |
| `tabs/dragGeometry.ts` | Drop-zone/split geometry math for tab drags. |
| `terminal/TerminalView.tsx` | xterm.js terminal wrapper + PTY I/O. |
| `files/FileTree.tsx` | Project file tree with git markers, fs-watch refresh. |
| `files/FileBrowser.tsx` | File browser pane. |
| `files/GitHistory.tsx` | Commit history / commit / push UI. |
| `files/SetDefaultAppDialog.tsx` | Pick the default app for a file type. |
| `embed/EmbedPane.tsx` | Hosts an embedded external app window. |
| `embed/FileViewerPane.tsx` | In-app viewers (PDF, image, markdown, code, TeX/SyncTeX). |
| `common/Dropdown.tsx`, `common/OrbitSpinner.tsx` | Shared primitives. |

**Stores (`src/stores/`), hooks, lib**

| File | Purpose |
|------|---------|
| `projects.ts` | Project list, active project, CRUD, `setActive`. |
| `tabs.ts` | Tab/subwindow layout tree per scope; tab persistence policy. |
| `boxes.ts` | Project boxes (meta-grouping) CRUD + membership. |
| `settings.ts` | App settings (theme, default agent, git profile, shortcuts, etc.). |
| `windows.ts` | Embedded app windows. |
| `detached.ts` | Detached/popped-out subwindow state (#42). |
| `drag.ts` | Isolated per-frame drag state (reference for fine-grained selectors). |
| `activity.ts` | PTY-output activity outside React (`lastOutputByPty`). |
| `timer.ts` | Per-project time-tracking state. |
| `linkRouting.ts` | Routing of clicked links/URIs to viewers or external apps. |
| `pdfSync.ts` | Bidirectional PDF/SyncTeX sync state. |
| `editorJump.ts` | Cross-pane jump-to-location requests. |
| `vpnPrompt.ts` | State backing `VpnPasswordPrompt`. |
| `hooks/useKeyboard.ts` | Global keyboard-shortcut hook. |
| `lib/shortcuts.ts` | Shortcut definitions, chord parsing/resolution. |
| `lib/viewers/{fileUtils,markdown,highlight,tex}.ts` | Pure viewer logic (XSS-safe markdown/highlight, TeX, file utils). |

### Backend (`src-tauri/src/`)

**Top level**

| File | Purpose |
|------|---------|
| `main.rs` | Tauri app entry point, plugin registration. |
| `lib.rs` | Command registration (`generate_handler!`), app setup, hook/restore install. |
| `storage.rs` | JSON persistence helpers (read/write state files). |
| `paths.rs` | Canonical Eldrun directory paths. |
| `sysstat.rs` | Per-process CPU sampling via `/proc` (`descendant_pids`). |

**Commands (`commands/`)** — Tauri command handlers exposed to the frontend.

| File | Purpose |
|------|---------|
| `projects.rs` | Project CRUD, scaffold/import, time-today (god module; #1). |
| `fs.rs` | File-I/O commands (read/write/mtime, extracted from `projects.rs`; #1 seam). |
| `fs_watch.rs` | Filesystem watch start/stop + change events. |
| `git.rs` | Git status/history/commit/push. |
| `github.rs` | GitHub repo publishing. |
| `terminal.rs` | Terminal/PTY command surface (delegates to `terminal/mod.rs`). |
| `apps.rs` | App launching, `run_script_detached`, `open_file`, external window tracking. |
| `default_apps.rs` | Per-file-type default-app mapping. |
| `downloads.rs` | Per-project download routing. |
| `ssh.rs` | SSH commands for remote projects (`ssh_connect`, `ssh_default_dir`, `ssh_list_dir`, `ensure_project_mounted`). |
| `openvpn.rs` | OpenVPN tunnel connect/store-config commands. |
| `ollama.rs` | Ollama model list/pull/delete + local autocomplete. |
| `tex.rs` | TeX compile + SyncTeX (shell-escape defense). |
| `boxes.rs` | Project-box CRUD. |
| `subwindow.rs` | Detached/popped-out subwindow lifecycle (#42). |
| `timer.rs` | Time-tracking commands. |
| `workspace.rs` | KDE/X11 workspace switch commands. |
| `settings.rs` | Settings read/update. |
| `project_runtime.rs` | Project-switch runtime command wrapper (off-UI-thread). |
| `crash.rs` | Receives frontend renderer crash reports. |
| `debug.rs` | Debug-mode helpers. |

**Services (`services/`)** — `AppHandle`-free, unit-testable.

| File | Purpose |
|------|---------|
| `ssh_mount.rs` | sshfs mount lifecycle (mount/unmount, mountpoint derivation, arg validation). |
| `ssh_exec.rs` | Remote command execution over SSH (ControlMaster). |
| `remote_agents.rs` | Remote agent bootstrap/resume for SSH projects. |
| `openvpn.rs` | OpenVPN process lifecycle (askpass file, teardown). |
| `agent_session.rs` | SessionStart hook installer + live-session recording for agent resume. |
| `project_runtime.rs` | Worker-thread project switch + time flush (`flush_project_secs`). |
| `restore_service.rs` | Tab/session restore on relaunch. |
| `terminal_service.rs` | Tab layout save/restore for terminals. |
| `window_service.rs` | Window-state helpers. |

**Platform (`platform/`)** — `WorkspaceBackend` strategy.

| File | Purpose |
|------|---------|
| `x11.rs` | X11 workspace / window management via xlib. |
| `wayland_kde.rs` | KDE Wayland backend via KWin scripting + DBus (show/hide stub, #18). |
| `windows.rs` | Windows backend (stub). |
| `null.rs` | No-op platform fallback. |

**Schema (`schema/`)** — Serde structs mirroring the JSON state files.

| File | Purpose |
|------|---------|
| `projects.rs` / `project.rs` | `projects.json` entries + per-project `project.json`. |
| `settings.rs` | `settings.json`. |
| `default_apps.rs` | `default_apps.json`. |
| `time_log.rs` | `time_log.json` (unbounded `Vec`; Efficiency #2/#12). |
| `boxes.rs` | Project boxes. |
| `session.rs` | Live/restorable session state. |
| `active_session.rs` | Defined but **not yet wired** (TODO Group F #24). |

**Terminal (`terminal/`)**

| File | Purpose |
|------|---------|
| `mod.rs` | PTY lifecycle + agent-session resolvers (`resolve_{claude,codex}_session`). |

## Persistence

- Managed projects normally live under `~/eldrun/projects/<sanitized-name>/`.
- The root terminal spawns in `~/eldrun/root/`.
- Global Eldrun state lives in `~/.local/share/eldrun/`:
  `projects.json`, `settings.json`, `default_apps.json`, `time_log.json`, and
  `active_session.json`.
- Remote (SSH) projects are sshfs-mounted under
  `~/.local/share/eldrun/mounts/<project-id>/`; that mountpoint becomes the
  project's `directory`. Such projects carry a `remote` spec (`user?`, `host`,
  `port?`, `remote_path`) in their `project.json` and mirrored into the
  `projects.json` entry's `extra`. Requires `sshfs`/FUSE locally.
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
2. Type-check frontend:

```bash
npx tsc --noEmit
```

3. Run Rust tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

4. **Privacy check before every push.** This repo is intended to go public, so
   before pushing run the privacy/secret scan on the staged changes and stop if
   it reports anything real:

   ```bash
   git add -A && scripts/privacy-check.sh
   ```

   The patterns and the blocker-vs-expected guidance live in the script itself
   (it derives private values at runtime and excludes its own file, so neither
   this doc nor the script hardcodes or self-matches the literals it catches).
   Commits must use the GitHub `noreply` author email, never the real address.

5. Every push to GitHub should produce a fresh packaged artifact from the
   workflow in `.github/workflows/ci-cd.yml`; use `npm run package` locally if
   you need to install the same release build under `~/.local/share/eldrun/`.
   GitHub Releases are only published for `v0.<minor>.0` tags, so patch-only
   bumps like `0.1.1 -> 0.1.2` do not create a release.

6. Do not start Eldrun from Claude. Frontend (`src/`) edits hot-reload in the
   running instance — no restart needed. Only ask the user to rebuild/restart
   for backend (`src-tauri/`) changes.

Useful keys: `F11` toggles fullscreen; `Super` toggles panels while Eldrun is
focused.
