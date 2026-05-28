"""Global cross-project app registry: system resolution, launch-or-raise, sticky windows.

Implements G6.1 (registry), G6.2 (system resolution), G6.4 (launch-or-raise),
and G6.5 (sticky window via _NET_WM_DESKTOP = 0xFFFFFFFF).
"""

import os
import subprocess
import pathlib

from gi.repository import GLib

# ── role definitions ──────────────────────────────────────────────────────────

ROLES = [
    {"key": "browser",          "label": "Browser",          "icon": "web-browser-symbolic"},
    {"key": "mail",             "label": "Mail",             "icon": "mail-symbolic"},
    {"key": "calendar",         "label": "Calendar",         "icon": "x-office-calendar-symbolic"},
    {"key": "print_manager",    "label": "Print Manager",    "icon": "printer-symbolic"},
    {"key": "file_manager",     "label": "File Manager",     "icon": "system-file-manager-symbolic"},
    {"key": "password_manager", "label": "Password Manager", "icon": "dialog-password-symbolic"},
    {"key": "video_conf",       "label": "Video Conf.",      "icon": "camera-web-symbolic"},
    {"key": "media_player",     "label": "Media Player",     "icon": "audio-x-generic-symbolic"},
    {"key": "system_monitor",   "label": "System Monitor",   "icon": "utilities-system-monitor-symbolic"},
    {"key": "notes",            "label": "Notes",            "icon": "accessories-text-editor-symbolic"},
    {"key": "screenshot",       "label": "Screenshot",       "icon": "applets-screenshooter-symbolic"},
    {"key": "screen_recorder",  "label": "Screen Recorder",  "icon": "video-display-symbolic"},
]

_RESOLVE: dict[str, tuple] = {
    "browser":          ("xdg-settings", "default-web-browser"),
    "mail":             ("xdg-mime",     "x-scheme-handler/mailto"),
    "calendar":         ("xdg-mime",     "text/calendar"),
    "print_manager":    ("path",         ["system-config-printer"]),
    "file_manager":     ("xdg-mime",     "inode/directory"),
    "password_manager": ("path",         ["keepassxc", "bitwarden-desktop", "1password"]),
    "video_conf":       ("path",         ["zoom", "teams", "webex"]),
    "media_player":     ("xdg-mime",     "audio/mpeg"),
    "system_monitor":   ("path",         ["gnome-system-monitor", "ksysguard"]),
    "notes":            ("path",         ["obsidian", "zettlr", "gedit"]),
    "screenshot":       ("path",         ["flameshot", "gnome-screenshot"]),
    "screen_recorder":  ("path",         ["obs", "kazam", "simplescreenrecorder"]),
}


# ── desktop file helpers ──────────────────────────────────────────────────────

def _exec_from_desktop_name(desktop_name: str) -> str | None:
    dirs = [
        pathlib.Path.home() / ".local/share/applications",
        pathlib.Path("/usr/share/applications"),
        pathlib.Path("/usr/local/share/applications"),
    ]
    for d in dirs:
        f = d / desktop_name
        if not f.exists():
            continue
        try:
            for line in f.read_text(errors="replace").splitlines():
                if line.startswith("Exec="):
                    parts = [p for p in line[5:].split() if not p.startswith("%")]
                    if parts:
                        return GLib.find_program_in_path(parts[0]) or parts[0]
        except OSError:
            pass
    return None


def _resolve_exec(key: str) -> str | None:
    strategy = _RESOLVE.get(key)
    if strategy is None:
        return None
    method, arg = strategy
    if method == "xdg-settings":
        try:
            r = subprocess.run(
                ["xdg-settings", "get", str(arg)],
                capture_output=True, text=True, timeout=3,
            )
            desktop = r.stdout.strip()
            if desktop:
                return _exec_from_desktop_name(desktop)
        except (OSError, subprocess.TimeoutExpired):
            pass
    elif method == "xdg-mime":
        try:
            r = subprocess.run(
                ["xdg-mime", "query", "default", str(arg)],
                capture_output=True, text=True, timeout=3,
            )
            desktop = r.stdout.strip()
            if desktop:
                return _exec_from_desktop_name(desktop)
        except (OSError, subprocess.TimeoutExpired):
            pass
    elif method == "path":
        for candidate in arg:
            found = GLib.find_program_in_path(candidate)
            if found:
                return found
    return None


# ── manager class ─────────────────────────────────────────────────────────────

class GlobalAppsManager:
    """Registry and launcher for global cross-project apps."""

    def __init__(self, settings_manager):
        self._settings = settings_manager

    # ── registry (G6.1) ───────────────────────────────────────────────────────

    def get_registry(self) -> dict:
        """Return {key: {exec: str|None, visible: bool}} for all roles."""
        stored = self._settings.get("global_apps") or {}
        return {
            r["key"]: {
                "exec": (stored.get(r["key"]) or {}).get("exec") or None,
                "visible": bool((stored.get(r["key"]) or {}).get("visible", True)),
            }
            for r in ROLES
        }

    def set_exec(self, key: str, exec_cmd: str | None):
        stored = dict(self._settings.get("global_apps") or {})
        entry = dict(stored.get(key, {}))
        entry["exec"] = exec_cmd or None
        stored[key] = entry
        self._settings.set("global_apps", stored)

    def set_visible(self, key: str, visible: bool):
        stored = dict(self._settings.get("global_apps") or {})
        entry = dict(stored.get(key, {}))
        entry["visible"] = visible
        stored[key] = entry
        self._settings.set("global_apps", stored)

    # ── startup resolution (G6.2) ─────────────────────────────────────────────

    def populate_missing(self):
        """Probe system defaults for roles whose exec is unset. Called at startup."""
        stored = dict(self._settings.get("global_apps") or {})
        changed = False
        for role in ROLES:
            k = role["key"]
            entry = stored.get(k) or {}
            if not entry.get("exec"):
                resolved = _resolve_exec(k)
                if resolved:
                    entry = dict(entry)
                    entry["exec"] = resolved
                    if "visible" not in entry:
                        entry["visible"] = True
                    stored[k] = entry
                    changed = True
        if changed:
            self._settings.set("global_apps", stored)

    # ── launch-or-raise (G6.4 + G6.5) ────────────────────────────────────────

    def launch_or_raise(self, key: str):
        """Raise an existing window for the role, or launch a fresh sticky instance."""
        registry = self.get_registry()
        entry = registry.get(key, {})
        exec_cmd = entry.get("exec")
        if not exec_cmd:
            return
        app_name = os.path.basename(exec_cmd).lower()

        try:
            from Xlib import display as _Xdisp, X as _X
            from Xlib.protocol import event as _Xev
            d = _Xdisp.Display()
            root = d.screen().root
            client_atom = d.intern_atom("_NET_CLIENT_LIST")
            active_atom = d.intern_atom("_NET_ACTIVE_WINDOW")
            wm_class_atom = d.intern_atom("WM_CLASS")
            prop = root.get_full_property(client_atom, _X.AnyPropertyType)
            xids = list(prop.value) if (prop and prop.value) else []
            for xid in xids:
                try:
                    win = d.create_resource_object("window", xid)
                    cls_prop = win.get_full_property(wm_class_atom, _X.AnyPropertyType)
                    if cls_prop and cls_prop.value:
                        raw = cls_prop.value
                        if isinstance(raw, bytes):
                            parts = [p.decode("utf-8", errors="replace").lower()
                                     for p in raw.split(b"\x00") if p]
                        else:
                            parts = [p.lower() for p in str(raw).split("\x00") if p]
                        if any(p == app_name or p.startswith(app_name + "-")
                               for p in parts):
                            ev = _Xev.ClientMessage(
                                window=win,
                                client_type=active_atom,
                                data=(32, [2, _X.CurrentTime, 0, 0, 0]),
                            )
                            root.send_event(
                                ev,
                                event_mask=(_X.SubstructureRedirectMask
                                            | _X.SubstructureNotifyMask),
                            )
                            d.flush()
                            d.close()
                            return
                except Exception:
                    continue
            d.close()
        except Exception:
            pass

        # Not found — launch fresh; make sticky once window appears
        try:
            proc = subprocess.Popen([exec_cmd])
            GLib.timeout_add(500, self._poll_and_sticky, proc.pid, 10)
        except OSError:
            pass

    def _poll_and_sticky(self, pid: int, attempts: int) -> bool:
        try:
            from Xlib import display as _Xdisp, X as _X
            d = _Xdisp.Display()
            root = d.screen().root
            pid_atom = d.intern_atom("_NET_WM_PID")
            client_atom = d.intern_atom("_NET_CLIENT_LIST")
            prop = root.get_full_property(client_atom, _X.AnyPropertyType)
            xids = list(prop.value) if (prop and prop.value) else []
            for xid in xids:
                try:
                    win = d.create_resource_object("window", xid)
                    p = win.get_full_property(pid_atom, _X.AnyPropertyType)
                    if p and p.value and p.value[0] == pid:
                        self._make_sticky(win, root, d)
                        d.flush()
                        d.close()
                        return False
                except Exception:
                    continue
            d.close()
        except Exception:
            pass
        if attempts > 1:
            GLib.timeout_add(500, self._poll_and_sticky, pid, attempts - 1)
        return False

    @staticmethod
    def _make_sticky(win, root, d):
        from Xlib import X as _X
        from Xlib.protocol import event as _Xev
        desktop_atom = d.intern_atom("_NET_WM_DESKTOP")
        ev = _Xev.ClientMessage(
            window=win,
            client_type=desktop_atom,
            data=(32, [0xFFFFFFFF, _X.CurrentTime, 0, 0, 0]),
        )
        root.send_event(
            ev,
            event_mask=_X.SubstructureRedirectMask | _X.SubstructureNotifyMask,
        )
