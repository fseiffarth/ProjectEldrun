# ProjectEldrun — Claude Context

Eldrun is a Tauri 2 + React + TypeScript desktop workspace for AI-assisted
development. It keeps a root control terminal, one terminal per active project,
a bottom project switcher, a right-side file tree overlay, app launching, time
tracking, and optional KDE/X11 workspace integration in one window.

Stack: Rust (Tauri 2), React 18, TypeScript, Zustand, xterm.js, Tailwind CSS.

## Running

Do not launch Eldrun from Claude or any other agent terminal for verification.
Opening a second Eldrun instance can corrupt workspace state. Ask the user to
run or restart the existing instance when runtime validation is needed.

Runtime launch commands are intentionally omitted from this Claude context.

## File Map

### Frontend (`src/`)

| File | Purpose |
|------|---------|
| `src/App.tsx` | Root component, theme injection, global key handlers. |
| `src/main.tsx` | React entry point. |
| `src/components/layout/AppShell.tsx` | Top-level layout: header, center, bottom, right panel wiring. |
| `src/components/layout/HeaderBar.tsx` | Window drag handle, close/minimize/maximize buttons. |
| `src/components/layout/GlobalAppBar.tsx` | Global toolbar (app launcher, shortcuts). |
| `src/components/layout/CenterPanel.tsx` | Terminal stack and tab bar. |
| `src/components/layout/BottomBar.tsx` | Project pill switcher. |
| `src/components/layout/RightPanel.tsx` | File tree overlay panel. |
| `src/components/projects/ProjectPill.tsx` | Individual project tab pill in the bottom bar. |
| `src/components/terminal/TerminalView.tsx` | xterm.js terminal wrapper. |
| `src/stores/projects.ts` | Zustand store for project list, active project, CRUD. |
| `src/stores/tabs.ts` | Zustand store for center-panel tabs. |
| `src/stores/settings.ts` | Zustand store for app settings. |
| `src/stores/windows.ts` | Zustand store for embedded app windows. |
| `src/types/index.ts` | Shared TypeScript types. |

### Backend (`src-tauri/src/`)

| File | Purpose |
|------|---------|
| `main.rs` | Tauri app entry point, plugin registration. |
| `lib.rs` | Command registration, app setup. |
| `storage.rs` | JSON persistence helpers (read/write state files). |
| `schema/` | Serde structs mirroring the JSON state files (projects, settings, time log, etc.). |
| `platform/x11.rs` | X11 workspace / window management via xlib. |
| `platform/wayland_kde.rs` | KDE Wayland workspace backend via KWin scripting + DBus. |
| `platform/null.rs` | No-op platform fallback. |
| `terminal/` | PTY management and terminal I/O commands. |
| `commands/` | Tauri command handlers exposed to the frontend. |

## Persistence

- Managed projects normally live under `~/eldrun/projects/<sanitized-name>/`.
- The root terminal spawns in `~/eldrun/root/`.
- Global Eldrun state lives in `~/.local/share/eldrun/`:
  `projects.json`, `settings.json`, `default_apps.json`, `time_log.json`, and
  `active_session.json`.
- Project-local state lives in each project's `project.json`.
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

4. Every push to GitHub should produce a fresh packaged artifact from the
   workflow in `.github/workflows/ci-cd.yml`; use `npm run package` locally if
   you need to install the same release build under `~/.local/share/eldrun/`.
   GitHub Releases are only published for `v0.<minor>.0` tags, so patch-only
   bumps like `0.1.1 -> 0.1.2` do not create a release.

5. Do not start Eldrun from Claude. Ask the user to restart the existing
   instance for runtime verification.

Useful keys: `F11` toggles fullscreen; `Super` toggles panels while Eldrun is
focused.
