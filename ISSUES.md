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

### ISSUE-003: "+" button is a no-op
**Phase:** 7 (pending)  
`_on_new_project_clicked` in `window.py` is an empty stub. Clicking "+" does nothing.

---

### ISSUE-004: Projects not restored on restart
**Phase:** 7 (pending)  
`project_manager.projects` is loaded from JSON on startup but `_on_map` does not iterate it to recreate terminals and rows. Restarting Eldrun loses the visible project list (data is persisted but UI is not rebuilt).

---

### ~~ISSUE-005: Root terminal opens in `~/eldrun/` even if the folder doesn't exist~~ ✅ Fixed
`open_master_terminal()` now calls `pathlib.Path(_PROJECTS_ROOT).mkdir(parents=True, exist_ok=True)` before spawning.

---

### ISSUE-006: Project structure bottom section is a stub
**Phase:** 5.C (future)  
The "PROJECT" section in the left panel is an empty `Gtk.ListBox` with no content. File tree not yet implemented.
