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

    def test_chat_role_can_be_resolved_from_installed_chat_app(self):
        with patch.object(
            gam.GLib,
            "find_program_in_path",
            side_effect=lambda name: f"/usr/bin/{name}" if name == "discord" else None,
        ):
            self.assertEqual(gam._resolve_exec("chat"), "/usr/bin/discord")


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

    def test_chat_role_uses_chat_icon_fallback_order(self):
        role = self._role("chat")

        self.assertEqual(
            gam.role_icon_names(role),
            ["internet-chat-symbolic", "user-available-symbolic", "mail-send-symbolic"],
        )
        self.assertEqual(
            gam.select_role_icon(role, lambda name: name == "user-available-symbolic"),
            "user-available-symbolic",
        )


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
            patch.object(gam, "launch_on_other_monitor", return_value=proc) as launch,
            patch.object(gam.GLib, "timeout_add") as timeout_add,
        ):
            manager.launch_or_raise("browser")

        launch.assert_called_once_with(["/usr/bin/firefox"], anchor_window=None)
        timeout_add.assert_called_once_with(500, manager._poll_and_sticky, 1234, 10)


class TestLaunchRoleForUri(unittest.TestCase):
    """Phase 5a (G6.7) — URI scheme routing through global app roles."""

    def _manager(self, browser="/usr/bin/firefox", mail=None, calendar=None):
        settings = MemorySettings({
            "global_apps": {
                "browser": {"exec": browser, "visible": True} if browser else {},
                "mail":    {"exec": mail,    "visible": True} if mail    else {},
                "calendar":{"exec": calendar,"visible": True} if calendar else {},
            },
        })
        return gam.GlobalAppsManager(settings)

    def test_http_launches_browser(self):
        manager = self._manager(browser="/usr/bin/firefox")
        with patch("global_apps_manager.launch_on_other_monitor") as launch:
            result = manager.launch_role_for_uri("http", "http://example.com")
        self.assertTrue(result)
        launch.assert_called_once_with(
            ["/usr/bin/firefox", "http://example.com"], anchor_window=None
        )

    def test_https_launches_browser(self):
        manager = self._manager(browser="/usr/bin/firefox")
        with patch("global_apps_manager.launch_on_other_monitor") as launch:
            result = manager.launch_role_for_uri("https", "https://example.com")
        self.assertTrue(result)
        launch.assert_called_once()

    def test_mailto_launches_mail_client(self):
        manager = self._manager(mail="/usr/bin/thunderbird")
        with patch("global_apps_manager.launch_on_other_monitor") as launch:
            result = manager.launch_role_for_uri("mailto", "mailto:user@example.com")
        self.assertTrue(result)
        launch.assert_called_once_with(
            ["/usr/bin/thunderbird", "mailto:user@example.com"], anchor_window=None
        )

    def test_webcal_launches_calendar(self):
        manager = self._manager(calendar="/usr/bin/gnome-calendar")
        with patch("global_apps_manager.launch_on_other_monitor") as launch:
            result = manager.launch_role_for_uri("webcal", "webcal://cal.example.com")
        self.assertTrue(result)
        launch.assert_called_once()

    def test_unknown_scheme_returns_false(self):
        manager = self._manager()
        with patch("global_apps_manager.launch_on_other_monitor") as launch:
            result = manager.launch_role_for_uri("ftp", "ftp://files.example.com")
        self.assertFalse(result)
        launch.assert_not_called()

    def test_no_exec_returns_false(self):
        manager = self._manager(browser=None)
        with patch("global_apps_manager.launch_on_other_monitor") as launch:
            result = manager.launch_role_for_uri("http", "http://example.com")
        self.assertFalse(result)
        launch.assert_not_called()

    def test_scheme_matching_is_case_insensitive(self):
        manager = self._manager(browser="/usr/bin/firefox")
        with patch("global_apps_manager.launch_on_other_monitor") as launch:
            result = manager.launch_role_for_uri("HTTP", "http://example.com")
        self.assertTrue(result)
        launch.assert_called_once()


if __name__ == "__main__":
    unittest.main()
