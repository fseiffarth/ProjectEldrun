"""Tests for the application picker dialog glue."""

import os
import sys
import types
import unittest
from unittest.mock import MagicMock, patch


gi_mock = MagicMock()
repo_mock = MagicMock()
gi_mock.repository = repo_mock
sys.modules["gi"] = gi_mock
sys.modules["gi.repository"] = repo_mock
for name in ("Gtk", "GLib"):
    mod = MagicMock()
    sys.modules[f"gi.repository.{name}"] = mod
    setattr(repo_mock, name, mod)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import app_picker


class TestAppPicker(unittest.TestCase):
    def setUp(self):
        self.gtk = MagicMock()
        app_picker.Gtk = self.gtk

    def test_file_picker_uses_matching_mime_apps_as_suggestions(self):
        apps = [
            {
                "name": "Text Editor",
                "exec": "gedit",
                "icon": "accessories-text-editor-symbolic",
                "mime_types": ["text/plain"],
            },
            {
                "name": "Code",
                "exec": "code",
                "icon": "code",
                "mime_types": ["text/x-python"],
            },
        ]

        with patch("default_apps_manager.get_installed_apps", return_value=apps), \
                patch("default_apps_manager.get_mime_for_file", return_value="text/x-python") as mime:
            app_picker.show_app_picker(lambda _cmd: None, for_file="/tmp/main.py")

        mime.assert_called_once_with("/tmp/main.py")
        listbox = self.gtk.ListBox.return_value
        self.assertGreaterEqual(listbox.append.call_count, 5)

    def test_row_activation_invokes_callback_and_closes_window(self):
        selected = []
        listbox = self.gtk.ListBox.return_value
        window = self.gtk.Window.return_value

        with patch("default_apps_manager.get_installed_apps", return_value=[]):
            app_picker.show_app_picker(selected.append)

        callbacks = {
            call.args[0]: call.args[1]
            for call in listbox.connect.call_args_list
        }
        callbacks["row-activated"](
            listbox,
            types.SimpleNamespace(app_exec="code"),
        )

        self.assertEqual(selected, ["code"])
        window.close.assert_called_once()

    def test_header_activation_is_ignored(self):
        selected = []
        listbox = self.gtk.ListBox.return_value
        window = self.gtk.Window.return_value

        with patch("default_apps_manager.get_installed_apps", return_value=[]):
            app_picker.show_app_picker(selected.append)

        callbacks = {
            call.args[0]: call.args[1]
            for call in listbox.connect.call_args_list
        }
        callbacks["row-activated"](
            listbox,
            types.SimpleNamespace(app_exec=""),
        )

        self.assertEqual(selected, [])
        window.close.assert_not_called()


if __name__ == "__main__":
    unittest.main()
