"""Tests for global app registry and launch helpers."""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch


gi_mock = MagicMock()
repo_mock = MagicMock()
glib_mock = MagicMock()
repo_mock.GLib = glib_mock
gi_mock.repository = repo_mock
sys.modules.setdefault("gi", gi_mock)
sys.modules.setdefault("gi.repository", repo_mock)
sys.modules.setdefault("gi.repository.GLib", glib_mock)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import global_apps_manager as gam


class MemorySettings:
    def __init__(self, initial=None):
        self.values = dict(initial or {})

    def get(self, key):
        return self.values.get(key)

    def set(self, key, value):
        self.values[key] = value


class TestGlobalAppsRegistry(unittest.TestCase):
    def test_registry_defaults_all_roles_visible_without_exec(self):
        manager = gam.GlobalAppsManager(MemorySettings())

        registry = manager.get_registry()

        self.assertEqual(set(registry), {role["key"] for role in gam.ROLES})
        self.assertTrue(all(entry["visible"] for entry in registry.values()))
        self.assertTrue(all(entry["exec"] is None for entry in registry.values()))

    def test_set_exec_preserves_existing_visibility(self):
        settings = MemorySettings({
            "global_apps": {"browser": {"visible": False}},
        })
        manager = gam.GlobalAppsManager(settings)

        manager.set_exec("browser", "/usr/bin/firefox")

        self.assertEqual(
            settings.values["global_apps"]["browser"],
            {"visible": False, "exec": "/usr/bin/firefox"},
        )

    def test_set_visible_preserves_existing_exec(self):
        settings = MemorySettings({
            "global_apps": {"browser": {"exec": "/usr/bin/firefox"}},
        })
        manager = gam.GlobalAppsManager(settings)

        manager.set_visible("browser", False)

        self.assertEqual(
            settings.values["global_apps"]["browser"],
            {"exec": "/usr/bin/firefox", "visible": False},
        )

    def test_populate_missing_resolves_only_empty_entries(self):
        settings = MemorySettings({
            "global_apps": {"browser": {"exec": "/custom/browser"}},
        })
        manager = gam.GlobalAppsManager(settings)

        def resolve(key):
            return "/usr/bin/notes" if key == "notes" else None

        with patch.object(gam, "_resolve_exec", side_effect=resolve):
            manager.populate_missing()

        stored = settings.values["global_apps"]
        self.assertEqual(stored["browser"]["exec"], "/custom/browser")
        self.assertEqual(stored["notes"], {"exec": "/usr/bin/notes", "visible": True})


class TestGlobalAppRoleIcons(unittest.TestCase):
    def _role(self, key: str) -> dict:
        return next(role for role in gam.ROLES if role["key"] == key)

    def test_browser_prefers_standard_internet_icon_when_available(self):
        role = self._role("browser")

        self.assertEqual(
            gam.select_role_icon(role, lambda name: name == "internet-web-browser-symbolic"),
            "internet-web-browser-symbolic",
        )

    def test_browser_falls_back_to_web_browser_icon(self):
        role = self._role("browser")

        self.assertEqual(
            gam.select_role_icon(role, lambda name: name == "web-browser-symbolic"),
            "web-browser-symbolic",
        )

    def test_mail_does_not_use_nonstandard_mail_symbolic(self):
        role = self._role("mail")

        self.assertNotIn("mail-symbolic", gam.role_icon_names(role))
        self.assertEqual(role["icon"], "internet-mail-symbolic")

    def test_single_icon_roles_remain_compatible(self):
        role = {"icon": "printer-symbolic"}

        self.assertEqual(gam.role_icon_names(role), ["printer-symbolic"])
        self.assertEqual(gam.select_role_icon(role), "printer-symbolic")


class TestGlobalAppsLaunch(unittest.TestCase):
    def test_launch_or_raise_no_exec_does_nothing(self):
        manager = gam.GlobalAppsManager(MemorySettings())

        with patch.object(gam.subprocess, "Popen") as popen:
            manager.launch_or_raise("browser")

        popen.assert_not_called()

    def test_launch_or_raise_launches_when_window_lookup_fails(self):
        settings = MemorySettings({
            "global_apps": {"browser": {"exec": "/usr/bin/firefox"}},
        })
        manager = gam.GlobalAppsManager(settings)
        proc = MagicMock()
        proc.pid = 1234

        with (
            patch.dict(sys.modules, {"Xlib": None}),
            patch.object(gam.subprocess, "Popen", return_value=proc) as popen,
            patch.object(gam.GLib, "timeout_add") as timeout_add,
        ):
            manager.launch_or_raise("browser")

        popen.assert_called_once_with(["/usr/bin/firefox"])
        timeout_add.assert_called_once_with(500, manager._poll_and_sticky, 1234, 10)


if __name__ == "__main__":
    unittest.main()
