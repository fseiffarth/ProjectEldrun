# ProjectEldrun — Gemini Context

Eldrun is a GTK4 desktop workspace for AI-assisted development. It keeps a root
control terminal, one terminal per active project, a bottom project switcher, a
right-side file tree overlay, app launching/embedding, time tracking, and
optional workspace backend integration in one window.

Python 3.11+, GTK4, Libadwaita, VTE 3.91, and `python-xlib` are expected. X11 is
required for app-window embedding; KDE Plasma (X11 and Wayland) and Cinnamon
workspace management are supported.

## Running

Do not launch Eldrun from Gemini or any other agent terminal for verification.
Opening a second Eldrun instance can corrupt workspace state. Ask the user to
run or restart the existing instance when runtime validation is needed.

Runtime launch commands are intentionally omitted from this context.

## File Map

| File | Purpose |
|------|---------|
| `app/eldrun.py` | `Adw.Application`, CSS themes, signal handlers, crash logging. |
| `app/window.py` | `EldrunWindow`: header, layout, key handling, startup restore, project activation, time tracking hooks, network callbacks, workspace integration. |
| `app/project_manager.py` | Project registry, create/import flow, scaffold writer, migrations, root context files. |
| `app/settings_manager.py` | JSON-backed user settings. |
| `app/default_apps_manager.py` | Global and per-project file-extension app mappings; system MIME bootstrap. |
| `app/time_tracker.py` | Active project session tracking, orphan-session closure, `STATUS.md` time summary updates. |
| `app/project_stats.py` | Background file-type and time summary scanner. |
| `app/network_monitor.py` | Background connectivity probe and network interface type detection. |
| `app/workspace_manager.py` | Two-workspace parking model; delegates window and desktop operations to the active `ProjectSpaceBackend`. |
| `app/workspace_core.py` | `ProjectSpaceBackend` ABC and shared workspace types. |
| `app/backends/__init__.py` | Backend auto-detection: KDE first, then Cinnamon, then null. |
| `app/backends/kde_kwin.py` | KDE Plasma backend: X11 via Xlib EWMH; Wayland via KWin JS scripting + DBus. |
| `app/backends/cinnamon_x11.py` | Cinnamon/X11 workspace backend. |
| `app/backends/gnome.py` | GNOME workspace backend. |
| `app/backends/null.py` | No-op backend fallback. |
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
- New/imported projects receive `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
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
- Do not use `GLib.idle_add` for deferred startup work that calls
  `get_monitor_at_surface()`. Use `GLib.timeout_add(500, ...)` instead — the
  idle path can trigger a frame-clock reentrance SIGSEGV before the first render
  cycle completes (see `_restore_project_apps()` in `window.py`).
- X11 reparenting is best-effort and fragile; non-KDE Wayland embedding is not
  implemented.
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
  app/project_stats.py app/workspace_manager.py app/panels/*.py \
  app/backends/*.py
```

3. Run tests:

```bash
python3 -m unittest
```

4. Do not start Eldrun from an agent terminal. Ask the user to restart the
   existing instance for runtime verification.

Useful keys: `F11` toggles fullscreen; `Super` toggles panels while Eldrun is
focused. The custom header close button calls `app.quit()`.
