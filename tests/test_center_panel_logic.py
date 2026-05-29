"""Tests for CenterPanel-adjacent pure logic."""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch


gi_mock = MagicMock()
repo_mock = MagicMock()
gi_mock.repository = repo_mock
sys.modules.setdefault("gi", gi_mock)
sys.modules.setdefault("gi.repository", repo_mock)
for name in ("Gtk", "Gdk", "GLib", "GObject", "Vte", "Pango"):
    mod = MagicMock()
    setattr(repo_mock, name, mod)
    sys.modules.setdefault(f"gi.repository.{name}", mod)
sys.modules["gi.repository.Gtk"].Box = object

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from panels.center_panel import (
    CenterPanel,
    _agent_label_base,
    _next_numbered_label,
    _normalize_scheme,
    _normalize_task_title,
    _task_preview,
    _task_stdin_text,
    _terminal_command_name,
)


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

    def test_terminal_command_defaults_to_claude(self):
        self.assertEqual(_terminal_command_name(None), "claude")

    def test_terminal_command_uses_settings_value(self):
        settings = MagicMock()
        settings.get.return_value = "codex"
        self.assertEqual(_terminal_command_name(settings), "codex")
        settings.get.assert_called_once_with("terminal_command")

    def test_theme_normalization_accepts_fancy_variants(self):
        self.assertEqual(_normalize_scheme("fancy_dark"), "fancy_dark")
        self.assertEqual(_normalize_scheme("fancy_light"), "fancy_light")

    def test_theme_normalization_maps_legacy_fancy_to_dark(self):
        self.assertEqual(_normalize_scheme("fancy"), "fancy_dark")

    def test_task_title_normalization_collapses_whitespace(self):
        self.assertEqual(_normalize_task_title("  Fix   the\nthing\tsoon  "), "Fix the thing soon")

    def test_task_preview_truncates_after_word_limit(self):
        text = " ".join(f"w{i}" for i in range(53))
        self.assertEqual(
            _task_preview(text, word_limit=50),
            " ".join(f"w{i}" for i in range(50)) + "...",
        )

    def test_task_preview_does_not_add_ellipsis_when_short(self):
        self.assertEqual(_task_preview("Fix tab task tracking", word_limit=50), "Fix tab task tracking")

    def test_task_stdin_text_normalizes_and_appends_newline(self):
        self.assertEqual(_task_stdin_text("  Fix   it\nnow "), "Fix it now\n")

    def test_task_stdin_text_is_empty_for_blank_input(self):
        self.assertEqual(_task_stdin_text(" \n\t "), "")


class TestCenterPanelAgentTaskFlow(unittest.TestCase):
    def test_feed_agent_task_writes_normalized_task_to_terminal(self):
        panel = CenterPanel.__new__(CenterPanel)
        terminal = MagicMock()

        result = panel._feed_agent_task(terminal, "  Fix   the\nthing  ")

        self.assertFalse(result)
        terminal.feed_child.assert_called_once_with(b"Fix the thing\n")

    def test_feed_agent_task_ignores_blank_task(self):
        panel = CenterPanel.__new__(CenterPanel)
        terminal = MagicMock()

        result = panel._feed_agent_task(terminal, " \n\t ")

        self.assertFalse(result)
        terminal.feed_child.assert_not_called()

    def test_add_agent_terminal_sets_and_feeds_initial_task(self):
        import panels.center_panel as cp

        panel = CenterPanel.__new__(CenterPanel)
        panel._agent_info = {}
        panel._tab_project = {}
        panel._terminals = {}
        panel._terminal_pids = {}
        panel._stack = MagicMock()
        panel._current_agent_directory = MagicMock(return_value="/work/project")
        panel._current_project_id = MagicMock(return_value="project-id")
        panel._next_agent_number = MagicMock(return_value=1)
        panel._used_tab_label_indices = MagicMock(return_value=set())
        panel._make_terminal = MagicMock(return_value=MagicMock())
        panel._add_tab = MagicMock()
        panel._set_agent_task = MagicMock()
        panel._notify_page = MagicMock()
        panel._on_agent_exited = MagicMock()

        def fake_spawn(_terminal, _directory, _cmd, callback):
            callback(_terminal, 1234, None)

        with patch.object(cp, "_spawn", side_effect=fake_spawn), \
                patch.object(
                    cp.GLib,
                    "timeout_add",
                    return_value=1,
                ) as timeout_add:
            panel._add_agent_terminal("claude", task_title="  Review   tests ")

        terminal = panel._make_terminal.return_value
        panel._stack.add_named.assert_called_once_with(terminal, "agent-1")
        self.assertEqual(panel._tab_project["agent-1"], "project-id")
        self.assertEqual(panel._terminal_pids["agent-1"], 1234)
        panel._set_agent_task.assert_called_once_with(
            "agent-1",
            "Review tests",
            "active",
        )
        timeout_add.assert_called_once_with(
            350,
            panel._feed_agent_task,
            terminal,
            "Review tests",
        )


if __name__ == "__main__":
    unittest.main()
