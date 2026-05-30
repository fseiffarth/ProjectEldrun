"""Tests for the two-workspace model in WorkspaceManager."""

import os
import sys
import unittest
from unittest.mock import MagicMock, call, patch


_XLIB_MOCKS = {
    "Xlib": MagicMock(),
    "Xlib.display": MagicMock(),
    "Xlib.X": MagicMock(),
    "Xlib.protocol": MagicMock(),
    "Xlib.protocol.event": MagicMock(),
}
for mod, mock in _XLIB_MOCKS.items():
    sys.modules.setdefault(mod, mock)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import workspace_manager as wm_module


class TestWorkspaceManager(unittest.TestCase):
    def _manager(self, backend="cinnamon"):
        manager = wm_module.WorkspaceManager()
        manager._backend = backend
        return manager

    # ── setup_two_workspaces ──────────────────────────────────────────────────

    def test_setup_creates_at_least_two_workspaces(self):
        manager = self._manager()
        with (
            patch.object(manager, "is_available", return_value=True),
            patch.object(manager, "_workspace_count", return_value=1),
            patch.object(manager, "_ensure_workspace_count") as ensure,
            patch.object(manager, "_set_workspace_names"),
        ):
            manager.setup_two_workspaces()
        ensure.assert_called_once_with(2)

    def test_setup_does_not_reduce_workspace_count_if_already_enough(self):
        manager = self._manager()
        with (
            patch.object(manager, "is_available", return_value=True),
            patch.object(manager, "_workspace_count", return_value=4),
            patch.object(manager, "_ensure_workspace_count") as ensure,
            patch.object(manager, "_set_workspace_names"),
        ):
            manager.setup_two_workspaces()
        ensure.assert_not_called()

    def test_setup_names_workspaces_eldrun_and_hidden(self):
        manager = self._manager()
        with (
            patch.object(manager, "is_available", return_value=True),
            patch.object(manager, "_workspace_count", return_value=2),
            patch.object(manager, "_ensure_workspace_count"),
            patch.object(manager, "_set_workspace_names") as set_names,
        ):
            manager.setup_two_workspaces()
        set_names.assert_called_once_with(["Eldrun", "Eldrun-Hidden"])

    def test_setup_returns_false_when_unavailable(self):
        manager = self._manager()
        with patch.object(manager, "is_available", return_value=False):
            self.assertFalse(manager.setup_two_workspaces())

    # ── switch_project ────────────────────────────────────────────────────────

    def test_switch_moves_current_windows_to_hidden(self):
        manager = self._manager()
        manager._project_windows["old"] = []

        with (
            patch.object(manager, "is_available", return_value=True),
            patch.object(manager, "_get_windows_on_desktop", side_effect=lambda idx: [10, 20] if idx == 0 else [10, 20]),
            patch.object(manager, "_move_window_to_desktop") as move,
        ):
            manager.switch_project("old", "new", eldrun_xid=None)

        move.assert_any_call(10, wm_module._HIDDEN_WS)
        move.assert_any_call(20, wm_module._HIDDEN_WS)

    def test_switch_records_windows_for_old_project(self):
        manager = self._manager()

        with (
            patch.object(manager, "is_available", return_value=True),
            patch.object(manager, "_get_windows_on_desktop", return_value=[10, 20]),
            patch.object(manager, "_move_window_to_desktop"),
        ):
            manager.switch_project("old", "new", eldrun_xid=None)

        self.assertEqual(manager._project_windows.get("old"), [10, 20])

    def test_switch_excludes_eldrun_from_move(self):
        manager = self._manager()

        with (
            patch.object(manager, "is_available", return_value=True),
            patch.object(manager, "_get_windows_on_desktop", return_value=[10, 99, 20]),
            patch.object(manager, "_move_window_to_desktop") as move,
        ):
            manager.switch_project("old", "new", eldrun_xid=99)

        moved = [c.args[0] for c in move.call_args_list]
        self.assertNotIn(99, moved)
        self.assertIn(10, moved)
        self.assertIn(20, moved)

    def test_switch_restores_known_new_project_windows(self):
        manager = self._manager()
        manager._project_windows["new"] = [30, 40]

        def fake_get_windows(idx):
            if idx == wm_module._CURRENT_WS:
                return []
            return [30, 40, 50]  # ws1 has new project's windows plus others

        with (
            patch.object(manager, "is_available", return_value=True),
            patch.object(manager, "_get_windows_on_desktop", side_effect=fake_get_windows),
            patch.object(manager, "_move_window_to_desktop") as move,
        ):
            manager.switch_project(None, "new", eldrun_xid=None)

        restore_calls = [c for c in move.call_args_list if c.args[1] == wm_module._CURRENT_WS]
        restored = {c.args[0] for c in restore_calls}
        self.assertEqual(restored, {30, 40})

    def test_switch_noop_when_unavailable(self):
        manager = self._manager()
        with (
            patch.object(manager, "is_available", return_value=False),
            patch.object(manager, "_move_window_to_desktop") as move,
        ):
            manager.switch_project("old", "new", eldrun_xid=None)
        move.assert_not_called()

    # ── on_project_closed ─────────────────────────────────────────────────────

    def test_on_project_closed_removes_tracking(self):
        manager = self._manager()
        manager._project_windows["p1"] = [10, 20]
        manager.on_project_closed("p1")
        self.assertNotIn("p1", manager._project_windows)

    def test_on_project_closed_is_noop_for_unknown_project(self):
        manager = self._manager()
        manager.on_project_closed("unknown")  # should not raise

    # ── release_all ───────────────────────────────────────────────────────────

    def test_release_all_moves_hidden_windows_to_current(self):
        manager = self._manager()
        with (
            patch.object(manager, "is_available", return_value=True),
            patch.object(manager, "_get_windows_on_desktop", return_value=[10, 20]),
            patch.object(manager, "_move_window_to_desktop") as move,
            patch.object(manager, "_ensure_workspace_count"),
        ):
            manager.release_all()

        for c in move.call_args_list:
            self.assertEqual(c.args[1], wm_module._CURRENT_WS)

    def test_release_all_clears_project_windows(self):
        manager = self._manager()
        manager._project_windows = {"p1": [10], "p2": [20]}
        with (
            patch.object(manager, "is_available", return_value=True),
            patch.object(manager, "_get_windows_on_desktop", return_value=[]),
            patch.object(manager, "_move_window_to_desktop"),
            patch.object(manager, "_ensure_workspace_count"),
        ):
            manager.release_all()
        self.assertEqual(manager._project_windows, {})

    def test_release_all_collapses_to_one_workspace(self):
        manager = self._manager()
        with (
            patch.object(manager, "is_available", return_value=True),
            patch.object(manager, "_get_windows_on_desktop", return_value=[]),
            patch.object(manager, "_move_window_to_desktop"),
            patch.object(manager, "_ensure_workspace_count") as ensure,
        ):
            manager.release_all()
        ensure.assert_called_once_with(1)

    # ── current_desktop ───────────────────────────────────────────────────────

    def test_current_desktop_delegates_to_ewmh(self):
        manager = self._manager()
        with patch.object(wm_module, "_ewmh_get_current_desktop", return_value=0):
            result = manager.current_desktop()
        self.assertEqual(result, 0)


if __name__ == "__main__":
    unittest.main()
