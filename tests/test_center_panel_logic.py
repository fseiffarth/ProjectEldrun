"""Tests for CenterPanel-adjacent pure logic."""

import os
import sys
import unittest
from unittest.mock import MagicMock


gi_mock = MagicMock()
repo_mock = MagicMock()
gi_mock.repository = repo_mock
sys.modules.setdefault("gi", gi_mock)
sys.modules.setdefault("gi.repository", repo_mock)
for name in ("Gtk", "Gdk", "GLib", "GObject", "Vte", "Pango"):
    mod = MagicMock()
    setattr(repo_mock, name, mod)
    sys.modules.setdefault(f"gi.repository.{name}", mod)

xlib_mock = MagicMock()
display_mock = MagicMock()
x_mock = MagicMock()
protocol_mock = MagicMock()
event_mock = MagicMock()
xlib_mock.display = display_mock
xlib_mock.X = x_mock
protocol_mock.event = event_mock
sys.modules.setdefault("Xlib", xlib_mock)
sys.modules.setdefault("Xlib.display", display_mock)
sys.modules.setdefault("Xlib.X", x_mock)
sys.modules.setdefault("Xlib.protocol", protocol_mock)
sys.modules.setdefault("Xlib.protocol.event", event_mock)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from panels.center_panel import _agent_label_base, _next_numbered_label


class TestCenterPanelTabNaming(unittest.TestCase):
    def test_first_label_is_unnumbered(self):
        self.assertEqual(_next_numbered_label("Claude", set()), ("Claude", 0))

    def test_second_label_starts_at_one(self):
        self.assertEqual(_next_numbered_label("Claude", {0}), ("Claude1", 1))

    def test_lowest_available_number_is_reused(self):
        self.assertEqual(_next_numbered_label("Claude", {0, 1, 3}), ("Claude2", 2))

    def test_unnumbered_slot_is_reused_when_available(self):
        self.assertEqual(_next_numbered_label("Terminal", {1}), ("Terminal", 0))

    def test_agent_label_base_follows_command(self):
        self.assertEqual(_agent_label_base("claude"), "Claude")
        self.assertEqual(_agent_label_base("codex"), "Codex")


if __name__ == "__main__":
    unittest.main()
