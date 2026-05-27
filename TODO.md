# ProjectEldrun — TODO

> Completed work has been moved to `TODO_history.md`.
> Open items are grouped by area and numbered as `G<group>.<item>`.

---

## Open TODOs

### G1 — Agents and tabs

G1.1 [x] **Agent tab rename**: rename the permanent terminal tab from "Terminal" to the configured agent name (`Claude` or `Codex`) everywhere (`_TERMINAL_TAB` label, `_update_terminal_tab_label`, `_terminal_back_btn` label).

G1.2 [x] **Multiple agent tabs**: in addition to switching the default terminal command between `claude` and `codex`, right-clicking the tab bar should open a popover for adding a new `claude` or `codex` agent from a dropdown. Additional agents use command-specific names like `Claude1` or `Codex1`; right-clicking an agent tab should open a rename popover except for the default agent tab; additional agent tabs get an `x` close button, but the default agent tab does not.

G1.3 [x] **Agent numbering reset after close** (`ISSUE-013`): after an additional agent is closed, recompute visible agent display numbers or intentionally reuse the expected sequence so the next added agent does not continue from a stale number.

G1.4 [x] **Agent creation stays in current project** (`ISSUE-014`): adding a new agent should keep the bottom project switcher selection, keep the right panel visible, and only open a new terminal/tab inside the current project.

G1.5 [x] **Uniform agent tab behavior**: do not distinguish between the master/default agent and newly added agents. Every agent tab should be renameable and closeable; if all agents are closed, the user must add a new one manually by right-clicking the tab bar.

G1.6 [x] **Tab bar right-click: agent + terminal rows**: restructure the tab-bar right-click popover into two rows: first row, "New agent" label followed by an inline dropdown (`claude` / `codex`) to pick the command; second row, "New terminal" button that opens a plain `$SHELL` terminal tab. The plain terminal tab must be renameable and closeable like any agent tab.

G1.7 [x] **Empty state when all tabs are closed** (`ISSUE-017`): do not create an implicit hidden terminal when the final tab is closed. Show an empty center page saying no tab is open and that a new agent or terminal can be created by right-clicking the tab bar.

### G2 — Project and panel lifecycle

G2.1 [x] **Right panel restore width** (`ISSUE-009`): after hide-both -> show-left -> show-right, recompute the inner paned position from the current allocation so the right panel returns to the expected width instead of doubling.

G2.2 [x] **Close active project returns to root** (`ISSUE-015`): when the current project is closed with `x`, activate the root session, clear the project-specific bottom-switcher selection, and hide the right project panel.

G2.3 [x] **Close-project root selection refresh** (`ISSUE-016`): after closing a project, select root with the blue border and show the root agent/terminal instead of leaving an empty "no project selected" agent tab.

G2.4 [x] **Tab bar in header frame**: the center-panel tab bar scroll widget is now placed as the center widget of the header `CenterBox`; clock moved to the right side; tabs use a top accent bar for the active indicator; header min-height bumped to 40px.

### G3 — Settings, theme, and monitor support

G3.1 [x] **Settings dropdown stays open**: resolved by commit `fa13e2d` — settings was converted from `Gtk.Popover` (which autohides on outside clicks) to `Gtk.Window` with `modal=True`, so the dropdown interaction no longer dismisses it.

G3.2 [ ] **Standalone app theme env**: pass `GTK_THEME=Adwaita:dark` or `GTK_THEME=Adwaita` in the `env` dict of `subprocess.Popen` at launch, derived from `settings_manager.get("color_scheme")`.

G3.3 [x] **Workspace toggle takes effect immediately**: when the "Manage workspaces" setting is turned on mid-session, allocate workspaces for already-active projects without requiring a restart.

G3.4 [ ] **Secondary-monitor settings toggle**: add "Open apps on secondary monitor" to the settings popover; persist under `"multi_monitor"` in `settings.json`; default `false` so single-monitor users are unaffected.

G3.5 [ ] **Secondary-monitor detection**: at startup and on `Gdk.Display` `monitors-changed`, read `Gdk.Display.get_monitors()` and store the list; expose `window.get_secondary_monitor() -> Gdk.Monitor | None`.

G3.6 [ ] **Secondary-monitor app launch**: in the standalone dispatch path, if a secondary monitor exists, set `GDK_MONITOR=1` or pass geometry args where supported in the `subprocess.Popen` environment.

G3.7 [x] **GNOME workspace support**: use `org.gnome.Shell` `Eval` or `Meta.WorkspaceManager`; fall back to `wmctrl -s <idx>` if DBus is unavailable.

G3.8 [ ] **Embedded app theme propagation**: on theme toggle in `_on_toggle_theme`, iterate open embed tabs and send an XSETTINGS `Net/ThemeName` change via `python-xlib`; fall back to a no-op if the window is gone.

G3.9 [x] **Fancy bright/dark split**: expose separate `Fancy Dark` and `Fancy Bright` settings values while keeping legacy `fancy` as a `fancy_dark` alias.

### G4 — Open apps and embedding

G4.1 [ ] **Standalone open-app mode field** (`ISSUE-008`): add `"mode": "standalone"` to `project.json["open_apps"]` entries written for standalone windows; existing entries without the field default to `"embed"`.

G4.2 [ ] **Resolve built-in app defaults**: at startup, resolve the system defaults with `xdg-settings get default-web-browser`, `xdg-mime query default x-scheme-handler/mailto`, and the default calendar `.desktop` file; skip silently if not found.

G4.3 [ ] **Permanent built-in app tabs**: add non-closeable icon tabs for Browser (`web-browser-symbolic`), Mail (`mail-client-symbolic`), and Calendar (`x-office-calendar-symbolic`) in the tab bar; grey out any whose default app is not found.

G4.4 [ ] **Project-scoped open-app list** (`ISSUE-002`): filter the open-apps panel so it only shows windows whose process cwd belongs to the current project instead of showing all normal desktop windows.

G4.5 [ ] **Open-app standalone baseline** (`ISSUE-008`, Stage 1): make file opening reliable without embedding first by launching the app with `subprocess.Popen([app, path])` and recording the entry in `project.json["open_apps"]`.

G4.6 [ ] **Standalone app restore** (`ISSUE-008`): on project re-activation, relaunch entries with `"mode": "standalone"` via `subprocess.Popen` without any embed probe; entries with `"mode": "embed"` or no field go through the full two-path probe again.

G4.7 [ ] **Built-in app dispatch**: each resolved Browser, Mail, and Calendar app goes through the two-strategy dispatch: embed frameless if viable, else open standalone and add to the open-windows list.

G4.8 [ ] **Embedding pipeline hardening and verification** (`ISSUE-001`, `ISSUE-008`, Stages 2-3): define the center panel XID as the embedding target, retry reparenting after launch, restore the terminal page on failure, reconnect `AppRow` clicks, and verify a live file-open/reparent/close flow end-to-end.

### G5 — Local AI and suggestions

G5.1 [ ] **Ollama daemon management**: start/stop an `ollama serve` subprocess when Eldrun launches; expose a status indicator in the header bar where green means ready and grey means offline.

G5.2 [ ] **Local AI model selection**: make model selection configurable per project in `CLAUDE.md` or a sidebar setting; default to a small fast model such as `mistral` or `phi3`.

G5.3 [ ] **Local AI privacy boundary**: keep all inference local; no data leaves the machine; add a visible "local AI" label to AI-generated suggestions.

G5.4 [ ] **Context-aware terminal hints**: optionally pipe the last N lines of the active terminal's scrollback to Ollama and display a short hint strip below the terminal.

G5.5 [ ] **Intelligent project search**: embedding-based semantic search; query Ollama for sentence embeddings of the project name plus `STATUS.md` / `CLAUDE.md` summary, then rank results by cosine similarity.

G5.6 [ ] **Suggest projects for today**: on startup, send recent git activity (`git log --oneline -20` across all projects) plus current date/time to Ollama and surface the top 2-3 projects the user likely wants to continue; show as a soft highlight or pinned section at the top of the project list.

G5.7 [ ] **App/file suggestions per project**: when a project is activated, ask Ollama which files are most likely relevant given recent commits and `project.json["open_apps"]` history; surface suggestions as a "Suggested" section at the top of the open-apps browser.
