# ProjectEldrun — TODO

## Completed

### Infrastructure
- [x] Directory structure: `app/`, `app/panels/`, `__init__.py` files
- [x] Entry point `app/eldrun.py`: `Adw.Application`, CSS, SIGTERM/SIGINT handlers
- [x] Dependencies: GTK4, Adw, VTE 3.91 (`gir1.2-vte-3.91`), python-xlib all importable

### Main window (`app/window.py`)
- [x] `EldrunWindow(Adw.ApplicationWindow)`: undecorated, 1440×900 default
- [x] Triple-column `Gtk.Paned` layout: left 220px / center flex / right 280px
- [x] F11 fullscreen toggle
- [x] Prevent accidental close (`close-request` → True)
- [x] On startup: open Root terminal in center, hide left panel
- [x] Left panel shown only when a project terminal is active; hidden for Root/empty/app views

### Project Manager (`app/project_manager.py`)
- [x] JSON persistence at `~/.local/share/eldrun/projects.json`
- [x] `add_project()`, `remove_project()`, `get_project()`, `set_shell_pid()`

### Right panel (`app/panels/right_panel.py`)
- [x] Red "Root" button (Adwaita `destructive-action`) → calls `center_panel.open_master_terminal()`
- [x] PROJECTS section: `Gtk.ListBox` with `ProjectRow` (folder icon, name, × close button)
- [x] Row selection → `center_panel.show_project_terminal(project_id)`
- [x] Green "+" button at bottom → `_on_new_project_clicked` (currently a no-op stub)

### Center panel (`app/panels/center_panel.py`)
- [x] `Gtk.Stack` (NONE transition) inside `Gtk.Overlay`
- [x] Placeholder page ("No project selected. Press + to create one.")
- [x] Root/master terminal page (`__master__`): spawns `claude`/bash in `~/eldrun/`, lazy init, respawns on exit
- [x] Per-project terminal pages: spawns `claude`/bash in project dir, respawns on exit
- [x] `open_master_terminal()`, `add_project_terminal()`, `show_project_terminal()`, `remove_project_terminal()`
- [x] `on_page_changed` callback → notifies window to show/hide left panel
- [x] "⬛ Terminal" overlay button: visible when app is embedded, returns to last terminal
- [x] `show_app_window(xid)`: X11 reparenting via GdkX11 + python-xlib (untested)
- [x] `_release_app_window()`: reparents embedded window back to root

### Left panel (`app/panels/left_panel.py`)
- [x] Top section "OPEN APPS": polls `_NET_CLIENT_LIST` every 2 s via python-xlib EWMH
- [x] Filters: `_NET_WM_WINDOW_TYPE_NORMAL` only, skip own PID
- [x] Diff-based row updates (add/remove/rename without full rebuild)
- [x] Row click → `center_panel.show_app_window(xid)` (falls back to `_raise_window`)
- [x] Bottom section "PROJECT": stub `Gtk.ListBox` (file tree not yet implemented)

---

## Completed (Phases 1–10)

### Phase 1 — Projects folder restructure

- [x] Move `PROJECTS_ROOT` from `~/eldrun/` to `~/eldrun/projects/` and update all path references
- [x] Migrate existing projects on startup: if a dir under `~/eldrun/` is a project dir (not `projects/`), move it into `~/eldrun/projects/` and update `projects.json`
- [x] Update root terminal cwd to `~/eldrun/` (workspace root, not projects subfolder)
- [x] Update all scaffold, file-tree, and EWMH cwd-filter references to use new path

### Phase 2 — Window chrome: custom title bar + drag-to-move

- [x] `Gtk.WindowHandle` wraps a custom `app-header` box — drag-to-move works natively
- [x] Minimize (yellow), maximize/restore (green), close (red) circular WM buttons on the right
- [x] Close calls `app.quit()`; maximize toggles with tooltip update on `notify::maximized`
- [x] `close-request` blocker removed; header close button is the canonical exit path

### Phase 3 — "+" button: new project dialog + scaffold

- [x] `NewProjectDialog` modal with name entry, visibility dropdown, live path preview, conflict warning
- [x] `PROJECTS_ROOT = ~/eldrun/projects`; `WORKSPACE_ROOT = ~/eldrun`; `sanitize_name()`
- [x] `create_project()`: mkdir, git init, write all scaffold files, initial commit
- [x] Scaffold: `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `TODO.md`, `ROADMAP.md`, `STATUS.md`, `DOCUMENTATION.md`
- [x] Wired in `window.py`: "+" → dialog → `add_project_terminal` + `add_project_row`; "×" removes; startup restores

### Phase 4 — Active project indicator

- [x] CSS class `project-row-active` → red border + border-radius on the active row
- [x] `RightPanel.set_active_project(id)` adds/removes the class across all rows
- [x] Called from `window._on_center_page_changed`; cleared on Root/empty view

### Phase 5 — Import project (+ button popup)

- [x] "+" button shows `Gtk.Popover` with **New Project** and **Import Project** actions
- [x] `ImportProjectDialog`: `Gtk.FileChooserNative` folder picker, name entry (pre-filled), visibility dropdown, destination preview, conflict warning
- [x] `project_manager.import_project()`: `shutil.copytree` (skips `.git/`), scaffold gap-fill, fresh git init + commit, background thread, spinner label

### Phase 6 — Project search field (below Root button)

- [x] `Gtk.SearchEntry` between Root button and PROJECTS header
- [x] Real-time case-insensitive filter via `ListBox.set_filter_func`
- [x] Enter on a single matching result selects it, opens its terminal, clears the query

### Phase 7 — Left panel: project file tree

- [x] `update_project()` rebuilds tree on project switch; 5 s refresh timer
- [x] `Gtk.TreeView` + `Gtk.TreeStore`; folders first; `.git` and `open_apps.json` hidden
- [x] Row-activated: expand/collapse dirs; `xdg-open` files
- [x] Placeholder shown when no project is active

### Phase 8 — Open-apps browser mode (left panel)

- [x] `OpenAppsManager` class persists `open_apps.json` per project (`{name, exe, args}` entries)
- [x] `AppRow` shows ● running indicator (green/grey), app name, × remove button
- [x] On project activation: load `open_apps.json`, rebuild rows, reopen missing apps after 600 ms
- [x] EWMH poll records every window whose cwd is in the project into `open_apps.json`
- [x] Click: raises window if running (`show_app_window`/`_raise_window`), relaunches if not
- [x] × button removes entry from `open_apps.json` and the UI row

### Phase 9 — Left panel: project-scoped app filtering

- [x] `/proc/<pid>/cwd` read via `os.readlink`; only windows inside the current project dir shown
- [x] Re-filters on project switch; nothing shown on Root/empty view

### Phase 10 — Packaging + docs

- [x] `eldrun.desktop` launcher present
- [x] `CLAUDE.md` updated: new file map, new gotchas, new dev workflow
- [x] `DOCUMENTATION.md` updated: import dialog, `open_apps.json`, path changes
- [x] `README.md` updated: new feature list
- [x] Full syntax check passes: all 8 `.py` files compile clean

---

## Future Goals

> These are long-horizon ideas — not scheduled. They require the core phases above to be stable before they make sense to pursue.

### Local Ollama integration

Run a local Ollama instance alongside Eldrun to provide lightweight AI assistance without requiring an internet connection or external API key.

- [ ] **Daemon management**: start/stop an `ollama serve` subprocess when Eldrun launches; expose a status indicator (dot in the header bar — green = ready, grey = offline)
- [ ] **Intelligent project search**: replace the plain substring filter in the search field (Phase 6) with an embedding-based semantic search — query Ollama for sentence embeddings of the project name + `STATUS.md` / `CLAUDE.md` summary, rank results by cosine similarity
- [ ] **"Suggest projects for today"**: on startup, send recent git activity (`git log --oneline -20` across all projects) + current date/time to Ollama and surface the top 2–3 projects the user likely wants to continue; show as a soft highlight or pinned section at the top of the project list
- [ ] **App/file suggestions per project**: when a project is activated, ask Ollama which files are most likely relevant given recent commits and `open_apps.json` history; surface suggestions as a "Suggested" section at the top of the open-apps browser (Phase 8)
- [ ] **Context-aware terminal hints**: optionally pipe the last N lines of the active terminal's scrollback to Ollama and display a short hint strip below the terminal ("looks like a test failure — run `pytest -x`")
- [ ] **Model selection**: configurable per-project in `CLAUDE.md` or a sidebar setting; default to a small fast model (e.g. `mistral`, `phi3`) for latency-sensitive suggestions
- [ ] **Privacy boundary**: all inference runs locally; no data leaves the machine; add a visible "local AI" label to any AI-generated suggestion so the user always knows the source
