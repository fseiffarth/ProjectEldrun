"""Tests for EldrunWindow layout state helpers."""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch


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
        win._file_tree_revealer = MagicMock()
        win._file_tree_strip = MagicMock()
        win._bottom_revealer = MagicMock()
        win._bottom_strip = MagicMock()
        win._file_tree_toggle_btn = MagicMock()
        win._bottom_edge_btn = MagicMock()
        win._active_project_id = "project-id"
        win._panels_hidden = False
        win._file_tree_hidden = True
        win._file_tree_auto_shown = False
        win._bottom_auto_shown = True
        win._bottom_pointer_inside = True
        win._bottom_context_menu_open = False
        win._bottom_panel_motion = None
        win._update_toggle_btn = MagicMock()
        return win

    def test_visible_bottom_bar_does_not_add_bottom_margins(self):
        win = self._window()

        win._apply_panel_visibility()

        win._bottom_revealer.set_reveal_child.assert_called_once_with(True)
        win._center_panel.set_margin_bottom.assert_called_once_with(0)
        win._file_tree_panel.set_margin_bottom.assert_called_once_with(0)
        win._bottom_strip.set_visible.assert_called_once_with(True)

    def test_hidden_bottom_bar_keeps_bottom_margins_zero(self):
        win = self._window()
        win._bottom_auto_shown = False

        win._apply_panel_visibility()

        win._bottom_revealer.set_reveal_child.assert_called_once_with(False)
        win._center_panel.set_margin_bottom.assert_called_once_with(0)
        win._file_tree_panel.set_margin_bottom.assert_called_once_with(0)
        win._bottom_strip.set_visible.assert_called_once_with(True)

    def test_bottom_panel_leave_hides_when_pointer_exits_panel(self):
        win = self._window()

        win._on_bottom_panel_leave(MagicMock())

        self.assertFalse(win._bottom_auto_shown)
        self.assertFalse(win._bottom_pointer_inside)
        win._bottom_revealer.set_reveal_child.assert_called_once_with(False)

    def test_bottom_popover_close_keeps_bar_when_pointer_is_contained(self):
        win = self._window()
        win._bottom_pointer_inside = False
        win._bottom_context_menu_open = True
        win._bottom_panel_motion = MagicMock()
        win._bottom_panel_motion.contains_pointer.return_value = True

        win._on_bottom_context_menu_open_changed(False)

        self.assertFalse(win._bottom_context_menu_open)
        self.assertTrue(win._bottom_auto_shown)
        self.assertTrue(win._bottom_pointer_inside)
        win._update_toggle_btn.assert_not_called()


class TestEldrunWindowDownloadRouting(unittest.TestCase):
    def _window(self, page_name: str):
        win = EldrunWindow.__new__(EldrunWindow)
        win._center_panel = MagicMock()
        win._center_panel._stack.get_visible_child_name.return_value = page_name
        win._file_tree_panel = MagicMock()
        win._bottom_panel = MagicMock()
        win._file_tree_revealer = MagicMock()
        win._file_tree_strip = MagicMock()
        win._bottom_revealer = MagicMock()
        win._bottom_strip = MagicMock()
        win._file_tree_toggle_btn = MagicMock()
        win._bottom_edge_btn = MagicMock()
        win._panels_hidden = False
        win._file_tree_hidden = True
        win._file_tree_auto_shown = False
        win._bottom_auto_shown = False
        win._update_toggle_btn = MagicMock()
        win._time_tracker = MagicMock()
        win._refresh_time_bars = MagicMock()
        win._active_project_id = None
        win._downloads_active_dir = object()
        win.project_manager = MagicMock()
        return win

    def test_project_page_points_shared_download_link_to_project_directory(self):
        win = self._window("project-alpha")
        project = {"id": "alpha", "directory": "/work/alpha"}
        win.project_manager.get_project.return_value = project

        with patch("window.update_project_downloads") as update_downloads:
            win._apply_panel_visibility()

        win._file_tree_panel.update_project.assert_called_once_with(project)
        win._bottom_panel.set_active_project.assert_called_once_with("alpha")
        update_downloads.assert_called_once_with("/work/alpha")

    def test_same_project_directory_does_not_rewrite_download_link(self):
        win = self._window("project-alpha")
        win._downloads_active_dir = "/work/alpha"
        win.project_manager.get_project.return_value = {
            "id": "alpha",
            "directory": "/work/alpha",
        }

        with patch("window.update_project_downloads") as update_downloads:
            win._apply_panel_visibility()

        update_downloads.assert_not_called()

    def test_root_page_points_shared_download_link_to_root_directory(self):
        win = self._window("__master__")

        with patch("window.update_project_downloads") as update_downloads:
            win._apply_panel_visibility()

        win._file_tree_panel.update_project.assert_called_once_with(None)
        win._bottom_panel.set_root_active.assert_called_once_with(True)
        update_downloads.assert_called_once_with(None)


class TestEldrunWindowWorkspaceActivation(unittest.TestCase):
    def _window(self, enabled=True):
        win = EldrunWindow.__new__(EldrunWindow)
        win.settings_manager = MagicMock()
        win.settings_manager.get.return_value = enabled
        win._workspace_manager = MagicMock()
        win._get_own_xid = MagicMock(return_value=123)
        win._global_apps_manager = MagicMock()
        win._global_apps_manager.get_exec_names.return_value = set()
        win._center_panel = MagicMock()
        win._bottom_panel = MagicMock()
        win.project_manager = MagicMock()
        win._active_project_id = None
        return win

    def test_pill_activation_always_shows_terminal(self):
        """In the new model, terminal is always shown (no workspace-gate)."""
        win = self._window(enabled=True)

        win._on_pill_activate("alpha")

        win._center_panel.show_project_terminal.assert_called_once_with("alpha")

    def test_pill_activation_calls_switch_project_with_old_and_new(self):
        """switch_project receives the previous active project and the new one."""
        win = self._window(enabled=True)
        win._active_project_id = "prev"

        with patch.object(win, "_switch_project_workspace") as switch:
            win._on_pill_activate("alpha")

        switch.assert_called_once_with("prev", "alpha")

    def test_pill_activation_passes_none_when_no_previous_project(self):
        win = self._window(enabled=True)
        win._active_project_id = None

        with patch.object(win, "_switch_project_workspace") as switch:
            win._on_pill_activate("alpha")

        switch.assert_called_once_with(None, "alpha")

    def test_switch_project_workspace_calls_workspace_manager(self):
        """_switch_project_workspace delegates to workspace_manager.switch_project."""
        win = self._window(enabled=True)

        win._switch_project_workspace("old", "new")

        win._workspace_manager.switch_project.assert_called_once_with(
            "old",
            "new",
            123,
            set(),
        )

    def test_switch_project_workspace_noop_when_disabled(self):
        win = self._window(enabled=False)

        win._switch_project_workspace("old", "new")

        win._workspace_manager.switch_project.assert_not_called()

    def test_search_activation_adds_terminal_and_switches_workspace(self):
        win = self._window(enabled=True)
        win._active_project_id = "prev"
        project = {"id": "alpha", "status": "active", "directory": "/work/alpha"}
        win.project_manager.get_project.return_value = project
        win._bottom_panel.has_project_pill.return_value = True

        with patch.object(win, "_switch_project_workspace") as switch:
            win._on_search_project_selected("alpha")

        win._center_panel.add_project_terminal.assert_called_once_with(project, show=False)
        switch.assert_called_once_with("prev", "alpha")
        win._center_panel.show_project_terminal.assert_called_once_with("alpha")


if __name__ == "__main__":
    unittest.main()
