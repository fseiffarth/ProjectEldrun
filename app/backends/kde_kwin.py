"""KDE Plasma / KWin workspace backend — Phase 6a (X11 only).

Uses KWin DBus for virtual desktop management and EWMH/Xlib for window
operations.  All Xlib imports are deferred to the methods that need them
so the module loads cleanly on systems without a display.

Phase 6b will add the Wayland path via KWin scripting and the
/org/kde/KWin/Windows/<uuid> DBus interface.
"""

import subprocess

from workspace_core import ProjectSpaceBackend

_CURRENT_DESK = 0   # desktop 0 — current project
_HIDDEN_DESK  = 1   # desktop 1 — background projects


class KDEKWinBackend(ProjectSpaceBackend):
    """KDE Plasma adapter for project workspace isolation.

    Phase 6a scope: X11 sessions only.  is_available() returns False on
    Wayland so detect_backend() falls through to NullBackend there.
    """

    def __init__(self):
        self._kde_version: int = 5          # refined in is_available()
        self._project_windows: dict[str, list[int]] = {}  # project_id → [xid]
        self._created_hidden_desktop: bool = False
        self._original_desktop_count: int = 1

    # ── availability ──────────────────────────────────────────────────────────

    def is_available(self) -> bool:
        import os
        # Wayland support is Phase 6b
        if os.environ.get("WAYLAND_DISPLAY"):
            return False
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
                return True
        except Exception:
            pass
        return False

    # ── KDE version probe ─────────────────────────────────────────────────────

    def _detect_kde_version(self) -> int:
        """Return 6 if /VirtualDesktopManager is available, else 5."""
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
        """Call a method on org.kde.KWin and return reply stdout, or None."""
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
        """Extract the first integer from dbus-send --print-reply output."""
        if not text:
            return default
        for word in text.split():
            try:
                return int(word)
            except ValueError:
                continue
        return default

    # ── virtual desktop management ────────────────────────────────────────────

    def _get_desktop_count(self) -> int:
        """Read _NET_NUMBER_OF_DESKTOPS via EWMH (works on KDE 5 and 6 / X11)."""
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
        return 1

    def _create_desktop(self, position: int, name: str) -> None:
        """Add a virtual desktop via KWin DBus."""
        if self._kde_version >= 6:
            self._kwin_dbus(
                "/VirtualDesktopManager",
                "org.kde.KWin.VirtualDesktopManager.createDesktop",
                f"uint32:{position}",
                f"string:{name}",
            )
        else:
            # KDE 5: wmctrl sets the total desktop count
            try:
                current = self._get_desktop_count()
                subprocess.run(
                    ["wmctrl", "-n", str(current + 1)],
                    capture_output=True, timeout=3,
                )
            except Exception:
                pass

    def _switch_to_desktop(self, index: int) -> None:
        """Switch to virtual desktop by 0-based index via EWMH ClientMessage."""
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
        """Write _NET_DESKTOP_NAMES via Xlib."""
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
        """Reduce virtual desktop count via wmctrl (X11 fallback for all versions)."""
        try:
            subprocess.run(
                ["wmctrl", "-n", str(max(1, desired))],
                capture_output=True, timeout=3,
            )
        except Exception:
            pass

    # ── prepare / cleanup ─────────────────────────────────────────────────────

    def prepare(self) -> None:
        """Ensure exactly two named virtual desktops exist."""
        self._original_desktop_count = self._get_desktop_count()
        if self._original_desktop_count < 2:
            self._create_desktop(1, "Eldrun-Hidden")
            self._created_hidden_desktop = True
        self._set_desktop_names(["Eldrun", "Eldrun-Hidden"])
        self._switch_to_desktop(_CURRENT_DESK)

    def cleanup(self) -> None:
        """Restore all hidden windows to desktop 0 and original desktop count."""
        try:
            from Xlib import display as XD
            d = XD.Display()
            for xid in self._get_windows_on_desktop(d, _HIDDEN_DESK):
                self._move_window(d, xid, _CURRENT_DESK)
            d.close()
        except Exception:
            pass

        self._project_windows.clear()

        if self._created_hidden_desktop:
            self._collapse_desktop_count(self._original_desktop_count)
            self._created_hidden_desktop = False

    # ── window operations (EWMH / Xlib) ──────────────────────────────────────

    @staticmethod
    def _get_windows_on_desktop(d, desktop_index: int) -> list[int]:
        """Return non-sticky window XIDs currently on the given desktop."""
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
        """Move a window to the given desktop via EWMH ClientMessage."""
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
        """Return {xid: [lowercase WM_CLASS parts]} for the given XIDs."""
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
        try:
            from Xlib import display as XD
            d = XD.Display()
            self._do_switch(d, project_id, previous_project_id,
                            eldrun_xid, protected_names or set())
            d.close()
        except Exception:
            pass

    def _do_switch(
        self, d, new_id: str, old_id: str | None,
        eldrun_xid: int | None, protected: set[str],
    ) -> None:
        exclude: set[int] = {eldrun_xid} if eldrun_xid is not None else set()

        # Collect moveable windows currently on desktop 0
        ws0_all = self._get_windows_on_desktop(d, _CURRENT_DESK)
        class_map = self._get_wm_classes(d, ws0_all)
        ws0_moveable: list[int] = [
            xid for xid in ws0_all
            if xid not in exclude
            and not (protected and self._matches_protected(
                class_map.get(xid, []), protected
            ))
        ]

        # Park old project's windows on desktop 1
        for xid in ws0_moveable:
            self._move_window(d, xid, _HIDDEN_DESK)
        if old_id is not None:
            self._project_windows[old_id] = ws0_moveable

        # Rescue any protected windows that drifted to desktop 1
        ws1_all = set(self._get_windows_on_desktop(d, _HIDDEN_DESK))
        if protected and ws1_all:
            class_map1 = self._get_wm_classes(d, list(ws1_all))
            for xid in list(ws1_all):
                if self._matches_protected(class_map1.get(xid, []), protected):
                    self._move_window(d, xid, _CURRENT_DESK)
                    ws1_all.discard(xid)

        # Restore new project's tracked windows from desktop 1 to desktop 0
        for xid in set(self._project_windows.get(new_id, [])) & ws1_all:
            self._move_window(d, xid, _CURRENT_DESK)

    def has_managed_windows(self) -> bool:
        return bool(self._project_windows)
