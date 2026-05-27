"""Tests for eldrun.py theme normalization."""

import os
import sys
import unittest
from unittest.mock import MagicMock


gi_mock = MagicMock()
repo_mock = MagicMock()
gi_mock.repository = repo_mock
sys.modules.setdefault("gi", gi_mock)
sys.modules.setdefault("gi.repository", repo_mock)
for name in ("Gtk", "Adw", "Gdk", "GLib", "Vte"):
    mod = MagicMock()
    setattr(repo_mock, name, mod)
    sys.modules.setdefault(f"gi.repository.{name}", mod)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from eldrun import _normalize_theme, _should_use_cairo_renderer


class TestEldrunThemeNormalization(unittest.TestCase):
    def test_accepts_fancy_variants(self):
        self.assertEqual(_normalize_theme("fancy_dark"), "fancy_dark")
        self.assertEqual(_normalize_theme("fancy_light"), "fancy_light")

    def test_maps_legacy_fancy_to_dark(self):
        self.assertEqual(_normalize_theme("fancy"), "fancy_dark")

    def test_bool_compatibility_remains(self):
        self.assertEqual(_normalize_theme(True), "dark")
        self.assertEqual(_normalize_theme(False), "light")

    def test_cairo_renderer_workaround_targets_cinnamon_x11(self):
        env = {"XDG_SESSION_TYPE": "x11", "XDG_CURRENT_DESKTOP": "X-Cinnamon"}
        self.assertTrue(_should_use_cairo_renderer(env))

    def test_cairo_renderer_workaround_honors_existing_renderer(self):
        env = {
            "XDG_SESSION_TYPE": "x11",
            "XDG_CURRENT_DESKTOP": "X-Cinnamon",
            "GSK_RENDERER": "gl",
        }
        self.assertFalse(_should_use_cairo_renderer(env))

    def test_cairo_renderer_workaround_can_be_disabled(self):
        env = {
            "XDG_SESSION_TYPE": "x11",
            "XDG_CURRENT_DESKTOP": "X-Cinnamon",
            "ELDRUN_DISABLE_RENDERER_WORKAROUND": "1",
        }
        self.assertFalse(_should_use_cairo_renderer(env))

    def test_cairo_renderer_workaround_does_not_target_wayland(self):
        env = {"XDG_SESSION_TYPE": "wayland", "XDG_CURRENT_DESKTOP": "X-Cinnamon"}
        self.assertFalse(_should_use_cairo_renderer(env))


if __name__ == "__main__":
    unittest.main()
