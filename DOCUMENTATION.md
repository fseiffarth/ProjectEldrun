# ProjectEldrun - Documentation

Eldrun is a Python/GTK4 desktop orchestration and project-management app built
around agent terminals. It keeps project-specific Claude, Codex, and shell
sessions available without losing the surrounding project context: files,
default app choices, global app shortcuts, time tracking, network state, and
optional desktop workspace routing.

This document reflects the code in `app/` as of May 29, 2026.

## Eldrun's Model

Eldrun treats development work as a set of active projects, each with its own
directory, metadata, terminal state, file context, and optional desktop
workspace.

- The root terminal is for orchestration: managing Eldrun itself and the broader
  workspace under `~/eldrun/root/`.
- Project terminals are for implementation work inside a specific project
  directory.
- Agent tabs run `claude` or `codex`; plain terminal tabs run the user's shell.
- The right file panel, default app mappings, open-window list, stats, and time
  tracking follow the active project.
- Global app shortcuts are intentionally cross-project. They launch or raise
  tools such as a browser, mail client, notes app, screenshot tool, or system
  monitor and keep those windows sticky across project workspaces when X11
  allows it.

## Installation

### Runtime Dependencies

```bash
# Debian / Ubuntu
sudo apt install python3 python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 \
    gir1.2-vte-3.91 gir1.2-gdkx11-4.0
pip3 install --user python-xlib
```

Eldrun uses:

- GTK 4 and Libadwaita for windows and controls.
- VTE 3.91 for embedded terminals.
- `python-xlib` and GDK X11 bindings for X11 window tracking, app embedding,
  launch-or-raise, sticky windows, and workspace integration.
- `xdg-mime`, `xdg-settings`, `.desktop` files, and `xdg-open` style handlers for
  file and global app discovery.
- `git` for new/imported project initialization.

### Launching

```bash
./start-eldrun.sh
```

or:

```bash
cd app && python3 eldrun.py
```

The desktop launcher is `Eldrun.app.desktop`. Its `Exec=` path is absolute in the
current checkout, so update that path before installing it elsewhere:

```bash
cp Eldrun.app.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications/
```

## User Interface

The active layout is a single orchestration surface:

```text
+------------------------------------------------------------------+
| status/network      agent + terminal tabs          wm controls   |
+------------------------------------------------------------------+
| global cross-project app toolbar                                 |
+------------------------------------------------------------------+
|                                                                  |
| VTE agent terminal, shell terminal, app placeholder, or X11 app   | right overlay
|                                                                  | PROJECT tree
|                                                                  | OPEN WINDOWS
+------------------------------------------------------------------+
| Root | Search... | project pills...             | settings | +   |
+------------------------------------------------------------------+
```

### Header

- Shows online/offline status and wired/wireless type.
- Hosts the center tab bar, so terminal and app context stays visible at the top
  of the window.
- Provides custom minimize, maximize/restore, and close buttons.
- Shows a close confirmation dialog before quitting.
- Uses `Gtk.WindowHandle` so the undecorated header can be dragged.

### Global App Toolbar

The slim toolbar below the header renders cross-project app roles from
`settings.json["global_apps"]`.

Supported roles:

| Role | Typical resolution |
|------|--------------------|
| Browser | `xdg-settings get default-web-browser`, fallback to configured command |
| Mail | `xdg-mime query default x-scheme-handler/mailto` |
| Calendar | `xdg-mime query default text/calendar` |
| Print Manager | `system-config-printer` |
| File Manager | `xdg-mime query default inode/directory` |
| Password Manager | `keepassxc`, `bitwarden-desktop`, or `1password` |
| Video Conferencing | `zoom`, `teams`, or `webex` |
| Media Player | `xdg-mime query default audio/mpeg` |
| System Monitor | `gnome-system-monitor` or `ksysguard` |
| Notes | `obsidian`, `zettlr`, or `gedit` |
| Screenshot | `flameshot`, `gnome-screenshot`, or another configured tool |
| Screen Recorder | `obs`, `kazam`, or `simplescreenrecorder` |

Toolbar behavior:

- Startup resolution fills missing executable paths when system defaults are
  discoverable.
- Settings can show/hide each role and edit its executable command.
- Buttons are insensitive when a visible role has no resolved command.
- Clicking a role scans existing X11 windows and raises a match when possible.
- If no match is found, Eldrun launches a new process and polls for its window.
- Found global app windows are marked sticky across all workspaces via EWMH on
  X11.
- The screenshot role can launch common tools in interactive region-selection
  mode.

### Center Panel and Tabs

`CenterPanel` in `app/panels/center_panel.py` owns the terminal/app stack and the
tab bar.

- The default tab uses the configured agent command, currently `claude` or
  `codex`.
- Right-clicking the tab bar opens controls for adding a new Claude/Codex agent
  or a plain shell terminal.
- Agent and plain terminal tabs can be renamed, closed, and reordered by drag and
  drop.
- If all tabs are closed, the stack shows an empty state explaining that a new
  agent or terminal can be added from the tab bar.
- Each active project has a VTE terminal page named `project-<id>`.
- The root orchestration terminal uses the master page and opens in
  `~/eldrun/root/`.
- File opens can create temporary app tabs. Eldrun tries to find the launched
  process' X11 window and reparent it into the center panel.
- If embedding fails, the app tab is removed and the app is tracked as a
  standalone open window in the right overlay.
- An offline banner is displayed over the stack when the network probe reports
  offline.

The terminal command comes from `settings.json["terminal_command"]`. If the
configured command is not found in `$PATH`, Eldrun falls back to the system
shell.

### Right File Tree Overlay

`FileTreePanel` lives in `app/panels/right_panel.py`. Despite the historical
filename, it is the current project file browser, not the old project-list
panel.

The panel appears only while a project page is active and panel visibility allows
it. If the file panel is hidden, a small edge control near the upper-right side
opens it on hover; the control disappears while the panel is open. A panel that
was auto-shown hides again when the pointer leaves it.

The panel provides:

- Recursive project file tree with folders first.
- Toggles for hidden files and standard scaffold files.
- Ignored internal files: `.git`, `open_apps.json`, `project.json`,
  `project_default_apps.json`, and `.eldrun_colors.json`.
- Double-click folder expand/collapse.
- Double-click file open through per-project defaults, global defaults, system
  MIME defaults, or a manual "Open With" dialog.
- Right-click actions: open, open with, new file, new folder, copy path, reveal
  in file manager, color label, reset color, rename, delete, and properties.
- Per-path color labels stored as `.eldrun_colors.json` in the project.
- An `OPEN WINDOWS` section for standalone app windows that could not be
  embedded.

### Bottom Project Bar

`BottomPanel` in `app/panels/bottom_panel.py` owns the persistent project and
settings controls:

- **Root** opens the root orchestration terminal.
- **Search** finds registered projects, including inactive projects.
- **Project pills** activate, close, show warm/open-app state, show time/file
  type stats on hover/right click, and support drag-and-drop reordering.
- **Settings** opens terminal command, theme, workspace management, global app,
  and file-type default settings.
- **+** opens a popover for new project or import project.

Closing a project removes its terminal and marks it inactive in the global index.
If local metadata says the project has open apps, Eldrun asks for confirmation.
Closing the active project returns the UI to the root terminal.

### Keyboard Shortcuts

| Key | Behavior |
|-----|----------|
| `F11` | Toggle fullscreen. |
| `Super` | Toggle panel visibility while Eldrun is focused. Eldrun temporarily disables the desktop Super binding and restores it when focus is lost or the app exits. |
| `Esc` | Closes create/import dialogs. |
| `Enter` | Confirms create/import when valid; activates a unique bottom-bar search match. |

## Project Lifecycle

### Creating a Project

Click `+` -> `New Project`.

Name sanitization for the directory:

- Lowercase and trim.
- Spaces and underscores become hyphens.
- Characters outside `a-z`, `0-9`, and `-` are removed.
- Repeated hyphens collapse and leading/trailing hyphens are stripped.

Example: `My New Project!` -> `my-new-project`.

On confirmation Eldrun:

1. Creates `~/eldrun/projects/<sanitized-name>/`.
2. Runs `git init --initial-branch=main`, falling back to plain `git init`.
3. Writes scaffold files.
4. Commits them as `Initial project scaffold` with author
   `Eldrun <eldrun@local>`.
5. Creates project-local `project.json`.
6. Adds a lightweight global index entry to
   `~/.local/share/eldrun/projects.json`.
7. Opens the project terminal and adds a project pill.
8. Starts a background stats scan.

### Importing a Project

Click `+` -> `Import Project`.

Import modes:

| Mode | Behavior |
|------|----------|
| Keep location | Registers the selected directory in place. |
| Copy | Copies the source into `~/eldrun/projects/<sanitized-name>/`, excluding `.git/`. |
| Move | Moves the source into `~/eldrun/projects/<sanitized-name>/`. |

Missing scaffold files are created without overwriting existing files. If the
target has no `.git/`, Eldrun initializes git and commits the registration or
import.

### Scaffold Files

New and imported projects receive these files when missing:

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent instructions, scope, and permission boundary. |
| `CLAUDE.md` | Claude Code context: path, visibility, and project notes. |
| `.claude/settings.json` | Claude permission allow/deny rules scoped to the project directory. |
| `.gitignore` | Common Python, Node, macOS, log, and build ignores. |
| `TODO.md` | Project task list. |
| `ROADMAP.md` | Long-term project roadmap. |
| `STATUS.md` | Project status and current-state notes. |
| `DOCUMENTATION.md` | Project documentation stub. |

The root terminal also gets context files in `~/eldrun/root/`:

- `CLAUDE.md`: explains the Eldrun workspace root and global data files.
- `AGENTS.md`: tells agents that root-terminal work is for Eldrun/workspace
  management, not project implementation.

## Architecture

```text
EldrunApp (Adw.Application)
+-- EldrunWindow (Adw.ApplicationWindow)
    +-- header: status lamp, network icon, center tab bar, window controls
    +-- global app toolbar
    +-- CenterPanel: VTE agent terminals, shell terminals, app tabs, X11 embedding attempt
    +-- FileTreePanel: project file tree and standalone open-window list
    +-- BottomPanel: Root, search, project pills, settings, add/import
```

### Module Map

| File | Responsibility |
|------|----------------|
| `app/eldrun.py` | Application entry point, CSS themes, signal handlers, `EldrunApp`. |
| `app/window.py` | Main window composition, key handling, startup restore, project activation, global app toolbar, time tracking hooks, network callbacks, workspace integration, quit flow. |
| `app/project_manager.py` | Project registry, project creation/import, scaffold writing, migrations, root context files. |
| `app/new_project_dialog.py` | Modal project creation UI and validation. |
| `app/import_project_dialog.py` | Modal import UI, folder chooser, mode selection. |
| `app/settings_manager.py` | JSON-backed user settings. |
| `app/default_apps_manager.py` | Global and per-project file-extension app mappings; system MIME bootstrap. |
| `app/global_apps_manager.py` | Cross-project app role registry, system resolution, launch-or-raise, sticky-window handling, screenshot-region dispatch. |
| `app/time_tracker.py` | Active project session tracking and crash/orphan session closure. |
| `app/project_stats.py` | Background file-type and time summary scanner. |
| `app/network_monitor.py` | Background 1.1.1.1:53 probe and network interface type detection. |
| `app/workspace_manager.py` | Workspace creation/switch/removal for Cinnamon, GNOME, and wmctrl backends; sticky Eldrun window support. |
| `app/panels/center_panel.py` | Terminal stack, tab bar, agent/plain terminal lifecycle, app tab lifecycle, X11 embedding/fallback. |
| `app/panels/right_panel.py` | Current `FileTreePanel`: file operations, default app dialogs, open-window list. |
| `app/panels/bottom_panel.py` | Bottom bar, project pills, settings windows, search, drag/drop ordering. |

## Persistence Model

Eldrun intentionally splits global index data from project-local metadata.

### Global Directory

All global data is under `~/.local/share/eldrun/`.

| File | Managed by | Purpose |
|------|------------|---------|
| `projects.json` | `ProjectManager` | Lightweight index of known projects. |
| `settings.json` | `SettingsManager` | User settings, including terminal command, theme, workspace management, and global app registry. |
| `default_apps.json` | `DefaultAppsManager` | Global file-extension app map. |
| `time_log.json` | `TimeTracker` | Append-only session records. |
| `active_session.json` | `TimeTracker` | Crash/orphan-session sentinel. |

### `projects.json`

Current global index entries contain only:

```json
{
  "id": "<uuid4>",
  "name": "My Project",
  "status": "current",
  "position": 10,
  "local_file": "/home/user/eldrun/projects/my-project/project.json"
}
```

Global fields:

| Field | Meaning |
|-------|---------|
| `id` | Stable UUID for UI state, logs, and references. |
| `name` | Display name. |
| `status` | `current`, `active`, or `inactive`. At most one should be `current`. |
| `position` | Bottom-bar ordering weight; lower appears earlier. |
| `local_file` | Path to project-local metadata. |

Older entries that stored full project data in `projects.json` are migrated on
load by deriving or writing `project.json`.

### Project-Local `project.json`

Each project stores durable local metadata in `<project_dir>/project.json`.

Example:

```json
{
  "id": "<uuid4>",
  "name": "My Project",
  "directory": "/home/user/eldrun/projects/my-project",
  "git_type": "private",
  "created_at": "2026-05-27T10:00:00+00:00",
  "status": "current",
  "position": 10,
  "local_file": "/home/user/eldrun/projects/my-project/project.json",
  "default_apps": {
    ".md": "gnome-text-editor"
  },
  "file_type_stats": {
    ".py": { "count": 12, "bytes": 48200 }
  },
  "time_today_s": 1800.0,
  "time_total_s": 3600.0,
  "last_updated": "2026-05-27T11:00:00",
  "time": {
    "total_s": 3600.0,
    "recent_sessions": [
      {
        "date": "2026-05-27",
        "start": "2026-05-27 10:00",
        "duration_s": 3600.0
      }
    ]
  },
  "open_apps": []
}
```

Notes:

- `ProjectManager` treats `id`, `name`, `status`, `position`, and `local_file`
  as global-index-canonical fields and overlays them when loading.
- `shell_pid` is runtime-only and is not persisted.
- `open_apps` is the canonical durable location for current open-app state.
  `ProjectManager` preserves it while other metadata is rewritten.
- Per-project default app overrides live in `default_apps`.
- Old `project_default_apps.json` files are migrated into `project.json`.

### `settings.json`

Common settings:

```json
{
  "terminal_command": "claude",
  "workspace_management": false,
  "color_scheme": "dark",
  "global_apps": {
    "browser": {
      "exec": "/usr/bin/firefox",
      "visible": true
    }
  }
}
```

Notes:

- `terminal_command` drives the default agent tab and project/root terminal
  respawn behavior. UI choices are currently `claude` and `codex`.
- `color_scheme` supports `dark`, `light`, `fancy_dark`, and `fancy_light`;
  legacy `fancy` is normalized to `fancy_dark`.
- `global_apps` stores one entry per role with `exec` and `visible`.

### `default_apps.json`

```json
{
  ".py": "code",
  ".md": "gnome-text-editor",
  ".pdf": "evince"
}
```

Lookup order for file opens:

1. Project-local `project.json["default_apps"]`.
2. Global `default_apps.json`.
3. System MIME default from `xdg-mime`.
4. Manual "Open With" dialog.

### `time_log.json`

```json
[
  {
    "project_id": "<uuid4>",
    "date": "2026-05-27",
    "start_iso": "2026-05-27T10:00:00+00:00",
    "duration_s": 3600.0
  }
]
```

`active_session.json` stores the active project id and start time while a session
is open. On next startup, `TimeTracker` closes a leftover sentinel as an
orphaned session and removes the sentinel.

## Runtime Behavior

### Startup

1. `EldrunApp` applies CSS and creates `EldrunWindow`.
2. `ProjectManager` creates required global directories and root context files,
   then loads and migrates the project registry.
3. Settings, default apps, global apps, time tracker, and workspace manager are
   initialized.
4. Missing global app executables are populated from system defaults when
   discoverable.
5. On map, visible projects (`active` or `current`) get terminals and bottom-bar
   pills.
6. Inactive projects receive background stats scans.
7. The project marked `current` is opened; if none exists, the root terminal is
   opened.
8. Optional workspace management allocates workspaces for visible projects.
9. File-extension app mappings are bootstrapped from system MIME defaults in an
   idle callback.

### Project Activation

Activating a project pill:

- Shows the project terminal page.
- Marks the previous current project `active`.
- Marks the new one `current`.
- Updates the file tree overlay.
- Starts a time-tracking session for the project.
- Refreshes time tooltips.
- Switches to the assigned workspace if workspace management is enabled.

Switching away from a project terminal closes the active time-tracking session.

### Terminal Respawn

Project and root terminals respawn automatically when their child exits. Changing
the terminal command from settings resets active terminal widgets and terminates
recorded child PIDs so they respawn with the new command.

Additional agent and plain terminal tabs are runtime UI state. They can be
renamed, closed, and reordered, but the current implementation does not persist
custom tab layouts across application restarts.

### File Opening and App Embedding

When a file is opened:

1. Eldrun resolves an app command.
2. It launches `subprocess.Popen([app, path], cwd=project_dir)`.
3. `CenterPanel` creates an app tab and polls `_NET_CLIENT_LIST` for a window
   with `_NET_WM_PID` matching the launched process.
4. If found, Eldrun attempts to strip decorations and reparent the X11 window
   into the center stack.
5. If embedding fails, it closes the app tab and records a standalone
   open-window row in the right overlay.

This is best-effort and X11-specific. Wayland compositors do not support this
embedding model.

### Global App Launching

Global app buttons are separate from project file opening:

1. Eldrun looks up the role entry in `settings.json["global_apps"]`.
2. It scans `_NET_CLIENT_LIST` for a likely matching existing window.
3. If a window is found, Eldrun raises it.
4. If no window is found, Eldrun launches the configured command.
5. When a launched or found global app window is available, Eldrun marks it
   sticky across all workspaces on X11.

Global apps are not moved to project workspaces and are not owned by any single
project.

### Network Monitoring

`NetworkMonitor` runs a daemon thread every 5 seconds:

- TCP connect probe to `1.1.1.1:53` with a 3 second timeout.
- Interface scan under `/sys/class/net` to classify `wlan`, `lan`, or
  `disconnected`.
- UI callbacks are delivered through `GLib.idle_add`.

### Workspace Management

`WorkspaceManager` auto-detects the backend on startup:

| Backend | Detection | Workspace create/name | Workspace switch |
|---|---|---|---|
| Cinnamon | `org.Cinnamon` DBus Eval | JS via `global.workspace_manager` | JS activate |
| GNOME | `gsettings get org.gnome.mutter dynamic-workspaces` succeeds | `gsettings` (`org.gnome.desktop.wm.preferences`) | EWMH `_NET_CURRENT_DESKTOP` |
| wmctrl | `wmctrl -l` exits 0 | `wmctrl -n` (count only, no names) | `wmctrl -s` |
| none | fallthrough | no-op | no-op |

Behavior common to all backends:

- Eldrun's window is marked sticky via `_NET_WM_STATE_STICKY` EWMH.
- Each active project gets a workspace; activating a project switches to it.
- Assignments are in memory and rebuilt every launch.
- Turning workspace management on mid-session reconciles already-active
  projects without requiring a restart.
- Normal quit restores managed workspace state where the backend supports it.

GNOME-specific notes:

- Dynamic workspaces (`org.gnome.mutter dynamic-workspaces`) are temporarily
  disabled while Eldrun is running so a fixed workspace count can be held.
- On clean exit (or Python crash via `atexit`), the original workspace count,
  names, and dynamic-workspaces setting are restored.
- SIGKILL cannot be caught; if the process is killed hard the `gsettings` state
  remains changed and must be restored manually:
  `gsettings reset org.gnome.mutter dynamic-workspaces`

Wayland limitations:

- `gsettings` calls for workspace count, names, and dynamic-workspace toggling
  work on Wayland.
- Workspace switching uses EWMH (`_NET_CURRENT_DESKTOP`), which Wayland
  compositors do not honor.
- Sticky-window state also relies on EWMH and may not propagate under Wayland.
- App window embedding is not implemented on Wayland.

## Tests and Current Quality Signals

The repository has unit tests for project management, settings, default apps,
network detection, time tracking, open-app metadata, and bottom-panel logic.

Recommended checks:

```bash
python3 -m py_compile app/eldrun.py app/window.py app/project_manager.py \
  app/new_project_dialog.py app/import_project_dialog.py app/settings_manager.py \
  app/default_apps_manager.py app/network_monitor.py app/time_tracker.py \
  app/project_stats.py app/workspace_manager.py app/panels/*.py

python3 -m unittest
```

Important analysis findings:

- `app/panels/right_panel.py` is a historical filename. Its live widget is
  `FileTreePanel`.
- Open-app metadata is stored in `project.json["open_apps"]`; robust standalone
  restore remains future work.
- Global app role state is stored in `settings.json["global_apps"]`, not in
  project metadata.

## Known Limitations

- X11 app embedding is fragile and should be treated as experimental.
- Wayland: workspace switching, sticky-window state, launch-or-raise window
  manipulation, and app embedding are limited or unavailable because those paths
  rely on X11/EWMH.
- Open-window/app persistence has a canonical metadata location, but restore
  behavior is not wired as a robust current feature.
- Extra agent/plain terminal tab layout is runtime state and is not persisted
  across restarts.
- Network status depends on reaching Cloudflare DNS and may show offline on
  networks that block direct TCP/53 even when general internet access works.
- The app uses several GTK widgets and X11 techniques that require live-session
  testing beyond headless unit tests.

## Practical Development Notes

- Prefer editing under `app/`; generated global/runtime data lives under
  `~/.local/share/eldrun/` and project-local runtime files.
- Use `GLib.idle_add` for GTK updates from threads and return `False` from
  one-shot callbacks.
- Keep `ProjectManager._save()` as a lightweight index write and
  `_save_local()` as project-local metadata write.
- Be careful with terminal command changes: active terminals are reset and child
  PIDs are killed so VTE `child-exited` handlers respawn them.
- Treat X11 window IDs as volatile. Any embedding path needs recovery that
  returns to a valid terminal page on failure.
