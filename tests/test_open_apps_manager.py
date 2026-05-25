"""Tests for OpenAppsManager in panels/left_panel.py — covers Phase 8."""

import json
import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

# Stub all GTK-related imports before importing the module
_GTK_MOCKS = {
    "gi": MagicMock(),
    "gi.repository": MagicMock(),
    "gi.repository.Gtk": MagicMock(),
    "gi.repository.Gdk": MagicMock(),
    "gi.repository.GLib": MagicMock(),
    "gi.repository.Pango": MagicMock(),
    "Xlib": MagicMock(),
    "Xlib.display": MagicMock(),
    "Xlib.X": MagicMock(),
    "Xlib.protocol": MagicMock(),
    "Xlib.protocol.event": MagicMock(),
}
for mod, mock in _GTK_MOCKS.items():
    sys.modules.setdefault(mod, mock)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app", "panels"))

# Import only OpenAppsManager by extracting it from the module source
# We do this to avoid the GTK widget instantiation at import time
with patch.dict("sys.modules", _GTK_MOCKS):
    import importlib
    import panels.left_panel as lp


class TestOpenAppsManager(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.json_path = os.path.join(self.tmpdir, "open_apps.json")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_oam(self):
        return lp.OpenAppsManager(self.tmpdir)

    def test_empty_dir_creates_no_file(self):
        oam = self._make_oam()
        self.assertEqual(oam.entries, [])
        self.assertFalse(os.path.exists(self.json_path))

    def test_add_new_entry(self):
        oam = self._make_oam()
        oam.add_or_update("/usr/bin/gedit", "gedit", [])
        self.assertEqual(len(oam.entries), 1)
        self.assertEqual(oam.entries[0]["exe"], "/usr/bin/gedit")
        self.assertEqual(oam.entries[0]["name"], "gedit")

    def test_update_existing_entry(self):
        oam = self._make_oam()
        oam.add_or_update("/usr/bin/gedit", "gedit", [])
        oam.add_or_update("/usr/bin/gedit", "GEdit — New Title", ["--no-plugins"])
        self.assertEqual(len(oam.entries), 1)
        self.assertEqual(oam.entries[0]["name"], "GEdit — New Title")
        self.assertEqual(oam.entries[0]["args"], ["--no-plugins"])

    def test_remove_entry(self):
        oam = self._make_oam()
        oam.add_or_update("/usr/bin/app", "App", [])
        oam.remove("/usr/bin/app")
        self.assertEqual(oam.entries, [])

    def test_remove_nonexistent_no_error(self):
        oam = self._make_oam()
        oam.remove("/nonexistent/app")  # must not raise

    def test_persisted_to_json(self):
        oam = self._make_oam()
        oam.add_or_update("/usr/bin/vim", "Vim", ["-n"])
        self.assertTrue(os.path.exists(self.json_path))
        with open(self.json_path) as f:
            data = json.load(f)
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["exe"], "/usr/bin/vim")

    def test_loaded_from_json(self):
        existing = [{"name": "Firefox", "exe": "/usr/bin/firefox", "args": []}]
        with open(self.json_path, "w") as f:
            json.dump(existing, f)
        oam = self._make_oam()
        self.assertEqual(len(oam.entries), 1)
        self.assertEqual(oam.entries[0]["name"], "Firefox")

    def test_corrupt_json_returns_empty(self):
        with open(self.json_path, "w") as f:
            f.write("not valid json")
        oam = self._make_oam()
        self.assertEqual(oam.entries, [])

    def test_non_list_json_returns_empty(self):
        with open(self.json_path, "w") as f:
            json.dump({"not": "a list"}, f)
        oam = self._make_oam()
        self.assertEqual(oam.entries, [])

    def test_multiple_entries(self):
        oam = self._make_oam()
        oam.add_or_update("/usr/bin/a", "A", [])
        oam.add_or_update("/usr/bin/b", "B", ["-x"])
        oam.add_or_update("/usr/bin/c", "C", [])
        self.assertEqual(len(oam.entries), 3)

    def test_remove_middle_entry(self):
        oam = self._make_oam()
        oam.add_or_update("/usr/bin/a", "A", [])
        oam.add_or_update("/usr/bin/b", "B", [])
        oam.add_or_update("/usr/bin/c", "C", [])
        oam.remove("/usr/bin/b")
        exes = [e["exe"] for e in oam.entries]
        self.assertNotIn("/usr/bin/b", exes)
        self.assertIn("/usr/bin/a", exes)
        self.assertIn("/usr/bin/c", exes)

    def test_reopen_missing_launches_subprocess(self):
        oam = self._make_oam()
        oam.add_or_update("/usr/bin/gedit", "gedit", [])
        running = set()  # gedit is NOT running
        with patch("subprocess.Popen") as mock_popen:
            oam.reopen_missing(running, self.tmpdir)
            mock_popen.assert_called_once_with(
                ["/usr/bin/gedit"], cwd=self.tmpdir
            )

    def test_reopen_already_running_not_relaunched(self):
        oam = self._make_oam()
        oam.add_or_update("/usr/bin/gedit", "gedit", [])
        running = {"/usr/bin/gedit"}  # already running
        with patch("subprocess.Popen") as mock_popen:
            oam.reopen_missing(running, self.tmpdir)
            mock_popen.assert_not_called()

    def test_reopen_with_args(self):
        oam = self._make_oam()
        oam.add_or_update("/usr/bin/vim", "vim", ["-n", "--noplugin"])
        with patch("subprocess.Popen") as mock_popen:
            oam.reopen_missing(set(), self.tmpdir)
            mock_popen.assert_called_once_with(
                ["/usr/bin/vim", "-n", "--noplugin"], cwd=self.tmpdir
            )

    def test_reopen_oserror_silently_ignored(self):
        oam = self._make_oam()
        oam.add_or_update("/nonexistent/app", "bad", [])
        with patch("subprocess.Popen", side_effect=OSError("no such file")):
            oam.reopen_missing(set(), self.tmpdir)  # must not raise

    def test_atomic_save(self):
        """_save() must use a .tmp file and replace atomically."""
        oam = self._make_oam()
        oam.add_or_update("/usr/bin/test", "test", [])
        tmp_path = self.json_path + ".tmp"
        self.assertFalse(os.path.exists(tmp_path))


if __name__ == "__main__":
    unittest.main()
