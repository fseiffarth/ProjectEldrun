"""Tests for workspace_core.py — ABC and ProjectWindowRegistry."""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from workspace_core import ProjectSpaceBackend, ProjectWindowRegistry


class ConcreteBackend(ProjectSpaceBackend):
    """Minimal concrete subclass for testing the ABC defaults."""

    def is_available(self) -> bool:
        return True


class TestProjectSpaceBackendDefaults(unittest.TestCase):
    def setUp(self):
        self.backend = ConcreteBackend()

    def test_prepare_is_noop(self):
        self.backend.prepare()  # must not raise

    def test_open_project_is_noop(self):
        self.backend.open_project("proj1")  # must not raise

    def test_close_project_is_noop(self):
        self.backend.close_project("proj1")

    def test_activate_project_is_noop(self):
        self.backend.activate_project("proj1", "proj0", eldrun_xid=1, protected_names={"foo"})

    def test_assign_window_is_noop(self):
        self.backend.assign_window_to_project(1234, "proj1")

    def test_make_global_window_is_noop(self):
        self.backend.make_global_window(1234)

    def test_has_managed_windows_defaults_false(self):
        self.assertFalse(self.backend.has_managed_windows())

    def test_cleanup_is_noop(self):
        self.backend.cleanup()

    def test_is_available_must_be_implemented(self):
        with self.assertRaises(TypeError):
            ProjectSpaceBackend()  # can't instantiate ABC directly


class TestProjectWindowRegistry(unittest.TestCase):
    def setUp(self):
        self.reg = ProjectWindowRegistry()

    def test_assign_and_get(self):
        self.reg.assign(100, "proj1")
        self.assertEqual(self.reg.get_project(100), "proj1")

    def test_get_unknown_xid_returns_none(self):
        self.assertIsNone(self.reg.get_project(999))

    def test_remove_xid(self):
        self.reg.assign(100, "proj1")
        self.reg.remove(100)
        self.assertIsNone(self.reg.get_project(100))

    def test_remove_unknown_xid_is_noop(self):
        self.reg.remove(999)  # must not raise

    def test_get_xids_for_project(self):
        self.reg.assign(100, "proj1")
        self.reg.assign(200, "proj1")
        self.reg.assign(300, "proj2")
        xids = set(self.reg.get_xids("proj1"))
        self.assertEqual(xids, {100, 200})

    def test_get_xids_for_unknown_project(self):
        self.assertEqual(self.reg.get_xids("unknown"), [])

    def test_clear_project_removes_its_xids(self):
        self.reg.assign(100, "proj1")
        self.reg.assign(200, "proj2")
        self.reg.clear_project("proj1")
        self.assertIsNone(self.reg.get_project(100))
        self.assertEqual(self.reg.get_project(200), "proj2")

    def test_len(self):
        self.reg.assign(100, "p1")
        self.reg.assign(200, "p2")
        self.assertEqual(len(self.reg), 2)


class TestNullBackend(unittest.TestCase):
    def test_is_always_available(self):
        from backends.null import NullBackend
        self.assertTrue(NullBackend().is_available())

    def test_all_methods_are_noop(self):
        from backends.null import NullBackend
        b = NullBackend()
        b.prepare()
        b.open_project("p1")
        b.close_project("p1")
        b.activate_project("p1", None)
        b.assign_window_to_project(1, "p1")
        b.make_global_window(1)
        b.cleanup()
        self.assertFalse(b.has_managed_windows())


class TestDetectBackend(unittest.TestCase):
    def test_wayland_session_returns_null_backend(self):
        import backends as bk
        from backends.null import NullBackend

        env = {"WAYLAND_DISPLAY": ":1", "XDG_CURRENT_DESKTOP": "GNOME"}
        with patch.dict(os.environ, env, clear=False):
            b = bk.detect_backend()

        self.assertIsInstance(b, NullBackend)

    def test_x11_unavailable_returns_null_backend(self):
        import backends as bk
        from backends.null import NullBackend
        from backends.cinnamon_x11 import CinnamonX11Backend

        with patch.dict(os.environ, {}, clear=True), \
                patch.object(CinnamonX11Backend, "is_available", return_value=False), \
                patch.object(CinnamonX11Backend, "__init__", return_value=None):
            b = bk.detect_backend()

        self.assertIsInstance(b, NullBackend)

    def test_x11_available_returns_cinnamon_backend(self):
        import backends as bk
        from backends.cinnamon_x11 import CinnamonX11Backend

        with patch.dict(os.environ, {}, clear=True), \
                patch.object(CinnamonX11Backend, "is_available", return_value=True), \
                patch.object(CinnamonX11Backend, "__init__", return_value=None):
            b = bk.detect_backend()

        self.assertIsInstance(b, CinnamonX11Backend)


class TestCinnamonX11Backend(unittest.TestCase):
    def _backend(self):
        from backends.cinnamon_x11 import CinnamonX11Backend
        b = CinnamonX11Backend.__new__(CinnamonX11Backend)
        b._wm = MagicMock()
        return b

    def test_is_available_delegates(self):
        b = self._backend()
        b._wm.is_available.return_value = True
        self.assertTrue(b.is_available())

    def test_prepare_calls_setup_two_workspaces(self):
        b = self._backend()
        b.prepare()
        b._wm.setup_two_workspaces.assert_called_once()

    def test_activate_project_delegates_to_switch_project(self):
        b = self._backend()
        b.activate_project("new", "old", eldrun_xid=99, protected_names={"browser"})
        b._wm.switch_project.assert_called_once_with("old", "new", 99, {"browser"})

    def test_close_project_delegates(self):
        b = self._backend()
        b.close_project("p1")
        b._wm.on_project_closed.assert_called_once_with("p1")

    def test_cleanup_delegates_to_release_all(self):
        b = self._backend()
        b.cleanup()
        b._wm.release_all.assert_called_once()

    def test_has_managed_windows_reflects_wm_state(self):
        b = self._backend()
        b._wm._project_windows = {}
        self.assertFalse(b.has_managed_windows())
        b._wm._project_windows = {"p1": [10]}
        self.assertTrue(b.has_managed_windows())


if __name__ == "__main__":
    unittest.main()
