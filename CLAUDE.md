# ProjectEldrun — Claude context

Standalone GTK4 terminal manager. Python 3.11+, GTK4, Libadwaita, VTE 3.91.
All app code lives under `app/`. Entry point: `app/eldrun.py`.

## Running

```bash
cd /home/user/Documents/repos/ProjectEldrun/app && DISPLAY=:0 python3 eldrun.py
```

To start in the background and tail logs:
```bash
cd /home/user/Documents/repos/ProjectEldrun/app && DISPLAY=:0 python3 eldrun.py &> /tmp/eldrun.log &
```

## File map

| File | Purpose |
|------|---------|
| `app/eldrun.py` | `Adw.Application`, CSS, signal handlers |
| `app/window.py` | `EldrunWindow`: custom header bar, layout, key bindings, startup restore |
| `app/project_manager.py` | JSON persistence at `~/.local/share/eldrun/projects.json`; `create_project()`, `import_project()`, scaffold writer, startup migration |
| `app/new_project_dialog.py` | Modal dialog for creating new projects |
| `app/import_project_dialog.py` | Modal dialog for importing an existing folder as a project |
| `app/panels/left_panel.py` | Open-apps browser (`open_apps.json`) + project file tree (EWMH poll) |
| `app/panels/center_panel.py` | `Gtk.Stack` of VTE terminals + X11 app embedding |
| `app/panels/right_panel.py` | Root button, search field, project list with active indicator, +/Import popover |

Projects are stored as git repos under `~/eldrun/projects/<sanitized-name>/`.
The root terminal spawns in `~/eldrun/root/` (dedicated root working dir, not the workspace root itself).

## GTK4 gotchas

- `Gtk.Dialog` is deprecated; use `Gtk.Window` with `modal=True` + `transient_for`.
- `Gtk.TreeView` / `Gtk.TreeStore` are legacy but still work. New code should use `Gtk.ColumnView` + `Gtk.TreeListModel` — but don't refactor unless needed.
- `Vte.Terminal.spawn_async` is non-blocking; the PID arrives in the callback, not the return value.
- `GLib.idle_add` callbacks must return `False` to avoid being called repeatedly.
- CSS property `background-color` works on `window {}` only with `set_decorated(False)` or via an Adwaita style manager override.
- X11 reparenting (`show_app_window`) is best-effort and untested on Wayland compositors.
- `Gtk.WindowHandle` makes its child area drag-to-move; wrap the custom header box in it.
- `Gtk.FileChooserNative` (GTK 4.0+) is preferred over the deprecated `Gtk.FileChooserDialog`.

## Dev workflow

1. Edit files in `app/`.
2. Syntax check: `python3 -m py_compile app/eldrun.py app/window.py app/project_manager.py app/new_project_dialog.py app/import_project_dialog.py app/panels/*.py`
3. Run: `cd app && python3 eldrun.py`
4. F11 toggles fullscreen. Custom header close button calls `app.quit()`.
