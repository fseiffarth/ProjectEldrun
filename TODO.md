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

### Agent session permission boundary

Claude/agent sessions opened inside `~/eldrun/projects/<project>` should be allowed to change everything inside that project directory but only read (not write) files outside of it.

- [ ] Define the permission boundary for agent sessions: full write access within the project dir, read-only everywhere outside
- [ ] Investigate how to enforce this — e.g. via `.claude/settings.json` in the project scaffold, chroot/namespace sandbox, or a custom MCP server that intercepts file writes
- [ ] Add a `settings.json` template to the project scaffold (written by `create_project()`) that pre-configures the permission rules
- [ ] Document the boundary in `AGENTS.md` so agents know their scope from the start

---

### Project state model + startup restore

Introduce a formal three-state model for projects and restore the previous session layout on startup.

#### Three-state status field

- [ ] Add `status` field (`"current"` | `"active"` | `"inactive"`) to every entry in `~/.local/share/eldrun/projects.json`; migrate existing entries on load (treat missing field as `"inactive"`)
- [ ] **`"current"`**: the one project whose terminal is shown in the center panel; at most one at a time; its row carries `project-row-active` CSS class
- [ ] **`"active"`**: project is in the right-panel list, its terminal page exists, and its apps remain open — but it is not the foreground view
- [ ] **`"inactive"`**: project is registered globally but absent from the right-panel list and has no running apps; never rendered as a row
- [ ] `set_active_project(id)`: transitions selected project to `"current"`, demotes previous `"current"` to `"active"` (not `"inactive"`), persists both changes
- [ ] Clicking `×` on a row: transitions project to `"inactive"`, calls `remove_project_terminal()`, closes its apps, removes the row — entry stays in `projects.json`

#### Startup restore

- [ ] On startup, after the window is realized, read `projects.json` and for each project with `status` `"active"` or `"current"`: add a `ProjectRow` and call `add_project_terminal()`
- [ ] The Root view (`__master__`) is always opened first; it is the initial `"current"` view
- [ ] The project that was `"current"` at last shutdown is restored to `"active"` (its row appears and terminal is created) but the Root terminal remains the foreground — the user explicitly switches back to it
- [ ] All previously `"active"` projects have their apps reopened via the existing `open_apps.json` relaunch path (already triggered on project activation; wire it to run for all restored `"active"` projects during startup)
- [ ] Write `status = "inactive"` for all projects on clean shutdown (via `app.quit()` / SIGTERM handler) so a crash leaves `"active"` entries intact for the next startup

---

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

### Global project search with dropdown

Replace the current right-panel search (which filters only the visible project rows) with a global search across all projects registered in Eldrun. Results appear in a dropdown; selecting one adds the project to the active panel list.

#### Data model — three-state project status

- [ ] Replace any `active` boolean in `projects.json` with a `status` field with three values:
  - `"current"` — the project whose terminal is currently shown in the center panel (at most one at a time)
  - `"active"` — project is in the right-panel list and its apps are kept running, but its terminal is not the foreground view
  - `"inactive"` — project is registered globally but not shown in the right panel and its apps are not running
- [ ] Only projects with `status` `"current"` or `"active"` appear in the right-panel list; `"inactive"` projects are hidden from the list
- [ ] Clicking `×` on a project row sets `status = "inactive"`, closes the terminal page (`remove_project_terminal()`), closes any open apps for the project, and removes the row — the entry remains in `projects.json` so it can be re-opened via search
- [ ] `set_active_project(id)` sets the selected project to `"current"` and demotes the previous `"current"` project to `"active"` (not `"inactive"`)
- [ ] Persist status changes to `projects.json` immediately on every transition

#### Search behaviour

- [ ] On each keystroke in the search field, query `project_manager.get_all_projects()` (all statuses, not just visible rows) and filter by case-insensitive substring match on project name
- [ ] Display matches in a `Gtk.Popover` dropdown anchored below the search entry; each row shows the project name, its path (smaller, muted text), and a subtle status badge (`active` / `inactive`)
- [ ] Do **not** filter the existing right-panel list while the search popover is open — the two are now independent
- [ ] Close the dropdown when the search field loses focus or `Escape` is pressed; clear the search text on close

#### Selecting a result

- [ ] When the user clicks a dropdown row (or presses Enter on the highlighted entry): if `status` is `"inactive"`, set it to `"active"`, add a `ProjectRow`, and open its terminal via `add_project_terminal()` + `add_project_row()`; then make it `"current"` via `set_active_project()`
- [ ] If already `"active"` or `"current"`, just switch to it (`show_project_terminal()`) without adding a duplicate row
- [ ] After selection, close the dropdown and clear the search field

#### CSS / UX

- [ ] Style the dropdown popover to match the right-panel background; highlight the focused row with a subtle accent
- [ ] Show a "No projects found" placeholder row when the query matches nothing

---

### Project list sorting — current project always on top

Sort the right-panel list so the `"current"` project is always pinned first, followed by `"active"` projects, with no `"inactive"` rows ever shown.

- [ ] Add a sort function via `Gtk.ListBox.set_sort_func` in `right_panel.py`; `"current"` row sorts first (weight 0), `"active"` rows follow (weight 1), sorted alphabetically within each group
- [ ] Re-trigger sort on every status transition by calling `self._listbox.invalidate_sort()`

---

### Project row hover tooltip + right-click stats popover

Show rich project stats on hover and right-click for each project row in the right panel. Stats are pre-computed into a per-project `project.json` cache file so the UI never blocks on disk I/O.

#### `project.json` cache (per project)

- [ ] On startup, spawn a background thread per project that scans the project directory and writes `<project_dir>/project.json` with:
  - `file_type_stats`: `{extension: {count, bytes}}` map (skip `.git/`, hidden dirs)
  - `app_icons`: list of `{name, icon}` entries derived from `open_apps.json` — resolve each app's `.desktop` file to get its `Icon=` field
  - `time_total_s`: lifetime tracked seconds from `time_log.json` for this project
  - `time_today_s`: today's tracked seconds
  - `last_updated`: ISO timestamp
- [ ] Re-scan and rewrite `project.json` whenever the project is activated (debounced, background thread)
- [ ] `project_manager.py`: expose `get_project_stats(project_id)` that reads and parses `project.json`; returns `None` if not yet generated

#### Hover tooltip (popover on `motion-notify` / `enter-notify`)

- [ ] Attach a `Gtk.Popover` to each `ProjectRow` that opens after a short hover delay (~500 ms via `GLib.timeout_add`) and closes on leave
- [ ] Popover content:
  - **Time**: "Xh Ym today · Xh total" (from `time_today_s` / `time_total_s`)
  - **File type bar**: horizontal proportional bar (like GitHub's language bar) — each segment colored by extension, widths proportional to byte count; a legend below shows `ext — X%` for the top 5 types
  - **App icons**: a row of `Gtk.Image` widgets (16–24 px) for each app in `app_icons`; use `Gtk.Image.new_from_icon_name` with the resolved icon name
- [ ] If `project.json` is not yet available, show a "Loading…" label instead

#### Right-click context menu additions

- [ ] Add a **"Stats"** item to the existing right-click menu on project rows (or create one if absent) that opens the same stats popover pinned open (not auto-dismissed on mouse leave)

#### CSS

- [ ] Style the file-type bar segments with auto-assigned muted colors per extension (hash extension name to a hue); keep the bar height at ~6 px with rounded ends

---

### Drag-and-drop reordering of project rows

Allow users to reorder project rows in the right panel by holding (long-press) on a row to initiate a drag, then dropping it at the desired position.

#### Drag initiation (click-and-drag)

- [ ] Initiate drag on regular click-and-drag (not long-press): wire `Gtk.DragSource` directly so dragging a row starts immediately on mouse motion past the drag threshold — no hold delay needed
- [ ] On drag start, apply a visual "lifted" state to the dragged row (e.g. slight opacity reduction + box-shadow via CSS class `project-row-dragging`)

#### GTK4 drag-and-drop wiring

- [ ] Add a `Gtk.DragSource` to each `ProjectRow`: set `actions = Gdk.DragAction.MOVE`; in `prepare` callback return a `Gdk.ContentProvider` carrying the project ID string
- [ ] Add a `Gtk.DropTarget` to each `ProjectRow`: accept the same content type; on `drop` signal determine the target row's index and call the reorder logic
- [ ] Use `Gtk.DropTarget.set_preload(True)` and connect to `motion` to show a live insertion indicator (a highlighted 2 px line above/below the hovered row) as the drag passes over rows

#### Reorder logic

- [ ] Maintain an explicit `order` list (or per-entry `position` integer) in `projects.json` so the custom order survives restarts
- [ ] On drop: compute the new index from the target row position, update the in-memory order, reinsert the `ProjectRow` widget at the new position via `Gtk.ListBox.remove` + `Gtk.ListBox.insert`, and persist the updated order to `projects.json`
- [ ] If a `set_sort_func` is active (from the "active project always on top" feature), disable it while a drag is in progress and re-enable on drop

#### CSS

- [ ] `project-row-dragging`: `opacity: 0.5`
- [ ] Drop insertion indicator: a thin accent-colored horizontal rule rendered above or below the hovered row depending on cursor position (top/bottom half of the row)

---

### Double-click to set current project

Double-clicking a project row in the right panel should activate it as the "current" project (switch the center panel to its terminal). Single-click remains the selection/hover action; double-click is the explicit "make this my active project" gesture.

- [ ] In `ProjectRow` (or the `Gtk.ListBox` row-activated handler in `right_panel.py`), distinguish single-click from double-click — connect to `Gtk.GestureClick` with `n_press == 2` for the double-click action
- [ ] On double-click: call `set_active_project(project_id)` and `show_project_terminal(project_id)`; apply `project-row-active` CSS class to the row
- [ ] Ensure drag-and-drop initiation (click-and-drag) does not fire a spurious double-click; cancel the double-click timer on drag start

---

### Project list section dividers

Add a single horizontal separator line in the right-panel project list between the `"current"` project row and the `"active"` rows below it. No separator is needed for inactive projects as they are never shown in the list.

- [ ] Use `Gtk.ListBox.set_header_func` in `right_panel.py`; the callback inserts a separator widget as the header of the first `"active"` row (i.e. whenever the previous row's status is `"current"`)
- [ ] Call `self._listbox.invalidate_headers()` on every status transition so the separator tracks the current row correctly
- [ ] CSS: style the separator as a thin (1 px) dark line with a small top/bottom margin

---

### Time label beside project timeline bar

Show the number of minutes worked today directly to the right of each project's `ProgressBar` in the right panel, so the time is readable at a glance without hovering for the tooltip.

- [ ] Add a `Gtk.Label` to the right of `self._time_bar` in `ProjectRow`; update it alongside `update_time_bar()` — show `"Xm"` (or `"Xh Ym"` for ≥ 60 min); hide when zero (consistent with bar visibility)
- [ ] Keep the existing tooltip as-is for full detail

---

### Current time display in header bar

Show the current time in the left status area of the header bar, immediately to the right of the connection symbol (● lamp).

- [ ] Place the time `Gtk.Label` in the left status box in `window.py`, directly after the ● network lamp (and connection-type icon if present) — not on the right side of the header
- [ ] Update it every 30 s via `GLib.timeout_add_seconds(30, ...)` — no need for per-second refresh
- [ ] Style with a muted/secondary CSS class so it doesn't compete visually with the panel controls

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

### Bug: right panel too wide on first project open after startup

When a project is opened immediately after startup, the right panel renders wider than its configured 220 px. The hide-right-panel toggle button (`›`) remains at its correct position, suggesting the button is anchored independently but the panel itself does not honour the initial width constraint until a resize or toggle cycle.

- [ ] Investigate where the right pane position is set at startup in `window.py` — check if `Gtk.Paned.set_position()` is called before the window is realized/shown, which can cause the paned to ignore the value
- [ ] Ensure the right-panel width is applied after the window is realized (e.g. connect to `notify::default-width` or use `GLib.idle_add` to defer `set_position()`)
- [ ] Confirm the fix does not break the panel toggle (`›`) or the stored position on subsequent opens

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
