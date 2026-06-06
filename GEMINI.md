# ProjectEldrun — Gemini Context

Eldrun is a Tauri-based desktop workspace for AI-assisted development. It provides a unified interface with a root terminal, project-specific terminals, a bottom project switcher, a right-side file tree, application launching/tracking, and workspace management.

## Tech Stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS.
- **State Management:** Zustand (for projects, tabs, settings, windows).
- **Terminal:** xterm.js + @xterm/addon-fit.
- **Backend:** Rust, Tauri v2.
- **PTY:** `portable-pty` for terminal management.
- **Workspace:** `zbus` (DBus) and `xcb` (X11) for Linux desktop integration.

## File Map

### Frontend (`src/`)

| Path | Purpose |
|------|---------|
| `src/App.tsx` | Main entry point, renders `AppShell`. |
| `src/components/layout/` | Layout components: `AppShell`, `HeaderBar`, `CenterPanel`, `RightPanel`, `BottomBar`. |
| `src/components/terminal/` | `TerminalView` using xterm.js. |
| `src/components/files/` | `FileBrowser` and `FileTree`. |
| `src/stores/` | Zustand stores: `projects.ts`, `tabs.ts`, `settings.ts`, `windows.ts`. |
| `src/hooks/` | Custom hooks like `useKeyboard.ts`. |
| `src/types/` | TypeScript type definitions. |

### Backend (`src-tauri/src/`)

| Path | Purpose |
|------|---------|
| `src/main.rs` | Tauri entry point. |
| `src/lib.rs` | Command registration and app initialization. |
| `src/commands/` | Tauri command implementations (projects, apps, terminal, workspace, etc.). |
| `src/platform/` | Workspace backend implementations (KDE Wayland/X11, Cinnamon, Null). |
| `src/schema/` | Data models and serialization for persistence. |
| `src/storage.rs` | Logic for global and project-specific storage paths. |
| `src/terminal/` | PTY registry and management logic. |

## Persistence

- Global Eldrun state lives in `~/.local/share/eldrun/`:
  `projects.json`, `settings.json`, `default_apps.json`, `time_log.json`, and `active_session.json`.
- Project-local state lives in each project's `project.json` (includes `tab_layout` and `open_apps`).
- Managed projects normally live under `~/eldrun/projects/<sanitized-name>/`.
- The root terminal spawns in `~/eldrun/root/`.

## Dev Workflow

### Running

Do not launch Eldrun from Gemini or any other agent terminal for verification. Opening a second Eldrun instance can corrupt workspace state. Ask the user to run or restart the existing instance when runtime validation is needed.

- **Development:** `npm run tauri dev`
- **Build:** `npm run build` (builds frontend) then `npm run tauri build`
- **Packaging:** every push to GitHub produces a fresh release artifact via
  `.github/workflows/ci-cd.yml`; locally, `npm run package` installs the same
  packaged AppImage under `~/.local/share/eldrun/` so the running app is
  decoupled from the checkout. GitHub Releases are only published for
  `v0.<minor>.0` tags, so patch-only bumps like `0.1.1 -> 0.1.2` do not create
  a release.

### Validation

1. **Frontend:** `npm run build` (checks TypeScript and Vite build).
2. **Backend:** `cargo check` or `cargo build` in `src-tauri/`.
3. **Tests:** `cargo test` in `src-tauri/`.

## Key Concepts

- **Project Switching:** When a project is activated, Eldrun switches the workspace (if supported by the backend) and restores the project's terminal tabs and open applications.
- **PTY Registry:** The backend maintains a registry of active PTYs, keyed by UUID, allowing the frontend to reconnect to terminals.
- **Workspace Backends:**
  - `KdeWaylandBackend`: Uses KWin scripting via DBus.
  - `X11Backend`: Uses EWMH/NetWM via X11.
  - `NullBackend`: Fallback for unsupported environments.
- **Tab Scoping:** Tabs are scoped to either "root" or a specific project ID.
