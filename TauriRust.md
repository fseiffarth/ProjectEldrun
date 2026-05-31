# Migrate ProjectEldrun to Tauri + Rust + React + TypeScript

## Context

ProjectEldrun is a GTK4/Python desktop workspace for AI-assisted development. The goal is
to rewrite it using Tauri v2 (Rust backend) + React + TypeScript (WebView frontend), gaining
a modern component-based UI, TypeScript safety, and a more accessible tech stack while
keeping the full feature set. This is a ground-up rewrite — no Python/GTK code survives
as-is. Total estimated effort: ~12 weeks of focused engineering.

**Platform targets:** Linux is the primary target. The architecture minimises Linux-only
code to a single seam: the `WorkspaceBackend` trait in `src-tauri/src/platform/`. Every
other subsystem — PTY, network, MIME, file opening, persistence, UI — uses cross-platform
crates and compiles unchanged on Windows and macOS. Linux-specific crates (`xcb`, `zbus`)
are in `[target.'cfg(target_os = "linux")'.dependencies]` so they never enter the build
graph on other OSes.

---

## Architecture Overview

```
src/                          # React + TypeScript frontend
  components/
    layout/                   # Window shell, panels
    terminal/                 # xterm.js terminal tabs
    projects/                 # Pills, dialogs, file tree
    header/                   # Status lamps, clock, app toolbar
  hooks/                      # useTerminal, useProject, useSettings …
  stores/                     # Zustand global state
  types/                      # Shared TS interfaces mirroring Rust structs

src-tauri/
  src/
    main.rs
    commands/
      terminal.rs             # PTY lifecycle, env, I/O
      projects.rs             # Project CRUD, scaffold
      settings.rs             # Settings load/save
      workspace.rs            # X11 workspace / window management
      network.rs              # Connectivity probe
      apps.rs                 # Launch helpers, role mapping
      files.rs                # File tree, MIME detection
      time_tracker.rs         # Session tracking
    platform/
      mod.rs                  # WorkspaceBackend trait + auto-detect factory
      x11.rs                  # xcb EWMH — Linux X11 window/desktop ops
      wayland_kde.rs          # KWin JS scripting + zbus — KDE Wayland desktop ops
      windows.rs              # Windows stub (VirtualDesktop API — future)
      macos.rs                # macOS stub (Mission Control / Spaces — future)
      null.rs                 # No-op backend (non-Linux or unsupported compositor)
    state.rs                  # AppState (Arc<Mutex<…>>)
```

**IPC pattern:** Rust ↔ React via Tauri commands (`invoke`) for request/response and Tauri
events (`emit_all` / `listen`) for push notifications (terminal output, network status,
Ollama chunks, time ticks).

---

## Key Technology Choices

| Concern | Choice | Linux-only? |
|---------|--------|-------------|
| Terminal UI | `xterm.js` (`@xterm/xterm` + `@xterm/addon-fit`) | No — WebView |
| PTY management | `portable-pty` crate | No — Win/Mac/Linux |
| Async runtime | Tokio | No |
| JSON persistence | `serde_json` + Tauri path API | No |
| MIME detection | `mime_guess` (extension) + `infer` (magic bytes) | No — replaces `xdg-mime` subprocess |
| File/URL opening | `opener` crate | No — wraps xdg-open / open / start per OS |
| Network adapter type | `network-interface` crate + TCP probe | No — replaces sysfs read |
| State (frontend) | Zustand | No |
| Styling | Tailwind CSS + CSS variables | No |
| Drag-to-reorder | `@dnd-kit/core` | No |
| Workspace abstraction | `WorkspaceBackend` trait + null backend | No — Linux impls compiled only on Linux |
| X11 window ops | `xcb` crate | **Yes** — `cfg(target_os = "linux")` only |
| DBus | `zbus` crate | **Yes** — `cfg(target_os = "linux")` only |
| XDG sandbox env | `#[cfg(target_os = "linux")]` block in `terminal.rs` | **Yes** — entire block gated |

---

## Feature Fate

| Feature | Status | Notes |
|---------|--------|-------|
| VTE terminals (agent + project + root) | **Redesigned** | xterm.js + portable-pty PTY backend |
| Tab management + persistence | **Ported** | React tabs, `tab_layout` in project.json |
| Project CRUD + scaffolding | **Ported** | Rust (serde_json) |
| Settings manager | **Ported** | Rust (serde_json + Tauri path API) |
| Time tracking | **Ported** | Rust + Tauri events for UI updates |
| Network monitor | **Ported** | Tokio + `network-interface` crate + TCP probe; Tauri events to frontend |
| File tree + default apps | **Ported** | React TreeView; `mime_guess`+`infer` for MIME; `opener` crate for launching |
| Bottom panel / project pills | **Ported** | React + @dnd-kit drag-to-reorder |
| Global apps toolbar | **Ported** | React toolbar + Rust subprocess launch |
| CSS themes (4) | **Ported** | Tailwind CSS variables |
| Workspace management (KDE/Cinnamon) | **Ported (X11 + KDE Wayland)** | X11: xcb EWMH; Wayland: KWin JS scripting + zbus (mirrors Phase 6b) |
| X11 window embedding | **Dropped** | Fundamentally incompatible with Tauri WebView; redesign as floating windows |
| Windows / macOS support | **Stubbed, future-ready** | `WorkspaceBackend` trait returns null backend; PTY + UI work on day 1; workspace swapping needs OS-specific impl |
| Project stats scanner | **Ported** | Tokio background task |
| Downloads manager | **Ported** | Rust symlink + browser prefs |
| Crash logging | **Ported** | `std::panic::set_hook` to crash.log |
| Header (clock, lamps, buttons) | **Ported** | React + Tauri window controls API |

---

## Phased Implementation Roadmap

### Phase 1 — Scaffolding + Persistence (Week 1)
**Goal:** Tauri project boots, reads and writes all JSON data files.

- `cargo create-tauri-app` with React + TypeScript template (Tauri v2)
- Port `project_manager.py` → `src-tauri/src/commands/projects.rs`
  - Load/save `projects.json`, per-project `project.json`
  - Project CRUD: create, import, delete, reorder
  - Scaffold writer (AGENTS.md, CLAUDE.md, .gitignore, etc.)
  - Migration logic for legacy formats
- Port `settings_manager.py` → `src-tauri/src/commands/settings.rs`
- Port `default_apps_manager.py` → `src-tauri/src/commands/apps.rs` (data layer only)
- Port `time_tracker.py` → `src-tauri/src/commands/time_tracker.rs`
- Tauri commands: `load_projects`, `save_project`, `load_settings`, `save_settings`, etc.
- No UI yet; validate by writing integration tests in Rust.

### Phase 2 — App Shell + Themes (Week 2)
**Goal:** Window renders with correct layout and all 4 themes switchable.

- Main window layout: header bar (top) + center terminal stack + right panel overlay + bottom bar
- Tailwind CSS variables for 4 themes (dark, light, fancy_dark, fancy_light) matching existing colors exactly
- Header: window-manager buttons (min/max/close via Tauri window API), clock (1s interval), status lamp placeholders
- Bottom panel: project pills (click to switch, no drag yet), add/settings buttons
- Right panel: static file tree placeholder
- Theme toggle working end-to-end

### Phase 3 — Terminal Subsystem (Weeks 3–5) ← highest risk
**Goal:** VTE-equivalent terminal tabs with PTY, env sandbox, agent spawning.

- `src-tauri/src/commands/terminal.rs`:
  - `portable-pty` for PTY creation (cross-platform; handles SIGCHLD + auto-respawn)
  - Per-terminal `TerminalSession { pty_master, child_pid, write_tx, read_rx }`
  - `spawn_terminal(cmd, directory, envv)` command — builds sandbox env; XDG_* vars injected only inside `#[cfg(target_os = "linux")]` block (identical logic to `_project_sandbox_envv`)
  - Streaming stdout via Tauri events: `emit_all("terminal-output-{id}", chunk)`
  - `write_terminal(id, data)` command for stdin (replaces `feed_child`)
  - Auto-respawn on child exit (re-spawn same cmd+env)
  - Terminal registry in `AppState`
- React `TerminalTab` component:
  - `xterm.js` instance per tab, attached via `useEffect`
  - `@xterm/addon-fit` for resize; `@xterm/addon-web-links` for URI click
  - Listen to `terminal-output-{id}` events → `xterm.write(chunk)`
  - `invoke('write_terminal', { id, data })` on xterm's `onData`
- Tab bar: React tabs with close/rename, auto-numbering (Claude, Claude1, Claude2…)
- `tab_layout` save/restore: persist to `project.json` via `projects.rs` commands
- Task feeding: 350 ms delay post-spawn, then `write_terminal` (same pattern as current)
- Offline banner: React overlay shown when `network-status-changed` fires with `is_online: false`
- Agent spawning: `_add_agent_terminal` logic → `invoke('spawn_agent', { cmd, taskTitle, directory })`

### Phase 4 — File Tree + Right Panel (Week 6)
**Goal:** File tree browsable; context menus and project settings work.

- `src-tauri/src/commands/files.rs`: directory listing, MIME detection via `mime_guess` (extension lookup) + `infer` (magic-byte sniffing) — no subprocess, no Linux dependency; default app resolution stores user mappings in `default_apps.json`; `invoke('open_path', { path })` delegates to `opener::open()` which calls `xdg-open` / `open` / `start` per OS
- React `FileTree` component using a virtual tree (react-arborist or custom recursive component)
- Context menu on files: open with default / choose app
- Project settings popover: hidden files toggle, file stats display, time display
- App picker dialog: search + suggested section

### Phase 5 — Project Dialogs (Week 7)
**Goal:** New project and import flows work end-to-end.

- `NewProjectDialog` React component: name validation, path preview, remote repo option
- `ImportProjectDialog` React component: folder picker (Tauri dialog API), import modes
- All scaffold writing via Rust command `scaffold_project`

### Phase 6 — Network + Platform Integrations (Weeks 8–9)
**Goal:** Network monitor, workspace management, app launching all work.

- `src-tauri/src/commands/network.rs`: Tokio interval + TCP probe (cross-platform) + `network-interface` crate for adapter type detection (ethernet/wifi/none) → `emit_all("network-status-changed", …)`; no sysfs, no Linux dependency
- Workspace backend trait in `src-tauri/src/platform/mod.rs`; auto-detect at startup: KDE → Cinnamon → GNOME → null
- `src-tauri/src/platform/x11.rs` — **KDE/Cinnamon/GNOME X11 path**:
  - EWMH via `xcb`: `_NET_CLIENT_LIST`, `_NET_WM_DESKTOP`, `_NET_CURRENT_DESKTOP`, `_NET_NUMBER_OF_DESKTOPS`, `_NET_DESKTOP_NAMES`, `_NET_CLOSE_WINDOW`
  - `activate_project`: collect ws0 windows (excluding Eldrun XID + protected WM_CLASS), move to ws1, restore tracked ws1 windows for new project
  - `prepare`: ensure 2 desktops exist, name them "Eldrun" / "Eldrun-Hidden"
  - `cleanup`: move all tracked hidden windows back to ws0, collapse to original desktop count
  - `make_global_window`: `_NET_WM_STATE` + `_NET_WM_STATE_STICKY` ClientMessage
  - KDE version probe: introspect `/VirtualDesktopManager` to detect KDE 6 vs 5
  - KDE 6 desktop management: `VirtualDesktopManager.createDesktop` / `removeDesktop` via `zbus`
  - Cinnamon: `zbus` call to `org.Cinnamon /org/Cinnamon org.Cinnamon.Eval` (JS string eval)
  - GNOME: `std::process::Command` for `gsettings` + `zbus` for Shell.Eval fallback
- `src-tauri/src/platform/wayland_kde.rs` — **KDE Wayland path** (mirrors `kde_kwin.py` Phase 6b):
  - Active when `WAYLAND_DISPLAY` is set and `XDG_CURRENT_DESKTOP` contains `kde`/`plasma`
  - KWin DBus availability check: `org.kde.KWin / org.freedesktop.DBus.Peer.Ping` via `zbus`
  - KDE version probe: introspect `/VirtualDesktopManager` via `zbus`
  - `run_kwin_script(js)`: write JS to `NamedTempFile`, call `org.kde.kwin.Scripting.loadScript` via `zbus`, run (KDE 5 only: `org.kde.kwin.Script.run`), then `unloadScript`; delete temp file in `Drop`
  - KWin JS templates (identical to Python):
    - `JS_ENUMERATE`: writes `{ desktopUUIDs, windows }` JSON via XHR PUT to a temp file path; fallback on KDE 6: enumerate via `/org/kde/KWin/Windows` DBus introspection
    - `JS_MOVE`: batch-move windows by UUID array to `workspace.desktops[N]`
    - `JS_SWITCH`: `workspace.currentDesktop = workspace.desktops[N]`
    - `JS_STICKY`: set `onAllDesktops = true` for UUID array
  - `enumerate_state()`: run JS_ENUMERATE, read + delete output JSON, parse into `WaylandState { desktop_uuids, windows }`; fallback to `enumerate_kde6_dbus()` if file write fails
  - `enumerate_kde6_dbus()`: introspect `/org/kde/KWin/Windows` for UUIDs; get `resourceClass` + `desktops` properties per window via `zbus`; get desktop UUIDs from `/VirtualDesktopManager` children
  - `activate_project`: enumerate state, collect moveable ws0 windows (non-sticky, non-protected by `resourceClass`), batch-move to ws1, store as old project; rescue protected windows from ws1; restore tracked ws1 windows for new project; call `JS_SWITCH(0)`
  - `activate_project` fallback (enumeration fails): move only tracked windows via `JS_MOVE`
  - `move_window_kde6_dbus(window_uuid, desktop_uuid)`: `zbus` call to `org.kde.KWin.Window.desktops` property setter on `/org/kde/KWin/Windows/{uuid}` (used when `run_kwin_script` fails)
  - `cleanup_wayland()`: enumerate state, move all tracked hidden-desk windows back to ws0
  - `prepare()`: ensure 2 virtual desktops exist (`createDesktop` via `zbus`), set names, switch to desktop 0
  - `cleanup()`: restore all hidden windows to ws0, collapse desktop count to original
- Global apps toolbar: React toolbar + `invoke('launch_app', { role, uri })` → `opener::open_with()` (cross-platform; falls back to `opener::open()` if app name is not an absolute path)
- Download manager: `invoke('set_active_project_downloads', { projectDir })` → `std::fs::remove_file` + `std::os::unix::fs::symlink` on Unix; on Windows use `std::os::windows::fs::symlink_dir` (requires developer mode or admin) — gate with `#[cfg(unix)]` / `#[cfg(windows)]`
- Project stats scanner: Tokio background task in `AppState`

### Phase 7 — Drag-to-Reorder + Polish (Weeks 10–11)
**Goal:** Feature-complete, all interactions polished.

- Bottom panel drag-to-reorder: `@dnd-kit/core` (pointer sensor, long-press activation)
- Right panel drag-over scroll (scroll trigger area at panel edges)
- All keyboard shortcuts: F11 fullscreen, Super panel toggle, Ctrl+K Ollama, per-dialog Escape/Enter
- Custom window-manager buttons via `appWindow.minimize/maximize/close()`
- Crash logging: `std::panic::set_hook` writes to `{app_data_dir}/crash.log` via Tauri's `app.path().app_data_dir()` — resolves to `~/.local/share/eldrun/` on Linux, `%APPDATA%\eldrun\` on Windows, `~/Library/Application Support/eldrun/` on macOS
- Time tracking bars in bottom panel (update on `time-tick` events)
- Debug badge, workspace ID badge (debug mode)
- Ollama will be added post-migration as a persistent terminal tab (better than the removed GTK dialog)

---

## Critical Rust Crates

```toml
# Cross-platform — compile everywhere
[dependencies]
tauri = { version = "2", features = ["protocol-asset"] }
portable-pty = "0.8"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
mime_guess = "2"
infer = "0.16"
opener = "0.7"
network-interface = "2"
regex = "1"

# Linux-only — never enters the build graph on Windows or macOS
[target.'cfg(target_os = "linux")'.dependencies]
zbus = "4"
xcb = { version = "1", features = ["randr", "ewmh"] }
```

## Critical npm Packages

```json
"@xterm/xterm": "^5",
"@xterm/addon-fit": "^0.10",
"@xterm/addon-web-links": "^0.11",
"@dnd-kit/core": "^6",
"@dnd-kit/sortable": "^8",
"zustand": "^5",
"@tauri-apps/api": "^2",
"@tauri-apps/plugin-dialog": "^2",
"@tauri-apps/plugin-shell": "^2"
```

---

## Feature Parity Verification

At each phase, verify against the current GTK app:
1. **Phase 1**: Read/write all JSON data files; existing data from `~/.local/share/eldrun/` loads correctly
2. **Phase 3**: Terminal spawns `claude`; task text is fed after 350 ms; tab saves/restores across project switches
3. **Phase 7**: On KDE X11, switching projects moves windows to workspace 0/1 correctly
4. Final: All existing Python unit tests have Rust equivalents passing; no regression in JSON data files

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| xterm.js performance vs VTE for large scrollback | Cap scrollback at 5,000 lines by default; `@xterm/addon-canvas` renderer for GPU acceleration |
| portable-pty SIGCHLD handling on Linux | Integration test: spawn bash, kill it, verify respawn in <1s |
| XDG sandbox env on non-Linux | Entire XDG_* injection block is `#[cfg(target_os = "linux")]`; on Windows/macOS the env is passed as-is |
| xcb/zbus workspace code on Wayland | `wayland_kde.rs` handles KDE Wayland via KWin JS scripting + zbus; other compositors (GNOME Wayland, etc.) get null backend + informational badge |
| X11 window embedding dropped | Document in ROADMAP.md as "Embedding not available in Tauri version" |
| Windows support (future) | Only `workspace.rs` needs a new impl (`windows.rs` using `IVirtualDesktopManager` COM via `windows-rs`); all other code already compiles — no changes to PTY, network, MIME, or UI |
| macOS support (future) | Only `workspace.rs` needs a new impl (`macos.rs` using `NSWorkspace`/Spaces via `objc2`); all other code already compiles |
| `mime_guess` misses uncommon types | `infer` magic-byte sniffing covers binaries; for truly unknown types fall back to `"application/octet-stream"` — same behaviour as current `xdg-mime` fallback |
| `opener` not found on headless Linux | `opener` calls `xdg-open`; on headless CI just skip integration tests that open files |
| `tauri.conf.json` bundle targets | Set `targets: ["deb", "appimage"]` for Linux; adding `"msi"` / `"dmg"` later requires no code changes, only CI pipeline additions |
