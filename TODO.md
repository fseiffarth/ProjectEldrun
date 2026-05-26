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

### Global CLAUDE.md and AGENTS.md for the root terminal

The root terminal spawns in `~/eldrun/root/` but that directory is created empty — no context files exist, so a `claude` session there has no idea what the workspace is or what it is allowed to do.

- [x] On first launch (or whenever `~/eldrun/root/` is created), write `CLAUDE.md` and `AGENTS.md` into `~/eldrun/root/` describing the workspace layout, the purpose of the root terminal, and the boundary between workspace-level and project-level work
- [x] `CLAUDE.md` content should cover: what `~/eldrun/` is, the `projects/` subdirectory structure, the global data files under `~/.local/share/eldrun/`, and that the root terminal is for workspace-wide tasks (not individual project work)
- [x] `AGENTS.md` content should cover: permitted scope (workspace root and global config; read-only into project dirs unless explicitly instructed), and conventions for creating or importing projects via Eldrun rather than by hand
- [x] Wire the write into `CenterPanel.open_master_terminal()` (or `ProjectManager.__init__`) so it runs once and skips if the files already exist

---

### Agent session permission boundary

Claude/agent sessions opened inside `~/eldrun/projects/<project>` should be allowed to change everything inside that project directory but only read (not write) files outside of it.

- [x] Define the permission boundary for agent sessions: full write access within the project dir, read-only everywhere outside
- [x] Investigate how to enforce this — `.claude/settings.json` in the project scaffold; deny writes to `~/.local/share/eldrun/**` and require confirmation for anything outside the project dir
- [x] Add a `settings.json` template to the project scaffold (written by `create_project()`) that pre-configures the permission rules
- [x] Document the boundary in `AGENTS.md` so agents know their scope from the start

---

### Project state model + startup restore

- [x] Add `status` field (`"current"` | `"active"` | `"inactive"`) to every entry in `~/.local/share/eldrun/projects.json`; migrate existing entries on load (treat missing field as `"inactive"`)
- [x] `set_active_project(id)`: transitions selected project to `"current"`, demotes previous `"current"` to `"active"`, persists both changes
- [x] Clicking `×` on a row: transitions project to `"inactive"`, removes row — entry stays in `projects.json`
- [x] Startup restore: `_on_map` reads `get_visible_projects()` and restores active/current rows and terminals
- [x] `set_all_inactive()` called on clean shutdown

---

### Propagate theme toggle to terminals and embedded apps

- [x] **VTE terminals**: `CenterPanel.apply_theme()` calls `_apply_terminal_colors()` on all open terminals
- [x] **Persistence**: color scheme saved in `settings.json`, applied on startup
- [ ] **Embedded apps**: propagate theme to apps that accept `GTK_THEME` or D-Bus portal signals

---

### Fix double-click file open + improve app picker

- [x] **Fix double-click not opening files**: `_open_file` tries configured app → resolved system default → `xdg-open` fallback
- [x] **App icons in the app picker**: `make_app_row` uses `Gtk.Image.new_from_icon_name` with the `Icon=` field from `.desktop`
- [x] **Suggested apps for the file type**: `_show_app_picker` pre-populates a "Suggested" section when `for_file` MIME matches

---

### Global project search with dropdown

- [x] Search queries all projects (all statuses) via `project_manager.projects`
- [x] Popover dropdown with name + path + status; "No projects found" placeholder
- [x] Selecting inactive result promotes to `"active"`, adds row, opens terminal

---

### Project list sorting — current project always on top

- [x] `_sort_rows` weights `"current"` = 0, `"active"` = 1; within group sorts by `position`
- [x] `invalidate_sort()` called on every status transition

---

### Project row hover tooltip + right-click stats popover

- [x] Hover after 500 ms opens stats popover; leave dismisses
- [x] Right-click opens pinned stats popover
- [x] Stats loaded from `project.json` via `get_project_stats()`; file-type bar drawn via `DrawingArea`

---

### Drag-and-drop reordering of project rows

- [x] `Gtk.DragSource` + `Gtk.DropTarget` on each `ProjectRow`
- [x] Drop computes insertion index, reassigns `position` integers, persists via `set_project_position()`
- [x] `project-row-dragging` / `drag-over-top` / `drag-over-bottom` CSS classes

---

### Double-click to set current project

- [x] `Gtk.GestureClick` with `n_press == 2` fires `_on_activate_cb` → `show_project_terminal()`
- [x] Single-click only selects the row visually; double-click switches the terminal view

---

### Project list section dividers

- [x] `set_header_func(_header_func)` inserts a `Gtk.Separator` before the first `"active"` row
- [x] `invalidate_headers()` called on every status transition

---

### Time label beside project timeline bar

- [x] `ProjectRow._time_label` shows `"Xm"` / `"Xh Ym"` next to the progress bar; hidden when zero

---

### Current time display in header bar

- [x] `_time_label` in header right box; updated every 30 s via `GLib.timeout_add_seconds`

---

### Connection type indicator

- [x] `/sys/class/net/` polled in `NetworkMonitor`; WLAN/LAN icon shown via `_conn_icon` in header

---

### Panel toggle button polish

- [x] Toggle buttons placed at panel edges via `Gtk.Overlay` (not in header bar)
- [x] Buttons reposition/relabel when panel is hidden/shown

---

### Right-click: color picker for files and folders in the project tree

- [x] "Color…" item in `_show_context_menu` opens `Gtk.ColorDialog`
- [x] Colors persisted in `.eldrun_colors.json`; applied via `_color_data_func`; "Reset color" item shown when set

---

### Settings button in left panel file tree (per-project file-type defaults)

- [x] Gear button in "PROJECT" header row; insensitive when no project active
- [x] Opens per-project file-type window with ext → app rows, browse, add, remove

---

### Fix folder expand/collapse staying open in project file tree

- [x] `_rebuild_file_tree` saves expanded paths via `foreach`, repopulates, then restores expansion

---

### Default app for "Remember globally" should be the default radio selection

- [x] `save_global.set_active(True)` in `_show_choose_app_dialog`

---

### Debug: default app for file opening not being stored

- [x] `set_global_app` writes atomically via `.tmp` + `os.replace`; `bootstrap_from_system` only fills missing keys so manual entries survive restarts
- [x] `_GLOBAL_FILE` resolves to `~/.local/share/eldrun/default_apps.json` via `GLib.get_user_data_dir()`

---

### Project import modes

- [x] `ImportProjectDialog` has "Keep location / Copy / Move" dropdown
- [x] `project_manager.import_project(mode=...)` handles all three cases; `directory` field stored in `project.json`

---

### Bug: right panel too wide on first project open after startup

- [x] `_init_inner_paned` now returns early (re-defers) when `outer_w == 0` instead of using a `or 1440` fallback

---

### Warn to save open app files before closing or deactivating a project

- [x] `_on_project_close` checks `open_apps.json`; if non-empty shows modal confirm dialog before closing
- [x] Cancel aborts; "Close Project" proceeds with `_do_close_project()`

---

### Left-panel project tree: create file/folder, show hidden, properties

Extend the right-click context menu in the project file tree with three capabilities:

#### Create new file / folder (right-click on empty area or existing entry)

- [x] Add "New File…" and "New Folder…" items to `_show_context_menu` in `left_panel.py`; also show them when right-clicking the empty tree background (`_on_tree_bg_right_click` on `tree_scrolled`)
- [x] "New File…": modal `Gtk.Window` with filename `Gtk.Entry`; on confirm, `open(target, "x")`, refresh tree
- [x] "New Folder…": same dialog, `os.makedirs()` instead, refresh tree

#### Show hidden files toggle

- [x] `Gtk.CheckButton` in the "PROJECT" header row, to the right of the gear button
- [x] `self._show_hidden_btn.get_active()` checked in `_populate_dir`; default off
- [x] Toggle calls `_rebuild_file_tree()` immediately

#### File / folder properties

- [x] "Properties" item at the bottom of `_show_context_menu` (separator above it)
- [x] `_show_properties`: full path, size (files: bytes; dirs: file count + total), mtime, permissions string

---

### Rewrite open-app pipeline (ISSUE-008)

Approach changed from the original three-stage plan: the "OPEN APPS" left-panel browser was removed entirely and replaced with a tab bar in the center panel. Each opened file gets its own closeable tab; the permanent "Terminal" tab acts as the back mechanism.

#### Stage 1 — Open file in standalone window ✅

- [x] Remove `show_app_window()` call from `_launch_and_track` in `left_panel.py`; file open only does `subprocess.Popen([app, path])`
- [x] Remove auto-embed logic (`_pending_auto_embed_exe`, EWMH embed trigger) from `left_panel.py`
- [x] Remove old `show_app_window()` / `_release_app_window()` / `_APP_PAGE` from `center_panel.py`
- [x] Remove the "OPEN APPS" browser (`OpenAppsManager`, `AppRow`, EWMH poll) from `left_panel.py`

#### Stage 2 — Tab bar + X11 embedding (code written, unverified)

- [x] Scrollable tab bar above center stack; permanent non-closeable **Terminal** tab; closeable app tabs
- [x] `add_app_tab(name, proc, project_id)` in `CenterPanel`: creates tab + placeholder stack page; called from `_launch_and_track` in `left_panel.py`
- [x] `_poll_for_app_window()`: retries up to 8× at 400 ms intervals searching `_NET_CLIENT_LIST` by `_NET_WM_PID`
- [x] `_try_embed()`: `XReparentWindow + configure + map` wrapped in try/except; falls back to `_raise_window_ewmh()` on failure
- [x] `_on_stack_resize()`: keeps embedded window fitted to stack allocation on resize
- [x] `_close_app_tab()`: releases embedded window, removes tab + stack page; also called from `remove_project_terminal()` for all tabs belonging to that project
- [x] Tab click (Terminal tab) releases embedded window and returns to last terminal page
- [ ] **Add "⬛ Terminal" overlay button** visible while an app tab is active — provides a visible back shortcut without requiring the user to click the tab bar
- [ ] **Verify live**: double-click a file → app opens, new tab appears, app embeds in center panel; close tab → app released; Terminal tab click → back to terminal

---

### Multi-monitor: terminal on main, apps on secondary

On multi-monitor setups, keep the Eldrun terminal on the primary monitor and open project apps on secondary monitors.

- [ ] Detect available monitors via `Gdk.Display.get_monitors()` at startup and on connect/disconnect
- [ ] When opening an app from the open-apps browser: if a secondary monitor exists, launch the app on the secondary monitor instead of reparenting it into the center panel
- [ ] Add a setting to toggle this behaviour (single-monitor users should not be affected)

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
