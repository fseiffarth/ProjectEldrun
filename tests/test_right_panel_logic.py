"""Tests for current BottomPanel and FileTreePanel-adjacent pure logic."""

import os
import sys
import unittest
from unittest.mock import MagicMock


_GTK_MOCKS = {
    "gi": MagicMock(),
    "gi.repository": MagicMock(),
    "gi.repository.Gtk": MagicMock(),
    "gi.repository.Gdk": MagicMock(),
    "gi.repository.GLib": MagicMock(),
    "gi.repository.GObject": MagicMock(),
    "gi.repository.Pango": MagicMock(),
    "Xlib": MagicMock(),
    "Xlib.display": MagicMock(),
    "Xlib.X": MagicMock(),
    "Xlib.protocol": MagicMock(),
    "Xlib.protocol.event": MagicMock(),
}
for mod, mock in _GTK_MOCKS.items():
    sys.modules.setdefault(mod, mock)
for name in ("Gtk", "Gdk", "GLib", "GObject", "Pango"):
    setattr(_GTK_MOCKS["gi.repository"], name, _GTK_MOCKS[f"gi.repository.{name}"])

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from panels.bottom_panel import project_matches_query, project_search_results


class TestProjectSearchLogic(unittest.TestCase):
    def setUp(self):
        self.projects = [
            {
                "id": "inactive",
                "name": "Inactive API",
                "directory": "/work/hidden-api",
                "status": "inactive",
                "position": 20,
            },
            {
                "id": "current",
                "name": "Current UI",
                "directory": "/work/current-ui",
                "status": "current",
                "position": 10,
            },
            {
                "id": "active",
                "name": "Active Backend",
                "directory": "/work/backend",
                "status": "active",
                "position": 30,
            },
        ]

    def test_search_includes_inactive_projects(self):
        results = project_search_results(self.projects, "inactive")
        self.assertEqual([p["id"] for p in results], ["inactive"])

    def test_search_matches_directory(self):
        results = project_search_results(self.projects, "backend")
        self.assertEqual([p["id"] for p in results], ["active"])

    def test_search_is_case_insensitive(self):
        self.assertTrue(project_matches_query(self.projects[1], "CURRENT"))

    def test_empty_query_does_not_match(self):
        self.assertFalse(project_matches_query(self.projects[1], ""))

    def test_results_are_ordered_by_bottom_bar_position(self):
        results = project_search_results(self.projects, "i")
        self.assertEqual([p["id"] for p in results], ["current", "inactive", "active"])


if __name__ == "__main__":
    unittest.main()
