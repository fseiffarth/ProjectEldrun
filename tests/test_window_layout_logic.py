"""Tests for EldrunWindow layout state helpers."""

import os
import sys
import unittest
from unittest.mock import MagicMock


gi_mock = sys.modules.setdefault("gi", MagicMock())
repo_mock = sys.modules.setdefault("gi.repository", MagicMock())
gi_mock.repository = repo_mock
for name in ("Gtk", "Adw", "Gdk", "GLib"):
    mod = sys.modules.setdefault(f"gi.repository.{name}", MagicMock())
    setattr(repo_mock, name, mod)

sys.modules["gi.repository.Adw"].ApplicationWindow = object

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from window import EldrunWindow


class TestEldrunWindowBottomOverlay(unittest.TestCase):
    def _window(self):
        win = EldrunWindow.__new__(EldrunWindow)
        win._center_panel = MagicMock()
        win._center_panel._stack.get_visible_child_name.return_value = "agent-1"
        win._file_tree_panel = MagicMock()
        win._bottom_panel = MagicMock()
        win._file_tree_toggle_btn = MagicMock()
        win._bottom_edge_btn = MagicMock()
        win._active_project_id = "project-id"
        win._panels_hidden = False
        win._file_tree_hidden = True
        win._file_tree_auto_shown = False
        win._bottom_auto_shown = True
        win._update_toggle_btn = MagicMock()
        return win

    def test_visible_bottom_bar_does_not_add_bottom_margins(self):
        win = self._window()

        win._apply_panel_visibility()

        win._bottom_panel.set_visible.assert_called_once_with(True)
        win._center_panel.set_margin_bottom.assert_called_once_with(0)
        win._file_tree_panel.set_margin_bottom.assert_called_once_with(0)
        win._bottom_edge_btn.set_visible.assert_called_once_with(False)

    def test_hidden_bottom_bar_keeps_bottom_margins_zero(self):
        win = self._window()
        win._bottom_auto_shown = False

        win._apply_panel_visibility()

        win._bottom_panel.set_visible.assert_called_once_with(False)
        win._center_panel.set_margin_bottom.assert_called_once_with(0)
        win._file_tree_panel.set_margin_bottom.assert_called_once_with(0)
        win._bottom_edge_btn.set_visible.assert_called_once_with(True)


if __name__ == "__main__":
    unittest.main()
