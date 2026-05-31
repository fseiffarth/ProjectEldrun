"""Tests for backends/kde_kwin.py — Phase 6a + 6b (KDE Plasma / X11 + Wayland)."""

import json
import os
import sys
import subprocess
import tempfile
import types
import unittest
from subprocess import CompletedProcess
from unittest.mock import MagicMock, call, patch

# Stub Xlib so the module can be imported without a display
_XLIB_MOCKS = {
    "Xlib":                MagicMock(),
    "Xlib.display":        MagicMock(),
    "Xlib.X":              MagicMock(),
    "Xlib.protocol":       MagicMock(),
    "Xlib.protocol.event": MagicMock(),
}
for mod, mock in _XLIB_MOCKS.items():
    sys.modules.setdefault(mod, mock)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from backends.kde_kwin import KDEKWinBackend, _CURRENT_DESK, _HIDDEN_DESK


# ── helpers ───────────────────────────────────────────────────────────────────

def _ok(stdout: str = "") -> CompletedProcess:
    # Use str stdout: _kwin_dbus and _detect_kde_version both run with text=True.
    return CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")


def _fail() -> CompletedProcess:
    return CompletedProcess(args=[], returncode=1, stdout="", stderr="")


def _backend(kde_version: int = 6, session: str = "x11") -> KDEKWinBackend:
    b = KDEKWinBackend.__new__(KDEKWinBackend)
    b._kde_version = kde_version
    b._session = session
    b._project_windows = {}
    b._desktop_uuids = []
    b._created_hidden_desktop = False
    b._original_desktop_count = 1
    return b


# ── detection ─────────────────────────────────────────────────────────────────

class TestKDEDetection(unittest.TestCase):

    def test_is_available_returns_true_on_kde_wayland_phase6b(self):
        b = _backend()
        with patch.dict(os.environ,
                        {"WAYLAND_DISPLAY": ":1",
                         "XDG_CURRENT_DESKTOP": "KDE"}), \
             patch("subprocess.run",
                   side_effect=[_ok(), _ok("VirtualDesktopManager x")]):
            self.assertTrue(b.is_available())
        self.assertEqual(b._session, "wayland")

    def test_is_available_returns_false_for_non_kde_desktop(self):
        b = _backend()
        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "GNOME"},
                        clear=True):
            self.assertFalse(b.is_available())

    def test_is_available_returns_false_when_kwin_dbus_fails(self):
        b = _backend()
        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE"},
                        clear=True), \
             patch("subprocess.run", return_value=_fail()):
            self.assertFalse(b.is_available())

    def test_is_available_returns_true_when_kwin_responds(self):
        b = _backend()
        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE"},
                        clear=True), \
             patch("subprocess.run",
                   side_effect=[_ok(), _ok("VirtualDesktopManager introspect")]):
            self.assertTrue(b.is_available())

    def test_is_available_recognises_plasma_desktop_string(self):
        b = _backend()
        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE Plasma"},
                        clear=True), \
             patch("subprocess.run",
                   side_effect=[_ok(), _ok()]):
            self.assertTrue(b.is_available())

    def test_is_available_dbus_exception_returns_false(self):
        b = _backend()
        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE"},
                        clear=True), \
             patch("subprocess.run", side_effect=FileNotFoundError("dbus-send")):
            self.assertFalse(b.is_available())

    def test_detect_kde_version_returns_6_when_vdm_present(self):
        b = _backend()
        with patch("subprocess.run",
                   return_value=_ok("VirtualDesktopManager stuff")):
            self.assertEqual(b._detect_kde_version(), 6)

    def test_detect_kde_version_returns_5_when_vdm_absent(self):
        b = _backend()
        with patch("subprocess.run", return_value=_fail()):
            self.assertEqual(b._detect_kde_version(), 5)

    def test_detect_kde_version_returns_5_on_exception(self):
        b = _backend()
        with patch("subprocess.run", side_effect=OSError):
            self.assertEqual(b._detect_kde_version(), 5)

    def test_is_available_sets_kde_version_on_success(self):
        b = _backend()
        b._kde_version = 5
        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE"},
                        clear=True), \
             patch("subprocess.run",
                   side_effect=[_ok(), _ok("VirtualDesktopManager x")]):
            b.is_available()
        self.assertEqual(b._kde_version, 6)


# ── parse_int ─────────────────────────────────────────────────────────────────

class TestParseInt(unittest.TestCase):
    def test_extracts_first_integer_from_dbus_reply(self):
        text = "   method return time=1234\n      uint32 2\n"
        self.assertEqual(KDEKWinBackend._parse_int(text), 2)

    def test_returns_default_on_none(self):
        self.assertEqual(KDEKWinBackend._parse_int(None, default=7), 7)

    def test_returns_default_when_no_integer_found(self):
        self.assertEqual(KDEKWinBackend._parse_int("no ints here", default=3), 3)


# ── kwin_dbus ─────────────────────────────────────────────────────────────────

class TestKwinDbus(unittest.TestCase):
    def test_builds_correct_dbus_send_command(self):
        b = _backend()
        with patch("subprocess.run", return_value=_ok("reply\n")) as run:
            result = b._kwin_dbus("/VirtualDesktopManager",
                                  "org.kde.KWin.VDM.createDesktop",
                                  "uint32:1", "string:Hidden")
        cmd = run.call_args[0][0]
        self.assertIn("--dest=org.kde.KWin", cmd)
        self.assertIn("/VirtualDesktopManager", cmd)
        self.assertIn("org.kde.KWin.VDM.createDesktop", cmd)
        self.assertIn("uint32:1", cmd)
        self.assertEqual(result, "reply\n")

    def test_returns_none_on_nonzero_returncode(self):
        b = _backend()
        with patch("subprocess.run", return_value=_fail()):
            self.assertIsNone(b._kwin_dbus("/KWin", "some.Method"))

    def test_returns_none_on_exception(self):
        b = _backend()
        with patch("subprocess.run", side_effect=FileNotFoundError):
            self.assertIsNone(b._kwin_dbus("/KWin", "some.Method"))


# ── virtual desktop management ────────────────────────────────────────────────

class TestKDEDesktopManagement(unittest.TestCase):

    def test_create_desktop_kde6_calls_vdm_path(self):
        b = _backend(kde_version=6)
        with patch("subprocess.run", return_value=_ok()) as run:
            b._create_desktop(1, "Eldrun-Hidden")
        cmd = run.call_args[0][0]
        self.assertIn("/VirtualDesktopManager", cmd)
        self.assertTrue(any("createDesktop" in arg for arg in cmd))
        self.assertIn("string:Eldrun-Hidden", cmd)

    def test_create_desktop_kde5_uses_wmctrl(self):
        b = _backend(kde_version=5)
        with patch.object(b, "_get_desktop_count", return_value=1), \
             patch("subprocess.run", return_value=_ok()) as run:
            b._create_desktop(1, "Eldrun-Hidden")
        cmd = run.call_args[0][0]
        self.assertIn("wmctrl", cmd)
        self.assertIn("-n", cmd)
        self.assertIn("2", cmd)

    def test_set_desktop_names_writes_net_desktop_names(self):
        b = _backend()
        mock_d = MagicMock()
        mock_d.intern_atom.side_effect = lambda name: {"_NET_DESKTOP_NAMES": 1,
                                                        "UTF8_STRING": 2}.get(name, 0)
        mock_d.screen.return_value.root = MagicMock()

        from Xlib import display as XD
        with patch.object(XD, "Display", return_value=mock_d):
            b._set_desktop_names(["Eldrun", "Eldrun-Hidden"])

        mock_d.screen.return_value.root.change_property.assert_called_once()

    def test_switch_to_desktop_sends_ewmh_client_message(self):
        b = _backend()
        mock_d = MagicMock()
        mock_d.intern_atom.return_value = 99
        mock_d.screen.return_value.root = MagicMock()

        from Xlib import display as XD
        with patch.object(XD, "Display", return_value=mock_d):
            b._switch_to_desktop(0)

        mock_d.screen.return_value.root.send_event.assert_called_once()
        mock_d.flush.assert_called()

    def test_collapse_desktop_count_calls_wmctrl(self):
        b = _backend(kde_version=5)
        with patch("subprocess.run", return_value=_ok()) as run:
            b._collapse_desktop_count(1)
        cmd = run.call_args[0][0]
        self.assertIn("wmctrl", cmd)
        self.assertIn("1", cmd)

    def test_collapse_desktop_count_clamps_to_minimum_one(self):
        b = _backend(kde_version=5)
        with patch("subprocess.run", return_value=_ok()) as run:
            b._collapse_desktop_count(0)
        cmd = run.call_args[0][0]
        self.assertIn("1", cmd)

    def test_collapse_desktop_count_ignores_wmctrl_error(self):
        b = _backend(kde_version=5)
        with patch("subprocess.run", side_effect=FileNotFoundError):
            b._collapse_desktop_count(1)  # must not raise

    def test_collapse_desktop_count_kde6_uses_dbus_removal(self):
        b = _backend(kde_version=6)
        with patch.object(b, "_get_desktop_uuids_kde6_dbus",
                          return_value=["d0", "d1", "d2"]), \
             patch.object(b, "_kwin_dbus") as dbus, \
             patch("subprocess.run") as run:
            b._collapse_desktop_count(1)
        run.assert_not_called()
        removed = [c.args[2] for c in dbus.call_args_list]
        self.assertEqual(removed, ["string:d2", "string:d1"])

    def test_collapse_desktop_count_kde6_ignores_unknown_desktops(self):
        b = _backend(kde_version=6)
        with patch.object(b, "_get_desktop_uuids_kde6_dbus", return_value=[]), \
             patch.object(b, "_kwin_dbus") as dbus:
            b._collapse_desktop_count(1)
        dbus.assert_not_called()

    def test_prepare_creates_second_desktop_when_only_one_exists(self):
        b = _backend()
        with patch.object(b, "_get_desktop_count", return_value=1), \
             patch.object(b, "_create_desktop") as create, \
             patch.object(b, "_set_desktop_names"), \
             patch.object(b, "_switch_to_desktop"):
            b.prepare()
        create.assert_called_once_with(1, "Eldrun-Hidden")
        self.assertTrue(b._created_hidden_desktop)
        self.assertEqual(b._original_desktop_count, 1)

    def test_prepare_does_not_create_desktop_when_two_already_exist(self):
        b = _backend()
        with patch.object(b, "_get_desktop_count", return_value=2), \
             patch.object(b, "_create_desktop") as create, \
             patch.object(b, "_set_desktop_names"), \
             patch.object(b, "_switch_to_desktop"):
            b.prepare()
        create.assert_not_called()
        self.assertFalse(b._created_hidden_desktop)

    def test_prepare_names_desktops_eldrun_and_hidden(self):
        b = _backend()
        with patch.object(b, "_get_desktop_count", return_value=2), \
             patch.object(b, "_create_desktop"), \
             patch.object(b, "_set_desktop_names") as set_names, \
             patch.object(b, "_switch_to_desktop"):
            b.prepare()
        set_names.assert_called_once_with(["Eldrun", "Eldrun-Hidden"])

    def test_prepare_switches_to_desktop_zero(self):
        b = _backend()
        with patch.object(b, "_get_desktop_count", return_value=2), \
             patch.object(b, "_create_desktop"), \
             patch.object(b, "_set_desktop_names"), \
             patch.object(b, "_switch_to_desktop") as switch:
            b.prepare()
        switch.assert_called_once_with(_CURRENT_DESK)

    def test_cleanup_removes_created_hidden_desktop(self):
        b = _backend()
        b._created_hidden_desktop = True
        b._original_desktop_count = 1
        with patch.object(b, "_get_windows_on_desktop", return_value=[]), \
             patch.object(b, "_collapse_desktop_count") as collapse:
            from Xlib import display as XD
            with patch.object(XD, "Display", return_value=MagicMock()):
                b.cleanup()
        collapse.assert_called_once_with(1)
        self.assertFalse(b._created_hidden_desktop)

    def test_cleanup_does_not_collapse_when_desktop_was_preexisting(self):
        b = _backend()
        b._created_hidden_desktop = False
        with patch.object(b, "_get_windows_on_desktop", return_value=[]), \
             patch.object(b, "_collapse_desktop_count") as collapse:
            from Xlib import display as XD
            with patch.object(XD, "Display", return_value=MagicMock()):
                b.cleanup()
        collapse.assert_not_called()

    def test_cleanup_clears_project_windows(self):
        b = _backend()
        b._project_windows = {"p1": [10, 20]}
        with patch.object(b, "_get_windows_on_desktop", return_value=[]):
            from Xlib import display as XD
            with patch.object(XD, "Display", return_value=MagicMock()):
                b.cleanup()
        self.assertEqual(b._project_windows, {})

    def test_cleanup_restores_only_tracked_hidden_windows(self):
        b = _backend()
        b._project_windows = {"p1": [10, 20]}
        with patch.object(b, "_get_windows_on_desktop", return_value=[10, 30]), \
             patch.object(b, "_move_window") as move:
            from Xlib import display as XD
            with patch.object(XD, "Display", return_value=MagicMock()):
                b.cleanup()
        moved = {c.args[1] for c in move.call_args_list}
        self.assertEqual(moved, {10})


# ── window operations ─────────────────────────────────────────────────────────

class TestKDEWindowOps(unittest.TestCase):
    """Unit tests for the static Xlib EWMH helpers."""

    def _make_display(self, windows: dict[int, int]) -> MagicMock:
        """Build a mock Xlib Display with given {xid: desktop_index} mapping."""
        from Xlib import X

        mock_d = MagicMock()

        # _NET_CLIENT_LIST returns all xids
        client_prop = MagicMock()
        client_prop.value = list(windows.keys())

        desktop_props = {}
        for xid, desk in windows.items():
            dp = MagicMock()
            dp.value = [desk]
            desktop_props[xid] = dp

        wm_class_props = {}
        for xid in windows:
            cp = MagicMock()
            cp.value = f"foo\x00bar\x00".encode()
            wm_class_props[xid] = cp

        def intern_atom(name):
            return {"_NET_CLIENT_LIST": 1,
                    "_NET_WM_DESKTOP": 2,
                    "WM_CLASS": 3}.get(name, 0)

        mock_d.intern_atom.side_effect = intern_atom

        def get_full_property(atom, _type):
            return client_prop

        mock_d.screen.return_value.root.get_full_property.side_effect = get_full_property

        def create_resource_object(_type, xid):
            win = MagicMock()
            def win_prop(atom, _type):
                if atom == 2:
                    return desktop_props.get(xid, MagicMock())
                if atom == 3:
                    return wm_class_props.get(xid, MagicMock())
                return None
            win.get_full_property.side_effect = win_prop
            return win

        mock_d.create_resource_object.side_effect = create_resource_object
        return mock_d

    def test_get_windows_on_desktop_returns_correct_xids(self):
        d = self._make_display({10: 0, 20: 1, 30: 0})
        result = KDEKWinBackend._get_windows_on_desktop(d, 0)
        self.assertEqual(set(result), {10, 30})

    def test_get_windows_on_desktop_returns_empty_for_no_match(self):
        d = self._make_display({10: 0, 20: 0})
        result = KDEKWinBackend._get_windows_on_desktop(d, 1)
        self.assertEqual(result, [])

    def test_move_window_sends_client_message(self):
        d = MagicMock()
        d.intern_atom.return_value = 99
        win = MagicMock()
        d.create_resource_object.return_value = win
        root = d.screen.return_value.root

        result = KDEKWinBackend._move_window(d, 1234, 1)

        self.assertTrue(result)
        root.send_event.assert_called_once()
        d.flush.assert_called()

    def test_move_window_returns_false_on_xlib_error(self):
        d = MagicMock()
        d.intern_atom.side_effect = Exception("display error")
        self.assertFalse(KDEKWinBackend._move_window(d, 1234, 1))

    def test_get_wm_classes_parses_null_separated_bytes(self):
        d = MagicMock()
        d.intern_atom.return_value = 3

        prop = MagicMock()
        prop.value = b"Firefox\x00firefox\x00"
        win = MagicMock()
        win.get_full_property.return_value = prop
        d.create_resource_object.return_value = win

        result = KDEKWinBackend._get_wm_classes(d, [100])
        self.assertEqual(result[100], ["firefox", "firefox"])

    def test_matches_protected_exact_name(self):
        self.assertTrue(
            KDEKWinBackend._matches_protected(["firefox"], {"firefox"})
        )

    def test_matches_protected_name_with_suffix(self):
        self.assertTrue(
            KDEKWinBackend._matches_protected(["firefox-esr"], {"firefox"})
        )

    def test_matches_protected_no_match(self):
        self.assertFalse(
            KDEKWinBackend._matches_protected(["thunderbird"], {"firefox"})
        )

    def test_matches_protected_empty_protected_set(self):
        self.assertFalse(
            KDEKWinBackend._matches_protected(["firefox"], set())
        )


# ── activate_project ──────────────────────────────────────────────────────────

class TestKDEActivateProject(unittest.TestCase):

    def _backend_with_windows(
        self,
        ws0: list[int],
        ws1: list[int],
        wm_classes: dict[int, list[str]] | None = None,
    ) -> tuple[KDEKWinBackend, MagicMock]:
        b = _backend()
        mock_d = MagicMock()

        def get_windows(d, idx):
            return ws0 if idx == _CURRENT_DESK else ws1

        def get_classes(d, xids):
            cls = wm_classes or {}
            return {xid: cls.get(xid, []) for xid in xids}

        return b, mock_d, get_windows, get_classes

    def _run_activate(self, b, mock_d, get_windows_fn, get_classes_fn,
                      new_id="new", old_id="old",
                      eldrun_xid=None, protected=None):
        with patch.object(KDEKWinBackend, "_get_windows_on_desktop",
                          side_effect=get_windows_fn), \
             patch.object(KDEKWinBackend, "_get_wm_classes",
                          side_effect=get_classes_fn), \
             patch.object(KDEKWinBackend, "_move_window") as move:
            from Xlib import display as XD
            with patch.object(XD, "Display", return_value=mock_d):
                b.activate_project(new_id, old_id,
                                   eldrun_xid=eldrun_xid,
                                   protected_names=protected)
        return move

    def test_activate_moves_ws0_windows_to_hidden(self):
        b, d, gw, gc = self._backend_with_windows(ws0=[10, 20], ws1=[])
        move = self._run_activate(b, d, gw, gc)
        moved_to_1 = [c.args for c in move.call_args_list
                      if c.args[2] == _HIDDEN_DESK]
        self.assertEqual({c[1] for c in moved_to_1}, {10, 20})

    def test_activate_records_old_project_windows(self):
        b, d, gw, gc = self._backend_with_windows(ws0=[10, 20], ws1=[])
        self._run_activate(b, d, gw, gc, old_id="old")
        self.assertEqual(b._project_windows.get("old"), [10, 20])

    def test_activate_excludes_eldrun_xid_from_move(self):
        b, d, gw, gc = self._backend_with_windows(ws0=[10, 99, 20], ws1=[])
        move = self._run_activate(b, d, gw, gc, eldrun_xid=99)
        moved_xids = {c.args[1] for c in move.call_args_list
                      if c.args[2] == _HIDDEN_DESK}
        self.assertNotIn(99, moved_xids)
        self.assertIn(10, moved_xids)
        self.assertIn(20, moved_xids)

    def test_activate_excludes_protected_windows(self):
        classes = {10: ["firefox", "firefox"], 20: ["code", "code"]}
        b, d, gw, gc = self._backend_with_windows(ws0=[10, 20], ws1=[],
                                                   wm_classes=classes)
        move = self._run_activate(b, d, gw, gc, protected={"firefox"})
        moved_xids = {c.args[1] for c in move.call_args_list
                      if c.args[2] == _HIDDEN_DESK}
        self.assertNotIn(10, moved_xids)
        self.assertIn(20, moved_xids)

    def test_activate_restores_new_project_windows_from_hidden(self):
        b, d, gw, gc = self._backend_with_windows(ws0=[], ws1=[30, 40])
        b._project_windows["new"] = [30, 40]
        move = self._run_activate(b, d, gw, gc, new_id="new", old_id=None)
        restored = {c.args[1] for c in move.call_args_list
                    if c.args[2] == _CURRENT_DESK}
        self.assertEqual(restored, {30, 40})

    def test_activate_only_restores_tracked_windows_from_hidden(self):
        # ws1 has 30 (tracked) and 50 (not tracked); only 30 should be restored
        b, d, gw, gc = self._backend_with_windows(ws0=[], ws1=[30, 50])
        b._project_windows["new"] = [30]
        move = self._run_activate(b, d, gw, gc, new_id="new", old_id=None)
        restored = {c.args[1] for c in move.call_args_list
                    if c.args[2] == _CURRENT_DESK}
        self.assertEqual(restored, {30})
        self.assertNotIn(50, restored)

    def test_activate_no_previous_project_skips_recording(self):
        b, d, gw, gc = self._backend_with_windows(ws0=[10], ws1=[])
        self._run_activate(b, d, gw, gc, new_id="new", old_id=None)
        self.assertNotIn(None, b._project_windows)

    def test_activate_no_previous_project_does_not_park_ws0_windows(self):
        b, d, gw, gc = self._backend_with_windows(ws0=[10, 20], ws1=[])
        move = self._run_activate(b, d, gw, gc, new_id="new", old_id=None)
        moved_to_hidden = [c for c in move.call_args_list
                           if c.args[2] == _HIDDEN_DESK]
        self.assertEqual(moved_to_hidden, [])

    def test_activate_rescues_protected_windows_from_hidden(self):
        classes = {10: ["firefox"]}
        # 10 drifted to ws1 even though it's protected
        b, d, gw, gc = self._backend_with_windows(ws0=[], ws1=[10],
                                                   wm_classes=classes)
        move = self._run_activate(b, d, gw, gc, protected={"firefox"})
        rescued = [c.args[1] for c in move.call_args_list
                   if c.args[2] == _CURRENT_DESK]
        self.assertIn(10, rescued)

    def test_activate_noop_when_xlib_unavailable(self):
        b = _backend()
        from Xlib import display as XD
        with patch.object(XD, "Display", side_effect=Exception("no display")):
            b.activate_project("new", "old")  # must not raise

    def test_close_project_removes_tracking(self):
        b = _backend()
        b._project_windows = {"p1": [10, 20], "p2": [30]}
        b.close_project("p1")
        self.assertNotIn("p1", b._project_windows)
        self.assertIn("p2", b._project_windows)

    def test_close_project_unknown_id_is_noop(self):
        b = _backend()
        b.close_project("nonexistent")  # must not raise

    def test_has_managed_windows_false_when_empty(self):
        b = _backend()
        self.assertFalse(b.has_managed_windows())

    def test_has_managed_windows_true_when_tracking(self):
        b = _backend()
        b._project_windows = {"p1": [10]}
        self.assertTrue(b.has_managed_windows())


# ── detect_backend integration ────────────────────────────────────────────────

class TestDetectBackendKDE(unittest.TestCase):

    def test_detect_returns_kde_backend_on_kde_x11(self):
        import backends as bk
        from backends.kde_kwin import KDEKWinBackend

        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE"},
                        clear=True), \
             patch.object(KDEKWinBackend, "is_available", return_value=True), \
             patch.object(KDEKWinBackend, "__init__", return_value=None):
            b = bk.detect_backend()

        self.assertIsInstance(b, KDEKWinBackend)

    def test_detect_kde_checked_before_cinnamon(self):
        """KDE must be probed first so KDE/X11 doesn't fall through to Cinnamon."""
        import backends as bk
        from backends.kde_kwin import KDEKWinBackend
        from backends.cinnamon_x11 import CinnamonX11Backend

        cinnamon_called = []
        kde_called = []

        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE"},
                        clear=True), \
             patch.object(KDEKWinBackend, "__init__", return_value=None), \
             patch.object(KDEKWinBackend, "is_available",
                          side_effect=lambda: kde_called.append(1) or True), \
             patch.object(CinnamonX11Backend, "is_available",
                          side_effect=lambda: cinnamon_called.append(1) or True):
            bk.detect_backend()

        self.assertEqual(len(kde_called), 1)
        self.assertEqual(len(cinnamon_called), 0)

    def test_detect_falls_through_to_cinnamon_when_kde_unavailable(self):
        import backends as bk
        from backends.kde_kwin import KDEKWinBackend
        from backends.cinnamon_x11 import CinnamonX11Backend

        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE"},
                        clear=True), \
             patch.object(KDEKWinBackend, "__init__", return_value=None), \
             patch.object(KDEKWinBackend, "is_available", return_value=False), \
             patch.object(CinnamonX11Backend, "__init__", return_value=None), \
             patch.object(CinnamonX11Backend, "is_available", return_value=True):
            b = bk.detect_backend()

        self.assertIsInstance(b, CinnamonX11Backend)

    def test_detect_kde_wayland_returns_null_backend_when_kwin_unavailable(self):
        """KDE on Wayland falls through to NullBackend when KWin DBus is unreachable."""
        import backends as bk
        from backends.kde_kwin import KDEKWinBackend
        from backends.null import NullBackend

        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE",
                         "WAYLAND_DISPLAY": ":1"}), \
             patch.object(KDEKWinBackend, "__init__", return_value=None), \
             patch.object(KDEKWinBackend, "is_available", return_value=False):
            b = bk.detect_backend()

        self.assertIsInstance(b, NullBackend)

    def test_detect_plasma_string_triggers_kde_backend(self):
        import backends as bk
        from backends.kde_kwin import KDEKWinBackend

        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE Plasma"},
                        clear=True), \
             patch.object(KDEKWinBackend, "__init__", return_value=None), \
             patch.object(KDEKWinBackend, "is_available", return_value=True):
            b = bk.detect_backend()

        self.assertIsInstance(b, KDEKWinBackend)

    def test_detect_non_kde_x11_skips_kde_check(self):
        import backends as bk
        from backends.kde_kwin import KDEKWinBackend
        from backends.cinnamon_x11 import CinnamonX11Backend

        kde_called = []

        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "X-Cinnamon"},
                        clear=True), \
             patch.object(KDEKWinBackend, "is_available",
                          side_effect=lambda: kde_called.append(1) or True), \
             patch.object(CinnamonX11Backend, "__init__", return_value=None), \
             patch.object(CinnamonX11Backend, "is_available", return_value=True):
            bk.detect_backend()

        self.assertEqual(len(kde_called), 0)


# ═══════════════════════════════════════════════════════════════════════════════
# Phase 6b — Wayland tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestSessionDetection(unittest.TestCase):
    """is_available() now sets _session based on WAYLAND_DISPLAY."""

    def test_is_available_returns_true_on_kde_wayland(self):
        b = KDEKWinBackend.__new__(KDEKWinBackend)
        b._kde_version = 5
        b._session = "x11"
        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE",
                         "WAYLAND_DISPLAY": ":1"}), \
             patch("subprocess.run",
                   side_effect=[_ok(), _ok("VirtualDesktopManager x")]):
            result = b.is_available()
        self.assertTrue(result)
        self.assertEqual(b._session, "wayland")

    def test_is_available_sets_x11_session_when_no_wayland_display(self):
        b = KDEKWinBackend.__new__(KDEKWinBackend)
        b._kde_version = 5
        b._session = "wayland"
        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE"},
                        clear=True), \
             patch("subprocess.run",
                   side_effect=[_ok(), _ok("VirtualDesktopManager x")]):
            b.is_available()
        self.assertEqual(b._session, "x11")

    def test_is_available_wayland_kde5_has_session_wayland(self):
        b = _backend(kde_version=5)
        b._session = "x11"
        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE",
                         "WAYLAND_DISPLAY": ":1"}), \
             patch("subprocess.run",
                   side_effect=[_ok(), _fail()]):
            b.is_available()
        self.assertEqual(b._session, "wayland")

    def test_wayland_kde_returns_true_from_is_available(self):
        b = _backend()
        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "plasma",
                         "WAYLAND_DISPLAY": ":1"}), \
             patch("subprocess.run",
                   side_effect=[_ok(), _ok("VirtualDesktopManager")]):
            self.assertTrue(b.is_available())


# ── KWin script runner ────────────────────────────────────────────────────────

class TestKWinScriptRunner(unittest.TestCase):

    def _backend_wayland(self, kde=6):
        b = _backend(kde_version=kde)
        b._session = "wayland"
        return b

    def test_run_kwin_script_loads_and_unloads(self):
        b = self._backend_wayland()
        calls = []

        def run_side_effect(cmd, **kw):
            calls.append(cmd)
            return _ok("   int32 1\n")

        with patch("subprocess.run", side_effect=run_side_effect), \
             patch("os.unlink"):
            result = b._run_kwin_script("print('hello');")

        self.assertTrue(result)
        methods = [c[5] for c in calls]  # 6th element is the method name
        self.assertTrue(any("loadScript" in m for m in methods))
        self.assertTrue(any("unloadScript" in m for m in methods))

    def test_run_kwin_script_kde5_sends_run_call(self):
        b = self._backend_wayland(kde=5)
        methods_called = []

        def run_side_effect(cmd, **kw):
            methods_called.append(cmd[5] if len(cmd) > 5 else "")
            return _ok("   int32 42\n")

        with patch("subprocess.run", side_effect=run_side_effect), \
             patch("os.unlink"):
            b._run_kwin_script("1+1;")

        self.assertTrue(any("Script.run" in m for m in methods_called))

    def test_run_kwin_script_kde6_skips_explicit_run(self):
        b = self._backend_wayland(kde=6)
        methods_called = []

        def run_side_effect(cmd, **kw):
            methods_called.append(cmd[5] if len(cmd) > 5 else "")
            return _ok("   int32 7\n")

        with patch("subprocess.run", side_effect=run_side_effect), \
             patch("os.unlink"):
            b._run_kwin_script("1+1;")

        self.assertFalse(any("Script.run" in m for m in methods_called))

    def test_run_kwin_script_returns_false_when_load_fails(self):
        b = self._backend_wayland()
        with patch("subprocess.run", return_value=_fail()), \
             patch("os.unlink"):
            result = b._run_kwin_script("1+1;")
        self.assertFalse(result)

    def test_run_kwin_script_returns_false_when_script_id_negative(self):
        b = self._backend_wayland()
        with patch("subprocess.run", return_value=_ok("no int here")), \
             patch("os.unlink"):
            result = b._run_kwin_script("1+1;")
        self.assertFalse(result)

    def test_run_kwin_script_cleans_up_temp_file_on_success(self):
        b = self._backend_wayland()
        deleted = []
        with patch("subprocess.run", return_value=_ok("   int32 1\n")), \
             patch("os.unlink", side_effect=deleted.append):
            b._run_kwin_script("1+1;")
        self.assertEqual(len(deleted), 1)

    def test_run_kwin_script_cleans_up_temp_file_on_failure(self):
        b = self._backend_wayland()
        deleted = []
        with patch("subprocess.run", return_value=_fail()), \
             patch("os.unlink", side_effect=deleted.append):
            b._run_kwin_script("1+1;")
        self.assertEqual(len(deleted), 1)

    def test_run_kwin_script_js_content_is_written_to_file(self):
        b = self._backend_wayland()
        written = []
        original_open = open

        def fake_ntf(*args, **kwargs):
            class FakeFile:
                name = "/tmp/eldrun_kwin_test.js"
                def write(self, s): written.append(s)
                def __enter__(self): return self
                def __exit__(self, *_): pass
            return FakeFile()

        with patch("tempfile.NamedTemporaryFile", side_effect=fake_ntf), \
             patch("subprocess.run", return_value=_ok("   int32 1\n")), \
             patch("os.unlink"):
            b._run_kwin_script("var x = 42;")

        self.assertTrue(any("var x = 42;" in w for w in written))


# ── window enumeration — KWin script path ─────────────────────────────────────

class TestEnumerateStateWayland(unittest.TestCase):

    def _state(self, desktops=None, windows=None):
        return {
            "desktopUUIDs": desktops or ["uuid-desk0", "uuid-desk1"],
            "windows": windows or [],
        }

    def _backend_wayland(self):
        b = _backend(kde_version=6)
        b._session = "wayland"
        b._desktop_uuids = []
        return b

    def test_enumerate_returns_parsed_json_from_file(self):
        b = self._backend_wayland()
        state = self._state(windows=[
            {"uuid": "w1", "cls": "firefox", "desktops": ["uuid-desk0"],
             "onAllDesktops": False},
        ])
        with patch.object(b, "_run_kwin_script", return_value=True), \
             patch.object(KDEKWinBackend, "_read_json_file", return_value=state):
            result = b._enumerate_state_wayland()

        self.assertIsNotNone(result)
        self.assertEqual(result["windows"][0]["uuid"], "w1")

    def test_enumerate_caches_desktop_uuids(self):
        b = self._backend_wayland()
        state = self._state(desktops=["aaa", "bbb"])
        with patch.object(b, "_run_kwin_script", return_value=True), \
             patch.object(KDEKWinBackend, "_read_json_file", return_value=state):
            b._enumerate_state_wayland()

        self.assertEqual(b._desktop_uuids, ["aaa", "bbb"])

    def test_enumerate_returns_none_when_file_missing_and_kde5(self):
        b = _backend(kde_version=5)
        b._session = "wayland"
        b._desktop_uuids = []
        with patch.object(b, "_run_kwin_script", return_value=False), \
             patch.object(KDEKWinBackend, "_read_json_file", return_value=None):
            result = b._enumerate_state_wayland()
        self.assertIsNone(result)

    def test_enumerate_kde6_falls_back_to_dbus_when_file_missing(self):
        b = self._backend_wayland()
        fallback_state = self._state(windows=[{"uuid": "w2", "cls": "code",
                                               "desktops": [], "onAllDesktops": False}])
        with patch.object(b, "_run_kwin_script", return_value=True), \
             patch.object(KDEKWinBackend, "_read_json_file", return_value=None), \
             patch.object(b, "_enumerate_windows_kde6_dbus",
                          return_value=fallback_state) as dbus_enum:
            result = b._enumerate_state_wayland()

        dbus_enum.assert_called_once()
        self.assertEqual(result["windows"][0]["uuid"], "w2")

    def test_read_json_file_returns_none_on_missing_file(self):
        self.assertIsNone(KDEKWinBackend._read_json_file("/nonexistent/path.json"))

    def test_read_json_file_returns_none_on_invalid_json(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json",
                                         delete=False) as f:
            f.write("not json {{{{")
            path = f.name
        try:
            self.assertIsNone(KDEKWinBackend._read_json_file(path))
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    def test_read_json_file_returns_none_for_non_dict_json(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json",
                                         delete=False) as f:
            json.dump([1, 2, 3], f)
            path = f.name
        try:
            self.assertIsNone(KDEKWinBackend._read_json_file(path))
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    def test_read_json_file_parses_valid_dict(self):
        data = {"desktopUUIDs": ["d0", "d1"], "windows": []}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json",
                                         delete=False) as f:
            json.dump(data, f)
            path = f.name
        result = KDEKWinBackend._read_json_file(path)
        self.assertEqual(result, data)

    def test_read_json_file_deletes_file_after_reading(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json",
                                         delete=False) as f:
            json.dump({"desktopUUIDs": [], "windows": []}, f)
            path = f.name
        KDEKWinBackend._read_json_file(path)
        self.assertFalse(os.path.exists(path))

    def test_read_json_file_deletes_file_even_on_parse_error(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json",
                                         delete=False) as f:
            f.write("{bad")
            path = f.name
        KDEKWinBackend._read_json_file(path)
        self.assertFalse(os.path.exists(path))


# ── window enumeration — KDE 6 DBus fallback ─────────────────────────────────

class TestEnumerateWindowsKDE6DBus(unittest.TestCase):

    _INTROSPECT_XML = """
    <?xml version="1.0"?>
    <node>
      <node name="win-uuid-1"/>
      <node name="win-uuid-2"/>
    </node>
    """

    def _backend6(self):
        b = _backend(kde_version=6)
        b._session = "wayland"
        b._desktop_uuids = []
        return b

    def test_parse_introspect_children_extracts_names(self):
        names = KDEKWinBackend._parse_introspect_children(self._INTROSPECT_XML)
        self.assertEqual(names, ["win-uuid-1", "win-uuid-2"])

    def test_parse_introspect_children_returns_empty_on_bad_xml(self):
        names = KDEKWinBackend._parse_introspect_children("not xml")
        self.assertEqual(names, [])

    def test_parse_strings_extracts_quoted_values(self):
        text = '   string "firefox"\n   string "Mozilla"\n'
        self.assertEqual(KDEKWinBackend._parse_strings(text), ["firefox", "Mozilla"])

    def test_enumerate_kde6_dbus_queries_each_window(self):
        b = self._backend6()
        call_count = [0]

        def fake_dbus(path, method, *args):
            call_count[0] += 1
            if any("resourceClass" in a for a in args):
                return '   string "firefox"\n'
            if any("desktops" in a for a in args):
                return '   string "desk-uuid"\n'
            return '   string "ignored"\n'

        with patch.object(b, "_kwin_dbus", side_effect=fake_dbus), \
             patch.object(KDEKWinBackend, "_parse_introspect_children",
                          return_value=["w1", "w2"]), \
             patch.object(b, "_get_desktop_uuids_kde6_dbus", return_value=[]):
            result = b._enumerate_windows_kde6_dbus()

        self.assertIsNotNone(result)
        self.assertEqual(len(result["windows"]), 2)

    def test_enumerate_kde6_dbus_returns_none_when_introspect_fails(self):
        b = self._backend6()
        with patch.object(b, "_kwin_dbus", return_value=None):
            self.assertIsNone(b._enumerate_windows_kde6_dbus())

    def test_enumerate_kde6_dbus_returns_none_when_no_windows(self):
        b = self._backend6()
        with patch.object(b, "_kwin_dbus", return_value="<node/>"), \
             patch.object(KDEKWinBackend, "_parse_introspect_children",
                          return_value=[]):
            self.assertIsNone(b._enumerate_windows_kde6_dbus())

    def test_enumerate_kde6_dbus_lowercases_class(self):
        b = self._backend6()

        def fake_dbus(path, method, *args):
            if not args:
                return "<node/>"
            if any("resourceClass" in a for a in args):
                return '   string "Firefox"\n'
            if any("desktops" in a for a in args):
                return '   string "d0"\n'
            return ""

        with patch.object(b, "_kwin_dbus", side_effect=fake_dbus), \
             patch.object(KDEKWinBackend, "_parse_introspect_children",
                          return_value=["w1"]), \
             patch.object(b, "_get_desktop_uuids_kde6_dbus", return_value=[]):
            result = b._enumerate_windows_kde6_dbus()

        self.assertEqual(result["windows"][0]["cls"], "firefox")

    def test_get_desktop_uuids_kde6_reads_each_child_id(self):
        b = self._backend6()

        def fake_dbus(path, method, *args):
            if any("string:id" in a for a in args):
                return f'   string "{path.split("/")[-1]}"\n'
            # introspect
            return '<node><node name="D1"/><node name="D2"/></node>'

        with patch.object(b, "_kwin_dbus", side_effect=fake_dbus), \
             patch.object(KDEKWinBackend, "_parse_introspect_children",
                          return_value=["D1", "D2"]):
            uuids = b._get_desktop_uuids_kde6_dbus()

        self.assertEqual(len(uuids), 2)


# ── window moves — Wayland ────────────────────────────────────────────────────

class TestMoveWindowsWayland(unittest.TestCase):

    def _backend_wayland(self, kde=6):
        b = _backend(kde_version=kde)
        b._session = "wayland"
        b._desktop_uuids = ["desk-uuid-0", "desk-uuid-1"]
        return b

    def test_move_windows_calls_run_kwin_script(self):
        b = self._backend_wayland()
        with patch.object(b, "_run_kwin_script", return_value=True) as run:
            b._move_windows_wayland(["uuid-w1", "uuid-w2"], 1)
        run.assert_called_once()

    def test_move_windows_js_contains_all_uuids(self):
        b = self._backend_wayland()
        js_args = []
        with patch.object(b, "_run_kwin_script",
                          side_effect=lambda js: js_args.append(js) or True):
            b._move_windows_wayland(["aaa", "bbb"], 0)
        js = js_args[0]
        self.assertIn('"aaa"', js)
        self.assertIn('"bbb"', js)

    def test_move_windows_js_contains_target_index(self):
        b = self._backend_wayland()
        js_args = []
        with patch.object(b, "_run_kwin_script",
                          side_effect=lambda js: js_args.append(js) or True):
            b._move_windows_wayland(["aaa"], 1)
        self.assertIn("workspace.desktops[1]", js_args[0])

    def test_move_windows_empty_list_is_noop(self):
        b = self._backend_wayland()
        with patch.object(b, "_run_kwin_script") as run:
            b._move_windows_wayland([], 0)
        run.assert_not_called()

    def test_move_windows_kde6_falls_back_to_gdbus_on_script_failure(self):
        b = self._backend_wayland(kde=6)
        with patch.object(b, "_run_kwin_script", return_value=False), \
             patch.object(b, "_move_window_kde6_dbus") as gdbus:
            b._move_windows_wayland(["w1", "w2"], 1)
        self.assertEqual(gdbus.call_count, 2)

    def test_move_windows_kde5_no_gdbus_fallback_on_script_failure(self):
        b = self._backend_wayland(kde=5)
        with patch.object(b, "_run_kwin_script", return_value=False), \
             patch.object(b, "_move_window_kde6_dbus") as gdbus:
            b._move_windows_wayland(["w1"], 0)
        gdbus.assert_not_called()

    def test_move_window_kde6_dbus_calls_gdbus(self):
        b = self._backend_wayland()
        with patch("subprocess.run", return_value=_ok()) as run:
            b._move_window_kde6_dbus("w-uuid", "desk-uuid")
        cmd = run.call_args[0][0]
        self.assertIn("gdbus", cmd)
        self.assertIn("w-uuid", " ".join(cmd))
        self.assertIn("desk-uuid", " ".join(cmd))


# ── desktop switching — Wayland ───────────────────────────────────────────────

class TestSwitchDesktopWayland(unittest.TestCase):

    def test_switch_to_desktop_wayland_runs_script(self):
        b = _backend()
        b._session = "wayland"
        with patch.object(b, "_run_kwin_script") as run:
            b._switch_to_desktop_wayland(0)
        run.assert_called_once()

    def test_switch_to_desktop_wayland_js_contains_index(self):
        b = _backend()
        b._session = "wayland"
        js_args = []
        with patch.object(b, "_run_kwin_script",
                          side_effect=lambda js: js_args.append(js) or True):
            b._switch_to_desktop_wayland(1)
        self.assertIn("workspace.desktops[1]", js_args[0])

    def test_make_sticky_wayland_passes_uuids_to_script(self):
        b = _backend()
        b._session = "wayland"
        js_args = []
        with patch.object(b, "_run_kwin_script",
                          side_effect=lambda js: js_args.append(js) or True):
            b._make_sticky_wayland(["sticky-uuid"])
        self.assertIn('"sticky-uuid"', js_args[0])
        self.assertIn("onAllDesktops", js_args[0])

    def test_make_sticky_wayland_empty_list_is_noop(self):
        b = _backend()
        with patch.object(b, "_run_kwin_script") as run:
            b._make_sticky_wayland([])
        run.assert_not_called()


# ── activate_project — Wayland ────────────────────────────────────────────────

class TestActivateWayland(unittest.TestCase):

    def _backend_wayland(self, windows=None, desk_uuids=None):
        b = _backend(kde_version=6)
        b._session = "wayland"
        uuids = desk_uuids or ["d0", "d1"]
        b._desktop_uuids = uuids
        state = {
            "desktopUUIDs": uuids,
            "windows": windows or [],
        }
        b._enumerate_state_wayland = MagicMock(return_value=state)
        b._move_windows_wayland = MagicMock()
        b._switch_to_desktop_wayland = MagicMock()
        return b

    def _win(self, uuid, cls="code", desktop_index=0, uuids=None):
        if uuids is None:
            uuids = ["d0", "d1"]
        return {
            "uuid": uuid,
            "cls": cls,
            "desktops": [uuids[desktop_index]] if desktop_index < len(uuids) else [],
            "onAllDesktops": False,
        }

    def test_activate_parks_ws0_windows_on_ws1(self):
        b = self._backend_wayland(windows=[self._win("w1")])
        b.activate_project("new", "old")
        b._move_windows_wayland.assert_any_call(["w1"], 1)

    def test_activate_records_old_project_windows(self):
        b = self._backend_wayland(windows=[self._win("w1")])
        b.activate_project("new", "old")
        self.assertEqual(b._project_windows.get("old"), ["w1"])

    def test_activate_restores_new_project_windows_from_ws1(self):
        b = self._backend_wayland(
            windows=[self._win("w2", desktop_index=1)]
        )
        b._project_windows["new"] = ["w2"]
        b.activate_project("new", None)
        b._move_windows_wayland.assert_any_call(["w2"], 0)

    def test_activate_excludes_protected_windows_from_parking(self):
        b = self._backend_wayland(windows=[
            self._win("firefox-w", cls="firefox"),
            self._win("code-w", cls="code"),
        ])
        b.activate_project("new", "old", protected_names={"firefox"})
        # "code" should be parked; "firefox" should not
        park_calls = [c for c in b._move_windows_wayland.call_args_list
                      if c[0][1] == 1]  # moves to ws1
        parked_uuids = park_calls[0][0][0] if park_calls else []
        self.assertNotIn("firefox-w", parked_uuids)
        self.assertIn("code-w", parked_uuids)

    def test_activate_rescues_protected_windows_from_ws1(self):
        b = self._backend_wayland(windows=[
            self._win("browser-w", cls="firefox", desktop_index=1),
        ])
        b.activate_project("new", None, protected_names={"firefox"})
        rescue_calls = [c for c in b._move_windows_wayland.call_args_list
                        if c[0][1] == 0]
        rescued = rescue_calls[0][0][0] if rescue_calls else []
        self.assertIn("browser-w", rescued)

    def test_activate_calls_switch_to_desktop_zero(self):
        b = self._backend_wayland()
        b.activate_project("new", None)
        b._switch_to_desktop_wayland.assert_called_with(0)

    def test_activate_no_old_id_does_not_record(self):
        b = self._backend_wayland(windows=[self._win("w1")])
        b.activate_project("new", None)
        self.assertNotIn(None, b._project_windows)

    def test_activate_no_old_id_does_not_park_ws0_windows(self):
        b = self._backend_wayland(windows=[self._win("w1")])
        b.activate_project("new", None)
        park_calls = [c for c in b._move_windows_wayland.call_args_list
                      if c.args[1] == _HIDDEN_DESK]
        self.assertEqual(park_calls, [])

    def test_activate_only_restores_tracked_ws1_windows(self):
        b = self._backend_wayland(windows=[
            self._win("tracked", desktop_index=1),
            self._win("untracked", desktop_index=1),
        ])
        b._project_windows["new"] = ["tracked"]
        b.activate_project("new", None)
        restore_calls = [c for c in b._move_windows_wayland.call_args_list
                         if c[0][1] == 0]
        restored = restore_calls[0][0][0] if restore_calls else []
        self.assertIn("tracked", restored)
        self.assertNotIn("untracked", restored)

    def test_activate_fallback_when_enumeration_fails(self):
        b = _backend(kde_version=6)
        b._session = "wayland"
        b._desktop_uuids = []
        b._project_windows = {"old": ["tracked-w"]}
        b._enumerate_state_wayland = MagicMock(return_value=None)
        b._move_windows_wayland = MagicMock()
        b._switch_to_desktop_wayland = MagicMock()

        b.activate_project("new", "old")

        # Should still move tracked windows
        b._move_windows_wayland.assert_any_call(["tracked-w"], 1)
        b._switch_to_desktop_wayland.assert_called_with(0)

    def test_activate_dispatches_to_x11_when_session_x11(self):
        b = _backend(kde_version=6)
        b._session = "x11"
        b._project_windows = {}
        activated = []
        with patch.object(b, "_do_switch_x11",
                          side_effect=lambda *_: activated.append(1)):
            from Xlib import display as XD
            with patch.object(XD, "Display", return_value=MagicMock()):
                b.activate_project("new", "old")
        self.assertEqual(len(activated), 1)

    def test_activate_dispatches_to_wayland_when_session_wayland(self):
        b = _backend(kde_version=6)
        b._session = "wayland"
        b._project_windows = {}
        activated = []
        with patch.object(b, "_activate_wayland",
                          side_effect=lambda *_: activated.append(1)):
            b.activate_project("new", "old")
        self.assertEqual(len(activated), 1)

    def test_make_global_window_wayland_calls_sticky(self):
        b = _backend()
        b._session = "wayland"
        with patch.object(b, "_make_sticky_wayland") as sticky:
            b.make_global_window(12345)
        sticky.assert_called_once()

    def test_make_global_window_x11_uses_net_wm_state(self):
        b = _backend()
        b._session = "x11"
        mock_d = MagicMock()
        from Xlib import display as XD
        with patch.object(XD, "Display", return_value=mock_d):
            b.make_global_window(9999)
        mock_d.screen.return_value.root.send_event.assert_called_once()


# ── prepare / cleanup — Wayland ───────────────────────────────────────────────

class TestPrepareCleanupWayland(unittest.TestCase):

    def test_prepare_wayland_calls_switch_wayland(self):
        b = _backend()
        b._session = "wayland"
        with patch.object(b, "_get_desktop_count", return_value=2), \
             patch.object(b, "_create_desktop"), \
             patch.object(b, "_set_desktop_names"), \
             patch.object(b, "_switch_to_desktop_wayland") as sw, \
             patch.object(b, "_switch_to_desktop") as sx11:
            b.prepare()
        sw.assert_called_once_with(0)
        sx11.assert_not_called()

    def test_prepare_x11_calls_switch_x11(self):
        b = _backend()
        b._session = "x11"
        with patch.object(b, "_get_desktop_count", return_value=2), \
             patch.object(b, "_create_desktop"), \
             patch.object(b, "_set_desktop_names"), \
             patch.object(b, "_switch_to_desktop") as sx11, \
             patch.object(b, "_switch_to_desktop_wayland") as sw:
            b.prepare()
        sx11.assert_called_once_with(0)
        sw.assert_not_called()

    def test_cleanup_wayland_restores_hidden_windows(self):
        b = _backend()
        b._session = "wayland"
        b._created_hidden_desktop = False
        b._original_desktop_count = 2
        b._desktop_uuids = ["d0", "d1"]
        b._project_windows = {"p1": ["w1"]}
        state = {
            "desktopUUIDs": ["d0", "d1"],
            "windows": [
                {"uuid": "w1", "cls": "code", "desktops": ["d1"],
                 "onAllDesktops": False},
                {"uuid": "w2", "cls": "code", "desktops": ["d1"],
                 "onAllDesktops": False},
            ],
        }
        with patch.object(b, "_enumerate_state_wayland", return_value=state), \
             patch.object(b, "_move_windows_wayland") as move, \
             patch.object(b, "_collapse_desktop_count"):
            b.cleanup()
        move.assert_called_once_with(["w1"], 0)

    def test_cleanup_wayland_clears_project_windows(self):
        b = _backend()
        b._session = "wayland"
        b._created_hidden_desktop = False
        b._project_windows = {"p1": ["w1"]}
        with patch.object(b, "_enumerate_state_wayland", return_value=None), \
             patch.object(b, "_collapse_desktop_count"):
            b.cleanup()
        self.assertEqual(b._project_windows, {})

    def test_cleanup_wayland_collapses_desktop_if_created(self):
        b = _backend()
        b._session = "wayland"
        b._created_hidden_desktop = True
        b._original_desktop_count = 1
        with patch.object(b, "_enumerate_state_wayland", return_value=None), \
             patch.object(b, "_collapse_desktop_count") as collapse:
            b.cleanup()
        collapse.assert_called_once_with(1)
        self.assertFalse(b._created_hidden_desktop)

    def test_cleanup_x11_dispatches_to_xlib(self):
        b = _backend()
        b._session = "x11"
        b._created_hidden_desktop = False
        b._project_windows = {"p1": [10, 20]}
        with patch.object(b, "_get_windows_on_desktop", return_value=[10, 20]), \
             patch.object(b, "_move_window") as move:
            from Xlib import display as XD
            with patch.object(XD, "Display", return_value=MagicMock()):
                b.cleanup()
        self.assertEqual(move.call_count, 2)

    def test_cleanup_x11_leaves_untracked_hidden_windows(self):
        b = _backend()
        b._session = "x11"
        b._created_hidden_desktop = False
        b._project_windows = {"p1": [10]}
        with patch.object(b, "_get_windows_on_desktop", return_value=[10, 20]), \
             patch.object(b, "_move_window") as move:
            from Xlib import display as XD
            with patch.object(XD, "Display", return_value=MagicMock()):
                b.cleanup()
        moved = {c.args[1] for c in move.call_args_list}
        self.assertEqual(moved, {10})


# ── detect_backend — KDE Wayland integration ──────────────────────────────────

class TestDetectBackendKDEWayland(unittest.TestCase):

    def test_detect_returns_kde_backend_on_kde_wayland(self):
        import backends as bk
        from backends.kde_kwin import KDEKWinBackend

        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE",
                         "WAYLAND_DISPLAY": ":1"}), \
             patch.object(KDEKWinBackend, "__init__", return_value=None), \
             patch.object(KDEKWinBackend, "is_available", return_value=True):
            b = bk.detect_backend()

        self.assertIsInstance(b, KDEKWinBackend)

    def test_detect_kde_wayland_does_not_fall_to_cinnamon(self):
        import backends as bk
        from backends.kde_kwin import KDEKWinBackend
        from backends.cinnamon_x11 import CinnamonX11Backend

        cinnamon_called = []
        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "KDE",
                         "WAYLAND_DISPLAY": ":1"}), \
             patch.object(KDEKWinBackend, "__init__", return_value=None), \
             patch.object(KDEKWinBackend, "is_available", return_value=True), \
             patch.object(CinnamonX11Backend, "is_available",
                          side_effect=lambda: cinnamon_called.append(1) or True):
            bk.detect_backend()

        self.assertEqual(len(cinnamon_called), 0)

    def test_non_kde_wayland_returns_null_backend(self):
        import backends as bk
        from backends.null import NullBackend
        from backends.kde_kwin import KDEKWinBackend

        with patch.dict(os.environ,
                        {"XDG_CURRENT_DESKTOP": "sway",
                         "WAYLAND_DISPLAY": ":1"}), \
             patch.object(KDEKWinBackend, "is_available", return_value=False):
            b = bk.detect_backend()

        self.assertIsInstance(b, NullBackend)


if __name__ == "__main__":
    unittest.main()
