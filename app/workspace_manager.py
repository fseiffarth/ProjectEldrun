"""
WorkspaceManager — per-project workspace reconciliation.

Design:
  - Eldrun's window is made sticky so it appears on all desktops.
  - Each visible project gets its own workspace, starting at desktop index 0.
  - The root terminal is only an Eldrun page; it does not own a workspace.
  - Backend is auto-detected: Cinnamon DBus → GNOME Shell DBus → wmctrl.
  - Xlib EWMH is used for state reads across all backends.
  - Assignments are in-memory only (no persistence) — rebuilt fresh each launch.
"""

import json
import subprocess

from Xlib import display as XD, X


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


def _ewmh_find_desktop_by_name(name: str) -> int | None:
    names = _ewmh_get_desktop_names()
    for idx, n in enumerate(names):
        if n == name:
            return idx
    return None


def _ewmh_switch(idx: int):
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
    except Exception:
        pass


def _xlib_set_desktop_name(idx: int, name: str):
    """Write a single desktop name into _NET_DESKTOP_NAMES (UTF-8, null-separated)."""
    try:
        d = XD.Display()
        root = d.screen().root
        atom = d.intern_atom("_NET_DESKTOP_NAMES")
        utf8 = d.intern_atom("UTF8_STRING")
        prop = root.get_full_property(atom, utf8)
        if prop and prop.value:
            raw = bytes(prop.value)
            names = raw.split(b"\x00")
        else:
            names = []
        while len(names) <= idx:
            names.append(b"")
        names[idx] = name.encode("utf-8")
        root.change_property(atom, utf8, 8, b"\x00".join(names) + b"\x00")
        d.flush()
        d.close()
    except Exception:
        pass


def _xlib_set_desktop_names(names: list[str]):
    """Write all desktop names into _NET_DESKTOP_NAMES."""
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


def _wmctrl_switch(idx: int):
    try:
        subprocess.run(["wmctrl", "-s", str(idx)], capture_output=True, timeout=3)
    except Exception:
        pass


# ── WorkspaceManager ──────────────────────────────────────────────────────────

class WorkspaceManager:
    def __init__(self):
        self._assignments: dict[str, int] = {}   # project_id → cached workspace_idx
        self._names: dict[str, str] = {}          # project_id → workspace name
        self._backend: str | None = None          # "cinnamon" | "gnome" | "wmctrl" | "none"

    def _detect_backend(self) -> str:
        if _cinnamon_eval("String(global.workspace_manager.get_n_workspaces())") is not None:
            return "cinnamon"
        if _gnome_eval("String(global.workspace_manager.get_n_workspaces())") is not None:
            return "gnome"
        if _wmctrl_available():
            return "wmctrl"
        return "none"

    def is_available(self) -> bool:
        if self._backend is None:
            self._backend = self._detect_backend()
        return self._backend != "none"

    def make_eldrun_sticky(self, xid: int):
        """Set _NET_WM_STATE_STICKY on the Eldrun window so it appears on all desktops."""
        if self.is_available() and self._backend == "cinnamon":
            self._wm_eval(
                "const xid = " + str(int(xid)) + ";"
                "for (const actor of global.get_window_actors()) {"
                "  const win = actor.meta_window || "
                "    (actor.get_meta_window ? actor.get_meta_window() : null);"
                "  if (!win) continue;"
                "  const wxid = global.screen.get_xwindow_for_window(win);"
                "  if (wxid === xid) { win.stick(); break; }"
                "}"
            )
        try:
            from Xlib.protocol import event as XEv
            d = XD.Display()
            root = d.screen().root
            win = d.create_resource_object("window", xid)
            atom_state = d.intern_atom("_NET_WM_STATE")
            atom_sticky = d.intern_atom("_NET_WM_STATE_STICKY")
            ev = XEv.ClientMessage(
                window=win,
                client_type=atom_state,
                data=(32, [1, atom_sticky, 0, 0, 0]),  # 1 = _NET_WM_STATE_ADD
            )
            root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
            d.flush()
            d.close()
        except Exception:
            pass

    def _wm_eval(self, js: str) -> str | None:
        if self._backend == "cinnamon":
            return _cinnamon_eval(js)
        if self._backend == "gnome":
            return _gnome_eval(js)
        return None

    def _workspace_name(self, project_id: str, name: str = "") -> str:
        return name.strip() or f"eldrun-{project_id[:8]}"

    def _workspace_count(self) -> int:
        if self._backend in ("cinnamon", "gnome"):
            result = self._wm_eval("String(global.workspace_manager.get_n_workspaces())")
            try:
                if result is not None:
                    return max(1, int(result))
            except ValueError:
                pass
        return _ewmh_get_count()

    def _ensure_workspace_count(self, desired: int):
        desired = max(1, desired)
        if not self.is_available():
            return

        if self._backend in ("cinnamon", "gnome"):
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

        _xlib_set_desktop_names(names)

    def reconcile(self, projects: list[dict]) -> dict[str, int]:
        """Make Cinnamon workspaces match the current visible project list."""
        self._assignments.clear()
        self._names.clear()

        if not self.is_available():
            return {}

        self._ensure_workspace_count(len(projects))

        names: list[str] = []
        for idx, project in enumerate(projects):
            project_id = project["id"]
            ws_name = self._workspace_name(project_id, str(project.get("name", "")))
            self._assignments[project_id] = idx
            self._names[project_id] = ws_name
            names.append(ws_name)

        if names:
            self._set_workspace_names(names)
        return dict(self._assignments)

    def allocate(self, project_id: str, name: str = "") -> int:
        """Compatibility wrapper for older call sites."""
        if not self.is_available():
            return 0
        projects = []
        found = False
        for pid in self._assignments:
            project_name = name if pid == project_id else self._names.get(pid, "")
            projects.append({"id": pid, "name": project_name})
            found = found or pid == project_id
        if not found:
            projects.append({"id": project_id, "name": name})
        self.reconcile(projects)
        return self._assignments.get(project_id, 0)

    def activate(self, project_id: str):
        """Switch to the workspace assigned to this project."""
        if not self.is_available():
            return
        idx = self._assignments.get(project_id)
        if idx is None:
            return
        if self._backend in ("cinnamon", "gnome"):
            result = self._wm_eval(
                f"global.workspace_manager.get_workspace_by_index({idx})"
                f".activate(global.get_current_time())"
            )
            if result is None:
                _ewmh_switch(idx)
        else:
            _wmctrl_switch(idx)

    def release(self, project_id: str):
        """Remove the workspace assigned to this project."""
        self._assignments.pop(project_id, None)
        self._names.pop(project_id, None)

    def switch_to_first(self):
        """Switch to workspace index 0 regardless of current position."""
        if not self.is_available():
            return
        if self._backend in ("cinnamon", "gnome"):
            result = self._wm_eval(
                "global.workspace_manager.get_workspace_by_index(0)"
                ".activate(global.get_current_time())"
            )
            if result is None:
                _ewmh_switch(0)
        else:
            _wmctrl_switch(0)

    def release_all(self):
        """Clear project assignments and leave a single workspace behind."""
        self.switch_to_first()
        self._assignments.clear()
        self._names.clear()
        if self.is_available():
            self._ensure_workspace_count(1)

    def get_assignment(self, project_id: str) -> int | None:
        return self._assignments.get(project_id)
