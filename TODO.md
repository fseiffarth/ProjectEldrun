# ProjectEldrun — TODO

> Completed work has been moved to `TODO_history.md`.
> Open items are numbered from simpler to harder.

---

## Open TODOs

1. [x] **Agent tab rename**: rename the permanent terminal tab from "Terminal" to "Agent" everywhere (`_TERMINAL_TAB` label, `_update_terminal_tab_label`, `_terminal_back_btn` label).

2. [x] **Multiple agent tabs**: in addition to switching the default terminal command between `claude` and `codex`, right-clicking the tab bar should open a popover for adding a new `claude` or `codex` agent from a dropdown. Additional agents are named `Agent1`, `Agent2`, etc.; right-clicking an agent tab should open a rename popover except for the default Agent tab; additional agent tabs get an `x` close button, but the default Agent tab does not.

3. [ ] **Agent numbering reset after close** (`ISSUE-013`): after an additional agent is closed, recompute visible agent display numbers or intentionally reuse the expected sequence so the next added agent does not continue from a stale number.

4. [ ] **Agent creation stays in current project** (`ISSUE-014`): adding a new agent should keep the bottom project switcher selection, keep the right panel visible, and only open a new terminal/tab inside the current project.

5. [ ] **Uniform agent tab behavior**: do not distinguish between the master/default agent and newly added agents. Every agent tab should be renameable and closeable; if all agents are closed, the user must add a new one manually by right-clicking the tab bar.

6. [x] **Settings dropdown stays open**: resolved by commit `fa13e2d` — settings was converted from `Gtk.Popover` (which autohides on outside clicks) to `Gtk.Window` with `modal=True`, so the dropdown interaction no longer dismisses it.

7. [ ] **Standalone app theme env**: pass `GTK_THEME=Adwaita:dark` or `GTK_THEME=Adwaita` in the `env` dict of `subprocess.Popen` at launch, derived from `settings_manager.get("color_scheme")`.

8. [ ] **Workspace toggle takes effect immediately**: when the "Manage workspaces" setting is turned on mid-session, allocate workspaces for already-active projects without requiring a restart.

9. [ ] **Secondary-monitor settings toggle**: add "Open apps on secondary monitor" to the settings popover; persist under `"multi_monitor"` in `settings.json`; default `false` so single-monitor users are unaffected.

10. [ ] **Standalone open-app mode field** (`ISSUE-008`): add `"mode": "standalone"` to `project.json["open_apps"]` entries written for standalone windows; existing entries without the field default to `"embed"`.

11. [ ] **Resolve built-in app defaults**: at startup, resolve the system defaults with `xdg-settings get default-web-browser`, `xdg-mime query default x-scheme-handler/mailto`, and the default calendar `.desktop` file; skip silently if not found.

12. [ ] **Permanent built-in app tabs**: add non-closeable icon tabs for Browser (`web-browser-symbolic`), Mail (`mail-client-symbolic`), and Calendar (`x-office-calendar-symbolic`) in the tab bar; grey out any whose default app is not found.

13. [ ] **Tab bar in header frame**: investigate whether the center-panel tab bar can be integrated into the header/title bar area for larger window sizes where the dedicated tab row wastes vertical space.

14. [x] **Right panel restore width** (`ISSUE-009`): after hide-both -> show-left -> show-right, recompute the inner paned position from the current allocation so the right panel returns to the expected width instead of doubling.

15. [ ] **Secondary-monitor detection**: at startup and on `Gdk.Display` `monitors-changed`, read `Gdk.Display.get_monitors()` and store the list; expose `window.get_secondary_monitor() -> Gdk.Monitor | None`.

16. [ ] **Secondary-monitor app launch**: in the standalone dispatch path, if a secondary monitor exists, set `GDK_MONITOR=1` or pass geometry args where supported in the `subprocess.Popen` environment.

17. [ ] **Ollama daemon management**: start/stop an `ollama serve` subprocess when Eldrun launches; expose a status indicator in the header bar where green means ready and grey means offline.

18. [ ] **Local AI model selection**: make model selection configurable per project in `CLAUDE.md` or a sidebar setting; default to a small fast model such as `mistral` or `phi3`.

19. [ ] **Local AI privacy boundary**: keep all inference local; no data leaves the machine; add a visible "local AI" label to AI-generated suggestions.

20. [ ] **Project-scoped open-app list** (`ISSUE-002`): filter the open-apps panel so it only shows windows whose process cwd belongs to the current project instead of showing all normal desktop windows.

21. [ ] **Open-app standalone baseline** (`ISSUE-008`, Stage 1): make file opening reliable without embedding first by launching the app with `subprocess.Popen([app, path])` and recording the entry in `project.json["open_apps"]`.

22. [ ] **Standalone app restore** (`ISSUE-008`): on project re-activation, relaunch entries with `"mode": "standalone"` via `subprocess.Popen` without any embed probe; entries with `"mode": "embed"` or no field go through the full two-path probe again.

23. [ ] **Built-in app dispatch**: each resolved Browser, Mail, and Calendar app goes through the two-strategy dispatch: embed frameless if viable, else open standalone and add to the open-windows list.

24. [ ] **Embedding pipeline hardening and verification** (`ISSUE-001`, `ISSUE-008`, Stages 2-3): define the center panel XID as the embedding target, retry reparenting after launch, restore the terminal page on failure, reconnect `AppRow` clicks, and verify a live file-open/reparent/close flow end-to-end.

25. [ ] **Context-aware terminal hints**: optionally pipe the last N lines of the active terminal's scrollback to Ollama and display a short hint strip below the terminal.

26. [ ] **GNOME workspace support**: use `org.gnome.Shell` `Eval` or `Meta.WorkspaceManager`; fall back to `wmctrl -s <idx>` if DBus is unavailable.

27. [ ] **Embedded app theme propagation**: on theme toggle in `_on_toggle_theme`, iterate open embed tabs and send an XSETTINGS `Net/ThemeName` change via `python-xlib`; fall back to a no-op if the window is gone.

28. [ ] **Intelligent project search**: embedding-based semantic search; query Ollama for sentence embeddings of the project name plus `STATUS.md` / `CLAUDE.md` summary, then rank results by cosine similarity.

29. [ ] **Suggest projects for today**: on startup, send recent git activity (`git log --oneline -20` across all projects) plus current date/time to Ollama and surface the top 2-3 projects the user likely wants to continue; show as a soft highlight or pinned section at the top of the project list.

30. [ ] **App/file suggestions per project**: when a project is activated, ask Ollama which files are most likely relevant given recent commits and `project.json["open_apps"]` history; surface suggestions as a "Suggested" section at the top of the open-apps browser.
