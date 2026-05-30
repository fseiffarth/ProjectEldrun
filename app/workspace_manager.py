"""
WorkspaceManager — two-workspace model for project isolation.

Design:
  - Exactly 2 workspaces are used:
      Workspace 0 ("Eldrun")        — current project's apps + Eldrun itself
      Workspace 1 ("Eldrun-Hidden") — pool holding all other active projects' apps
  - When a project becomes current, its tracked windows move from ws1→ws0.
    All previous current-project windows move from ws0→ws1.
  - Eldrun is NOT sticky; it simply lives on workspace 0.
  - Global app windows (sticky / _NET_WM_DESKTOP = 0xFFFFFFFF) are never moved.
  - Backend is auto-detected: Cinnamon DBus → GNOME Shell DBus → wmctrl.
  - Window tracking is in-memory only (XIDs don't survive restarts).
"""

import ast
import json
import subprocess
import time

from Xlib import display as XD, X

_CURRENT_WS = 0   # default workspace: current project
_HIDDEN_WS  = 1   # hidden workspace:  background project apps


# ── DBus eval helpers ─────────────────────────────────────────────────────────

def _dbus_eval(dest: str, path: str, iface_method: str, js: str) -> str | None:
    try:
        r = subprocess.run(
            [
                "dbus-send", "--session", "--print-reply",
                f"--dest={dest}", path,
                iface_method, f"string:{js}",
            ],
            capture_output=True, text=True, timeout=3,
        )
        if r.returncode == 0 and "boolean true" in r.stdout:
            for line in r.stdout.splitlines():
                line = line.strip()
                if line.startswith('string "'):
                    return line[8:].rstrip('"')
                if line.startswith("string "):
                    return line[7:]
    except Exception:
        pass
    return None


def _cinnamon_eval(js: str) -> str | None:
    return _dbus_eval(
        "org.Cinnamon", "/org/Cinnamon", "org.Cinnamon.Eval", js
    )


def _gnome_eval(js: str) -> str | None:
    return _dbus_eval(
        "org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell.Eval", js
    )


def _js_string(value: str) -> str:
    return json.dumps(value)


# ── EWMH helpers ──────────────────────────────────────────────────────────────

def _ewmh_get_count() -> int:
    try:
        d = XD.Display()
        root = d.screen().root
        prop = root.get_full_property(d.intern_atom("_NET_NUMBER_OF_DESKTOPS"), X.AnyPropertyType)
        d.close()
        if prop and prop.value:
            return int(prop.value[0])
    except Exception:
        pass
    return 1


def _ewmh_get_current_desktop() -> int | None:
    try:
        d = XD.Display()
        root = d.screen().root
        prop = root.get_full_property(d.intern_atom("_NET_CURRENT_DESKTOP"), X.AnyPropertyType)
        d.close()
        if prop and prop.value:
            return int(prop.value[0])
    except Exception:
        pass
    return None


def _ewmh_get_desktop_names() -> list[str]:
    try:
        d = XD.Display()
        root = d.screen().root
        atom = d.intern_atom("_NET_DESKTOP_NAMES")
        utf8 = d.intern_atom("UTF8_STRING")
        prop = root.get_full_property(atom, utf8)
        d.close()
        if prop and prop.value:
            parts = bytes(prop.value).split(b"\x00")
            return [p.decode("utf-8", errors="replace") for p in parts if p]
    except Exception:
        pass
    return []


def _ewmh_switch(idx: int) -> bool:
    try:
        from Xlib.protocol import event as XEv
        d = XD.Display()
        root = d.screen().root
        atom = d.intern_atom("_NET_CURRENT_DESKTOP")
        ev = XEv.ClientMessage(
            window=root,
            client_type=atom,
            data=(32, [idx, X.CurrentTime, 0, 0, 0]),
        )
        root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
        d.flush()
        d.close()
        return True
    except Exception:
        return False


def _xlib_set_desktop_names(names: list[str]):
    try:
        d = XD.Display()
        root = d.screen().root
        atom = d.intern_atom("_NET_DESKTOP_NAMES")
        utf8 = d.intern_atom("UTF8_STRING")
        raw = b"\x00".join(n.encode("utf-8") for n in names) + b"\x00"
        root.change_property(atom, utf8, 8, raw)
        d.flush()
        d.close()
    except Exception:
        pass


# ── wmctrl helpers ────────────────────────────────────────────────────────────

def _wmctrl_available() -> bool:
    try:
        r = subprocess.run(["wmctrl", "-l"], capture_output=True, timeout=3)
        return r.returncode == 0
    except Exception:
        return False


def _wmctrl_set_n_desktops(n: int):
    try:
        subprocess.run(["wmctrl", "-n", str(n)], capture_output=True, timeout=3)
    except Exception:
        pass


def _wmctrl_switch(idx: int) -> bool:
    try:
        r = subprocess.run(["wmctrl", "-s", str(idx)], capture_output=True, timeout=3)
        return r.returncode == 0
    except Exception:
        return False


# ── GNOME gsettings helpers ───────────────────────────────────────────────────

def _gnome_gsettings_available() -> bool:
    try:
        r = subprocess.run(
            ["gsettings", "get", "org.gnome.mutter", "dynamic-workspaces"],
            capture_output=True, text=True, timeout=3,
        )
        return r.returncode == 0
    except Exception:
        return False


def _gnome_get_dynamic_workspaces() -> bool:
    try:
        r = subprocess.run(
            ["gsettings", "get", "org.gnome.mutter", "dynamic-workspaces"],
            capture_output=True, text=True, timeout=3,
        )
        return r.returncode == 0 and r.stdout.strip() == "true"
    except Exception:
        return True


def _gnome_set_dynamic_workspaces(enabled: bool):
    try:
        subprocess.run(
            ["gsettings", "set", "org.gnome.mutter", "dynamic-workspaces",
             "true" if enabled else "false"],
            capture_output=True, timeout=3,
        )
    except Exception:
        pass


def _gnome_get_workspace_count() -> int:
    try:
        r = subprocess.run(
            ["gsettings", "get", "org.gnome.desktop.wm.preferences", "num-workspaces"],
            capture_output=True, text=True, timeout=3,
        )
        if r.returncode == 0:
            return max(1, int(r.stdout.strip()))
    except Exception:
        pass
    return _ewmh_get_count()


def _gnome_set_workspace_count(n: int):
    try:
        subprocess.run(
            ["gsettings", "set", "org.gnome.desktop.wm.preferences", "num-workspaces", str(n)],
            capture_output=True, timeout=3,
        )
    except Exception:
        pass


def _gnome_get_workspace_names() -> list[str]:
    try:
        r = subprocess.run(
            ["gsettings", "get", "org.gnome.desktop.wm.preferences", "workspace-names"],
            capture_output=True, text=True, timeout=3,
        )
        if r.returncode == 0:
            result = ast.literal_eval(r.stdout.strip())
            if isinstance(result, list):
                return [str(x) for x in result]
    except Exception:
        pass
    return []


def _gnome_set_workspace_names(names: list[str]):
    escaped = [n.replace("\\", "\\\\").replace("'", "\\'") for n in names]
    value = "[" + ", ".join(f"'{n}'" for n in escaped) + "]"
    try:
        subprocess.run(
            ["gsettings", "set", "org.gnome.desktop.wm.preferences", "workspace-names", value],
            capture_output=True, timeout=3,
        )
    except Exception:
        pass


# ── WorkspaceManager ──────────────────────────────────────────────────────────

class WorkspaceManager:
    def __init__(self):
        self._backend: str | None = None
        self._project_windows: dict[str, list[int]] = {}  # project_id → [xid, ...]
        self._gnome_original: dict | None = None

    def _detect_backend(self) -> str:
        if _cinnamon_eval("String(global.workspace_manager.get_n_workspaces())") is not None:
            return "cinnamon"
        if _gnome_gsettings_available():
            return "gnome"
        if _wmctrl_available():
            return "wmctrl"
        return "none"

    def is_available(self) -> bool:
        if self._backend is None:
            self._backend = self._detect_backend()
        return self._backend != "none"

    def _wm_eval(self, js: str) -> str | None:
        if self._backend == "cinnamon":
            return _cinnamon_eval(js)
        if self._backend == "gnome":
            return _gnome_eval(js)
        return None

    def _workspace_count(self) -> int:
        if self._backend == "cinnamon":
            result = self._wm_eval("String(global.workspace_manager.get_n_workspaces())")
            try:
                if result is not None:
                    return max(1, int(result))
            except ValueError:
                pass
        if self._backend == "gnome":
            return _gnome_get_workspace_count()
        return _ewmh_get_count()

    def _ensure_workspace_count(self, desired: int):
        desired = max(1, desired)
        if not self.is_available():
            return

        if self._backend == "cinnamon":
            current = self._workspace_count()
            while current < desired:
                self._wm_eval(
                    "global.workspace_manager.append_new_workspace(false, global.get_current_time())"
                )
                current += 1
            while current > desired:
                idx = current - 1
                self._wm_eval(
                    f"let ws=global.workspace_manager.get_workspace_by_index({idx});"
                    "if (ws) global.workspace_manager.remove_workspace(ws, global.get_current_time())"
                )
                current -= 1
            return

        if self._backend == "gnome":
            if self._gnome_original is None:
                self._gnome_original = {
                    "dynamic": _gnome_get_dynamic_workspaces(),
                    "count": _gnome_get_workspace_count(),
                    "names": _gnome_get_workspace_names(),
                }
            if self._gnome_original["dynamic"]:
                _gnome_set_dynamic_workspaces(False)
            _gnome_set_workspace_count(desired)
            return

        current = self._workspace_count()
        if current != desired:
            _wmctrl_set_n_desktops(desired)

    def _set_workspace_names(self, names: list[str]):
        if self._backend == "cinnamon":
            for idx, name in enumerate(names):
                self._wm_eval(
                    "const Main = imports.ui.main;"
                    f"Main.setWorkspaceName({idx}, {_js_string(name)})"
                )
            return
        if self._backend == "gnome":
            _gnome_set_workspace_names(names)
            return
        _xlib_set_desktop_names(names)

    # ── window enumeration ────────────────────────────────────────────────────

    def _get_windows_on_desktop(self, idx: int) -> list[int]:
        """Return non-sticky window XIDs currently on the given desktop index."""
        try:
            d = XD.Display()
            root = d.screen().root
            client_atom = d.intern_atom("_NET_CLIENT_LIST")
            desktop_atom = d.intern_atom("_NET_WM_DESKTOP")
            prop = root.get_full_property(client_atom, X.AnyPropertyType)
            xids = list(prop.value) if (prop and prop.value) else []
            result = []
            for xid in xids:
                try:
                    win = d.create_resource_object("window", xid)
                    dp = win.get_full_property(desktop_atom, X.AnyPropertyType)
                    if dp and dp.value:
                        desktop = int(dp.value[0])
                        if desktop == idx:  # excludes 0xFFFFFFFF (sticky) and other desktops
                            result.append(xid)
                except Exception:
                    continue
            d.close()
            return result
        except Exception:
            return []

    def _move_window_to_desktop(self, xid: int, target_idx: int) -> bool:
        """Move a window to the given desktop index via EWMH ClientMessage."""
        try:
            from Xlib.protocol import event as XEv
            d = XD.Display()
            root = d.screen().root
            win = d.create_resource_object("window", xid)
            atom = d.intern_atom("_NET_WM_DESKTOP")
            ev = XEv.ClientMessage(
                window=win,
                client_type=atom,
                data=(32, [target_idx, 2, 0, 0, 0]),  # 2 = source: pager/program
            )
            root.send_event(
                ev,
                event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask,
            )
            d.flush()
            d.close()
            return True
        except Exception:
            return False

    # ── WM_CLASS helpers ─────────────────────────────────────────────────────

    def _batch_get_wm_class(self, xids: list[int]) -> dict[int, list[str]]:
        """Return {xid: [lowercase WM_CLASS parts]} for the given XIDs."""
        result: dict[int, list[str]] = {}
        if not xids:
            return result
        try:
            d = XD.Display()
            atom = d.intern_atom("WM_CLASS")
            for xid in xids:
                try:
                    win = d.create_resource_object("window", xid)
                    prop = win.get_full_property(atom, X.AnyPropertyType)
                    if prop and prop.value:
                        raw = prop.value
                        if isinstance(raw, bytes):
                            parts = [p.decode("utf-8", errors="replace").lower()
                                     for p in raw.split(b"\x00") if p]
                        else:
                            parts = [p.lower() for p in str(raw).split("\x00") if p]
                        result[xid] = parts
                except Exception:
                    continue
            d.close()
        except Exception:
            pass
        return result

    @staticmethod
    def _matches_protected(parts: list[str], protected_names: set[str]) -> bool:
        return any(
            any(p == name or p.startswith(name + "-") for p in parts)
            for name in protected_names
        )

    # ── two-workspace model ───────────────────────────────────────────────────

    def setup_two_workspaces(self) -> bool:
        """Ensure exactly 2 named workspaces (current + hidden) exist."""
        if not self.is_available():
            return False
        current_count = self._workspace_count()
        if current_count < 2:
            self._ensure_workspace_count(2)
        self._set_workspace_names(["Eldrun", "Eldrun-Hidden"])
        return True

    def switch_project(
        self,
        old_project_id: str | None,
        new_project_id: str,
        eldrun_xid: int | None,
        protected_names: set[str] | None = None,
    ) -> None:
        """Move windows between workspace 0 (current) and workspace 1 (hidden).

        All non-sticky, non-Eldrun, non-protected windows on workspace 0 are moved
        to workspace 1 and recorded as old_project_id's windows.  Previously recorded
        windows for new_project_id that still exist on workspace 1 are restored to
        workspace 0.  Any protected global-app windows that ended up on workspace 1
        are rescued back to workspace 0 regardless of which project is switching.
        """
        if not self.is_available():
            return

        exclude: set[int] = set()
        if eldrun_xid is not None:
            exclude.add(eldrun_xid)

        # Collect ws0 windows, skipping Eldrun and global apps
        ws0_all = self._get_windows_on_desktop(_CURRENT_WS)
        if protected_names:
            class_map0 = self._batch_get_wm_class(ws0_all)
        ws0_windows = []
        for xid in ws0_all:
            if xid in exclude:
                continue
            if protected_names:
                parts = class_map0.get(xid, [])
                if self._matches_protected(parts, protected_names):
                    continue
            ws0_windows.append(xid)

        for xid in ws0_windows:
            self._move_window_to_desktop(xid, _HIDDEN_WS)
        if old_project_id is not None:
            self._project_windows[old_project_id] = ws0_windows

        # Restore new project's windows from hidden workspace;
        # also rescue any global-app windows that drifted to ws1
        ws1_windows = set(self._get_windows_on_desktop(_HIDDEN_WS))

        if protected_names and ws1_windows:
            class_map1 = self._batch_get_wm_class(list(ws1_windows))
            for xid in list(ws1_windows):
                if self._matches_protected(class_map1.get(xid, []), protected_names):
                    self._move_window_to_desktop(xid, _CURRENT_WS)
                    ws1_windows.discard(xid)

        target_xids = set(self._project_windows.get(new_project_id, []))
        if target_xids:
            to_restore = target_xids & ws1_windows
            for xid in to_restore:
                self._move_window_to_desktop(xid, _CURRENT_WS)

    def on_project_closed(self, project_id: str) -> None:
        """Clear window tracking when a project is closed."""
        self._project_windows.pop(project_id, None)

    def current_desktop(self) -> int | None:
        return _ewmh_get_current_desktop()

    def release_all(self):
        """Move all hidden windows back to workspace 0 and restore workspace state."""
        if not self.is_available():
            return
        # Bring everything back to workspace 0 before exiting
        for xid in self._get_windows_on_desktop(_HIDDEN_WS):
            self._move_window_to_desktop(xid, _CURRENT_WS)
        self._project_windows.clear()
        # Restore gnome settings or collapse back to 1 workspace
        if self._backend == "gnome" and self._gnome_original is not None:
            orig = self._gnome_original
            self._gnome_original = None
            _gnome_set_workspace_count(max(1, orig["count"]))
            _gnome_set_workspace_names(orig["names"])
            if orig["dynamic"]:
                _gnome_set_dynamic_workspaces(True)
        elif self.is_available():
            self._ensure_workspace_count(1)

    def close_workspace_apps(self, eldrun_xid: int | None = None):
        """Send _NET_CLOSE_WINDOW to all apps on the hidden workspace."""
        try:
            from Xlib.protocol import event as XEv
            d = XD.Display()
            root = d.screen().root
            close_atom = d.intern_atom("_NET_CLOSE_WINDOW")
            for xid in self._get_windows_on_desktop(_HIDDEN_WS):
                if eldrun_xid is not None and xid == eldrun_xid:
                    continue
                try:
                    win = d.create_resource_object("window", xid)
                    ev = XEv.ClientMessage(
                        window=win,
                        client_type=close_atom,
                        data=(32, [X.CurrentTime, 2, 0, 0, 0]),
                    )
                    root.send_event(
                        ev,
                        event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask,
                    )
                except Exception:
                    continue
            d.flush()
            d.close()
        except Exception:
            pass
