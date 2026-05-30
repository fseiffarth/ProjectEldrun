"""Helpers for launching external apps away from the Eldrun monitor.

These helpers are best-effort and X11-oriented: they launch a process normally,
then try to move newly created top-level windows onto a non-Eldrun monitor when
more than one monitor is available.
"""

from __future__ import annotations

import subprocess
import threading
import time


def _display_and_gdk():
    import gi

    gi.require_version("Gdk", "4.0")
    from gi.repository import Gdk

    return Gdk.Display.get_default(), Gdk


def _monitor_identity(monitor) -> tuple:
    for attr in ("get_connector", "get_model"):
        getter = getattr(monitor, attr, None)
        if callable(getter):
            try:
                value = getter()
            except Exception:
                value = None
            if value:
                return (attr, str(value))

    try:
        geom = monitor.get_geometry()
        scale = 1
        getter = getattr(monitor, "get_scale_factor", None)
        if callable(getter):
            try:
                scale = int(getter())
            except Exception:
                scale = 1
        return (
            "geometry",
            (int(geom.x), int(geom.y), int(geom.width), int(geom.height), scale),
        )
    except Exception:
        return ("object", id(monitor))


def _iter_monitors(display):
    monitors = display.get_monitors()
    if monitors is None:
        return []
    try:
        count = int(monitors.get_n_items())
    except Exception:
        return []
    items = []
    for idx in range(count):
        try:
            mon = monitors.get_item(idx)
        except Exception:
            mon = None
        if mon is not None:
            items.append(mon)
    return items


def get_other_monitor_geometry(anchor_window=None):
    """Return the geometry of the first monitor that is not the Eldrun monitor."""
    display, _gdk = _display_and_gdk()
    if display is None:
        return None

    monitors = _iter_monitors(display)
    if len(monitors) < 2:
        return None

    current = None
    if anchor_window is not None:
        try:
            surface = anchor_window.get_surface()
        except Exception:
            surface = None
        if surface is not None:
            try:
                current = display.get_monitor_at_surface(surface)
            except Exception:
                current = None

    if current is None:
        target = monitors[1]
    else:
        current_id = _monitor_identity(current)
        target = next(
            (mon for mon in monitors if _monitor_identity(mon) != current_id),
            None,
        )
        if target is None:
            return None

    try:
        return target.get_geometry()
    except Exception:
        return None


def _collect_client_xids():
    try:
        from Xlib import X, display as Xdisplay
    except Exception:
        return set()

    try:
        d = Xdisplay.Display()
        try:
            root = d.screen().root
            atom = d.intern_atom("_NET_CLIENT_LIST")
            prop = root.get_full_property(atom, X.AnyPropertyType)
            if prop and prop.value:
                return {int(x) for x in prop.value}
            return set()
        finally:
            d.close()
    except Exception:
        return set()


def _move_xid_to_geometry(xid: int, geometry) -> bool:
    try:
        from Xlib import display as Xdisplay
    except Exception:
        return False

    try:
        d = Xdisplay.Display()
        try:
            win = d.create_resource_object("window", xid)
            try:
                geo = win.get_geometry()
                width = int(getattr(geo, "width", 0) or 0)
                height = int(getattr(geo, "height", 0) or 0)
            except Exception:
                width = height = 0

            x = int(geometry.x + max(0, (geometry.width - width) // 2))
            y = int(geometry.y + max(0, (geometry.height - height) // 2))
            try:
                win.configure(x=x, y=y)
                d.flush()
                return True
            except Exception:
                return False
        finally:
            d.close()
    except Exception:
        return False


def _route_new_windows(proc: subprocess.Popen, geometry, baseline: set[int]) -> None:
    seen = set(baseline)
    attempts: dict[int, int] = {}
    quiet_rounds = 0

    # Poll for a short time: enough for xdg-open handoffs and normal startup,
    # but not long enough to become a background watcher.
    for _ in range(30):
        try:
            current = _collect_client_xids()
        except Exception:
            break

        new_xids = [xid for xid in current if xid not in seen]
        moved_any = False
        for xid in new_xids:
            attempts[xid] = attempts.get(xid, 0) + 1
            if attempts[xid] > 6:
                seen.add(xid)
                continue
            if _move_xid_to_geometry(xid, geometry):
                moved_any = True
                seen.add(xid)

        if new_xids:
            quiet_rounds = 0
        else:
            quiet_rounds += 1

        if proc.poll() is not None and quiet_rounds >= 4 and not moved_any:
            break
        time.sleep(0.35)


def launch_on_other_monitor(argv: list[str], cwd: str | None = None,
                            anchor_window=None):
    """Launch a command and try to move its windows to the other monitor."""
    geometry = get_other_monitor_geometry(anchor_window)
    baseline: set[int] = set()
    if geometry is not None:
        try:
            baseline = _collect_client_xids()
        except Exception:
            baseline = set()

    try:
        proc = subprocess.Popen(argv, cwd=cwd)
    except OSError:
        return None

    if geometry is None:
        return proc

    threading.Thread(
        target=_route_new_windows,
        args=(proc, geometry, baseline),
        daemon=True,
    ).start()
    return proc
