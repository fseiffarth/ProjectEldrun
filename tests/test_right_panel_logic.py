"""Tests for current BottomPanel and FileTreePanel-adjacent pure logic."""

import os
import sys
import types
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


class TestFileTreeContextMenuState(unittest.TestCase):
    def _panel(self):
        panel = FileTreePanel.__new__(FileTreePanel)
        panel._context_popover = None
        panel._context_menu_open = False
        panel._context_events = []
        panel._on_context_menu_open_changed = panel._context_events.append
        return panel

    def test_context_menu_open_callback_only_fires_on_state_change(self):
        panel = self._panel()

        panel._set_context_menu_open(True)
        panel._set_context_menu_open(True)
        panel._set_context_menu_open(False)

        self.assertEqual(panel._context_events, [True, False])

    def test_context_popover_close_reports_menu_closed(self):
        panel = self._panel()
        popover = object()
        panel._context_popover = popover
        panel._context_menu_open = True

        panel._on_context_popover_closed(popover)

        self.assertIsNone(panel._context_popover)
        self.assertEqual(panel._context_events, [False])

    def test_replacing_context_popover_does_not_report_closed_between_menus(self):
        class FakePopover:
            def __init__(self):
                self.closed_cb = None
                self.popdown_called = False

            def set_parent(self, _parent):
                pass

            def set_has_arrow(self, _has_arrow):
                pass

            def set_pointing_to(self, _rect):
                pass

            def connect(self, signal, callback):
                if signal == "closed":
                    self.closed_cb = callback

            def popdown(self):
                self.popdown_called = True
                if self.closed_cb:
                    self.closed_cb(self)

        panel = self._panel()

        with patch("panels.right_panel.Gtk.Popover", side_effect=FakePopover), \
                patch(
                    "panels.right_panel.Gdk.Rectangle",
                    side_effect=lambda: types.SimpleNamespace(),
                ):
            first = panel._new_context_popover(object(), 1, 2)
            second = panel._new_context_popover(object(), 3, 4)

        self.assertTrue(first.popdown_called)
        self.assertIs(panel._context_popover, second)
        self.assertEqual(panel._context_events, [True])

        second.closed_cb(second)

        self.assertIsNone(panel._context_popover)
        self.assertEqual(panel._context_events, [True, False])


class TestFileTreeLaunchRouting(unittest.TestCase):
    def _panel(self):
        panel = FileTreePanel.__new__(FileTreePanel)
        panel._current_project = {"id": "proj1", "directory": "/work/project"}
        panel._dam = MagicMock()
        panel._refresh_default_app_icons = MagicMock()
        panel._show_choose_app_dialog = MagicMock()
        panel._on_file_opened = None
        panel.get_root = MagicMock(return_value=MagicMock())
        return panel

    def test_open_file_uses_shared_launch_helper(self):
        panel = self._panel()
        panel._dam.get_app_for_file.return_value = "code"

        with patch("panels.right_panel.Gtk.Window", object), \
                patch("panels.right_panel.launch_on_other_monitor", return_value=MagicMock()) as launch:
            panel._open_file("/work/project/main.py")

        launch.assert_called_once_with(
            ["code", "/work/project/main.py"],
            cwd="/work/project",
            anchor_window=panel.get_root.return_value,
        )
        panel._show_choose_app_dialog.assert_not_called()

    def test_reveal_in_fm_uses_shared_launch_helper(self):
        panel = self._panel()

        with patch("panels.right_panel.Gtk.Window", object), \
                patch("panels.right_panel.launch_on_other_monitor", return_value=MagicMock()) as launch:
            panel._reveal_in_fm("/work/project/src/main.py")

        launch.assert_called_once_with(
            ["xdg-open", "/work/project/src"],
            cwd=None,
            anchor_window=panel.get_root.return_value,
        )


if __name__ == "__main__":
    unittest.main()
