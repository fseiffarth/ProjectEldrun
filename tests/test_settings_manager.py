"""Tests for settings_manager.py — covers Phase 0 foundation."""

import json
import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Stub out gi so the module can be imported without GTK installed on CI.
# ---------------------------------------------------------------------------
gi_mock = MagicMock()
sys.modules.setdefault("gi", gi_mock)
sys.modules.setdefault("gi.repository", gi_mock.repository)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))


class TestSettingsManager(unittest.TestCase):
    def _make_manager(self, data_dir: str):
        settings_file = os.path.join(data_dir, "settings.json")
        glib_mock = MagicMock()
        glib_mock.get_user_data_dir.return_value = data_dir

        with patch.dict("sys.modules", {"gi.repository.GLib": glib_mock}):
            import importlib
            import settings_manager as sm
            importlib.reload(sm)
            # Override module-level constant to use our tmpdir
            sm._SETTINGS_FILE = settings_file
            return sm.SettingsManager(), sm

    def test_default_value(self):
        with tempfile.TemporaryDirectory() as d:
            mgr, _ = self._make_manager(d)
            self.assertEqual(mgr.get("terminal_command"), "claude")

    def test_missing_key_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            mgr, _ = self._make_manager(d)
            self.assertIsNone(mgr.get("nonexistent_key"))

    def test_set_and_get(self):
        with tempfile.TemporaryDirectory() as d:
            mgr, sm = self._make_manager(d)
            mgr.set("terminal_command", "codex")
            self.assertEqual(mgr.get("terminal_command"), "codex")

    def test_persisted_across_instances(self):
        with tempfile.TemporaryDirectory() as d:
            mgr, sm = self._make_manager(d)
            mgr.set("terminal_command", "codex")

            mgr2, _ = self._make_manager(d)
            self.assertEqual(mgr2.get("terminal_command"), "codex")

    def test_corrupt_file_falls_back_to_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            settings_file = os.path.join(d, "settings.json")
            with open(settings_file, "w") as f:
                f.write("not valid json{{{{")

            glib_mock = MagicMock()
            glib_mock.get_user_data_dir.return_value = d
            import importlib
            import settings_manager as sm
            importlib.reload(sm)
            sm._SETTINGS_FILE = settings_file
            mgr = sm.SettingsManager()
            # Should fall back to defaults, not crash
            self.assertEqual(mgr.get("terminal_command"), "claude")

    def test_set_custom_key(self):
        with tempfile.TemporaryDirectory() as d:
            mgr, _ = self._make_manager(d)
            mgr.set("color_scheme", "light")
            self.assertEqual(mgr.get("color_scheme"), "light")

    def test_atomic_write(self):
        """_save() must use a .tmp file and atomically replace the target."""
        with tempfile.TemporaryDirectory() as d:
            mgr, sm = self._make_manager(d)
            mgr.set("terminal_command", "test_cmd")
            settings_file = sm._SETTINGS_FILE
            # .tmp file must not exist after save
            self.assertFalse(os.path.exists(settings_file + ".tmp"))
            self.assertTrue(os.path.exists(settings_file))

    def test_overwrite_existing_file(self):
        with tempfile.TemporaryDirectory() as d:
            mgr, sm = self._make_manager(d)
            mgr.set("terminal_command", "v1")
            mgr.set("terminal_command", "v2")
            self.assertEqual(mgr.get("terminal_command"), "v2")
            # Verify file contents
            with open(sm._SETTINGS_FILE) as f:
                data = json.load(f)
            self.assertEqual(data["terminal_command"], "v2")


if __name__ == "__main__":
    unittest.main()
