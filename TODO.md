# ProjectEldrun — TODO

> Completed work has been moved to `TODO_history.md`.
> Open items are numbered from simpler to harder.

---

## Open TODOs

1. [ ] **Agent tab rename**: rename the permanent terminal tab from "Terminal" to "Agent" everywhere (`_TERMINAL_TAB` label, `_update_terminal_tab_label`, `_terminal_back_btn` label).

2. [ ] **Settings dropdown stays open**: the global settings popover closes when clicking the terminal dropdown (`claude`/`codex`); the popover should remain open while interacting with its own child widgets.

3. [ ] **Standalone app theme env**: pass `GTK_THEME=Adwaita:dark` or `GTK_THEME=Adwaita` in the `env` dict of `subprocess.Popen` at launch, derived from `settings_manager.get("color_scheme")`.

4. [ ] **Workspace toggle takes effect immediately**: when the "Manage workspaces" setting is turned on mid-session, allocate workspaces for already-active projects without requiring a restart.

5. [ ] **Secondary-monitor settings toggle**: add "Open apps on secondary monitor" to the settings popover; persist under `"multi_monitor"` in `settings.json`; default `false` so single-monitor users are unaffected.

6. [ ] **Standalone open-app mode field**: add `"mode": "standalone"` to `project.json["open_apps"]` entries written for standalone windows; existing entries without the field default to `"embed"`.

7. [ ] **Resolve built-in app defaults**: at startup, resolve the system defaults with `xdg-settings get default-web-browser`, `xdg-mime query default x-scheme-handler/mailto`, and the default calendar `.desktop` file; skip silently if not found.

8. [ ] **Permanent built-in app tabs**: add non-closeable icon tabs for Browser (`web-browser-symbolic`), Mail (`mail-client-symbolic`), and Calendar (`x-office-calendar-symbolic`) in the tab bar; grey out any whose default app is not found.

9. [ ] **Tab bar in header frame**: investigate whether the center-panel tab bar can be integrated into the header/title bar area for larger window sizes where the dedicated tab row wastes vertical space.

10. [ ] **Secondary-monitor detection**: at startup and on `Gdk.Display` `monitors-changed`, read `Gdk.Display.get_monitors()` and store the list; expose `window.get_secondary_monitor() -> Gdk.Monitor | None`.

11. [ ] **Secondary-monitor app launch**: in the standalone dispatch path, if a secondary monitor exists, set `GDK_MONITOR=1` or pass geometry args where supported in the `subprocess.Popen` environment.

12. [ ] **Ollama daemon management**: start/stop an `ollama serve` subprocess when Eldrun launches; expose a status indicator in the header bar where green means ready and grey means offline.

13. [ ] **Local AI model selection**: make model selection configurable per project in `CLAUDE.md` or a sidebar setting; default to a small fast model such as `mistral` or `phi3`.

14. [ ] **Local AI privacy boundary**: keep all inference local; no data leaves the machine; add a visible "local AI" label to AI-generated suggestions.

15. [ ] **Standalone app restore**: on project re-activation, relaunch entries with `"mode": "standalone"` via `subprocess.Popen` without any embed probe; entries with `"mode": "embed"` or no field go through the full two-path probe again.

16. [ ] **Built-in app dispatch**: each resolved Browser, Mail, and Calendar app goes through the two-strategy dispatch: embed frameless if viable, else open standalone and add to the open-windows list.

17. [ ] **Embedding pipeline verification**: verify live end-to-end: double-click a project file, app launches, tab appears, window reparents into the center panel, closing the tab releases the window back to root, and Terminal tab / overlay button returns to terminal view.

18. [ ] **Context-aware terminal hints**: optionally pipe the last N lines of the active terminal's scrollback to Ollama and display a short hint strip below the terminal.

19. [ ] **GNOME workspace support**: use `org.gnome.Shell` `Eval` or `Meta.WorkspaceManager`; fall back to `wmctrl -s <idx>` if DBus is unavailable.

20. [ ] **Embedded app theme propagation**: on theme toggle in `_on_toggle_theme`, iterate open embed tabs and send an XSETTINGS `Net/ThemeName` change via `python-xlib`; fall back to a no-op if the window is gone.

21. [ ] **Intelligent project search**: embedding-based semantic search; query Ollama for sentence embeddings of the project name plus `STATUS.md` / `CLAUDE.md` summary, then rank results by cosine similarity.

22. [ ] **Suggest projects for today**: on startup, send recent git activity (`git log --oneline -20` across all projects) plus current date/time to Ollama and surface the top 2-3 projects the user likely wants to continue; show as a soft highlight or pinned section at the top of the project list.

23. [ ] **App/file suggestions per project**: when a project is activated, ask Ollama which files are most likely relevant given recent commits and `project.json["open_apps"]` history; surface suggestions as a "Suggested" section at the top of the open-apps browser.
