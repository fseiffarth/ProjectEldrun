# ProjectEldrun - Documentation

Eldrun is a Python/GTK4 desktop workspace for AI-assisted development. Its core
job is to keep many project-specific agent terminals available without losing the
surrounding project context: file tree, default app choices, time tracking,
network state, and optional desktop workspace routing.

This document reflects the code in `app/` as of May 27, 2026.

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
- `python-xlib` and GDK X11 bindings for X11 window tracking, app embedding, and
  Cinnamon workspace integration.
- `xdg-mime`, `.desktop` files, and `xdg-open` for file handler discovery.
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

The current app is no longer the older three-column layout. The active layout is:

```text
+--------------------------------------------------------------+
| status lamp + network icon        clock             wm dots   |
+--------------------------------------------------------------+
| center tab bar: Terminal/Root/project/app tabs                |
+--------------------------------------------------------------+
|                                                              ||
| VTE terminal, app loading placeholder, or embedded X11 app   || right overlay
|                                                              || PROJECT tree
|                                                              || OPEN WINDOWS
+--------------------------------------------------------------+
| Root | Search... | project pills...        | settings | + | > |
+--------------------------------------------------------------+
```

### Header

- Shows online/offline status and wired/wireless type.
- Shows a clock in the center.
- Provides custom minimize, maximize/restore, and close buttons.
- The window is undecorated and uses `Gtk.WindowHandle` so the header can be
  dragged.

### Center Panel

The center panel is a `Gtk.Stack` with a horizontal tab bar.

- The permanent terminal tab points to either Root or the last active project
  terminal.
- Each active project has one VTE terminal page named `project-<id>`.
- File opens can create temporary app tabs. Eldrun tries to find the launched
  process' X11 window and reparent it into the center panel.
- If embedding fails, the app tab is removed and the app is tracked as a
  standalone open window in the right overlay.
- An offline banner is displayed over the stack when the network probe reports
  offline.
- The terminal command comes from `settings.json` key `terminal_command`;
  supported UI choices are currently `claude` and `codex`, with shell fallback if
  the configured command is missing.

### Right File Tree Overlay

`FileTreePanel` lives in `app/panels/right_panel.py`. Despite the filename, it is
the current project file browser, not the old project-list panel.

The panel appears only while a project terminal is the active center page and can
be hidden from the bottom bar. It provides:

- Recursive project file tree with folders first.
- Hidden files toggle in per-project settings.
- Ignored internal files: `.git`, `open_apps.json`, `project.json`,
  `project_default_apps.json`, and `.eldrun_colors.json`.
- Double-click folder expand/collapse.
- Double-click file open through per-project defaults, global defaults, system
  MIME defaults, or a manual "Open With" dialog.
- Right-click actions: open, open with, new file, new folder, copy path, reveal in
  file manager, color label, reset color, rename, delete, and properties.
- Per-path color labels stored as `.eldrun_colors.json` in the project.
- An `OPEN WINDOWS` section for standalone app windows that could not be embedded.

### Bottom Project Bar

`BottomPanel` in `app/panels/bottom_panel.py` owns the persistent bottom controls:

- **Root** opens the root workspace terminal.
- **Search** opens a result list across all registered projects, including
  inactive projects.
- **Project pills** activate, close, show warm/open-app state, show time/file-type
  stats on hover/right click, and support drag-and-drop reordering.
- **Settings** opens terminal command, theme, workspace management, and global
  file-type app settings.
- **+** opens a popover for new project or import project.
- **> / <** hides or shows the right file tree overlay.

Closing a project removes its terminal and marks it inactive in the global index.
If local metadata says the project has open apps, Eldrun asks for confirmation.

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
└── EldrunWindow (Adw.ApplicationWindow)
    ├── header: status lamp, network icon, clock, custom window controls
    ├── CenterPanel: VTE terminals, app tabs, X11 embedding attempt
    ├── FileTreePanel: project file tree and standalone open-window list
    └── BottomPanel: Root, search, project pills, settings, add/import, panel toggle
```

### Module Map

| File | Responsibility |
|------|----------------|
| `app/eldrun.py` | Application entry point, CSS themes, signal handlers, `EldrunApp`. |
| `app/window.py` | Main window composition, key handling, startup restore, project activation, time tracking hooks, network callbacks, workspace integration. |
| `app/project_manager.py` | Project registry, project creation/import, scaffold writing, migrations, root context files. |
| `app/new_project_dialog.py` | Modal project creation UI and validation. |
| `app/import_project_dialog.py` | Modal import UI, folder chooser, mode selection. |
| `app/settings_manager.py` | JSON-backed user settings. |
| `app/default_apps_manager.py` | Global and per-project file-extension app mappings; system MIME bootstrap. |
| `app/time_tracker.py` | Active project session tracking and crash/orphan session closure. |
| `app/project_stats.py` | Background file-type and time summary scanner. |
| `app/network_monitor.py` | Background 1.1.1.1:53 probe and network interface type detection. |
| `app/workspace_manager.py` | Workspace creation/switch/removal for Cinnamon, GNOME, and wmctrl backends; sticky Eldrun window support. |
| `app/panels/center_panel.py` | Terminal stack, tab bar, app tab lifecycle, X11 embedding/fallback. |
| `app/panels/right_panel.py` | Current `FileTreePanel`: file operations, default app dialogs, open-window list. |
| `app/panels/bottom_panel.py` | Bottom bar, project pills, settings windows, search, drag/drop ordering. |

## Persistence Model

Eldrun intentionally splits global index data from project-local metadata.

### Global Directory

All global data is under `~/.local/share/eldrun/`.

| File | Managed by | Purpose |
|------|------------|---------|
| `projects.json` | `ProjectManager` | Lightweight index of known projects. |
| `settings.json` | `SettingsManager` | User settings. |
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

Defaults:

```json
{
  "terminal_command": "claude",
  "workspace_management": false
}
```

The UI can also persist `color_scheme` as `"dark"` or `"light"`.

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
is open. On next startup, `TimeTracker` closes a leftover sentinel as an orphaned
session and removes the sentinel.

## Runtime Behavior

### Startup

1. `EldrunApp` applies CSS and creates `EldrunWindow`.
2. `ProjectManager` creates required global directories and root context files,
   then loads and migrates the project registry.
3. Settings, default apps, time tracker, and workspace manager are initialized.
4. On map, visible projects (`active` or `current`) get terminals and bottom-bar
   pills.
5. Inactive projects receive background stats scans.
6. The project marked `current` is opened; if none exists, the root terminal is opened.
7. Optional workspace management allocates workspaces for visible projects.
8. Default app mappings are bootstrapped from system MIME defaults in an idle
   callback.

### Project Activation

Activating a project pill:

- Shows the project terminal page.
- Marks the previous current project `active`.
- Marks the new one `current`.
- Updates the file tree overlay.
- Starts a time-tracking session for the project.
- Refreshes time tooltips.
- Switches to the assigned Cinnamon workspace if workspace management is enabled.

Switching away from a project terminal closes the active time-tracking session.

### Terminal Respawn

Project and root terminals respawn automatically when their child exits. Changing
the terminal command from settings resets active terminal widgets and terminates
recorded child PIDs so they respawn with the new command.

### File Opening and App Embedding

When a file is opened:

1. Eldrun resolves an app command.
2. It launches `subprocess.Popen([app, path], cwd=project_dir)`.
3. `CenterPanel` creates an app tab and polls `_NET_CLIENT_LIST` for a window with
   `_NET_WM_PID` matching the launched process.
4. If found, Eldrun attempts to strip decorations and reparent the X11 window into
   the center stack.
5. If embedding fails, it closes the app tab and records a standalone open-window
   row in the right overlay.

This is best-effort and X11-specific. Wayland compositors do not support this
model.

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

Behaviour common to all backends:

- Eldrun's window is marked sticky via `_NET_WM_STATE_STICKY` EWMH.
- Each active project gets a workspace; activating a project switches to it.
- Assignments are in memory and rebuilt every launch.

GNOME-specific notes:

- Dynamic workspaces (`org.gnome.mutter dynamic-workspaces`) are temporarily
  disabled while Eldrun is running so a fixed workspace count can be held.
- On clean exit (or Python crash via `atexit`), the original workspace count,
  names, and dynamic-workspaces setting are restored.
- SIGKILL cannot be caught; if the process is killed hard the `gsettings` state
  remains changed and must be restored manually:
  `gsettings reset org.gnome.mutter dynamic-workspaces`

**Wayland limitations:** `gsettings` calls (count, names, dynamic toggle) work
on Wayland. However, workspace *switching* uses EWMH (`_NET_CURRENT_DESKTOP`)
which Wayland compositors do not honour — switching silently does nothing.
Sticky-window state also relies on EWMH and may not propagate under Wayland.
There is no public API for workspace switching on GNOME Wayland without a Shell
extension or re-enabling `org.gnome.Shell.Eval` unsafe mode; this is a known
limitation and out of scope until Wayland embedding is tackled more broadly.

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
- Open-app metadata is stored in `project.json["open_apps"]`; standalone restore
  behavior remains future work.

## Known Limitations

- X11 app embedding is fragile and should be treated as experimental.
- Wayland: workspace switching and sticky-window state are no-ops (EWMH not
  honoured by Wayland compositors). Workspace creation and naming via `gsettings`
  do work. App window embedding is impossible on Wayland.
- Open-window/app persistence has a canonical metadata location, but restore
  behavior is not wired as a robust current feature.
- Network status depends on reaching Cloudflare DNS and may show offline on
  networks that block direct TCP/53 even when general internet access works.
- The app uses several GTK widgets and X11 techniques that require live-session
  testing beyond headless unit tests.

## Practical Development Notes

- Prefer editing under `app/`; generated global/runtime data lives under
  `~/.local/share/eldrun/` and project-local runtime files.
- Use `GLib.idle_add` for GTK updates from threads and return `False` from one-shot
  callbacks.
- Keep `ProjectManager._save()` as a lightweight index write and
  `_save_local()` as project-local metadata write.
- Be careful with terminal command changes: active terminals are reset and child
  PIDs are killed so VTE `child-exited` handlers respawn them.
- Treat X11 window IDs as volatile. Any embedding path needs recovery that returns
  to a valid terminal page on failure.
