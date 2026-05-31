# KDE/KWin Backend Plan

This document specifies the implementation of `app/backends/kde_kwin.py` —
the KDE Plasma adapter for Eldrun's project workspace isolation system.

The adapter targets **Phase 6, Priority 1** from `plan_vision.md` and will
be the first non-Cinnamon backend.  Reaching it unlocks version `0.2.0`.

---

## Context

### What exists today

`detect_backend()` in `backends/__init__.py` currently returns:

- `CinnamonX11Backend` on X11 (wraps `WorkspaceManager`)
- `NullBackend` on any Wayland session

A KDE user therefore gets either no workspace isolation (Wayland) or the
wmctrl fallback path (X11), neither of which is purpose-built for KDE.

The `ProjectSpaceBackend` ABC is already in `workspace_core.py`.  Adding KDE
support is **one new file** plus a **two-line change** to `detect_backend()`.
No other core files change.

### How KDE's virtual desktop system works

KDE calls them **virtual desktops** (not workspaces).  Each desktop has:

- An **integer index** (0-based) used by EWMH/Xlib on X11
- A **UUID string** (KDE 5+) used internally and over DBus on Wayland

Both KDE 5 and KDE 6 must be supported.  The interfaces differ:

| Concern | KDE 5 DBus path | KDE 6 DBus path |
|---------|----------------|----------------|
| Desktop CRUD | `/KWin` | `/VirtualDesktopManager` |
| Switch desktop | `setCurrentDesktop(uint32)` | `setCurrent(string uuid)` |
| Window → desktop (X11) | EWMH `_NET_WM_DESKTOP` | EWMH `_NET_WM_DESKTOP` |
| Window → desktop (Wayland) | KWin scripting JS | KWin scripting JS **or** `/org/kde/KWin/Windows/<uuid>` |
| Window list (X11) | EWMH `_NET_CLIENT_LIST` | EWMH `_NET_CLIENT_LIST` |
| Window list (Wayland) | KWin scripting JS | KWin scripting JS |

The backend auto-detects the KDE version once at `__init__` and dispatches
accordingly throughout its lifetime.

---

## Architecture

### Session-type split

The backend contains two parallel code paths selected at construction time:

```
KDEKWinBackend
├── _session = "x11"
│   ├── Desktop CRUD → KWin DBus (org.kde.KWin)
│   └── Window ops   → Xlib EWMH (_NET_CLIENT_LIST, _NET_WM_DESKTOP)
└── _session = "wayland"
    ├── Desktop CRUD → KWin DBus (org.kde.KWin)
    └── Window ops   → KWin Scripting JS loaded via DBus
```

On **X11**, KDE fully respects EWMH atoms, so the window-enumerate and
window-move logic from `WorkspaceManager` is reused verbatim.  The only
KDE-specific part is creating/naming/switching desktops, which goes through
`org.kde.KWin` instead of Cinnamon DBus.

On **Wayland**, Xlib is unavailable.  All window communication goes through
KWin's scripting API: a short JS snippet is written to a temp file, loaded
via `org.kde.kwin.Scripting.loadScript`, and (on KDE 6) the per-window DBus
interface at `/org/kde/KWin/Windows/<uuid>` is used for moves.

### No new Python dependencies

All DBus communication uses `subprocess.run` with `dbus-send`.  The backend
does **not** require `python-dbus`, `dbus-python`, `jeepney`, or any other
DBus library.  `qdbus6`/`qdbus` are used as an optional higher-level
alternative but always fall back to `dbus-send`.

---

## File layout

```
app/
  backends/
    __init__.py      ← add 6-line KDE detection block
    kde_kwin.py      ← new file (~380 lines)
    cinnamon_x11.py  ← unchanged
    gnome.py         ← unchanged
    null.py          ← unchanged
  workspace_core.py  ← unchanged
  workspace_manager.py ← unchanged
tests/
  test_kde_kwin.py   ← new file (~130 tests)
```

---

## Detection

### `is_available()`

```python
def is_available(self) -> bool:
    import os, subprocess
    desktop = os.environ.get("XDG_CURRENT_DESKTOP", "").lower()
    if "kde" not in desktop and "plasma" not in desktop:
        return False
    try:
        r = subprocess.run(
            ["dbus-send", "--session", "--print-reply",
             "--dest=org.kde.KWin", "/",
             "org.freedesktop.DBus.Peer.Ping"],
            capture_output=True, timeout=2,
        )
        return r.returncode == 0
    except Exception:
        return False
```

### KDE version detection

Called once at `__init__`.  Probes whether `/VirtualDesktopManager` exists
(KDE 6) or only the legacy `/KWin` path (KDE 5):

```python
def _detect_kde_version(self) -> int:
    try:
        r = subprocess.run(
            ["dbus-send", "--session", "--print-reply",
             "--dest=org.kde.KWin", "/VirtualDesktopManager",
             "org.freedesktop.DBus.Introspectable.Introspect"],
            capture_output=True, timeout=2,
        )
        if r.returncode == 0 and b"VirtualDesktopManager" in r.stdout:
            return 6
    except Exception:
        pass
    return 5
```

### Session type detection

```python
def _detect_session(self) -> str:
    import os
    return "wayland" if os.environ.get("WAYLAND_DISPLAY") else "x11"
```

### `__init__` skeleton

```python
def __init__(self):
    self._kde_version: int = self._detect_kde_version()
    self._session: str = self._detect_session()
    self._project_windows: dict[str, list] = {}
    # List items are int XIDs on X11, str UUIDs on Wayland.
    self._hidden_desktop_id: str | int | None = None
    self._created_hidden_desktop: bool = False
    self._original_desktop_count: int = 1
```

---

## Virtual desktop management

All desktop operations go through `_kwin_dbus(path, method, *typed_args)`, a
thin wrapper around `dbus-send`:

```python
def _kwin_dbus(self, path: str, method: str, *args) -> str | None:
    """Call org.kde.KWin method and return stdout string, or None on error."""
    cmd = [
        "dbus-send", "--session", "--print-reply",
        "--dest=org.kde.KWin", path, method,
    ] + list(args)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
        return r.stdout if r.returncode == 0 else None
    except Exception:
        return None
```

### Desktop CRUD

#### `_get_desktop_count() -> int`

```python
# KDE 5
_kwin_dbus("/KWin", "org.kde.KWin.currentDesktop")
# parse int from reply

# KDE 6 — read count property via /VirtualDesktopManager
_kwin_dbus("/VirtualDesktopManager",
           "org.freedesktop.DBus.Properties.Get",
           "string:org.kde.KWin.VirtualDesktopManager",
           "string:count")
# parse uint32 from reply
```

#### `_create_desktop(position: int, name: str) -> str | None`

Returns the new desktop UUID (KDE 6) or None (KDE 5).

```bash
# KDE 5
dbus-send --session --print-reply --dest=org.kde.KWin \
    /KWin org.kde.KWin.createDesktop \
    uint32:<position> string:"<name>"

# KDE 6
dbus-send --session --print-reply --dest=org.kde.KWin \
    /VirtualDesktopManager \
    org.kde.KWin.VirtualDesktopManager.createDesktop \
    uint32:<position> string:"<name>"
# stdout contains the new UUID
```

#### `_remove_desktop(desktop_id: str | int)`

```bash
# KDE 5 — switch to desktop 0 first, then use wmctrl to reduce count
wmctrl -n <original_count>

# KDE 6
dbus-send --session --print-reply --dest=org.kde.KWin \
    /VirtualDesktopManager \
    org.kde.KWin.VirtualDesktopManager.removeDesktop \
    string:"<uuid>"
```

#### `_switch_to_desktop(index: int)`

```bash
# KDE 5 (1-indexed in this DBus call)
dbus-send --session --print-reply --dest=org.kde.KWin \
    /KWin org.kde.KWin.setCurrentDesktop uint32:<index+1>

# KDE 6 — need the UUID for the given index
# First: read desktops array, pick [index].id
dbus-send --session --print-reply --dest=org.kde.KWin \
    /VirtualDesktopManager \
    org.kde.KWin.VirtualDesktopManager.setCurrent \
    string:"<uuid>"
```

On X11, both KDE 5 and 6 also respond to the EWMH switch atom, which can be
used as a simpler alternative:

```python
from Xlib.protocol import event as XEv
ev = XEv.ClientMessage(
    window=root,
    client_type=d.intern_atom("_NET_CURRENT_DESKTOP"),
    data=(32, [index, X.CurrentTime, 0, 0, 0]),
)
root.send_event(ev, event_mask=...)
```

#### `_rename_desktop(index: int, name: str)`

```bash
# KDE 5
# No reliable rename via DBus in KDE 5; use wmctrl desktop names:
# Read _NET_DESKTOP_NAMES via Xlib (X11) or skip naming on Wayland KDE 5.

# KDE 6
# Get UUID for index, then:
dbus-send --session --print-reply --dest=org.kde.KWin \
    /VirtualDesktopManager/Desktop<uuid> \
    org.freedesktop.DBus.Properties.Set \
    string:org.kde.KWin.VirtualDesktopManager.Desktop \
    string:name \
    variant:string:"<name>"
```

### `prepare()`

```python
def prepare(self) -> None:
    self._original_desktop_count = self._get_desktop_count()
    if self._original_desktop_count < 2:
        new_id = self._create_desktop(1, "Eldrun-Hidden")
        self._hidden_desktop_id = new_id
        self._created_hidden_desktop = True
    else:
        # Reuse existing second desktop; note its id for cleanup
        self._hidden_desktop_id = self._get_desktop_id(index=1)
        self._created_hidden_desktop = False
    self._rename_desktop(0, "Eldrun")
    self._rename_desktop(1, "Eldrun-Hidden")
    self._switch_to_desktop(0)
```

---

## Window management — X11 path

When `self._session == "x11"`, all window operations use Xlib EWMH atoms.
The logic is **identical** to `WorkspaceManager.switch_project()` in
`workspace_manager.py`.  The backend either imports and delegates to a
`WorkspaceManager` instance (like `CinnamonX11Backend` does), or copies the
relevant methods.

**Recommendation**: inherit from a new `_X11WindowMixin` extracted from
`workspace_manager.py` so both backends share the code without duplication.
This is a refactor step inside Phase 6, not a prerequisite.

Key methods re-used:

| Method | Purpose |
|--------|---------|
| `_get_windows_on_desktop(idx)` | `_NET_CLIENT_LIST` + `_NET_WM_DESKTOP` |
| `_move_window_to_desktop(xid, idx)` | `_NET_WM_DESKTOP` ClientMessage |
| `_batch_get_wm_class(xids)` | `WM_CLASS` for protected-name filtering |
| `_make_sticky(win, root, d)` | `_NET_WM_STATE_STICKY` |

`_project_windows` stores `dict[str, list[int]]` (project_id → list of XIDs).

### `_activate_x11(new_id, old_id, eldrun_xid, protected_names)`

```
1. Collect all non-Eldrun, non-protected windows on desktop 0.
2. Move them to desktop 1; record as old_id's windows.
3. Collect old_id's tracked windows that exist on desktop 1.
4. Move them to desktop 0.
5. (Desktop switch is implicit — we stay on desktop 0.)
```

This is the same algorithm as `WorkspaceManager.switch_project()`.

---

## Window management — Wayland path

When `self._session == "wayland"`, Xlib is unavailable.  All window ops go
through **KWin Scripting**.

### KWin Scripting primer

KWin embeds a JavaScript runtime.  A script can:
- Enumerate all windows: `workspace.windowList()`
- Read window properties: `c.internalId`, `c.resourceClass`, `c.desktops`
- Move a window: `c.desktops = [workspace.desktops[idx]]`

Scripts are loaded via DBus, executed synchronously (KDE 5) or by signal
(KDE 6), and then unloaded.

### `_run_kwin_script(js_code: str) -> None`

```python
def _run_kwin_script(self, js_code: str) -> None:
    import tempfile, os
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".js", prefix="eldrun_kwin_",
        delete=False
    ) as f:
        f.write(js_code)
        script_path = f.name
    try:
        script_name = "eldrun_tmp"
        # Load
        out = self._kwin_dbus(
            "/Scripting",
            "org.kde.kwin.Scripting.loadScript",
            f"string:{script_path}",
            f"string:{script_name}",
        )
        script_id = self._parse_int(out)
        if script_id is None:
            return
        # Run (KDE 5 requires explicit start; KDE 6 auto-starts)
        if self._kde_version == 5:
            self._kwin_dbus(
                f"/Scripting/Script{script_id}",
                "org.kde.kwin.Script.run",
            )
        # Unload
        self._kwin_dbus(
            "/Scripting",
            "org.kde.kwin.Scripting.unloadScript",
            f"string:{script_name}",
        )
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass
```

### Enumerating windows on Wayland

The script writes a JSON file that the Python side reads back:

```python
_ENUMERATE_WINDOWS_JS = """
var result = [];
var clients = workspace.windowList();
for (var i = 0; i < clients.length; i++) {
    var c = clients[i];
    var desktopIds = [];
    for (var j = 0; j < c.desktops.length; j++) {
        desktopIds.push(c.desktops[j].id);
    }
    result.push({
        id: c.internalId,
        cls: c.resourceClass.toLowerCase(),
        desktops: desktopIds
    });
}
var f = new XMLHttpRequest();
f.open("PUT", "file:///tmp/eldrun_kwin_windows.json", false);
f.send(JSON.stringify(result));
"""
```

On KDE 5, `XMLHttpRequest` file:// writes may be blocked; alternative is to
use `workspace.sendDBusSignal()` or write via `callDBus`.  The simpler
fallback is to use KDE 6's window DBus directly (see below).

### Moving a window on Wayland (KDE 5 script)

```python
def _move_window_wayland(self, window_uuid: str, desktop_index: int) -> None:
    js = f"""
var clients = workspace.windowList();
for (var i = 0; i < clients.length; i++) {{
    if (clients[i].internalId === "{window_uuid}") {{
        clients[i].desktops = [workspace.desktops[{desktop_index}]];
        break;
    }}
}}
"""
    self._run_kwin_script(js)
```

### Moving a window on Wayland (KDE 6 window DBus, preferred)

KDE 6 exposes `/org/kde/KWin/Windows/<uuid>` with a `desktops` property:

```bash
# Read current desktops
dbus-send --session --print-reply --dest=org.kde.KWin \
    /org/kde/KWin/Windows/<uuid> \
    org.freedesktop.DBus.Properties.Get \
    string:org.kde.KWin.Window \
    string:desktops

# Set desktops (move to desktop 1)
dbus-send --session --print-reply --dest=org.kde.KWin \
    /org/kde/KWin/Windows/<uuid> \
    org.freedesktop.DBus.Properties.Set \
    string:org.kde.KWin.Window \
    string:desktops \
    variant:array:string:<uuid-of-desktop-1>
```

The backend uses this on KDE 6 + Wayland.  On KDE 5 + Wayland, it falls
back to the KWin scripting approach above.

### `_project_windows` on Wayland

Stores `dict[str, list[str]]` (project_id → list of window UUIDs, not XIDs).
The UUIDs are the `internalId` values returned by `workspace.windowList()`.

### `_activate_wayland(new_id, old_id, protected_names)`

```
1. Enumerate all windows via KWin script → [{id, cls, desktops}]
2. Windows on desktop[0]:
   a. Skip any whose cls matches Eldrun ("eldrun") or protected_names.
   b. Move remaining to desktop[1].
   c. Record their UUIDs as old_id's windows.
3. Windows on desktop[1] that belong to new_id (tracked UUIDs):
   a. Verify they still exist in the enumeration.
   b. Move to desktop[0].
4. Switch current desktop to desktop[0].
```

---

## Full `ProjectSpaceBackend` method table

| Method | X11 implementation | Wayland implementation |
|--------|-------------------|----------------------|
| `is_available()` | DBus ping to `org.kde.KWin` | same |
| `prepare()` | KWin DBus desktop CRUD | same |
| `close_project(id)` | clear `_project_windows[id]` | same |
| `activate_project(…)` | `_activate_x11(…)` | `_activate_wayland(…)` |
| `assign_window_to_project(wid, id)` | append XID to `_project_windows[id]` | append UUID |
| `save_project_layout(id)` | no-op (future) | no-op (future) |
| `restore_project_layout(id)` | no-op (future) | no-op (future) |
| `make_global_window(wid)` | `_NET_WM_STATE_STICKY` Xlib | KWin `showOnAllDesktops` script |
| `has_managed_windows()` | `bool(self._project_windows)` | same |
| `cleanup()` | move all desktop[1] → desktop[0], remove if created | same via Wayland moves |

### `make_global_window()` on Wayland

```python
def _make_sticky_wayland(self, window_uuid: str) -> None:
    js = f"""
var clients = workspace.windowList();
for (var i = 0; i < clients.length; i++) {{
    if (clients[i].internalId === "{window_uuid}") {{
        clients[i].onAllDesktops = true;
        break;
    }}
}}
"""
    self._run_kwin_script(js)
```

---

## `cleanup()`

```python
def cleanup(self) -> None:
    if self._session == "x11":
        try:
            from Xlib import display as XD, X
            d = XD.Display()
            for xid in self._get_windows_on_desktop_xlib(d, 1):
                self._move_window_to_desktop_xlib(d, xid, 0)
            d.close()
        except Exception:
            pass
    else:
        for xids in self._project_windows.values():
            for uid in xids:
                try:
                    self._move_window_wayland(uid, 0)
                except Exception:
                    pass

    self._project_windows.clear()

    if self._created_hidden_desktop and self._hidden_desktop_id is not None:
        self._remove_desktop(self._hidden_desktop_id)
        self._hidden_desktop_id = None
        self._created_hidden_desktop = False
```

---

## Integration into `detect_backend()`

```python
def detect_backend() -> ProjectSpaceBackend:
    import os
    desktop = os.environ.get("XDG_CURRENT_DESKTOP", "").lower()
    wayland = os.environ.get("WAYLAND_DISPLAY", "")

    # KDE Plasma — handles both X11 and Wayland sessions
    if "kde" in desktop or "plasma" in desktop:
        from backends.kde_kwin import KDEKWinBackend
        b = KDEKWinBackend()
        if b.is_available():
            return b

    # Non-KDE X11 (Cinnamon, GNOME fallback, wmctrl)
    if not wayland:
        from backends.cinnamon_x11 import CinnamonX11Backend
        b = CinnamonX11Backend()
        if b.is_available():
            return b

    from backends.null import NullBackend
    return NullBackend()
```

---

## Test plan — `tests/test_kde_kwin.py`

All tests are fully mockable.  No live KDE session is required.

The file sets up Xlib mocks identically to `test_workspace_manager.py` and
mocks `subprocess.run` for all DBus calls.

### `TestKDEDetection` (8 tests)

```python
test_is_available_kde_desktop_with_kwin_dbus()
test_is_available_returns_false_for_gnome_desktop()
test_is_available_returns_false_when_kwin_dbus_fails()
test_detects_kde5_when_virtualdesktopmanager_absent()
test_detects_kde6_when_virtualdesktopmanager_present()
test_detects_x11_session()
test_detects_wayland_session()
test_detect_backend_returns_kde_backend_on_kde_plasma()
```

### `TestKDEDesktopManagement` (14 tests)

```python
test_prepare_creates_second_desktop_when_only_one_exists()
test_prepare_reuses_existing_second_desktop()
test_prepare_renames_desktops_eldrun_and_hidden()
test_prepare_switches_to_desktop_zero()
test_create_desktop_calls_kde5_dbus_path()
test_create_desktop_calls_kde6_dbus_path()
test_create_desktop_returns_uuid_from_kde6_reply()
test_switch_desktop_kde5_uses_setCurrentDesktop()
test_switch_desktop_kde6_uses_setCurrent_with_uuid()
test_switch_desktop_x11_sends_ewmh_atom()
test_remove_desktop_kde5_uses_wmctrl()
test_remove_desktop_kde6_calls_removeDesktop()
test_cleanup_removes_hidden_desktop_if_created()
test_cleanup_does_not_remove_preexisting_desktop()
```

### `TestKDEActivateX11` (18 tests)

```python
test_activate_moves_current_windows_to_hidden()
test_activate_records_windows_for_old_project()
test_activate_restores_new_project_windows_from_hidden()
test_activate_excludes_eldrun_xid_from_move()
test_activate_excludes_protected_names()
test_activate_handles_no_previous_project()
test_activate_handles_no_tracked_windows_for_new_project()
test_activate_skips_unavailable_windows()
test_close_project_clears_tracking()
test_close_project_unknown_id_is_noop()
test_has_managed_windows_false_when_empty()
test_has_managed_windows_true_when_tracking_windows()
test_wm_class_filtering_matches_exact_name()
test_wm_class_filtering_matches_name_with_suffix()
test_wm_class_filtering_skips_mismatch()
test_cleanup_moves_all_hidden_windows_to_current()
test_cleanup_clears_project_windows()
test_cleanup_collapses_desktop_count_on_exit()
```

### `TestKDEActivateWayland` (20 tests)

```python
test_activate_wayland_enumerates_windows_via_script()
test_activate_wayland_moves_current_windows_to_hidden()
test_activate_wayland_excludes_eldrun_class()
test_activate_wayland_excludes_protected_names()
test_activate_wayland_restores_tracked_uuids_from_hidden()
test_activate_wayland_ignores_stale_uuids_no_longer_present()
test_move_window_wayland_generates_correct_js()
test_move_window_kde6_uses_dbus_window_interface()
test_run_kwin_script_loads_and_unloads()
test_run_kwin_script_cleans_up_temp_file_on_error()
test_run_kwin_script_kde5_sends_explicit_run_call()
test_run_kwin_script_kde6_skips_explicit_run_call()
test_enumerate_windows_parses_json_correctly()
test_enumerate_windows_handles_empty_list()
test_enumerate_windows_handles_malformed_json()
test_make_global_window_wayland_sets_on_all_desktops()
test_cleanup_wayland_moves_all_hidden_windows()
test_cleanup_wayland_clears_project_windows()
test_cleanup_wayland_removes_created_desktop()
test_close_project_removes_uuid_tracking()
```

### `TestKDEWindowRegistry` (8 tests)

```python
test_assign_window_to_project_records_xid_on_x11()
test_assign_window_to_project_records_uuid_on_wayland()
test_assign_same_window_to_different_project_replaces()
test_has_managed_windows_reflects_registry()
test_close_project_clears_all_its_windows()
test_close_project_preserves_other_projects()
test_cleanup_clears_all_projects()
test_get_windows_for_project_returns_correct_list()
```

### `TestDetectBackendKDE` (6 tests)

```python
test_detect_returns_kde_backend_when_kde_desktop_and_kwin_available()
test_detect_returns_kde_backend_on_wayland_kde()
test_detect_falls_through_to_cinnamon_when_kde_unavailable()
test_detect_falls_through_to_null_on_wayland_non_kde()
test_kde_backend_before_cinnamon_in_detection_order()
test_kde_detection_matches_plasma_in_desktop_string()
```

Total: **~74 tests** in `test_kde_kwin.py`, all passing without a live KDE session.

---

## Scope and limitations

| Feature | Supported | Notes |
|---------|-----------|-------|
| KDE 5 / X11 | ✅ Full | EWMH + KWin DBus 5 |
| KDE 6 / X11 | ✅ Full | EWMH + KWin DBus 6 |
| KDE 5 / Wayland | ⚠️ Partial | KWin scripting; window enumeration JSON write may need alternative transport |
| KDE 6 / Wayland | ✅ Full | KWin scripting + window DBus |
| KDE Activities | ❌ Out of scope | Eldrun uses virtual desktops, not Activities |
| Sticky global windows | ✅ | X11: `_NET_WM_STATE_STICKY`; Wayland: `onAllDesktops` |
| `python-dbus` / `dbus-python` | ❌ Not required | All DBus via `subprocess` + `dbus-send` |
| `qdbus6` / `qdbus` | ⚠️ Optional | Falls back to `dbus-send` if absent |

The one known rough edge on **KDE 5 Wayland** is writing the window list from
a KWin script to disk.  `XMLHttpRequest` file:// in KWin's JS runtime may be
sandboxed.  If so, the alternative is to use `callDBus` within the script to
send the JSON back via a custom DBus signal, and have the Python side listen
for it.  This is a known complexity that should be tested on a real KDE 5
Wayland session before the feature is declared stable.

---

## Implementation order

Work in this sequence to get a stable X11 backend before touching Wayland:

1. **Detection + version probe** — `is_available()`, `_detect_kde_version()`,
   `_detect_session()`.  No side effects.  Tests first.

2. **Desktop CRUD** — `prepare()`, `_create_desktop()`, `_rename_desktop()`,
   `_switch_to_desktop()`, `_remove_desktop()`, `cleanup()` skeleton.
   Tests mock `subprocess.run`.

3. **X11 window path** — `_activate_x11()` reusing Xlib EWMH helpers.
   At this point the backend is **feature-complete for KDE/X11**.

4. **Wire into `detect_backend()`** — 6-line change + integration test.
   Deployable to KDE/X11 users after live QA.

5. **Wayland scripting path** — `_run_kwin_script()`,
   `_enumerate_windows_wayland()`, `_move_window_wayland()`,
   `_activate_wayland()`.

6. **KDE 6 window DBus shortcut** — replace KWin script moves on KDE 6 + Wayland
   with direct `/org/kde/KWin/Windows/<uuid>` DBus calls.

7. **Live session QA** — test on actual KDE 5 X11, KDE 6 X11, KDE 6 Wayland.
   KDE 5 Wayland is best-effort.

8. **Version bump to `0.2.0`** — after QA sign-off.

---

## Manual QA checklist (live KDE session)

- [ ] `python3 -m unittest` passes before starting the session
- [ ] Eldrun starts; header shows correct version
- [ ] Opening two projects: switching between them hides/shows app windows
- [ ] A browser opened in project A disappears when switching to project B
- [ ] Switching back to project A restores the browser window
- [ ] Closing a project removes its windows from tracking
- [ ] Quitting Eldrun moves all hidden windows back to desktop 0
- [ ] Quitting Eldrun restores the original desktop count
- [ ] Global app windows (e.g. browser launched from toolbar) remain visible on all projects
- [ ] Wayland: above steps repeat on a Wayland session
- [ ] KDE 5 specific: version probe returns 5; desktop CRUD uses `/KWin` path
- [ ] KDE 6 specific: version probe returns 6; window moves use `/Windows/<uuid>`
