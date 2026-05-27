# ProjectEldrun — Claude Context

Eldrun is a GTK4 desktop workspace for AI-assisted development. It keeps a root
control terminal, one terminal per active project, a bottom project switcher, a
right-side file tree overlay, app launching/embedding, time tracking, and
optional Cinnamon workspace integration in one window.

Python 3.11+, GTK4, Libadwaita, VTE 3.91, and `python-xlib` are expected. X11 is
required for app-window embedding and Cinnamon workspace management.

## Running

Preferred launcher:

```bash
./start-eldrun.sh
```

Direct run:

```bash
cd app && python3 eldrun.py
```

Direct run with explicit display and log capture:

```bash
cd /home/user/eldrun/projects/projecteldrun/app && DISPLAY=:0 python3 eldrun.py &> /tmp/eldrun.log &
```

## File Map

| File | Purpose |
|------|---------|
| `app/eldrun.py` | `Adw.Application`, CSS themes, signal handlers. |
| `app/window.py` | `EldrunWindow`: header, layout, key handling, startup restore, project activation, time tracking hooks, network callbacks, workspace integration. |
| `app/project_manager.py` | Project registry, create/import flow, scaffold writer, migrations, root context files. |
| `app/settings_manager.py` | JSON-backed user settings. |
| `app/default_apps_manager.py` | Global and per-project file-extension app mappings; system MIME bootstrap. |
| `app/time_tracker.py` | Active project session tracking, orphan-session closure, `STATUS.md` time summary updates. |
| `app/project_stats.py` | Background file-type and time summary scanner. |
| `app/network_monitor.py` | Background connectivity probe and network interface type detection. |
| `app/workspace_manager.py` | Cinnamon workspace creation/switch/removal and sticky Eldrun window support. |
| `app/new_project_dialog.py` | Modal project creation UI and validation. |
| `app/import_project_dialog.py` | Modal import UI, folder chooser, mode selection. |
| `app/panels/center_panel.py` | Terminal stack, tab bar, app tab lifecycle, X11 embedding/fallback. |
| `app/panels/right_panel.py` | Current `FileTreePanel`: file operations, default app dialogs, open-window list. Historical filename. |
| `app/panels/bottom_panel.py` | Bottom bar, project pills, settings windows, project search, drag/drop ordering. |

## Persistence

- Managed projects normally live under `~/eldrun/projects/<sanitized-name>/`.
- The root terminal spawns in `~/eldrun/root/`.
- Global Eldrun state lives in `~/.local/share/eldrun/`:
  `projects.json`, `settings.json`, `default_apps.json`, `time_log.json`, and
  `active_session.json`.
- Project-local state lives in each project's `project.json`.
- Open-app metadata is stored in `project.json["open_apps"]`; standalone restore
  behavior is still future work.
- New/imported projects receive `AGENTS.md`, `CLAUDE.md`,
  `.claude/settings.json`, `.gitignore`, `TODO.md`, `ROADMAP.md`, `STATUS.md`,
  and `DOCUMENTATION.md` when missing.
- `TODO.md` uses grouped IDs such as `G1.1`. When adding a TODO, put it in the
  matching group, create a new group if no current group fits, or merge groups
  if the TODO depends on distinct areas that should be tracked together.

## GTK4 Gotchas

- `Gtk.Dialog` is deprecated; use `Gtk.Window` with `modal=True` and
  `transient_for`.
- `Gtk.TreeView` / `Gtk.TreeStore` are legacy but still used here. Do not
  refactor to `Gtk.ColumnView` unless the task requires it.
- `Vte.Terminal.spawn_async` is non-blocking; the PID arrives in the callback,
  not the return value.
- `GLib.idle_add` callbacks must return `False` unless repeated calls are
  intended.
- X11 reparenting is best-effort and fragile; Wayland embedding/workspace
  support is not implemented.
- `Gtk.WindowHandle` makes its child area drag-to-move; custom header content
  belongs inside it.
- `Gtk.FileChooserNative` is preferred over deprecated file chooser dialogs.

## Dev Workflow

1. Edit focused files under `app/` or docs.
2. Syntax check:

```bash
python3 -m py_compile app/eldrun.py app/window.py app/project_manager.py \
  app/new_project_dialog.py app/import_project_dialog.py app/settings_manager.py \
  app/default_apps_manager.py app/network_monitor.py app/time_tracker.py \
  app/project_stats.py app/workspace_manager.py app/panels/*.py
```

3. Run tests:

```bash
python3 -m unittest
```

4. Run locally with `./start-eldrun.sh` or `cd app && python3 eldrun.py`.

Useful keys: `F11` toggles fullscreen; `Super` toggles panels while Eldrun is
focused. The custom header close button calls `app.quit()`.
