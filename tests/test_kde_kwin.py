"""Tests for backends/kde_kwin.py — Phase 6a (KDE Plasma / X11)."""

import os
import sys
import subprocess
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


def _backend(kde_version: int = 6) -> KDEKWinBackend:
    b = KDEKWinBackend.__new__(KDEKWinBackend)
    b._kde_version = kde_version
    b._project_windows = {}
    b._created_hidden_desktop = False
    b._original_desktop_count = 1
    return b


# ── detection ─────────────────────────────────────────────────────────────────

class TestKDEDetection(unittest.TestCase):

    def test_is_available_returns_false_on_wayland(self):
        b = _backend()
        with patch.dict(os.environ,
                        {"WAYLAND_DISPLAY": ":1",
                         "XDG_CURRENT_DESKTOP": "KDE"}):
            self.assertFalse(b.is_available())

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
        b = _backend()
        with patch("subprocess.run", return_value=_ok()) as run:
            b._collapse_desktop_count(1)
        cmd = run.call_args[0][0]
        self.assertIn("wmctrl", cmd)
        self.assertIn("1", cmd)

    def test_collapse_desktop_count_clamps_to_minimum_one(self):
        b = _backend()
        with patch("subprocess.run", return_value=_ok()) as run:
            b._collapse_desktop_count(0)
        cmd = run.call_args[0][0]
        self.assertIn("1", cmd)

    def test_collapse_desktop_count_ignores_wmctrl_error(self):
        b = _backend()
        with patch("subprocess.run", side_effect=FileNotFoundError):
            b._collapse_desktop_count(1)  # must not raise

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

    def test_detect_kde_wayland_returns_null_backend(self):
        """KDE on Wayland falls through to NullBackend in Phase 6a."""
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


if __name__ == "__main__":
    unittest.main()
