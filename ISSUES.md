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

---

### ISSUE-015: Closing the current project should return to root and close the right panel
**Phase:** Project lifecycle polish  
**Severity:** Medium — active project UI can remain inconsistent after closing the current project  
When the current project is closed with the `x` button, Eldrun should switch back to the root project/session. Because the closed project is no longer active, the right project panel should also close or be hidden.

**Expected behavior:** Closing the active project selects the root project/session, clears the current project selection from the bottom switcher, and hides the right project panel because there is no active project for it to display.

**Fix needed:** Update the project-close path so that closing the active project explicitly activates the root session and tears down project-specific UI state, including the right panel.

---

### ISSUE-016: Closing a project leaves an empty "no project selected" agent tab instead of selecting root
**Phase:** Project lifecycle polish  
**Severity:** Medium — project close lands in an invalid workspace state  
After closing a project, the project panel now closes, but Eldrun does not switch to the root project/session. The root item in the bottom switcher does not receive the blue active border, and the center panel is left on an empty agent tab that says no project is selected.

**Expected behavior:** Closing the current project should activate the root session, select root in the bottom switcher with the blue border, and show the root agent/terminal rather than an empty no-project placeholder.

**Fix needed:** Ensure the close-project flow activates the root session after clearing project-specific UI, and refreshes both the bottom switcher selection state and center panel tab content.

---

### ISSUE-017: Closing all tabs creates a hidden terminal and breaks the tab bar
**Phase:** Agent/session lifecycle polish  
**Severity:** Medium — empty tab state is broken and confusing  
When all tabs are closed, Eldrun currently creates a new terminal implicitly. That terminal appears to be hidden, and the tab bar breaks instead of presenting a clear empty state.

**Expected behavior:** If all tabs are closed, do not create an implicit replacement terminal. Show an empty center page explaining that no tab is open and that a new agent or terminal can be created by right-clicking the tab bar.

**Fix needed:** Replace the implicit terminal fallback with an explicit empty-tab state, and keep the tab bar usable for right-click creation actions while no tabs are open.

---

### ISSUE-018: Reddish full-width flicker under high CPU load
**Phase:** Rendering/compositor diagnostics  
**Severity:** Medium — visually disruptive and may indicate a renderer/compositor sync issue  
Under high CPU load, a reddish flicker can appear as a short-height band spanning the full screen width. The symptom sounds like a frame presentation or compositor artifact rather than a normal widget repaint, especially because it is height-restricted but screen-wide.

**Possible causes:**
- `GSK_RENDERER=cairo` or another non-synced renderer path may still be active. `app/eldrun.py` already prefers `ngl` on Cinnamon/X11 because cairo can produce reddish horizontal tearing bands via XPutImage without vsync.
- The renderer workaround only applies when `XDG_SESSION_TYPE=x11` and `XDG_CURRENT_DESKTOP` contains `cinnamon`. Other X11 desktops, missing environment values, explicit `GSK_RENDERER`, or `ELDRUN_DISABLE_RENDERER_WORKAROUND=1` skip it.
- Cinnamon/X11 compositing may be missing frames when the CPU is saturated, especially with an undecorated, maximized GTK window and continuous VTE terminal updates.
- VTE output bursts may invalidate large areas of the center panel; if GTK/GSK cannot finish the render before scanout, a partially presented frame can look like a full-width colored strip.
- Full-width overlays and fixed-height surfaces such as the header/bottom panel/offline banner could expose stale themed pixels during delayed redraws, making the artifact appear red or pink depending on the active theme.

**Diagnostics needed:**
- Record `GSK_RENDERER`, `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, GPU/driver, refresh rate, compositor settings, and active Eldrun theme when it happens.
- Try `GSK_RENDERER=ngl`, `GSK_RENDERER=gl`, and `GSK_RENDERER=cairo` explicitly to confirm whether the artifact follows the renderer.
- Check whether the flicker occurs only during heavy terminal output, only while maximized/fullscreen, or also when the window is restored.
- Capture a phone video or compositor screencast to identify whether the band aligns with the VTE area, header, bottom panel, or the monitor scanout.

**Fix needed:** Harden renderer selection beyond Cinnamon/X11 if confirmed, document a safe override, and consider throttling high-frequency UI updates or reducing full-width overlay redraws if the artifact is tied to VTE/output bursts.
