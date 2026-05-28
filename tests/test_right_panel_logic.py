"""Tests for current BottomPanel and FileTreePanel-adjacent pure logic."""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch


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
_GTK_MOCKS["gi.repository.Gtk"].Box = object
for mod, mock in _GTK_MOCKS.items():
    sys.modules[mod] = mock
for name in ("Gtk", "Gdk", "GLib", "GObject", "Pango"):
    setattr(_GTK_MOCKS["gi.repository"], name, _GTK_MOCKS[f"gi.repository.{name}"])

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from panels.bottom_panel import project_matches_query, project_search_results
from panels.right_panel import FileTreePanel


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


class TestFileTreeHoverScrollLogic(unittest.TestCase):
    def _panel(self, text_width: int, visible_width: int = 120):
        panel = FileTreePanel.__new__(FileTreePanel)
        layout = MagicMock()
        layout.get_pixel_size.return_value = (text_width, 14)
        panel._file_tree = MagicMock()
        panel._file_tree.create_pango_layout.return_value = layout

        hadj = MagicMock()
        hadj.get_page_size.return_value = visible_width
        panel._tree_scrolled = MagicMock()
        panel._tree_scrolled.get_hadjustment.return_value = hadj
        panel._tree_scrolled.get_width.return_value = visible_width
        return panel

    def _path(self, depth: int = 1):
        path = MagicMock()
        path.get_depth.return_value = depth
        return path

    def test_short_filename_does_not_need_horizontal_scroll(self):
        panel = self._panel(text_width=50, visible_width=120)

        self.assertFalse(
            panel._tree_row_needs_horizontal_scroll(self._path(), "README.md")
        )

    def test_long_filename_needs_horizontal_scroll(self):
        panel = self._panel(text_width=160, visible_width=120)

        self.assertTrue(
            panel._tree_row_needs_horizontal_scroll(self._path(), "very-long-file.py")
        )

    def test_nested_filename_accounts_for_indent(self):
        panel = self._panel(text_width=75, visible_width=120)

        self.assertTrue(
            panel._tree_row_needs_horizontal_scroll(self._path(depth=2), "nested.py")
        )


class TestFileTreeDefaultIconLogic(unittest.TestCase):
    def _panel(self, app: str | None = "code"):
        panel = FileTreePanel.__new__(FileTreePanel)
        panel._current_project = {"directory": "/work/project"}
        panel._default_icon_cache = {}
        panel._dam = MagicMock()
        panel._dam.get_app_for_file.return_value = app
        return panel

    def test_directory_uses_folder_icon(self):
        panel = self._panel()

        self.assertEqual(
            panel._icon_for_tree_entry("/work/project/src", True),
            "folder-symbolic",
        )
        panel._dam.get_app_for_file.assert_not_called()

    def test_file_with_default_app_uses_app_icon(self):
        panel = self._panel(app="code")

        with patch("panels.right_panel._lookup_desktop_icon", return_value="code-icon"):
            self.assertEqual(
                panel._icon_for_tree_entry("/work/project/main.py", False),
                "code-icon",
            )

        panel._dam.get_app_for_file.assert_called_once_with(
            "/work/project/main.py", "/work/project"
        )

    def test_file_without_default_app_uses_generic_icon(self):
        panel = self._panel(app=None)

        self.assertEqual(
            panel._icon_for_tree_entry("/work/project/notes.txt", False),
            "text-x-generic-symbolic",
        )

    def test_file_with_default_app_but_no_icon_uses_generic_icon(self):
        panel = self._panel(app="unknown-editor")

        with patch("panels.right_panel._lookup_desktop_icon", return_value=None):
            self.assertEqual(
                panel._icon_for_tree_entry("/work/project/notes.txt", False),
                "text-x-generic-symbolic",
            )

    def test_files_with_same_extension_use_cache(self):
        panel = self._panel(app="code")

        with patch("panels.right_panel._lookup_desktop_icon", return_value="code-icon") as icon:
            self.assertEqual(
                panel._default_icon_for_file("/work/project/a.py"), "code-icon"
            )
            self.assertEqual(
                panel._default_icon_for_file("/work/project/b.py"), "code-icon"
            )

        panel._dam.get_app_for_file.assert_called_once_with(
            "/work/project/a.py", "/work/project"
        )
        icon.assert_called_once_with("code")


if __name__ == "__main__":
    unittest.main()
