"""Tests for project download symlink and browser preference helpers."""

import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch


import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import downloads_manager as dm


class TestProjectDownloadsSymlink(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.tmp.name)
        self.link = self.home / "eldrun" / "downloads"
        self._patch_link = patch.object(dm, "_LINK", self.link)
        self._patch_home = patch.object(dm.pathlib.Path, "home", return_value=self.home)
        self._patch_link.start()
        self._patch_home.start()

    def tearDown(self):
        self._patch_home.stop()
        self._patch_link.stop()
        self.tmp.cleanup()

    def test_project_downloads_points_to_active_project_tmp_downloads(self):
        project_dir = self.home / "projects" / "alpha"

        dm.update_project_downloads(str(project_dir))

        expected = project_dir / "tmp" / "downloads"
        self.assertTrue(expected.is_dir())
        self.assertTrue(self.link.is_symlink())
        self.assertEqual(os.readlink(self.link), str(expected))

    def test_root_downloads_used_when_no_project_is_active(self):
        dm.update_project_downloads(None)

        expected = self.home / "eldrun" / "root" / "tmp" / "downloads"
        self.assertTrue(expected.is_dir())
        self.assertTrue(self.link.is_symlink())
        self.assertEqual(os.readlink(self.link), str(expected))

    def test_existing_downloads_symlink_is_replaced_atomically(self):
        first_project = self.home / "projects" / "first"
        second_project = self.home / "projects" / "second"

        dm.update_project_downloads(str(first_project))
        dm.update_project_downloads(str(second_project))

        self.assertEqual(
            os.readlink(self.link),
            str(second_project / "tmp" / "downloads"),
        )
        self.assertFalse((self.link.parent / "downloads.tmp").exists())


class TestBrowserDownloadPreferences(unittest.TestCase):
    def test_firefox_user_js_managed_block_is_replaced(self):
        with tempfile.TemporaryDirectory() as d:
            user_js = pathlib.Path(d) / "user.js"
            user_js.write_text(
                "user_pref(\"keep.me\", true);\n"
                + dm._FF_MARKER_START
                + "user_pref(\"old\", false);\n"
                + dm._FF_MARKER_END,
                encoding="utf-8",
            )

            dm._ff_write_user_js(user_js, {"browser.download.folderList": "2"})

            text = user_js.read_text(encoding="utf-8")
            self.assertIn('user_pref("keep.me", true);', text)
            self.assertIn('user_pref("browser.download.folderList", 2);', text)
            self.assertNotIn('user_pref("old", false);', text)
            self.assertEqual(text.count(dm._FF_MARKER_START), 1)

    def test_firefox_prefs_updates_existing_key_and_appends_missing_key(self):
        with tempfile.TemporaryDirectory() as d:
            prefs = pathlib.Path(d) / "prefs.js"
            prefs.write_text(
                'user_pref("browser.download.folderList", 1);\n',
                encoding="utf-8",
            )

            dm._ff_write_prefs(
                prefs,
                {
                    "browser.download.folderList": "2",
                    "browser.download.useDownloadDir": "true",
                },
            )

            text = prefs.read_text(encoding="utf-8")
            self.assertIn('user_pref("browser.download.folderList", 2);', text)
            self.assertIn('user_pref("browser.download.useDownloadDir", true);', text)
            self.assertNotIn('user_pref("browser.download.folderList", 1);', text)

    def test_chromium_preferences_point_to_shared_eldrun_download_link(self):
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d)
            prefs = home / ".config" / "chromium" / "Default" / "Preferences"
            prefs.parent.mkdir(parents=True)
            prefs.write_text(json.dumps({"download": {"prompt_for_download": False}}))
            link = home / "eldrun" / "downloads"

            with patch.object(dm.pathlib.Path, "home", return_value=home), \
                    patch.object(dm, "_LINK", link):
                dm._apply_chromium("chromium")

            data = json.loads(prefs.read_text())
            self.assertEqual(data["download"]["default_directory"], str(link))
            self.assertIs(data["download"]["directory_upgrade"], True)
            self.assertIs(data["download"]["prompt_for_download"], False)


if __name__ == "__main__":
    unittest.main()
