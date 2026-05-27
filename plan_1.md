# Plan 1 — Rewrite Open-App Pipeline (ISSUE-008)

## Goal

The current X11 embedding pipeline is broken. Rewrite it in three gated stages.
**Do not start a later stage until the previous one is verified working.**

---

## Stage 1 — Open file in standalone window

**What it does:** strip all embedding code; file open = `Popen` + record in `open_apps.json`.

### `app/panels/left_panel.py`

**`__init__`** — remove the pending-embed attribute (line 147):
```python
# DELETE:
self._pending_auto_embed_exe: str | None = None
```

**`_launch_and_track`** (line 570–576) — remove the last line and update docstring:
```python
def _launch_and_track(self, app: str, path: str, project_dir: str | None):
    subprocess.Popen([app, path], cwd=project_dir or os.path.dirname(path))
    if self._oam is not None:
        self._oam.add_or_update(app, os.path.basename(app), [])
        self._notify_warm()
    # DELETE the line: self._pending_auto_embed_exe = ...
```

**`_on_app_click`** (line 1186–1200) — remove `show_app_window` call; always use `_raise_window`:
```python
def _on_app_click(self, row: AppRow):
    if row.xid is not None:
        self._raise_window(row.xid)   # raise standalone window
    else:
        exe = row.entry.get("exe", "")
        args = row.entry.get("args", [])
        cwd = self._current_project.get("directory") if self._current_project else None
        if exe:
            try:
                subprocess.Popen([exe] + args, cwd=cwd)
            except OSError:
                pass
```

**`_refresh`** (lines 1346–1362) — delete the entire "Auto-embed" block:
```python
# DELETE this block:
#   # Auto-embed: scan all normal windows for the pending exe (skip CWD filter)
#   if self._pending_auto_embed_exe is not None:
#       for xid in xids:
#           ...
#           (entire inner loop + break)
```

### `app/panels/center_panel.py`

**`_APP_PAGE` constant** (line 15) — delete:
```python
# DELETE: _APP_PAGE = "__app__"
```

**`CenterPanel.__init__`** — remove `_embedded_xid` (line 77):
```python
# DELETE: self._embedded_xid: int | None = None
```

**`show_app_window()`** (lines 200–248) — delete the entire method.

**`_release_app_window()`** (lines 249–262) — delete the entire method.

**`_on_back_to_terminal`** (line 266–275) — remove the `_release_app_window()` call since the
method is gone. Back button stays hidden in Stage 1 and is never triggered, but keep the
handler intact for Stage 2:
```python
def _on_back_to_terminal(self, _btn):
    target = self._last_terminal_page
    if target != "empty" and self._stack.get_child_by_name(target) is not None:
        self._stack.set_visible_child_name(target)
    else:
        target = "empty"
        self._stack.set_visible_child_name("empty")
    self._back_btn.set_visible(False)
    self._notify_page(target)
```

### Verification checklist

- [ ] Double-clicking a file in the project tree opens the app in a normal desktop window
- [ ] `open_apps.json` in the project dir gains an entry for the app
- [ ] The app row appears in "OPEN APPS" with a green running indicator
- [ ] Clicking the app row raises the standalone desktop window
- [ ] No crashes or tracebacks in `/tmp/eldrun.log`

---

## Stage 2 — Embed app fullscreen in center panel

**Prerequisite:** Stage 1 verified.

**What it does:** re-add `show_app_window` with a retry loop and solid error recovery.

### `app/panels/center_panel.py`

**Re-add constant:**
```python
_APP_PAGE = "__app__"
```

**Re-add `_embedded_xid`** in `__init__`:
```python
self._embedded_xid: int | None = None
```

**Re-add `show_app_window(xid)`** — new implementation with retry and recovery:
```python
def show_app_window(self, xid: int):
    """Embed an X window in the center via XReparentWindow. Retries 5× at 300 ms."""
    self._embed_attempts = 0
    self._embed_target_xid = xid
    GLib.timeout_add(300, self._try_embed)

def _try_embed(self) -> bool:
    xid = self._embed_target_xid
    self._embed_attempts += 1
    try:
        import gi as _gi
        _gi.require_version("GdkX11", "4.0")
        from gi.repository import GdkX11
        from Xlib import display as Xdisplay

        native = self.get_native()
        if native is None:
            raise RuntimeError("no native surface")
        surface = native.get_surface()
        if not isinstance(surface, GdkX11.X11Surface):
            raise RuntimeError("not an X11 surface")
        center_xid = GdkX11.X11Surface.get_xid(surface)

        disp = Xdisplay.Display()
        app_win  = disp.create_resource_object("window", xid)
        host_win = disp.create_resource_object("window", center_xid)

        alloc = self._stack.get_allocation()
        w = max(alloc.width, 400)
        h = max(alloc.height, 300)

        app_win.unmap()
        app_win.reparent(host_win, 0, 0)
        app_win.configure(width=w, height=h)
        app_win.map()
        disp.flush()
        self._embedded_xid = xid
    except Exception as exc:
        print(f"[eldrun] embed attempt {self._embed_attempts}: {exc}")
        if self._embed_attempts < 5:
            return True   # retry
        # all retries exhausted — stay on terminal
        self._embedded_xid = None
        return False

    # success
    current = self._stack.get_visible_child_name() or "empty"
    if current != _APP_PAGE:
        self._last_terminal_page = current
    if self._stack.get_child_by_name(_APP_PAGE) is None:
        self._stack.add_named(Gtk.Label(label=""), _APP_PAGE)
    self._stack.set_visible_child_name(_APP_PAGE)
    self._back_btn.set_visible(True)
    return False
```

**Re-add `_release_app_window()`** — unchanged from original.

**Update `_on_back_to_terminal`** — restore `_release_app_window()` call.

### Verification checklist

- [ ] Clicking an `AppRow` that has a running XID embeds the window in the center panel
- [ ] The "⬛ Terminal" back button appears and returns to the last terminal page on click
- [ ] If embedding fails (e.g. window not yet ready), Eldrun stays on the terminal — no crash
- [ ] Log shows retry attempts but no unhandled exceptions

---

## Stage 3 — Wire app rows to embedded windows

**Prerequisite:** Stage 2 verified.

**What it does:** connect `AppRow` click → `center_panel.show_app_window`; keep XID current
via EWMH poll.

### `app/panels/left_panel.py`

**`_on_app_click`** — restore `show_app_window` path:
```python
def _on_app_click(self, row: AppRow):
    if row.xid is not None:
        if self._center is not None and hasattr(self._center, "show_app_window"):
            self._center.show_app_window(row.xid)
        else:
            self._raise_window(row.xid)
    else:
        exe = row.entry.get("exe", "")
        args = row.entry.get("args", [])
        cwd = self._current_project.get("directory") if self._current_project else None
        if exe:
            try:
                subprocess.Popen([exe] + args, cwd=cwd)
            except OSError:
                pass
```

EWMH poll already updates `AppRow.xid` via `_sync_rows` / `row.set_running(is_running, xid)`.
No additional changes needed there.

### Verification checklist

- [ ] Full flow: file open → standalone window appears → click app row → window embeds in center panel
- [ ] "⬛ Terminal" click → back to terminal; app row indicator stays green while embedded
- [ ] Switching projects un-embeds the old window and shows the new project terminal
- [ ] App row indicator turns grey when the embedded app is closed

---

## Notes

- All three stages touch only `left_panel.py` and `center_panel.py`.
- The `OpenAppsManager`, `AppRow`, EWMH polling logic, and all terminal handling are
  left untouched throughout.
- Multi-monitor support (separate TODO) is a follow-on after Stage 3 is stable.
