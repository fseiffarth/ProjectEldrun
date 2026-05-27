"""Tests for project workspace assignment logic."""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch


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
    def _manager(self):
        manager = wm_module.WorkspaceManager()
        manager._backend = "cinnamon"
        return manager

    def test_reconcile_assigns_projects_from_first_workspace(self):
        manager = self._manager()
        projects = [
            {"id": "p1", "name": "ProjectEldrun"},
            {"id": "p2", "name": "New"},
            {"id": "p3", "name": "ExampleOne"},
        ]

        with (
            patch.object(manager, "is_available", return_value=True),
            patch.object(manager, "_ensure_workspace_count") as ensure_count,
            patch.object(manager, "_set_workspace_names") as set_names,
        ):
            assignments = manager.reconcile(projects)

        self.assertEqual(assignments, {"p1": 0, "p2": 1, "p3": 2})
        ensure_count.assert_called_once_with(3)
        set_names.assert_called_once_with(["ProjectEldrun", "New", "ExampleOne"])

    def test_reconcile_clears_removed_project_assignment(self):
        manager = self._manager()

        with (
            patch.object(manager, "is_available", return_value=True),
            patch.object(manager, "_ensure_workspace_count"),
            patch.object(manager, "_set_workspace_names"),
        ):
            manager.reconcile([
                {"id": "p1", "name": "ProjectEldrun"},
                {"id": "p2", "name": "New"},
            ])
            assignments = manager.reconcile([
                {"id": "p2", "name": "New"},
            ])

        self.assertEqual(assignments, {"p2": 0})
        self.assertIsNone(manager.get_assignment("p1"))

    def test_activate_uses_zero_based_workspace_index(self):
        manager = self._manager()
        manager._assignments = {"p2": 1}

        with (
            patch.object(manager, "is_available", return_value=True),
            patch.object(manager, "_wm_eval", return_value="ok") as wm_eval,
            patch.object(wm_module, "_ewmh_switch") as ewmh_switch,
        ):
            manager.activate("p2")

        self.assertIn("get_workspace_by_index(1)", wm_eval.call_args.args[0])
        ewmh_switch.assert_not_called()

    def test_release_all_leaves_single_workspace(self):
        manager = self._manager()
        manager._assignments = {"p1": 0, "p2": 1}
        manager._names = {"p1": "ProjectEldrun", "p2": "New"}

        with (
            patch.object(manager, "is_available", return_value=True),
            patch.object(manager, "_ensure_workspace_count") as ensure_count,
        ):
            manager.release_all()

        self.assertEqual(manager._assignments, {})
        self.assertEqual(manager._names, {})
        ensure_count.assert_called_once_with(1)


if __name__ == "__main__":
    unittest.main()
