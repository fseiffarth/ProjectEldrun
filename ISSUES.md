# ProjectEldrun — Known Issues

## Open

### ISSUE-001: X11 app embedding untested
**Phase:** 6.B  
**Severity:** Unknown — code written but not verified in a live session  
`show_app_window(xid)` uses `GdkX11.X11Surface.get_xid()` + `XReparentWindow`. This approach may fail if:
- The compositor rejects the reparent
- The embedded window ignores resize requests
- GDK surface is not yet realised when called (widget not yet mapped)

**Workaround:** Falls back to `_raise_window` if center panel ref is missing; but if it raises an exception mid-reparent the center panel may show a blank page.  
**Fix needed:** Test with a real window (e.g. gedit); add error recovery to restore last terminal page on failure.

---

### ISSUE-002: Left panel shows all desktop apps, not project-scoped
**Phase:** 6.C (future)  
All normal windows appear in "OPEN APPS" regardless of which project is active. Should filter to only windows whose process cwd is under `~/eldrun/<current-project>/`.

---

### ~~ISSUE-003: "+" button is a no-op~~ ✅ Fixed
`NewProjectDialog` and `ImportProjectDialog` wired via the "+" popover in `right_panel.py`.

---

### ~~ISSUE-004: Projects not restored on restart~~ ✅ Fixed
`_on_map` in `window.py` calls `get_visible_projects()` and restores all `"active"` / `"current"` rows and terminals on startup.

---

### ~~ISSUE-005: Root terminal opens in `~/eldrun/` even if the folder doesn't exist~~ ✅ Fixed
`open_master_terminal()` now calls `pathlib.Path(_PROJECTS_ROOT).mkdir(parents=True, exist_ok=True)` before spawning.

---

### ~~ISSUE-006: Project structure bottom section is a stub~~ ✅ Fixed
`LeftPanel` has a full `Gtk.TreeView` file tree with expand/collapse, right-click context menu, color picker, and 5 s refresh timer.

---

### ~~ISSUE-007: Right panel too wide on first project open after startup~~ ✅ Fixed
`_init_inner_paned` now returns early and re-defers via `GLib.idle_add` when `outer_w == 0`, eliminating the stale `or 1440` fallback that caused wrong paned positioning before the window was fully allocated.

---

### ISSUE-009: Right panel gets double width after hide-both → show-left → show-right
**Phase:** Post-Phase 13 (panel toggle polish)  
**Severity:** Medium — visual layout broken in this specific sequence  
When both panels are hidden and then revealed one at a time (left first, then right), the right panel takes roughly double the expected width instead of restoring to its original 220 px.

**Suspected cause:** The `Gtk.Paned` position for the outer pane (left/center split) is restored when the left panel is shown, but this shifts the total available width that the inner pane (center/right split) sees. When the right panel is subsequently shown, the inner pane position is recomputed against the now-shifted outer pane, resulting in the wrong right-panel width.

**Reproduction steps:**
1. Hide both panels (toggle left, then toggle right — or use Super key)
2. Show left panel only
3. Show right panel — observe it is ~440 px wide instead of ~220 px

**Fix needed:** When restoring a panel, recompute the paned position relative to the current window/outer-pane allocation rather than using the saved absolute pixel offset.

---

### ISSUE-008: Open-app embedding completely broken
**Phase:** Post-Phase 13  
**Severity:** High — current implementation is unusable  
The entire "open apps" pipeline (launching a file, detecting the window, embedding it in the center panel) has multiple failure modes and needs to be rewritten in stages:

**Stage 1 — Open file in standalone window (baseline)**
- Remove all X11 reparenting / embedding code from `LeftPanel` and `CenterPanel`
- `_open_file` should simply `subprocess.Popen([app, path])` and record the entry in `project.json["open_apps"]`
- Verify this works reliably before proceeding

**Stage 2 — Embed app fullscreen in center panel**
- Once Stage 1 is stable, define the center panel window ID as the embedding target
- Reimplement `show_app_window(xid)` using `GdkX11.X11Surface.get_xid()` + `XReparentWindow` + `XResizeWindow`; add robust error recovery (restore last terminal page on any exception)
- Add a 300 ms delay after launch before attempting reparent, retrying up to 5 times

**Stage 3 — Wire to the open-apps panel**
- Once Stage 2 is stable, reconnect `AppRow` click → `show_app_window(xid)` in `LeftPanel`
- EWMH poll should track the embedded window's XID and update `AppRow.xid` accordingly

---

### ~~ISSUE-010: Test suite references removed/renamed panel modules~~ ✅ Fixed
**Phase:** Documentation/codebase analysis follow-up  
**Severity:** Medium — tests can fail or validate stale behavior instead of current behavior  
Stale tests have been replaced with current `FileTreePanel` / `BottomPanel` logic coverage.

---

### ~~ISSUE-011: Scaffold contract disagrees with tests and docs~~ ✅ Fixed
**Phase:** Documentation/codebase analysis follow-up  
**Severity:** Low to Medium — new project contents are ambiguous  
`STATUS.md` is part of the project scaffold and is documented consistently.

---

### ~~ISSUE-012: Open-app persistence schema is inconsistent~~ ✅ Fixed
**Phase:** Documentation/codebase analysis follow-up  
**Severity:** Medium — warm project state and restore behavior are unreliable  
`project.json["open_apps"]` is the durable representation. Full standalone restore behavior remains tracked as future open-app pipeline work.

---

### ISSUE-013: Agent numbering does not reset after adding and closing an agent
**Phase:** Agent/session lifecycle polish  
**Severity:** Low to Medium — confusing UI state after normal agent add/close flow  
When a new agent is added and then closed, the visible agent numbers are not reset. Subsequent agents continue from the previous number instead of renumbering or reusing the expected sequence.

**Fix needed:** Recompute agent display numbers after agent removal, or clarify the intended numbering model if numbers are meant to be persistent session IDs.

---

### ISSUE-014: Adding a new agent clears current project selection and hides right panel
**Phase:** Agent/session lifecycle polish  
**Severity:** Medium — adding an agent disrupts the active project workspace  
When a new agent is added, the active project should remain unchanged. Instead, the bottom project switcher no longer shows the current project as selected and the right panel disappears.

**Expected behavior:** Adding a new agent should always happen inside the current project and should only open a new terminal/tab for that project. It should not change project selection, clear current-project UI state, or hide the right panel.

**Fix needed:** Keep the current project context stable during agent creation, and create the new agent terminal/tab under that project without triggering project-switch or panel-hide side effects.
