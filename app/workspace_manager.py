"""
WorkspaceManager — per-project Cinnamon workspace allocation.

Design:
  - Eldrun's window is made sticky so it appears on all desktops.
  - Each active project gets its own workspace (index >= 1).
  - Workspace 0 is the root workspace for non-project windows.
  - Cinnamon DBus Eval is used for mutations; Xlib EWMH for state reads.
  - Assignments are in-memory only (no persistence) — rebuilt fresh each launch.
"""

import subprocess

from Xlib import display as XD, X


def _cinnamon_eval(js: str) -> str | None:
    try:
        r = subprocess.run(
            [
                "dbus-send", "--session", "--print-reply",
                "--dest=org.Cinnamon", "/org/Cinnamon",
                "org.Cinnamon.Eval", f"string:{js}",
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


def _ewmh_switch(idx: int):
    """Fallback desktop switch via EWMH ClientMessage."""
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


class WorkspaceManager:
    def __init__(self):
        self._assignments: dict[str, int] = {}  # project_id → workspace_idx
        self._available: bool | None = None

    def is_available(self) -> bool:
        if self._available is None:
            result = _cinnamon_eval("global.workspace_manager.get_n_workspaces()")
            self._available = result is not None
        return self._available

    def make_eldrun_sticky(self, xid: int):
        """Set _NET_WM_STATE_STICKY on the Eldrun window so it appears on all desktops."""
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

    def allocate(self, project_id: str, name: str = "") -> int:
        """Append a new workspace for this project. Returns its index."""
        if not self.is_available():
            return 0
        if project_id in self._assignments:
            return self._assignments[project_id]

        _cinnamon_eval(
            "global.workspace_manager.append_new_workspace(false, global.get_current_time())"
        )
        idx = _ewmh_get_count() - 1

        if name:
            safe = name.replace('"', "'")
            _cinnamon_eval(
                f'global.workspace_manager.get_workspace_by_index({idx})'
                f'.change_workspace_name("{safe}")'
            )

        self._assignments[project_id] = idx
        return idx

    def activate(self, project_id: str):
        """Switch to the workspace assigned to this project."""
        idx = self._assignments.get(project_id)
        if idx is None or not self.is_available():
            return
        result = _cinnamon_eval(
            f"global.workspace_manager.get_workspace_by_index({idx})"
            f".activate(global.get_current_time())"
        )
        if result is None:
            _ewmh_switch(idx)

    def release(self, project_id: str):
        """Remove the workspace assigned to this project and reindex higher assignments."""
        idx = self._assignments.pop(project_id, None)
        if idx is None or not self.is_available():
            return
        _cinnamon_eval(
            f"let ws=global.workspace_manager.get_workspace_by_index({idx});"
            f"global.workspace_manager.remove_workspace(ws, global.get_current_time())"
        )
        # Shift down assignments for workspaces that were above the removed one
        for pid in list(self._assignments):
            if self._assignments[pid] > idx:
                self._assignments[pid] -= 1

    def release_all(self):
        """Remove all project workspaces. Called on shutdown or when feature is disabled."""
        if not self._assignments:
            return
        # Remove in reverse order so indices stay valid until the last removal
        sorted_ids = sorted(
            list(self._assignments.keys()),
            key=lambda pid: self._assignments[pid],
            reverse=True,
        )
        for project_id in sorted_ids:
            self.release(project_id)

    def get_assignment(self, project_id: str) -> int | None:
        return self._assignments.get(project_id)
