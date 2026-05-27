"""Tests for project.json open-app metadata behavior."""

import json
import os
import sys
import tempfile
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
_GTK_MOCKS["gi.repository.GLib"].get_user_data_dir.return_value = "/tmp/eldrun_test"

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import project_manager as pm_module
from panels.bottom_panel import project_has_open_apps


class TestOpenAppsMetadata(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.project_dir = self.tmpdir.name
        self.project_json = os.path.join(self.project_dir, "project.json")

    def tearDown(self):
        self.tmpdir.cleanup()

    def _write_project_json(self, data):
        with open(self.project_json, "w", encoding="utf-8") as f:
            json.dump(data, f)

    def _project(self):
        return {
            "id": "p1",
            "name": "Example",
            "directory": self.project_dir,
            "local_file": self.project_json,
            "status": "active",
            "position": 0,
        }

    def test_save_local_preserves_open_apps(self):
        self._write_project_json({
            "directory": self.project_dir,
            "open_apps": [{"name": "Editor", "exe": "/usr/bin/editor"}],
        })

        pm_module.ProjectManager._save_local(object(), {
            **self._project(),
            "git_type": "private",
            "open_apps": [],
        })

        with open(self.project_json, encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["open_apps"], [
            {"name": "Editor", "exe": "/usr/bin/editor"}
        ])
        self.assertEqual(saved["name"], "Example")

    def test_project_has_open_apps_true_for_non_empty_metadata(self):
        self._write_project_json({"open_apps": [{"name": "Editor"}]})
        self.assertTrue(project_has_open_apps(self._project()))

    def test_project_has_open_apps_false_for_empty_or_missing_metadata(self):
        self._write_project_json({"open_apps": []})
        self.assertFalse(project_has_open_apps(self._project()))

        os.remove(self.project_json)
        self.assertFalse(project_has_open_apps(self._project()))

    def test_project_has_open_apps_false_for_corrupt_json(self):
        with open(self.project_json, "w", encoding="utf-8") as f:
            f.write("not json")
        self.assertFalse(project_has_open_apps(self._project()))


if __name__ == "__main__":
    unittest.main()
