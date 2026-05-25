# ProjectEldrun — TODO

---

## Completed

### Phase 0 — Foundation

#### Infrastructure
- [x] Directory structure: `app/`, `app/panels/`, `__init__.py` files
- [x] Entry point `app/eldrun.py`: `Adw.Application`, CSS, SIGTERM/SIGINT handlers
- [x] Dependencies: GTK4, Adw, VTE 3.91 (`gir1.2-vte-3.91`), python-xlib all importable

#### Main window (`app/window.py`)
- [x] `EldrunWindow(Adw.ApplicationWindow)`: undecorated, 1440×900 default
- [x] Triple-column `Gtk.Paned` layout: left 220px / center flex / right 280px
- [x] F11 fullscreen toggle
- [x] Prevent accidental close (`close-request` → True)
- [x] On startup: open Root terminal in center, hide left panel
- [x] Left panel shown only when a project terminal is active; hidden for Root/empty/app views

#### Project Manager (`app/project_manager.py`)
- [x] JSON persistence at `~/.local/share/eldrun/projects.json`
- [x] `add_project()`, `remove_project()`, `get_project()`, `set_shell_pid()`

#### Right panel (`app/panels/right_panel.py`)
- [x] Red "Root" button (Adwaita `destructive-action`) → calls `center_panel.open_master_terminal()`
- [x] PROJECTS section: `Gtk.ListBox` with `ProjectRow` (folder icon, name, × close button)
- [x] Row selection → `center_panel.show_project_terminal(project_id)`
- [x] Green "+" button at bottom → `_on_new_project_clicked` (currently a no-op stub)

#### Center panel (`app/panels/center_panel.py`)
- [x] `Gtk.Stack` (NONE transition) inside `Gtk.Overlay`
- [x] Placeholder page ("No project selected. Press + to create one.")
- [x] Root/master terminal page (`__master__`): spawns `claude`/bash in `~/eldrun/`, lazy init, respawns on exit
- [x] Per-project terminal pages: spawns `claude`/bash in project dir, respawns on exit
- [x] `open_master_terminal()`, `add_project_terminal()`, `show_project_terminal()`, `remove_project_terminal()`
- [x] `on_page_changed` callback → notifies window to show/hide left panel
- [x] "⬛ Terminal" overlay button: visible when app is embedded, returns to last terminal
- [x] `show_app_window(xid)`: X11 reparenting via GdkX11 + python-xlib (untested)
- [x] `_release_app_window()`: reparents embedded window back to root

#### Left panel (`app/panels/left_panel.py`)
- [x] Top section "OPEN APPS": polls `_NET_CLIENT_LIST` every 2 s via python-xlib EWMH
- [x] Filters: `_NET_WM_WINDOW_TYPE_NORMAL` only, skip own PID
- [x] Diff-based row updates (add/remove/rename without full rebuild)
- [x] Row click → `center_panel.show_app_window(xid)` (falls back to `_raise_window`)
- [x] Bottom section "PROJECT": stub `Gtk.ListBox` (file tree not yet implemented)

---

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

### Phase 6 — Project search field

- [x] `Gtk.SearchEntry` between Root button and PROJECTS header
- [x] Real-time case-insensitive filter via `ListBox.set_filter_func`
- [x] Enter on a single matching result selects it, opens its terminal, clears the query

### Phase 7 — Left panel: project file tree

- [x] `update_project()` rebuilds tree on project switch; 5 s refresh timer
- [x] `Gtk.TreeView` + `Gtk.TreeStore`; folders first; `.git` and `open_apps.json` hidden
- [x] Row-activated: expand/collapse dirs; `xdg-open` files
- [x] Placeholder shown when no project is active

### Phase 8 — Open-apps browser (left panel)

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

### Phase 11 — File-tree interactions + settings

- [x] **Right-click context menu on project files**: Open, Open With…, Copy Path, Reveal in File Manager, Rename…, Delete
- [x] **Double-click opens file with matched app**: looks up `DefaultAppsManager` (project → global → xdg-mime); launches app, adds to open-apps list
- [x] **Per-project default app map**: `project_default_apps.json` per project dir; global fallback in `~/.local/share/eldrun/default_apps.json`; new module `app/default_apps_manager.py`
- [x] **No-match popup**: "Open With" dialog when no app found; option to save as default for this project or globally
- [x] **Bootstrap from system defaults**: `DefaultAppsManager.bootstrap_from_system()` runs at startup via `GLib.idle_add`
- [x] **Filetype → default app settings**: "File Type Apps…" button in gear popover opens a dedicated window
- [x] **Light-blue tint for warm projects**: CSS class `project-row-warm` when `open_apps.json` is non-empty
- [x] **Consistent Root switch UX**: `_on_root_clicked` deselects current project row before switching
- [x] **Super/Win key toggles panels**: hides/shows left + right panels; center takes full width
- [x] **Shift+Tab cycles open apps**: `LeftPanel.cycle_next_app()` rotates through running app rows

### Phase 12 — Polish + app picker

- [x] **Window starts maximized**: `EldrunWindow.__init__` calls `self.maximize()`
- [x] **App picker for default-app assignment**: "Browse…" button in "Open With" dialog and "⋯" in File Type Apps settings — both open a searchable list from `.desktop` files

### Phase 13 — Panel auto-hide + auto-embed

- [x] **Panel toggle buttons in header bar**: `‹` / `›` buttons flanking the title independently hide/show left and right panels; tooltips update on state change
- [x] **Right panel width normalized**: right panel is now 220 px (same as left) for a balanced layout
- [x] **Auto-embed app on file open**: when a file is opened from the project tree, Eldrun waits for the app's X window to appear (EWMH poll) and automatically embeds it in the center panel via `show_app_window`

---

### Phase 14 — Network status indicator

- [x] **Status lamp widget**: small circular `Gtk.Label` (●) in the header bar, far left via `Gtk.CenterBox`; CSS classes `status-online` (green) and `status-offline` (red)
- [x] **Connectivity probe**: daemon thread in `app/network_monitor.py`; TCP connect to `1.1.1.1:53` every 5 s; main-thread callback via `GLib.idle_add` on state change
- [x] **Offline visual feedback**: translucent `⚠ No internet connection` banner overlay in center panel (`CenterPanel.set_offline()`)
- [x] **Tooltip**: lamp tooltip shows "Online" or "Offline — last online HH:MM:SS"
- [x] **Graceful fallback**: any socket/OS exception in `_probe()` returns `False` (treated as offline); thread runs as daemon and never crashes the main process

### Phase 15 — Project time tracking + timeline bar

- [x] **Session recorder**: `TimeTracker` in `app/time_tracker.py`; `on_project_activated` / `on_project_deactivated` called from `_apply_panel_visibility`; appends `{project_id, date, start_iso, duration_s}` to `~/.local/share/eldrun/time_log.json`
- [x] **Today's totals**: `TimeTracker.get_today_totals()` aggregates from log; refreshed on every project switch and every 60 s via `GLib.timeout_add`
- [x] **Timeline bar in right panel**: `Gtk.ProgressBar` below each `ProjectRow`; fraction = project's share of today's max time; tooltip = "Xh Ym today"; hidden when zero
- [x] **CSS**: `progressbar.project-time-bar` (muted blue fill, rounded, 4 px height)
- [x] **status.md sync**: `TimeTracker._update_status_md()` rewrites `## Time Log` section on session close; creates section if absent, replaces if present; last 20 sessions in table; total duration line
- [x] **Startup resume**: `TimeTracker._close_orphan_session()` reads `~/.local/share/eldrun/active_session.json` sentinel on init and synthesises a closing log entry

---

## Next

### Propagate theme toggle to terminals and embedded apps

When the user switches dark mode on/off in the gear settings, the theme change should propagate beyond the UI:

- [ ] **VTE terminals**: update foreground/background colors on the active (and all open) `Vte.Terminal` instances — dark scheme uses current dark palette, light scheme uses a light terminal palette (e.g. white bg, dark fg)
- [ ] **Embedded apps**: for apps that support a theme flag (e.g. `--dark` / `--light`, `GTK_THEME`, or `prefers-color-scheme` via D-Bus `org.freedesktop.portal.Settings`), send the appropriate signal or relaunch with the new flag where feasible
- [ ] **Persistence**: save the chosen scheme in settings so terminals and apps open in the correct theme from the start, not just on toggle

---

### Fix double-click file open + improve app picker

Two related issues with the file-open flow in the project file tree:

- [ ] **Fix double-click not opening files**: debug `row-activated` handler in `left_panel.py` — confirm `DefaultAppsManager.get_app_for_file()` resolves correctly and the subprocess launch actually fires; add fallback to `xdg-open` if no app is matched
- [ ] **App icons in the app picker**: in the searchable `.desktop` app list (`_build_app_picker` in `right_panel.py`), load and show each app's icon (via `Gtk.Image.new_from_icon_name` using the `Icon=` field from the `.desktop` file) alongside the app name
- [ ] **Suggested apps for the file type**: when the picker is opened from a file context (double-click / right-click "Open With"), pre-populate a "Suggested" section at the top of the list with apps whose `MimeType=` field matches the file's extension; remaining apps follow in the general list

---

### Project list sorting — active project always on top

Sort the project list in the right panel so the currently active project is always pinned to the top, with remaining projects sorted below (e.g. alphabetically or by last-used time).

- [ ] Add a sort function via `Gtk.ListBox.set_sort_func` in `right_panel.py`; active row (`project-row-active`) sorts first, rest fall through
- [ ] Re-trigger sort on project switch (`set_active_project`) by calling `self._listbox.invalidate_sort()`

---

### Time label beside project timeline bar

Show the number of minutes worked today directly to the right of each project's `ProgressBar` in the right panel, so the time is readable at a glance without hovering for the tooltip.

- [ ] Add a `Gtk.Label` to the right of `self._time_bar` in `ProjectRow`; update it alongside `update_time_bar()` — show `"Xm"` (or `"Xh Ym"` for ≥ 60 min); hide when zero (consistent with bar visibility)
- [ ] Keep the existing tooltip as-is for full detail

---

### Connection type indicator

Extend the network status area (top-left header bar, beside the ● status lamp) to show the active connection type.

- [ ] Detect connection type: WLAN (wireless), LAN (wired), or disconnected — read from `/sys/class/net/` (check for `wireless/` subdirectory to distinguish wifi from ethernet)
- [ ] Show a symbolic icon or character next to the lamp: e.g. a wifi symbol for WLAN, an ethernet symbol for LAN, nothing (or a crossed-out icon) when offline
- [ ] Poll alongside the existing 5 s connectivity probe in `app/network_monitor.py`; fire the same `GLib.idle_add` callback with the additional connection-type info

---

### Panel toggle button polish

Move the hide-left / hide-right panel toggle buttons (`‹` / `›`) out of the header bar and integrate them directly into the panel edges. Give them a more visible/prominent color so they're easier to discover and use.

- [ ] Reposition toggle buttons — embed them at the inner edge of each panel (e.g. centered vertically on the panel border) rather than in the header bar
- [ ] Style with a more visible color (distinct from the header bar chrome) — consider the active-project blue or a dedicated accent

---

### Right-click: color picker for files and folders in the project tree

Add a "Color…" option to the right-click context menu in the left-panel file tree so users can tint individual files or folders with a custom color for visual organization.

- [ ] Add a "Color…" menu item to `_show_context_menu` in `left_panel.py` (works for both files and dirs)
- [ ] Clicking it opens a `Gtk.ColorDialog` (GTK 4.10+) or a small popover with a color swatch grid as fallback
- [ ] Persist the chosen color per path in a sidecar file (e.g. `<project_dir>/.eldrun_colors.json`, `{relative_path: "#rrggbb"}`)
- [ ] Apply the color in `_populate_dir`: set the `foreground` or `cell-background` property on the `CellRendererText` for colored rows; load `.eldrun_colors.json` once per tree rebuild
- [ ] Add a "Reset color" option if a color is already set
- [ ] Hide `.eldrun_colors.json` from the file tree (add to the skip list alongside `.git`)

---

### Settings button in left panel file tree (per-project file-type defaults)

Add a small settings/gear button to the "PROJECT" section header in the left panel so users can manage per-project file-type → default app mappings without going through the global gear popover.

- [ ] Add a gear `Gtk.Button` (flat, symbolic icon) to the right of the "PROJECT" header label in `left_panel.py`
- [ ] Clicking it opens a window (similar to the existing "File Type Apps…" window in `right_panel.py`) showing a list of `extension → app` rows scoped to the current project (`project_default_apps.json`)
- [ ] Each row: extension entry, app command entry, "⋯" browse button (reuse `_show_app_picker` with `for_file` mime suggestion), "×" remove button
- [ ] "＋ Add Entry" button at the bottom to add new rows
- [ ] Changes write to `<project_dir>/project_default_apps.json` via `DefaultAppsManager.set_project_app()` / `remove_project_app()` (add `remove_project_app()` if missing)
- [ ] Button is insensitive / hidden when no project is active

---

### Multi-monitor: terminal on main, apps on secondary

On multi-monitor setups, keep the Eldrun terminal on the primary monitor and open project apps (from the open-apps list) on secondary monitors rather than embedding them in the center panel.

- [ ] Detect available monitors via `Gdk.Display.get_monitors()` at startup and on connect/disconnect
- [ ] When opening an app from the open-apps browser: if a secondary monitor exists, launch the app and allow its window to land on the secondary monitor instead of reparenting it into the center panel
- [ ] Add a setting to toggle this behaviour (single-monitor users should not be affected)

---

### Fix folder expand/collapse staying open in project file tree

Right-clicking a folder in the project file tree and choosing "Open in File Manager" (or any context-menu action) auto-closes the folder after a few seconds. Remove this behaviour — folders should stay expanded until the user explicitly collapses them.

- [ ] Locate the timer or `collapse_row` call triggered after context-menu actions in `left_panel.py`
- [ ] Remove or gate the auto-collapse so it only fires on explicit row-activated toggle, not after menu actions

---

### Default app for "Remember globally" should be the default radio selection

When the "Open With" dialog appears and neither radio button is pre-selected, users may miss the "Remember globally" option. The global option should be the default-selected radio so saving the app for all projects is one less click.

- [ ] In `_show_choose_app_dialog` in `left_panel.py`, set `save_global` as the active radio button by default (and keep `save_proj` as the alternative)

---

### Debug: default app for file opening not being stored

Opening a file and choosing "Remember globally" does not persist the app for that extension across sessions. Investigate why `DefaultAppsManager.set_global_app()` is not being called or why the saved value is not read back.

- [ ] Add logging/tracing to `set_global_app` and `get_app_for_file` to confirm writes succeed
- [ ] Check that `_GLOBAL_FILE` path resolves correctly at runtime and that the JSON is being flushed atomically
- [ ] Verify `bootstrap_from_system()` doesn't overwrite manually-saved entries on next startup

---

### Project import modes

Change `ImportProjectDialog` + `project_manager.import_project()` to support three modes:

- [ ] **Keep location (default)**: register the project in place; no file copying or moving
- [ ] **Copy**: copy the folder into `~/eldrun/projects/` and register the copy
- [ ] **Move**: move the folder into `~/eldrun/projects/` and register the new location

Implementation notes:
- Add a mode selector (e.g. radio buttons or dropdown) to `ImportProjectDialog`
- Store each project's `path` explicitly in `projects.json` (meaningful, pretty-printed JSON — `indent=2`); don't assume `~/eldrun/projects/<name>` as the canonical location
- Update all path lookups in `project_manager.py`, `center_panel.py`, and `left_panel.py` to use `project["path"]` rather than a constructed path

---

## Future Goals

> Long-horizon ideas — not scheduled. Require the core phases above to be stable.

### Local Ollama integration

Run a local Ollama instance alongside Eldrun to provide lightweight AI assistance without requiring an internet connection or external API key.

- [ ] **Daemon management**: start/stop an `ollama serve` subprocess when Eldrun launches; expose a status indicator (dot in the header bar — green = ready, grey = offline)
- [ ] **Intelligent project search**: replace the plain substring filter in the search field (Phase 6) with an embedding-based semantic search — query Ollama for sentence embeddings of the project name + `STATUS.md` / `CLAUDE.md` summary, rank results by cosine similarity
- [ ] **"Suggest projects for today"**: on startup, send recent git activity (`git log --oneline -20` across all projects) + current date/time to Ollama and surface the top 2–3 projects the user likely wants to continue; show as a soft highlight or pinned section at the top of the project list
- [ ] **App/file suggestions per project**: when a project is activated, ask Ollama which files are most likely relevant given recent commits and `open_apps.json` history; surface suggestions as a "Suggested" section at the top of the open-apps browser
- [ ] **Context-aware terminal hints**: optionally pipe the last N lines of the active terminal's scrollback to Ollama and display a short hint strip below the terminal
- [ ] **Model selection**: configurable per-project in `CLAUDE.md` or a sidebar setting; default to a small fast model (e.g. `mistral`, `phi3`)
- [ ] **Privacy boundary**: all inference runs locally; no data leaves the machine; add a visible "local AI" label to any AI-generated suggestion
