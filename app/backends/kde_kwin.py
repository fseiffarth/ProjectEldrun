"""KDE Plasma / KWin workspace backend.

Phase 6a: X11 support via Xlib EWMH + KWin DBus.
Phase 6b: Wayland support via KWin JS scripting + KDE 6 DBus fallback.

All Xlib imports are deferred to the methods that use them so the module
loads cleanly on headless or pure-Wayland systems.  DBus is accessed only
via `dbus-send` and `gdbus call` subprocesses — no python-dbus required.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile

from workspace_core import ProjectSpaceBackend

_CURRENT_DESK = 0   # virtual desktop 0 — current project
_HIDDEN_DESK  = 1   # virtual desktop 1 — background projects

# ── KWin JS templates ─────────────────────────────────────────────────────────

# Enumerate all windows + desktop UUIDs; writes JSON to __OUTPUT_PATH__
_JS_ENUMERATE = """
(function() {
    var state = {
        desktopUUIDs: workspace.desktops.map(function(d) { return d.id; }),
        windows: workspace.windowList().map(function(w) {
            return {
                uuid: w.internalId,
                cls:  w.resourceClass.toLowerCase(),
                desktops: w.desktops.map(function(d) { return d.id; }),
                onAllDesktops: w.onAllDesktops
            };
        })
    };
    var xhr = new XMLHttpRequest();
    xhr.open("PUT", "file://__OUTPUT_PATH__", false);
    xhr.send(JSON.stringify(state));
})();
"""

# Batch-move a set of windows to a target desktop index
_JS_MOVE = """
(function() {
    var uuids = __UUIDS__;
    var target = workspace.desktops[__DESK_IDX__];
    if (!target) return;
    var clients = workspace.windowList();
    for (var i = 0; i < clients.length; i++) {
        if (uuids.indexOf(clients[i].internalId) !== -1) {
            clients[i].desktops = [target];
        }
    }
})();
"""

# Switch the active virtual desktop
_JS_SWITCH = """
(function() {
    var d = workspace.desktops[__DESK_IDX__];
    if (d) workspace.currentDesktop = d;
})();
"""

# Make a set of windows sticky (visible on all desktops)
_JS_STICKY = """
(function() {
    var uuids = __UUIDS__;
    var clients = workspace.windowList();
    for (var i = 0; i < clients.length; i++) {
        if (uuids.indexOf(clients[i].internalId) !== -1) {
            clients[i].onAllDesktops = true;
        }
    }
})();
"""

# Make the Eldrun shell window sticky by its app ID (no UUID lookup needed)
_JS_STICKY_ELDRUN = """
(function() {
    workspace.windowList().forEach(function(w) {
        if (w.resourceClass === 'io.github.fseiffarth.eldrun') {
            w.onAllDesktops = true;
        }
    });
})();
"""


class KDEKWinBackend(ProjectSpaceBackend):
    """KDE Plasma adapter — X11 (Phase 6a) + Wayland (Phase 6b)."""

    def __init__(self):
        self._kde_version: int = 5
        self._session: str = "x11"           # refined in is_available()
        self._project_windows: dict[str, list] = {}  # project_id → [xid|uuid]
        self._desktop_uuids: list[str] = []   # index → UUID, refreshed per switch
        self._created_hidden_desktop: bool = False
        self._original_desktop_count: int = 1
        self._project_desktops: dict[str, str] = {}  # Wayland: project_id → desktop UUID
        self._root_desktop_uuid: str = ""             # Wayland: UUID at prepare() time

    # ── availability ──────────────────────────────────────────────────────────

    def is_available(self) -> bool:
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
            if r.returncode == 0:
                self._kde_version = self._detect_kde_version()
                self._session = (
                    "wayland" if os.environ.get("WAYLAND_DISPLAY") else "x11"
                )
                return True
        except Exception:
            pass
        return False

    # ── KDE version probe ─────────────────────────────────────────────────────

    def _detect_kde_version(self) -> int:
        """Return 6 if /VirtualDesktopManager is reachable, else 5."""
        try:
            r = subprocess.run(
                ["dbus-send", "--session", "--print-reply",
                 "--dest=org.kde.KWin", "/VirtualDesktopManager",
                 "org.freedesktop.DBus.Introspectable.Introspect"],
                capture_output=True, text=True, timeout=2,
            )
            if r.returncode == 0 and "VirtualDesktopManager" in r.stdout:
                return 6
        except Exception:
            pass
        return 5

    # ── DBus helpers ──────────────────────────────────────────────────────────

    def _kwin_dbus(self, path: str, method: str, *args: str) -> str | None:
        cmd = [
            "dbus-send", "--session", "--print-reply",
            "--dest=org.kde.KWin", path, method,
        ] + list(args)
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
            return r.stdout if r.returncode == 0 else None
        except Exception:
            return None

    @staticmethod
    def _parse_int(text: str | None, default: int = 0) -> int:
        if not text:
            return default
        for word in text.split():
            try:
                return int(word)
            except ValueError:
                continue
        return default

    @staticmethod
    def _parse_strings(dbus_text: str) -> list[str]:
        """Extract all quoted string values from dbus-send --print-reply output."""
        return re.findall(r'string "([^"]*)"', dbus_text)

    # ── virtual desktop management ────────────────────────────────────────────

    def _get_desktop_count(self) -> int:
        try:
            from Xlib import display as XD, X
            d = XD.Display()
            root = d.screen().root
            prop = root.get_full_property(
                d.intern_atom("_NET_NUMBER_OF_DESKTOPS"), X.AnyPropertyType
            )
            d.close()
            if prop and prop.value:
                return max(1, int(prop.value[0]))
        except Exception:
            pass
        # Wayland fallback: ask KWin
        if self._kde_version >= 6:
            out = self._kwin_dbus(
                "/VirtualDesktopManager",
                "org.freedesktop.DBus.Properties.Get",
                "string:org.kde.KWin.VirtualDesktopManager",
                "string:count",
            )
            return max(1, self._parse_int(out, default=1))
        return 1

    def _create_desktop(self, position: int, name: str) -> None:
        if self._kde_version >= 6:
            self._kwin_dbus(
                "/VirtualDesktopManager",
                "org.kde.KWin.VirtualDesktopManager.createDesktop",
                f"uint32:{position}",
                f"string:{name}",
            )
        else:
            try:
                current = self._get_desktop_count()
                subprocess.run(
                    ["wmctrl", "-n", str(current + 1)],
                    capture_output=True, timeout=3,
                )
            except Exception:
                pass

    def _switch_to_desktop(self, index: int) -> None:
        """Switch desktop via EWMH ClientMessage (X11)."""
        try:
            from Xlib import display as XD, X
            from Xlib.protocol import event as XEv
            d = XD.Display()
            root = d.screen().root
            atom = d.intern_atom("_NET_CURRENT_DESKTOP")
            ev = XEv.ClientMessage(
                window=root,
                client_type=atom,
                data=(32, [index, X.CurrentTime, 0, 0, 0]),
            )
            root.send_event(
                ev,
                event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask,
            )
            d.flush()
            d.close()
        except Exception:
            pass

    def _set_desktop_names(self, names: list[str]) -> None:
        """Write _NET_DESKTOP_NAMES via Xlib (works on X11; also via XWayland)."""
        try:
            from Xlib import display as XD
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

    def _collapse_desktop_count(self, desired: int) -> None:
        desired = max(1, desired)
        if self._kde_version >= 6:
            self._remove_extra_desktops_kde6(desired)
            return
        try:
            subprocess.run(
                ["wmctrl", "-n", str(desired)],
                capture_output=True, timeout=3,
            )
        except Exception:
            pass

    def _remove_extra_desktops_kde6(self, desired: int) -> None:
        desktop_uuids = self._get_desktop_uuids_kde6_dbus()
        for desktop_uuid in reversed(desktop_uuids[desired:]):
            self._kwin_dbus(
                "/VirtualDesktopManager",
                "org.kde.KWin.VirtualDesktopManager.removeDesktop",
                f"string:{desktop_uuid}",
            )

    # ── prepare / cleanup ─────────────────────────────────────────────────────

    def prepare(self) -> None:
        if self._session == "wayland":
            self._prepare_wayland()
        else:
            self._prepare_x11()

    def _prepare_x11(self) -> None:
        self._original_desktop_count = self._get_desktop_count()
        if self._original_desktop_count < 2:
            self._create_desktop(1, "Eldrun-Hidden")
            self._created_hidden_desktop = True
        self._set_desktop_names(["Eldrun", "Eldrun-Hidden"])
        self._switch_to_desktop(_CURRENT_DESK)

    def _prepare_wayland(self) -> None:
        uuids = self._get_all_desktop_uuids()
        self._root_desktop_uuid = uuids[0] if uuids else ""
        self._run_kwin_script(_JS_STICKY_ELDRUN)

    def cleanup(self) -> None:
        if self._session == "wayland":
            self._cleanup_wayland()
        else:
            self._cleanup_x11()
        self._project_windows.clear()
        if self._created_hidden_desktop:
            self._collapse_desktop_count(self._original_desktop_count)
            self._created_hidden_desktop = False

    def _cleanup_x11(self) -> None:
        try:
            from Xlib import display as XD
            d = XD.Display()
            tracked = self._tracked_window_ids()
            hidden = set(self._get_windows_on_desktop(d, _HIDDEN_DESK))
            for xid in tracked & hidden:
                self._move_window(d, xid, _CURRENT_DESK)
            d.close()
        except Exception:
            pass

    def _cleanup_wayland(self) -> None:
        if self._root_desktop_uuid:
            self._set_current_desktop_uuid(self._root_desktop_uuid)
        self._project_desktops.clear()

    def _tracked_window_ids(self) -> set:
        return {
            window_id
            for project_windows in self._project_windows.values()
            for window_id in project_windows
        }

    # ── X11 window operations (Xlib EWMH) ────────────────────────────────────

    @staticmethod
    def _get_windows_on_desktop(d, desktop_index: int) -> list[int]:
        try:
            from Xlib import X
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
                    if dp and dp.value and int(dp.value[0]) == desktop_index:
                        result.append(xid)
                except Exception:
                    continue
            return result
        except Exception:
            return []

    @staticmethod
    def _move_window(d, xid: int, target_index: int) -> bool:
        try:
            from Xlib import X
            from Xlib.protocol import event as XEv
            root = d.screen().root
            win = d.create_resource_object("window", xid)
            atom = d.intern_atom("_NET_WM_DESKTOP")
            ev = XEv.ClientMessage(
                window=win,
                client_type=atom,
                data=(32, [target_index, 2, 0, 0, 0]),
            )
            root.send_event(
                ev,
                event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask,
            )
            d.flush()
            return True
        except Exception:
            return False

    @staticmethod
    def _get_wm_classes(d, xids: list[int]) -> dict[int, list[str]]:
        result: dict[int, list[str]] = {}
        try:
            from Xlib import X
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
        except Exception:
            pass
        return result

    @staticmethod
    def _matches_protected(parts: list[str], protected: set[str]) -> bool:
        return any(
            any(p == name or p.startswith(name + "-") for p in parts)
            for name in protected
        )

    # ── Wayland: KWin scripting ───────────────────────────────────────────────

    def _run_kwin_script(self, js_code: str) -> bool:
        """Write js_code to a temp file, load it as a KWin script, then unload."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".js", prefix="eldrun_kwin_",
            delete=False, encoding="utf-8",
        ) as f:
            f.write(js_code)
            script_path = f.name
        try:
            name = f"eldrun_{os.getpid()}"
            out = self._kwin_dbus(
                "/Scripting",
                "org.kde.kwin.Scripting.loadScript",
                f"string:{script_path}",
                f"string:{name}",
            )
            if out is None:
                return False
            script_id = self._parse_int(out, default=-1)
            if script_id < 0:
                return False
            # KDE 5 needs an explicit start signal; KDE 6 auto-starts on load
            if self._kde_version < 6:
                self._kwin_dbus(
                    f"/Scripting/Script{script_id}",
                    "org.kde.kwin.Script.run",
                )
            self._kwin_dbus(
                "/Scripting",
                "org.kde.kwin.Scripting.unloadScript",
                f"string:{name}",
            )
            return True
        except Exception:
            return False
        finally:
            try:
                os.unlink(script_path)
            except OSError:
                pass

    def _enumerate_state_wayland(self) -> dict | None:
        """Run the enumerate KWin script and return parsed {desktopUUIDs, windows}.

        On success also refreshes self._desktop_uuids.
        Falls back to _enumerate_windows_kde6_dbus() on KDE 6 if the file write fails.
        """
        out_path = os.path.join(
            tempfile.gettempdir(), f"eldrun_kwin_{os.getpid()}.json"
        )
        js = _JS_ENUMERATE.replace("__OUTPUT_PATH__", out_path)
        self._run_kwin_script(js)
        state = self._read_json_file(out_path)
        if state is None and self._kde_version >= 6:
            state = self._enumerate_windows_kde6_dbus()
        if state and isinstance(state.get("desktopUUIDs"), list):
            self._desktop_uuids = state["desktopUUIDs"]
        return state

    @staticmethod
    def _read_json_file(path: str) -> dict | None:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else None
        except Exception:
            return None
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    def _move_windows_wayland(self, uuids: list[str], desktop_index: int) -> None:
        """Batch-move windows to desktop[desktop_index] via KWin script."""
        if not uuids:
            return
        uuids_js = json.dumps(uuids)
        js = (
            _JS_MOVE
            .replace("__UUIDS__", uuids_js)
            .replace("__DESK_IDX__", str(desktop_index))
        )
        if not self._run_kwin_script(js):
            # KDE 6 fallback: gdbus call per window
            if self._kde_version >= 6:
                desk_uuid = (
                    self._desktop_uuids[desktop_index]
                    if desktop_index < len(self._desktop_uuids)
                    else ""
                )
                if desk_uuid:
                    for uuid in uuids:
                        self._move_window_kde6_dbus(uuid, desk_uuid)

    def _move_window_kde6_dbus(self, window_uuid: str, desktop_uuid: str) -> None:
        """Move one window via gdbus call (KDE 6 Wayland fallback)."""
        try:
            subprocess.run(
                [
                    "gdbus", "call", "--session",
                    "--dest", "org.kde.KWin",
                    "--object-path", f"/org/kde/KWin/Windows/{window_uuid}",
                    "--method", "org.freedesktop.DBus.Properties.Set",
                    "org.kde.KWin.Window",
                    "desktops",
                    f"<as ['{desktop_uuid}']>",
                ],
                capture_output=True, timeout=3,
            )
        except Exception:
            pass

    def _switch_to_desktop_wayland(self, index: int) -> None:
        """Switch active virtual desktop by index via DBus (KWin script as fallback)."""
        uuids = self._get_all_desktop_uuids()
        if 0 <= index < len(uuids):
            self._set_current_desktop_uuid(uuids[index])
        else:
            js = _JS_SWITCH.replace("__DESK_IDX__", str(index))
            self._run_kwin_script(js)

    def _make_sticky_wayland(self, uuids: list[str]) -> None:
        """Mark windows as sticky (visible on all desktops) via KWin script."""
        if not uuids:
            return
        js = _JS_STICKY.replace("__UUIDS__", json.dumps(uuids))
        self._run_kwin_script(js)

    # ── Wayland: KDE 6 DBus enumeration fallback ──────────────────────────────

    def _enumerate_windows_kde6_dbus(self) -> dict | None:
        """Enumerate windows via /org/kde/KWin/Windows DBus (KDE 6 only).

        Returns the same {desktopUUIDs, windows} shape as the script approach,
        but desktopUUIDs is populated separately via _get_desktop_uuids_kde6_dbus().
        """
        # Get window UUID list from introspect XML
        out = self._kwin_dbus(
            "/org/kde/KWin/Windows",
            "org.freedesktop.DBus.Introspectable.Introspect",
        )
        if not out:
            return None
        window_uuids = self._parse_introspect_children(out)
        if not window_uuids:
            return None

        windows = []
        for uuid in window_uuids:
            path = f"/org/kde/KWin/Windows/{uuid}"
            iface = "string:org.kde.KWin.Window"

            cls_out = self._kwin_dbus(
                path, "org.freedesktop.DBus.Properties.Get",
                iface, "string:resourceClass",
            )
            cls = self._parse_strings(cls_out or "")
            cls_str = cls[0].lower() if cls else ""

            desks_out = self._kwin_dbus(
                path, "org.freedesktop.DBus.Properties.Get",
                iface, "string:desktops",
            )
            desk_uuids = self._parse_strings(desks_out or "")

            windows.append({
                "uuid": uuid,
                "cls": cls_str,
                "desktops": desk_uuids,
                "onAllDesktops": False,
            })

        desktop_uuids = self._get_desktop_uuids_kde6_dbus()
        return {"desktopUUIDs": desktop_uuids, "windows": windows}

    def _get_all_desktop_uuids(self) -> list[str]:
        """Return ordered desktop UUIDs from the VirtualDesktopManager.desktops property."""
        out = self._kwin_dbus(
            "/VirtualDesktopManager",
            "org.freedesktop.DBus.Properties.Get",
            "string:org.kde.KWin.VirtualDesktopManager",
            "string:desktops",
        )
        if not out:
            return []
        return re.findall(
            r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
            out,
        )

    def _get_desktop_uuids_kde6_dbus(self) -> list[str]:
        """Return ordered list of desktop UUIDs (delegates to _get_all_desktop_uuids)."""
        return self._get_all_desktop_uuids()

    def _set_current_desktop_uuid(self, uuid: str) -> None:
        """Switch the active virtual desktop by UUID via VirtualDesktopManager."""
        if not uuid:
            return
        self._kwin_dbus(
            "/VirtualDesktopManager",
            "org.freedesktop.DBus.Properties.Set",
            "string:org.kde.KWin.VirtualDesktopManager",
            "string:current",
            f"variant:string:{uuid}",
        )

    def _ensure_project_desktop(self, project_id: str, name: str) -> str:
        """Return (creating if needed) the UUID of this project's virtual desktop."""
        if project_id in self._project_desktops:
            return self._project_desktops[project_id]
        before = set(self._get_all_desktop_uuids())
        count = self._get_desktop_count()
        self._create_desktop(count, name)
        after = self._get_all_desktop_uuids()
        new_uuids = [u for u in after if u not in before]
        uuid = new_uuids[0] if new_uuids else ""
        if uuid:
            self._project_desktops[project_id] = uuid
        return uuid

    @staticmethod
    def _parse_introspect_children(xml_text: str) -> list[str]:
        """Return node name attributes from a DBus Introspect XML response."""
        try:
            import xml.etree.ElementTree as ET
            root = ET.fromstring(xml_text)
            return [n.get("name", "") for n in root.findall("node") if n.get("name")]
        except Exception:
            # Fallback: regex extraction
            return re.findall(r'<node\s+name="([^"]+)"\s*/>', xml_text)

    # ── Wayland: protected window check ──────────────────────────────────────

    @staticmethod
    def _is_protected_wayland(cls: str, protected: set[str]) -> bool:
        return any(
            cls == name or cls.startswith(name + "-")
            for name in protected
        )

    # ── project activation ────────────────────────────────────────────────────

    def close_project(self, project_id: str) -> None:
        self._project_windows.pop(project_id, None)

    def activate_project(
        self,
        project_id: str,
        previous_project_id: str | None,
        eldrun_xid: int | None = None,
        protected_names: set[str] | None = None,
    ) -> None:
        if self._session == "wayland":
            self._activate_wayland(
                project_id, previous_project_id, protected_names or set()
            )
        else:
            try:
                from Xlib import display as XD
                d = XD.Display()
                self._do_switch_x11(d, project_id, previous_project_id,
                                    eldrun_xid, protected_names or set())
                d.close()
            except Exception:
                pass

    def _do_switch_x11(
        self, d, new_id: str, old_id: str | None,
        eldrun_xid: int | None, protected: set[str],
    ) -> None:
        exclude: set[int] = {eldrun_xid} if eldrun_xid is not None else set()

        ws0_all = self._get_windows_on_desktop(d, _CURRENT_DESK)
        class_map = self._get_wm_classes(d, ws0_all)
        ws0_moveable: list[int] = [
            xid for xid in ws0_all
            if xid not in exclude
            and not (protected and self._matches_protected(
                class_map.get(xid, []), protected
            ))
        ]

        if old_id is not None:
            for xid in ws0_moveable:
                self._move_window(d, xid, _HIDDEN_DESK)
            self._project_windows[old_id] = ws0_moveable

        ws1_all = set(self._get_windows_on_desktop(d, _HIDDEN_DESK))
        if protected and ws1_all:
            class_map1 = self._get_wm_classes(d, list(ws1_all))
            for xid in list(ws1_all):
                if self._matches_protected(class_map1.get(xid, []), protected):
                    self._move_window(d, xid, _CURRENT_DESK)
                    ws1_all.discard(xid)

        for xid in set(self._project_windows.get(new_id, [])) & ws1_all:
            self._move_window(d, xid, _CURRENT_DESK)

    def _activate_wayland(
        self, new_id: str, old_id: str | None, protected: set[str]
    ) -> None:
        """Switch to new_id's dedicated virtual desktop (per-project model).

        Each project gets its own virtual desktop created on first activation.
        KDE handles the visual show/hide automatically — no window enumeration needed.
        Eldrun itself is made sticky in _prepare_wayland so it stays visible.
        """
        uuid = self._ensure_project_desktop(new_id, new_id)
        if uuid:
            self._set_current_desktop_uuid(uuid)

    def make_global_window(self, window_id: int) -> None:
        if self._session == "wayland":
            # window_id is meaningful as UUID only if obtained from KWin;
            # best-effort sticky via scripting using the int as string UUID
            self._make_sticky_wayland([str(window_id)])
        else:
            try:
                from Xlib import display as XD, X
                from Xlib.protocol import event as XEv
                d = XD.Display()
                root = d.screen().root
                win = d.create_resource_object("window", window_id)
                atom_state = d.intern_atom("_NET_WM_STATE")
                atom_sticky = d.intern_atom("_NET_WM_STATE_STICKY")
                ev = XEv.ClientMessage(
                    window=win,
                    client_type=atom_state,
                    data=(32, [1, atom_sticky, 0, 0, 0]),
                )
                root.send_event(
                    ev,
                    event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask,
                )
                d.flush()
                d.close()
            except Exception:
                pass

    def has_managed_windows(self) -> bool:
        return bool(self._project_windows)
