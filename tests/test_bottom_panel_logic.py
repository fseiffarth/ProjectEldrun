"""Tests for bottom-panel add/import popover state handling."""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch


gi_mock = MagicMock()
repo_mock = MagicMock()
gi_mock.repository = repo_mock
sys.modules["gi"] = gi_mock
sys.modules["gi.repository"] = repo_mock
for name in ("Gtk", "Gdk", "GLib", "GObject", "Pango"):
    mod = MagicMock()
    sys.modules[f"gi.repository.{name}"] = mod
    setattr(repo_mock, name, mod)

sys.modules["gi.repository.Gtk"].Box = object

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from panels.bottom_panel import BottomPanel


class FakeBox:
    def __init__(self, *args, **kwargs):
        self.children = []

    def set_margin_start(self, *_):
        pass

    def set_margin_end(self, *_):
        pass

    def set_margin_top(self, *_):
        pass

    def set_margin_bottom(self, *_):
        pass

    def append(self, child):
        self.children.append(child)


class FakeButton:
    def __init__(self, label=None):
        self.label = label
        self.callbacks = {}

    def add_css_class(self, *_):
        pass

    def connect(self, signal, callback):
        self.callbacks[signal] = callback


class FakePopover:
    def __init__(self):
        self.closed_cb = None
        self.popup_called = False
        self.child = None
        self.parent = None

    def set_parent(self, parent):
        self.parent = parent

    def set_autohide(self, _autohide):
        pass

    def set_has_arrow(self, _has_arrow):
        pass

    def connect(self, signal, callback):
        if signal == "closed":
            self.closed_cb = callback

    def set_child(self, child):
        self.child = child

    def popup(self):
        self.popup_called = True

    def popdown(self):
        if self.closed_cb:
            self.closed_cb(self)


class TestBottomPanelAddPopover(unittest.TestCase):
    def _panel(self):
        panel = BottomPanel.__new__(BottomPanel)
        panel._popover = None
        panel._on_context_menu_open_changed = MagicMock()
        panel._new_project_cb = MagicMock()
        panel._import_project_cb = MagicMock()
        return panel

    def test_opening_add_popover_reports_context_open(self):
        panel = self._panel()

        with patch("panels.bottom_panel.Gtk.Popover", side_effect=FakePopover), \
                patch("panels.bottom_panel.Gtk.Box", side_effect=FakeBox), \
                patch("panels.bottom_panel.Gtk.Button", side_effect=FakeButton):
            panel._on_add_clicked(MagicMock())

        panel._on_context_menu_open_changed.assert_called_once_with(True)
        self.assertTrue(panel._popover.popup_called)

        panel._popover.closed_cb(panel._popover)

        panel._on_context_menu_open_changed.assert_has_calls([unittest.mock.call(True), unittest.mock.call(False)])

    def test_new_project_action_closes_menu_and_calls_callback(self):
        panel = self._panel()

        with patch("panels.bottom_panel.Gtk.Popover", side_effect=FakePopover), \
                patch("panels.bottom_panel.Gtk.Box", side_effect=FakeBox), \
                patch("panels.bottom_panel.Gtk.Button", side_effect=FakeButton):
            panel._on_add_clicked(MagicMock())
            new_btn = panel._popover.child.children[0]
            new_btn.callbacks["clicked"](MagicMock())

        panel._new_project_cb.assert_called_once_with()
        panel._on_context_menu_open_changed.assert_has_calls([unittest.mock.call(True), unittest.mock.call(False)])

    def test_import_project_action_closes_menu_and_calls_callback(self):
        panel = self._panel()

        with patch("panels.bottom_panel.Gtk.Popover", side_effect=FakePopover), \
                patch("panels.bottom_panel.Gtk.Box", side_effect=FakeBox), \
                patch("panels.bottom_panel.Gtk.Button", side_effect=FakeButton):
            panel._on_add_clicked(MagicMock())
            import_btn = panel._popover.child.children[1]
            import_btn.callbacks["clicked"](MagicMock())

        panel._import_project_cb.assert_called_once_with()
        panel._on_context_menu_open_changed.assert_has_calls([unittest.mock.call(True), unittest.mock.call(False)])


if __name__ == "__main__":
    unittest.main()
