# ProjectEldrun — Documentation

Eldrun is a Tauri 2 + React + TypeScript desktop workspace for AI-assisted
development. It keeps a root control terminal, one terminal per active project,
a bottom project switcher, a right-side file browser, global app launching,
time tracking, local Ollama model management, and optional KDE/X11 workspace
integration in one fullscreen window.

This document reflects the code in `src/` and `src-tauri/src/` as of
2026-06-06.

## Document Boundaries

- `DOCUMENTATION.md` describes how Eldrun works now: architecture, behavior,
  persistence, and operational notes.
- `STATUS.md` is the short current-state snapshot: readiness, validation, and
  known rough edges.
- `ROADMAP.md` captures product direction and sequencing.
- `TODO.md` tracks concrete implementation tasks with grouped IDs.

## Eldrun's Model

Eldrun treats development work as a set of active projects, each with its own
directory, metadata, terminal tabs, file context, and optional workspace-level
desktop state.

- The root terminal is for orchestration: managing Eldrun itself and the broader
  workspace under `~/eldrun/root/`.
- Project terminals are for implementation work inside a specific project
  directory. They launch with a best-effort project sandbox that keeps XDG
  config/cache/data/state and temp writes under `<project>/.eldrun/sandbox/`.
  The root terminal keeps the normal workspace environment.
- Agent tabs run `claude`, `codex`, `gemini`, or `vibe`; plain shell tabs run
  the user's shell. Other agents can be used in a plain shell tab.
- Local Ollama models appear as Local Agent tab choices when the Ollama server
  exposes installed models. They run through `vibe` with an isolated per-model
  `VIBE_HOME` under `~/.local/share/eldrun/vibe_local/`.
- The right file panel, default app mappings, tracked external windows, and time
  tracking follow the active project.
- Global app shortcuts are intentionally cross-project. They launch or raise
  tools such as a browser, mail client, notes app, screenshot tool, or system
  monitor and keep those windows visible across project switches. They are not
  owned by a single project.

## Stack

| Concern | Technology |
|---------|-----------|
| Window shell | Tauri v2 (`tauri-plugin-dialog`) |
| Frontend framework | React 18, TypeScript, Vite |
| Styling | Tailwind CSS + CSS variables (4 themes) |
| Global state | Zustand |
| Terminal UI | xterm.js (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`) |
| PTY management | `portable-pty` Rust crate |
| JSON persistence | `serde` + `serde_json` |
| MIME detection | `mime_guess` (extension) + `infer` (magic bytes) |
| File/URL opening | `xdg-open` / `opener` crate |
| Network monitoring | `network-interface` crate + TCP probe |
| Local model integration | Ollama REST API over localhost TCP + Vibe config files |
| Drag-to-reorder | `@dnd-kit/core` + `@dnd-kit/sortable` |
| X11 workspace | `xcb` crate (Linux only) |
| KDE DBus | `zbus` crate (Linux only) |

## Installation

### Runtime Dependencies

```bash
# Tauri system dependencies (Debian / Ubuntu)
sudo apt install libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev

# Install JS dependencies
npm install
```

### Launching

```bash
./start-eldrun-tauri.sh
```

Or for a development hot-reload build:

```bash
npm run tauri dev
```

The desktop launchers are `Eldrun.desktop` for the packaged app and
`EldrunHotReload.desktop` for the hot-reload dev server.

## User Interface

The active layout is a single fullscreen orchestration surface:

```text
+------------------------------------------------------------------+
| status lamp | network icon | clock  tab bar  workspace | controls |
+------------------------------------------------------------------+
| global cross-project app toolbar (hover-revealed from left edge)  |
+------------------------------------------------------------------+
|                                                                  |
| xterm.js PTY terminal or file browser tab                        | right panel
|                                                                  | (hover-revealed
|                                                                  |  from right edge)
+------------------------------------------------------------------+
| bottom project switcher (hover-revealed from bottom edge)        |
+------------------------------------------------------------------+
```

The two side panels — global app bar (left) and right file panel — appear on
pointer hover and auto-close after the pointer leaves; the project switcher now
lives in the top header bar. `Super` hides the panels simultaneously; `F11`
toggles fullscreen.

### Header Bar

`HeaderBar.tsx` spans the full window width and acts as the drag handle. It
contains:

- Status lamp and network/connection icon.
- Clock.
- Tab bar (center, from `TabBar.tsx`).
- Custom minimize, maximize/restore, and close buttons.

### Global App Toolbar

`GlobalAppBar.tsx` is a thin hover-revealed strip on the left side of the app
body. When the pointer enters the strip, the toolbar opens; it closes when the
pointer leaves.

Supported roles:

| Role | Key |
|------|-----|
| Browser | `browser` |
| Mail | `mail` |
| Calendar | `calendar` |
| Print Manager | `print_manager` |
| File Manager | `file_manager` |
| Password Manager | `password_manager` |
| Video Conferencing | `video_conf` |
| Media Player | `media_player` |
| System Monitor | `system_monitor` |
| Notes | `notes` |
| Screenshot | `screenshot` |
| Screen Recorder | `screen_recorder` |
| Chat | `chat` |

Toolbar behavior:

- Role entries come from `settings.json["global_apps"]`.
- Buttons are hidden when `visible: false`; clicking exposes an inline edit
  popover to change the command.
- Clicking a visible role invokes `launch_or_raise_global_app` on the backend.
- The backend scans for an existing window matching the role, raises it, marks
  it sticky (X11), or launches a new instance.
- Desktop icons are resolved via `resolve_app_icon` and cached as data URLs.

### Center Panel and Tabs

`CenterPanel.tsx` owns the terminal/file-browser stack and drives tab scoping.

- When a project is activated, `CenterPanel` sets the tab scope to that
  project's ID and restores its saved `tab_layout` from `project.json`, or
  opens a default agent tab on an explicit switch.
- When the root is active, the scope is `"root"` and the root terminal opens in
  `~/eldrun/root/`.
- `TabBar.tsx` renders tabs with close, rename (double-click), drag-to-reorder,
  and a `+` menu for adding Claude/Codex/Gemini/Vibe/Shell/Files tabs plus
  locally installed Ollama models.
- The center panel is a tiling layout: dragging a tab onto another subwindow's
  left/right/top/bottom edge splits that direction into a new pane (center drops
  move the tab in), splits resize with draggable dividers, and the whole tree is
  saved in `project.json` (`tab_layout`/`tab_groups`).
- **Detaching subwindows.** A subwindow tab bar exposes a pop-out button
  (`detachGroup`) that calls `detach_subwindow` (`commands/subwindow.rs`). The
  backend opens a borderless Tauri `WebviewWindow` rendering the same bundle under
  `?detached=<scope>:<group>` (`DetachedApp.tsx` → `DetachedCenterPanel.tsx`),
  registers it as a project-owned `TrackedWindow` (origin `detached_subwindow`),
  and opts its X11 id into the workspace backend's parkable override so the normal
  `project_runtime::switch` hide/show path parks and restores it with its project.
  The ⤓ dock button (and the cross-window drag-to-dock) re-docks the group via
  `attach_subwindow`, which closes the window. **Closing** the popped-out window
  (WM/title-bar close) instead emits `detached-close`: the main window kills its
  tabs' PTYs, drops their payloads, and persists, so those tabs do NOT dock back
  and do NOT restore on next launch. Dock-back is session-only — a re-docked group
  restores as docked on restart; only the main window persists `project.json`.
- Each tab with kind `"agent"` or `"shell"` renders a `TerminalView` backed by
  a PTY. Tabs with kind `"local_agent"` also render a PTY, using `vibe` with a
  per-model local Ollama configuration. Tabs with kind `"files"` render a
  `FileBrowser`.
- Tab layout is auto-saved to `project.json["tab_layout"]` whenever tabs change.
- If no tabs exist for the active scope, the stack shows an empty placeholder.
- A project-switch toast notification appears briefly after switching projects.
- An offline banner appears over the center when the network probe reports offline.

`TerminalView.tsx`:
- Creates an xterm.js `Terminal` instance with the `FitAddon` and `WebLinksAddon`.
- On mount, invokes `spawn_pty` on the backend; backend emits
  `pty-output-<key>` events which the frontend writes to the terminal.
- Resize events call `resize_pty`; keyboard input calls `write_pty`.
- On unmount, invokes `kill_pty`.

### Right File Panel

`RightPanel.tsx` is a hover-revealed overlay on the right edge.

The panel has two views toggled by buttons in its header:

1. **Files** — renders `FileTree.tsx`: a recursive project file tree. Features:
   - Toggle hidden files.
   - Double-click to expand/collapse folders.
   - File opens via per-project defaults → global defaults → system MIME →
     `xdg-open` fallback; tracked via `open_file`.
   - Context menu: open, open with, new file, new folder, copy path, reveal in
     file manager, rename, delete, properties.
2. **Windows** — lists tracked external windows from `windows.ts` store. Each
   entry shows the app name and allows un-tracking.

The panel is only rendered when a project is active and panels are not hidden.

### Project Switcher

`ProjectSwitcher.tsx` is the project-switcher strip in the top header bar
(rendered inside `header-center` by `HeaderBar.tsx`).

Contents:

- **Root button** — switches to the root terminal.
- **Search bar** — filters registered projects by name or path; `Enter`
  activates a unique match, `Escape` clears the search.
- **Project pills** — one per active/current project, drag-to-reorder via
  `@dnd-kit/sortable`. Hovering a pill shows a tooltip with the project path,
  status, and today's active time (from `get_time_today`). Clicking switches to
  the project; the × button closes it. The pill's menu also exposes **Publish to
  GitHub / GitLab** (see below).
- **Box pills** — `BoxPill.tsx` renders a project box as a single project-style
  pill (`.project-pill.is-box`) with a member-count badge. Dropping a project
  pill onto a box (same `PILL_DRAG_TYPE` as pill reorder) assigns it to the box;
  hovering opens a dropdown listing member projects (click one to switch to it);
  clicking the pill opens the box scope; right-click exposes Open / Rename /
  Delete. See **Project Boxes** under Project Lifecycle.
- **Settings gear** — opens the settings dialog.
- **+ button** — opens an add-project menu with "New project" and "Import
  project" sub-options.

**Publish to GitHub / GitLab.** `publishProject` (`stores/projects.ts`) invokes
`publish_project` (`commands/git_publish.rs`) with a `provider` (`github` /
`gitlab`) and `visibility`. For GitHub it runs `gh repo create <name>
--<visibility> --source=. --remote=origin --push`; for GitLab it runs `glab repo
create <name> --<visibility> --remoteName origin` followed by an explicit `git
push -u origin HEAD` (since `glab` has no `--source/--push`), authenticating the
push with the effective token via an ephemeral inline git credential helper. For a
work-remote (SSH) project the CLI call runs over `ssh` on the host where the repo
lives (`BatchMode`, validated argv, single-quoted remote path), relying on that
host's own `gh`/`glab` auth. On success it records the new push target —
`git_type` becomes `remote-public` or `remote-private`, and `git_provider` the
chosen provider, in both `projects.json` and the project's `project.json` — and
returns the CLI's stdout (the repo URL). Requires the chosen provider's CLI (`gh`
or `glab`) installed and authenticated, or a token under Settings → Git hosting
(locally, or on the remote host for remote projects).

Settings dialog covers: default agent command, theme (Dark/Bright/Fancy
Dark/Fancy Bright), workspace management toggle, global app role visibility and
commands, global file-extension defaults, and Ollama model management when the
`ollama` binary is installed.

### Ollama Model Management

The Settings dialog shows an `Ollama...` panel when `ollama_is_installed`
returns true. The panel uses backend commands from `commands/ollama.rs`:

| Command | Behavior |
|---------|----------|
| `ollama_is_installed` | Checks whether the `ollama` binary exists in `$PATH`. |
| `ensure_ollama_running` | Starts the system `ollama` service when possible, otherwise falls back to `ollama serve`. |
| `list_ollama_models` | Lists installed model names for the Local Agents tab menu. |
| `list_ollama_models_detailed` | Returns installed model names, disk sizes, family, parameter size, quantization, running state, and VRAM use. |
| `list_installable_models` | Returns Eldrun's built-in catalog of common model families and tags. |
| `pull_ollama_model` | Pulls or updates a model through `/api/pull`. |
| `stop_ollama_model` | Unloads a model from memory with `keep_alive = 0`. |
| `delete_ollama_model` | Deletes a local model through `/api/delete`. |
| `prepare_local_agent` | Writes an isolated per-model Vibe config and returns `VIBE_HOME` plus alias. |

`ensure_ollama_running` prefers `systemctl start ollama` so models owned by the
system Ollama service remain visible. If the service path is unavailable, it
spawns `ollama serve`; when system model directories are detected, it sets
`OLLAMA_MODELS` so the fallback process can see those models.

Local model tabs use `prepare_local_agent(model)`. The backend writes:

```text
~/.local/share/eldrun/vibe_local/<alias>/config.toml
```

The generated Vibe config pins `active_model = "<alias>"`, disables tools with
`enabled_tools = ["__no_tools__"]`, registers the local Ollama provider, and
adds one model block for the selected model. `TabBar.tsx` then opens `vibe`
with both `VIBE_HOME=<path>` and `VIBE_ACTIVE_MODEL=<alias>`. Keeping one
directory per alias prevents one local model tab from shadowing another and
keeps global `~/.vibe/config.toml` untouched.

### Keyboard Shortcuts

| Key | Behavior |
|-----|----------|
| `F11` | Toggle fullscreen. |
| `Super` | Toggle all panels (right, bottom, global app bar). |
| `Escape` | Close dialogs. |
| `Enter` | Confirm create/import dialogs; activate a unique search result. |

## Project Lifecycle

### Creating a Project

Click `+` → "New project".

Name sanitization:

- Trim and lowercase.
- Characters outside `a-z`, `0-9`, `_`, `-` become `-`.
- Repeated hyphens collapse; leading/trailing hyphens strip.

Example: `My New Project!` → `my-new-project`.

On confirmation the backend:

1. Creates `~/eldrun/projects/<sanitized-name>/`.
2. Runs `git init --initial-branch=main`, falling back to plain `git init`.
3. Writes scaffold files.
4. Commits them as `Initial project scaffold` with author `Eldrun <eldrun@local>`.
5. Creates project-local `project.json`.
6. Adds a lightweight global index entry to `~/.local/share/eldrun/projects.json`.

### Importing a Project

Click `+` → "Import project".

Import modes:

| Mode | Behavior |
|------|----------|
| Keep location | Registers the selected directory in place. |
| Copy | Copies the source into `~/eldrun/projects/<sanitized-name>/`, excluding `.git/`. |
| Move | Moves the source into `~/eldrun/projects/<sanitized-name>/`. |

Missing scaffold files are created without overwriting existing ones. If the
target has no `.git/`, Eldrun initializes git and commits the registration.

### Scaffold Files

New and imported projects receive these files when missing:

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent instructions, scope, and permission boundary. |
| `CLAUDE.md` | Claude Code context: paths, conventions, project notes. |
| `GEMINI.md` | Gemini CLI context: paths, conventions, project notes. |
| `.claude/settings.json` | Claude permission allow/deny rules scoped to the project. |
| `.gitignore` | Common ignores for Python, Node, macOS, logs, and build output. |
| `TODO.md` | Concrete task backlog with grouped IDs. |
| `ROADMAP.md` | High-level project direction and sequencing. |
| `STATUS.md` | Current-state and validation snapshot. |
| `DOCUMENTATION.md` | Architecture, behavior, and persistence notes. |

The root terminal also gets context files in `~/eldrun/root/`:
`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`.

### Project Boxes (meta-project grouping)

A *box* groups related projects and appears as its own pill in the switcher
(`BoxPill.tsx`, `stores/boxes.ts`, `commands/boxes.rs`). Backend commands:
`get_boxes`, `save_boxes`, `create_box`, `rename_box`, `delete_box`,
`set_box_members`, `ensure_box_folder`, `refresh_box_agent_docs`,
`set_box_relations`.

- **Data model.** Boxes live in their own `~/.local/share/eldrun/boxes.json`
  (`Vec<ProjectBox>` = `{id, name, member_ids, position, folder?, relations}`)
  so `projects.json` stays byte-compatible. The box's ordered `member_ids` is
  authoritative; a per-project `box_id` back-reference is a denormalized inverse
  the frontend derives from `member_ids` on load (in memory only — never written
  back on load). `get_boxes` reconciles away member ids that no longer reference
  a known project.
- **Membership.** Dropping a project pill on a box calls `assignToBox`, which
  rewrites the affected boxes' `member_ids` and persists both files. A box left
  with a single member dissolves (its lone member is ungrouped), so dragging a
  project out of a two-member box tears the box down.
- **Box folder + agent docs.** Opening a box (`openBox` → `ensure_box_folder`)
  lazily creates a folder under `~/.local/share/eldrun/boxes/<name>/` (unique
  name resolved against other boxes and existing dirs) and writes/refreshes
  managed `CLAUDE.md`/`GEMINI.md`/`AGENTS.md` link blocks pointing at each
  member's root and same-named agent doc. Only the text between the
  `<!-- eldrun:box-links:start -->` / `…:end -->` markers is regenerated, so
  user edits outside the block survive. `refresh_box_agent_docs` re-runs this for
  an already-opened box after membership changes.
- **Box scope (session-only).** Opening a box activates a `box:<id>` tab scope
  rooted in the box folder (disjoint from project ids and `"root"`) and opens a
  shell tab. Box scopes are **not** persisted or restored — they are dropped on
  project switch / restart (full box activation is a follow-on).

## Architecture

```text
Tauri v2 Application
+-- Rust backend (src-tauri/src/)
|   +-- commands/         Tauri command handlers
|   |   +-- terminal.rs   PTY lifecycle, spawn/resize/kill/write
|   |   +-- projects.rs   Project CRUD, scaffold, file tree, stats
|   |   +-- settings.rs   Settings load/save
|   |   +-- workspace.rs  Workspace backend dispatch
|   |   +-- apps.rs       Launch helpers, role mapping, icon resolution
|   |   +-- default_apps.rs  File-extension app mapping
|   |   +-- downloads.rs  ~/eldrun/downloads symlink + browser prefs
|   |   +-- ollama.rs     Local model discovery, management, and Vibe config
|   +-- platform/         Workspace backends
|   |   +-- x11.rs        EWMH/xcb — two-desktop parking model
|   |   +-- wayland_kde.rs  KWin DBus — per-project virtual desktop
|   |   +-- null.rs       No-op fallback
|   +-- terminal/         PTY registry (mod.rs + active_session.rs)
|   +-- schema/           Serde structs (project, settings, time_log, …)
|   +-- storage.rs        Path helpers (~/.local/share/eldrun/)
|   +-- lib.rs            Command registration and app setup
|   +-- main.rs           Tauri entry point
+-- React/TypeScript frontend (src/)
    +-- components/layout/
    |   +-- AppShell.tsx    Top-level layout, hover-panel orchestration
    |   +-- HeaderBar.tsx   Drag handle, header icons, tab bar, window controls
    |   +-- CenterPanel.tsx Terminal/file-browser stack and tab scoping
    |   +-- GlobalAppBar.tsx  Cross-project app toolbar (hover-revealed)
    |   +-- RightPanel.tsx  File tree + tracked windows (hover-revealed)
    |   +-- ProjectSwitcher.tsx   Project pills, search, settings (hover-revealed)
    +-- components/terminal/
    |   +-- TerminalView.tsx  xterm.js PTY wrapper
    +-- components/files/
    |   +-- FileBrowser.tsx  Files tab wrapper
    |   +-- FileTree.tsx     Recursive file tree with context menu
    +-- components/projects/
    |   +-- ProjectPill.tsx  Individual project tab pill
    +-- components/tabs/
    |   +-- TabBar.tsx       Tab strip with add/close/rename/reorder
    +-- components/header/
    |   +-- Clock.tsx        Live clock
    |   +-- ConnTypeIcon.tsx  Network type icon
    |   +-- StatusLamp.tsx   Online/offline status lamp
    |   +-- WindowControls.tsx  Minimize/maximize/close buttons
    +-- stores/
    |   +-- projects.ts     Project list, active project, CRUD
    |   +-- tabs.ts         Tab entries by scope, layout persistence
    |   +-- settings.ts     App settings
    |   +-- windows.ts      Tracked external windows
    +-- hooks/
    |   +-- useKeyboard.ts  F11 / Super key handlers
    +-- types/index.ts      Shared TypeScript types
```

**IPC pattern:** Rust ↔ React via Tauri `invoke` for request/response and
Tauri events (`emit_to` / `listen`) for push notifications (PTY output, network
status, time ticks, workspace updates). Terminal output is batched before
crossing IPC.

## Persistence Model

Eldrun splits global index data from project-local metadata.

### Global Directory

All global data is under `~/.local/share/eldrun/`.

| File | Purpose |
|------|---------|
| `projects.json` | Lightweight index of known projects. |
| `boxes.json` | Project-box definitions (id, name, ordered `member_ids`, `folder?`, relations). |
| `settings.json` | User settings: agent command, theme, workspace management, global apps, etc. |
| `default_apps.json` | Global file-extension → app command map. |
| `time_log.json` | Append-only session records. |
| `active_session.json` | Crash/orphan-session sentinel. |
| `crash.log` | Appended on Rust panics. |
| `vibe_local/` | Per-model Vibe homes for local Ollama agent tabs. |

### `projects.json`

Each entry:

```json
{
  "id": "<uuid4>",
  "name": "My Project",
  "status": "current",
  "position": 10,
  "local_file": "/home/user/eldrun/projects/my-project/project.json"
}
```

| Field | Meaning |
|-------|---------|
| `id` | Stable UUID. |
| `name` | Display name. |
| `status` | `current`, `active`, or `inactive`. At most one `current`. |
| `position` | Project-switcher ordering weight; lower appears earlier. |
| `local_file` | Path to the project-local metadata file. |

### Project-Local `project.json`

```json
{
  "id": "<uuid4>",
  "name": "My Project",
  "directory": "/home/user/eldrun/projects/my-project",
  "git_type": "private",
  "created_at": "2026-06-01T10:00:00+00:00",
  "status": "current",
  "position": 10,
  "local_file": "/home/user/eldrun/projects/my-project/project.json",
  "default_apps": {
    ".md": "gnome-text-editor"
  },
  "file_type_stats": {
    ".ts": { "count": 20, "bytes": 48200 }
  },
  "time_today_s": 1800.0,
  "time_total_s": 3600.0,
  "time": {
    "total_s": 3600.0,
    "recent_sessions": [
      { "date": "2026-06-01", "start": "2026-06-01 10:00", "duration_s": 3600.0 }
    ]
  },
  "tab_layout": [
    { "key": "tab-1", "label": "claude", "cmd": "claude", "cwd": "/home/user/eldrun/projects/my-project", "kind": "agent" },
    {
      "key": "local_agent-2",
      "label": "llama3.2:3b",
      "cmd": "vibe",
      "cwd": "/home/user/eldrun/projects/my-project",
      "kind": "local_agent",
      "env": {
        "VIBE_HOME": "/home/user/.local/share/eldrun/vibe_local/llama3.2-3b",
        "VIBE_ACTIVE_MODEL": "llama3.2-3b"
      }
    }
  ],
  "open_apps": []
}
```

- `tab_layout` is the persisted tab state restored on next project activation.
  Local Ollama agent tabs persist `kind: "local_agent"` and the Vibe-related
  environment variables needed to relaunch the same model.
- `open_apps` stores best-effort metadata for tracked external windows.
- `default_apps` holds per-project file-extension overrides.
- Unknown fields are preserved on read/write (serde `deny_unknown_fields` is
  not used) to allow rollback to earlier versions.

### `settings.json`

```json
{
  "default_agent_cmd": "claude",
  "workspace_management": false,
  "color_scheme": "dark",
  "global_apps": {
    "browser": { "exec": "/usr/bin/firefox", "visible": true }
  }
}
```

- `default_agent_cmd` drives the default tab type and project terminal respawn.
  UI choices are `claude`, `codex`, `gemini`, `vibe`.
- `color_scheme` supports `dark`, `light`, `fancy_dark`, `fancy_light`.
- `global_apps` stores one entry per role with `exec` and `visible`.

### `default_apps.json`

```json
{ ".py": "code", ".md": "gnome-text-editor", ".pdf": "evince" }
```

Lookup order for file opens:

1. Project-local `project.json["default_apps"]`.
2. Global `default_apps.json`.
3. System MIME default (`xdg-mime query default …`).
4. `xdg-open` fallback.

### `time_log.json`

```json
[
  {
    "project_id": "<uuid4>",
    "date": "2026-06-01",
    "start_iso": "2026-06-01T10:00:00+00:00",
    "duration_s": 3600.0
  }
]
```

`active_session.json` stores the active project id and start time while a
session is open. On next startup, a leftover sentinel is closed as an orphaned
session and removed.

## Runtime Behavior

### Startup

1. `AppShell` mounts; loads settings and projects from the backend.
2. `getCurrentWindow().setFullscreen(true)` is called after the window is ready.
3. Projects marked `current` or `active` appear as project-switcher pills.
4. The project marked `current` is the initial active scope; if none, root.
5. Workspace management (if enabled) allocates desktops for visible projects.
6. Network monitoring begins; `network-status-changed` events drive the status
   lamp and offline banner.

### Project Activation

Switching to a project pill:

- Sets the active scope in the projects store.
- `CenterPanel` reacts to `activeId` change: loads `tab_layout` from
  `project.json` and restores or spawns tabs.
- Updates the right panel to the new project directory.
- Starts a time-tracking session via `start_session`.
- The workspace backend moves windows between desktops (if enabled).

Switching away closes the active time session via `end_session`.

### Terminal Lifecycle

- `TerminalView` mounts → invokes `spawn_pty(key, cmd, args, cwd, env)`.
- Backend creates a PTY, spawns the child process, and begins streaming
  `pty-output-<key>` events.
- Project tabs get project-local XDG sandbox paths; local Ollama tabs also pass
  the prepared `VIBE_HOME` and `VIBE_ACTIVE_MODEL` values.
- xterm.js renders output; user input invokes `write_pty(key, data)`.
- Window resize invokes `resize_pty(key, cols, rows)`.
- Unmount invokes `kill_pty(key)`.
- The backend has a crash-loop guard: if a process exits within 1 s, respawn is
  delayed.

Tab layout is auto-saved to `project.json["tab_layout"]` with a 500 ms debounce
after any tab change.

### File Opening and External Window Tracking

When a file is opened:

1. Backend resolves the app command (per-project → global → MIME → `xdg-open`).
2. Backend launches the process via `xdg-open` or the resolved command.
3. The opened window is tracked by PID in `project.json["open_apps"]` and shown
   in the right panel's Windows view.

There is no X11 window embedding in the Tauri WebView. All file-opened apps run
as external processes tracked by PID.

### Global App Launching

1. Backend looks up the role entry in `settings.json["global_apps"]`.
2. Scans open windows for a match (by process name, WM_CLASS, or window title).
3. If found, raises the window (and marks it sticky on X11).
4. If not found, launches the configured command.
5. Global app windows are not moved during project switches.

### Network Monitoring

A Tokio background task probes `1.1.1.1:53` every 5 seconds with a 3-second
TCP timeout and scans `network-interface` for adapter type. State changes emit
`network-status-changed` Tauri events to the frontend.

### Workspace Management

Backend auto-detection:

| Backend | Detected when |
|---------|--------------|
| KDE Wayland | `WAYLAND_DISPLAY` is set and `XDG_CURRENT_DESKTOP` contains `kde`/`plasma` |
| X11 | X11 display is available and KDE Wayland conditions are not met |
| Null | All else |

**X11 two-desktop model:**

- Workspace 0 (`Eldrun`): the visible workspace for the current project.
- Workspace 1 (`Eldrun-Hidden`): parking workspace for inactive project windows.
- On project switch, non-sticky windows from workspace 0 are moved to workspace
  1 (or vice versa).
- Global app windows are excluded from parking.

**KDE Wayland per-project model:**

- Each project gets a dedicated KDE virtual desktop.
- Switching projects switches `VirtualDesktopManager.current` via KWin DBus.
- Eldrun is made sticky at startup via `_NET_WM_STATE_STICKY` or KWin scripting.
- KDE 5 and KDE 6 use different DBus paths (`/KWin` vs `/VirtualDesktopManager`).
- Window enumeration uses KWin JS scripting via `org.kde.kwin.Scripting`.

### Download Routing

On every project switch, the backend updates the `~/eldrun/downloads` symlink
to point to `<active_project_dir>/tmp/downloads/`. When root is active, it
points to `~/eldrun/root/tmp/downloads/`.

Firefox and Chromium preference files are updated on project switch (with
backups). Profile detection is best-effort.

### Crash Logging

`std::panic::set_hook` in the Rust backend appends stack traces to
`~/.local/share/eldrun/crash.log` on panics.

## Tests and Quality Checks

Type-check frontend:

```bash
npx tsc --noEmit
```

Build frontend:

```bash
npm run build
```

Run Rust schema round-trip tests:

```bash
cd src-tauri && cargo test
```

The Rust suite also includes Ollama config regression tests that verify
per-model Vibe homes, active-model ordering, alias sanitization, no-tools
configuration, and idempotent config generation. The live Ollama integration
test skips itself when no local Ollama server or model is available.

## Known Limitations

- X11 window embedding is not implemented; all file-opened apps run externally.
- KDE Wayland workspace management needs live-session QA (functional but
  untested end-to-end).
- Non-KDE Wayland compositors use the null backend (no workspace switching, no
  sticky windows).
- Tab layout is persisted but PTYs do not survive app restarts; tabs respawn
  their processes on next activation.
- Detached (popped-out) subwindows are session-only: they re-dock into the main
  layout on restart rather than respawning as separate OS windows.
- Project-box scopes are session-only: a box's tabs are dropped on project switch
  / restart. Renaming a box does not move its already-created folder.
- `publish_project` requires the chosen provider's CLI — `gh` (GitHub) or `glab`
  (GitLab) — installed and authenticated (on the remote host for work-remote
  projects); it does not manage provider auth itself beyond an optional token.
- Ollama model installation and update depend on network access to the Ollama
  registry and may take minutes for large models.
- `ensure_ollama_running` can start a system service only when the current user
  has permission to do so; otherwise it falls back to a user `ollama serve`
  process.
- Open-app restore uses a best-effort relaunch model; window geometry and focus
  order are not restored.
- Network status depends on reaching Cloudflare DNS; may show offline on
  networks that block direct TCP/53.
- Download routing browser preference edits assume the browser is not running.

## Practical Development Notes

- Edit frontend under `src/`; backend under `src-tauri/src/`.
- Run `npm run build` and `cargo test` before handing off changes.
- Do not launch Eldrun from an agent terminal; a second instance corrupts
  workspace state. Ask the user to restart the running instance.
- Keep Tauri command payload names in camelCase to match frontend `invoke` calls.
- Global/runtime data lives under `~/.local/share/eldrun/`; do not store it in
  tracked markdown files.
- Unknown JSON fields are preserved on read/write to allow rollback to earlier
  versions.
