# ProjectEldrun — TODO

> Completed work has been moved to `TODO_history.md`.
> Items within each section are roughly ordered by dependency.

---

## Bottom Bar Polish

- [x] **Panel toggle button position**: moved to the right of the + button
- [x] **Clock in bottom bar**: `HH:MM` label left of Root button, 1 s tick
- [x] **Show hidden files in project settings**: toggle moved from PROJECT header into the per-project gear settings window
- [ ] **Global project search**: the search field should search across *all* eldrun projects (including inactive ones not currently in the bottom bar), not just the active pills; selecting an inactive result adds it to the active projects in the bottom bar and opens its terminal
- [ ] **Tab bar in header frame**: investigate whether the center-panel tab bar can be integrated into the header/title bar area (for larger window sizes where the dedicated tab row wastes vertical space)
- [ ] **Settings dropdown stays open**: the global settings popover closes when clicking the terminal dropdown (claude/codex); the popover should remain open while interacting with its own child widgets

---

## App Embedding & Standalone Apps

### Verify embedding pipeline

- [ ] Verify live end-to-end: double-click a project file → app launches, tab appears, window reparented into the center panel; close tab → window released back to root; Terminal tab / overlay button → returns to terminal view

### Standalone app persistence

Standalone open-window entries must survive project deactivation and be restored on re-activation, just like terminal state.

- [ ] Add `"mode": "standalone"` field to `open_apps.json` entries written for standalone windows; existing entries without the field default to `"embed"`
- [ ] On project re-activation: entries with `"mode": "standalone"` are relaunched via `subprocess.Popen` without any embed probe; entries with `"mode": "embed"` (or no field) go through the full two-path probe again

### Theme propagation to embedded and standalone apps

- [ ] **Standalone apps**: pass `GTK_THEME=Adwaita:dark` or `GTK_THEME=Adwaita` in the `env` dict of `subprocess.Popen` at launch, derived from `settings_manager.get("color_scheme")`
- [ ] **Embedded apps**: on theme toggle in `_on_toggle_theme`, iterate open embed tabs and send an XSETTINGS `Net/ThemeName` change via `python-xlib`; fall back to a no-op if the window is gone

---

## Navigation & Built-in Tabs

### Agent tab + built-in app tabs (Browser, Mail, Calendar)

The permanent terminal tab should be called "Agent". Additionally, offer non-closeable built-in tabs for the system's default browser, email client, and calendar — embedded frameless where possible.

- [ ] Rename the permanent tab from "Terminal" to "Agent" everywhere (`_TERMINAL_TAB` label, `_update_terminal_tab_label`, `_terminal_back_btn` label)
- [ ] At startup, resolve the system defaults: `xdg-settings get default-web-browser`, `xdg-mime query default x-scheme-handler/mailto`, and the default calendar `.desktop` file; skip silently if not found
- [ ] Each resolved app goes through the two-strategy dispatch: embed frameless if viable, else open standalone and add to the open-windows list
- [ ] Add permanent (non-closeable) icon tabs for Browser (`web-browser-symbolic`), Mail (`mail-client-symbolic`), Calendar (`x-office-calendar-symbolic`) in the tab bar; grey out any whose default app is not found

---

## System Integration

### Multi-monitor: terminal on main, apps on secondary

On multi-monitor setups, keep Eldrun on the primary display and route standalone project apps to a secondary monitor.

- [ ] At startup and on `Gdk.Display` `monitors-changed`, read `Gdk.Display.get_monitors()` and store the list; expose `window.get_secondary_monitor() -> Gdk.Monitor | None`
- [ ] In the standalone dispatch path: if a secondary monitor exists, set `GDK_MONITOR=1` (or pass geometry args where supported) in `subprocess.Popen` env
- [ ] Add "Open apps on secondary monitor" toggle in the settings popover; persist under `"multi_monitor"` in `settings.json`; default `false` so single-monitor users are unaffected

### Desktop workspace management — follow-ups

The core Cinnamon implementation is done (see `TODO_history.md`). Remaining edge cases and extensions:

- [ ] **GNOME support**: use `org.gnome.Shell` `Eval` or `Meta.WorkspaceManager`; fall back to `wmctrl -s <idx>` if DBus is unavailable
- [ ] **Workspace toggle takes effect immediately**: when the "Manage workspaces" setting is turned on mid-session, allocate workspaces for already-active projects without requiring a restart

---

## Future Goals

> Long-horizon ideas — not scheduled. Require the items above to be stable.

### Local Ollama integration

Run a local Ollama instance alongside Eldrun to provide lightweight AI assistance without requiring an internet connection or external API key.

- [ ] **Daemon management**: start/stop an `ollama serve` subprocess when Eldrun launches; expose a status indicator (dot in the header bar — green = ready, grey = offline)
- [ ] **Intelligent project search**: embedding-based semantic search — query Ollama for sentence embeddings of the project name + `STATUS.md` / `CLAUDE.md` summary, rank results by cosine similarity
- [ ] **"Suggest projects for today"**: on startup, send recent git activity (`git log --oneline -20` across all projects) + current date/time to Ollama and surface the top 2–3 projects the user likely wants to continue; show as a soft highlight or pinned section at the top of the project list
- [ ] **App/file suggestions per project**: when a project is activated, ask Ollama which files are most likely relevant given recent commits and `open_apps.json` history; surface suggestions as a "Suggested" section at the top of the open-apps browser
- [ ] **Context-aware terminal hints**: optionally pipe the last N lines of the active terminal's scrollback to Ollama and display a short hint strip below the terminal
- [ ] **Model selection**: configurable per-project in `CLAUDE.md` or a sidebar setting; default to a small fast model (e.g. `mistral`, `phi3`)
- [ ] **Privacy boundary**: all inference runs locally; no data leaves the machine; add a visible "local AI" label to any AI-generated suggestion
