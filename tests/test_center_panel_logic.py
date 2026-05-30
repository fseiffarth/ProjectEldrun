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
    _project_sandbox_envv,
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
        self.assertEqual(_agent_label_base("gemini"), "Gemini")

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

    def test_project_sandbox_envv_scopes_runtime_dirs_to_project(self):
        envv = _project_sandbox_envv("/work/project")
        self.assertIsNotNone(envv)
        env = dict(item.split("=", 1) for item in envv)
        self.assertEqual(env["ELDRUN_PROJECT_DIR"], "/work/project")
        self.assertEqual(env["ELDRUN_SANDBOX_MODE"], "project")
        self.assertEqual(env["XDG_CONFIG_HOME"], "/work/project/.eldrun/sandbox/config")
        self.assertEqual(env["XDG_CACHE_HOME"], "/work/project/.eldrun/sandbox/cache")
        self.assertEqual(env["XDG_DATA_HOME"], "/work/project/.eldrun/sandbox/data")
        self.assertEqual(env["XDG_STATE_HOME"], "/work/project/.eldrun/sandbox/state")
        self.assertEqual(env["TMPDIR"], "/work/project/.eldrun/sandbox/tmp")
        self.assertEqual(env["PYTHONPYCACHEPREFIX"], "/work/project/.eldrun/sandbox/cache/pycache")


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

        def fake_spawn(_terminal, _directory, _cmd, callback, envv=None):
            self.assertIsNotNone(envv)
            env = dict(item.split("=", 1) for item in envv)
            self.assertEqual(env["ELDRUN_PROJECT_DIR"], "/work/project")
            self.assertEqual(env["ELDRUN_SANDBOX_MODE"], "project")
            self.assertEqual(env["XDG_CONFIG_HOME"], "/work/project/.eldrun/sandbox/config")
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

    def test_notify_page_schedules_focus_for_visible_terminal(self):
        import panels.center_panel as cp

        panel = CenterPanel.__new__(CenterPanel)
        terminal = MagicMock()
        panel._tab_widgets = {"agent-1": MagicMock()}
        panel._terminals = {"agent-1": terminal}
        panel._stack = MagicMock()
        panel._stack.get_visible_child_name.return_value = "agent-1"
        panel._focus_request_serial = 0
        panel._on_page_changed = MagicMock()

        with patch.object(cp.GLib, "idle_add", side_effect=lambda cb: cb()) as idle_add:
            panel._notify_page("agent-1")

        idle_add.assert_called_once()
        terminal.grab_focus.assert_called_once()
        panel._on_page_changed.assert_called_once_with("agent-1")

    def test_late_focus_request_does_not_steal_focus_from_new_tab(self):
        import panels.center_panel as cp

        panel = CenterPanel.__new__(CenterPanel)
        first_terminal = MagicMock()
        second_terminal = MagicMock()
        panel._tab_widgets = {"agent-1": MagicMock(), "agent-2": MagicMock()}
        panel._terminals = {"agent-1": first_terminal, "agent-2": second_terminal}
        panel._stack = MagicMock()
        panel._stack.get_visible_child_name.return_value = "agent-2"
        panel._focus_request_serial = 0
        panel._on_page_changed = MagicMock()

        callbacks = []

        def _idle_add(cb):
            callbacks.append(cb)
            return len(callbacks)

        with patch.object(cp.GLib, "idle_add", side_effect=_idle_add):
            panel._notify_page("agent-1")
            panel._notify_page("agent-2")

        callbacks[0]()
        first_terminal.grab_focus.assert_not_called()
        second_terminal.grab_focus.assert_not_called()

        callbacks[1]()
        second_terminal.grab_focus.assert_called_once()


class TestTabLayoutPersistence(unittest.TestCase):
    """Phase 2 (G2a / G2b) — tab layout save and restore."""

    def _panel(self, project=None):
        panel = CenterPanel.__new__(CenterPanel)
        panel._pm = MagicMock()
        panel._restoring_tab_layout = False
        panel._restored_tab_layouts = set()
        panel._tab_widgets = {}
        panel._agent_info = {}
        panel._tab_project = {}
        panel._task_state = {}
        panel._last_terminal_page = "project-p1"
        panel._settings = None
        panel._stack = MagicMock()
        if project is None:
            project = {"id": "p1", "directory": "/work/p1", "tab_layout": []}
        panel._pm.get_project.return_value = project
        return panel, project

    def test_save_tab_layout_captures_agent_tabs(self):
        panel, project = self._panel()
        panel._tab_widgets["agent-1"] = MagicMock()
        panel._tab_project["agent-1"] = "p1"
        panel._agent_info["agent-1"] = {"cmd": "claude", "directory": "/work/p1",
                                         "label_base": "Claude", "label_index": 0}

        with patch.object(panel, "_tab_label", return_value="Claude"):
            panel._save_tab_layout()

        self.assertEqual(len(project["tab_layout"]), 1)
        entry = project["tab_layout"][0]
        self.assertEqual(entry["key"], "agent-1")
        self.assertEqual(entry["cmd"], "claude")
        self.assertEqual(entry["label"], "Claude")
        panel._pm._save_local.assert_called_once_with(project)

    def test_save_tab_layout_excludes_default_terminal_tab(self):
        from panels.center_panel import _TERMINAL_TAB
        panel, project = self._panel()
        panel._tab_widgets[_TERMINAL_TAB] = MagicMock()
        panel._tab_project[_TERMINAL_TAB] = None

        panel._save_tab_layout()

        self.assertEqual(project["tab_layout"], [])

    def test_save_tab_layout_excludes_other_project_tabs(self):
        panel, project = self._panel()
        panel._tab_widgets["agent-2"] = MagicMock()
        panel._tab_project["agent-2"] = "other-project"
        panel._agent_info["agent-2"] = {"cmd": "claude", "directory": "/work/other",
                                         "label_base": "Claude", "label_index": 0}

        panel._save_tab_layout()

        self.assertEqual(project["tab_layout"], [])

    def test_save_tab_layout_skips_when_restoring(self):
        panel, project = self._panel()
        panel._restoring_tab_layout = True
        panel._tab_widgets["agent-1"] = MagicMock()
        panel._tab_project["agent-1"] = "p1"
        panel._agent_info["agent-1"] = {"cmd": "claude", "directory": "/work/p1",
                                         "label_base": "Claude", "label_index": 0}

        panel._save_tab_layout()

        panel._pm._save_local.assert_not_called()

    def test_restore_tab_layout_creates_agent_tabs(self):
        import panels.center_panel as cp

        project = {
            "id": "p1", "directory": "/work/p1",
            "tab_layout": [{"key": "agent-1", "cmd": "claude", "label": "Claude", "cwd": "/work/p1"}],
        }
        panel, _ = self._panel(project=project)
        panel._next_agent_number = MagicMock(return_value=1)
        panel._current_project_id = MagicMock(return_value="p1")
        panel._current_agent_directory = MagicMock(return_value="/work/p1")
        panel._used_tab_label_indices = MagicMock(return_value=set())
        panel._make_terminal = MagicMock(return_value=MagicMock())
        panel._add_tab = MagicMock()
        panel._set_agent_task = MagicMock()
        panel._notify_page = MagicMock()
        panel._terminal_pids = {}
        panel._terminals = {}
        panel._task_state = {}
        panel._tab_project = {}
        panel._agent_info = {}
        panel._tab_widgets = {}

        with patch.object(cp, "_spawn"), \
                patch.object(cp.GLib, "timeout_add"):
            result = panel._restore_tab_layout("p1")

        self.assertFalse(result)
        self.assertIn("agent-1", panel._agent_info)
        self.assertEqual(panel._agent_info["agent-1"]["cmd"], "claude")
        # _save_tab_layout is suppressed during restore (restoring_tab_layout flag)
        panel._pm._save_local.assert_not_called()

    def test_restore_tab_layout_returns_false_on_empty_layout(self):
        project = {"id": "p1", "directory": "/work/p1", "tab_layout": []}
        panel, _ = self._panel(project=project)

        result = panel._restore_tab_layout("p1")

        self.assertFalse(result)

    def test_show_project_terminal_triggers_restore_once(self):
        import panels.center_panel as cp
        panel, _ = self._panel()
        panel._stack.get_child_by_name.return_value = MagicMock()
        panel._show_terminal = MagicMock()

        with patch.object(cp.GLib, "idle_add") as idle_add:
            panel.show_project_terminal("p1")
            panel.show_project_terminal("p1")  # second call should not re-schedule

        idle_add.assert_called_once_with(panel._restore_tab_layout, "p1")
        self.assertIn("p1", panel._restored_tab_layouts)


class TestCenterPanelEmbedRetry(unittest.TestCase):
    """Phase 1 (G4.8 Stage 2) — X11 embedding retry scaffold."""

    def _panel(self):
        panel = CenterPanel.__new__(CenterPanel)
        panel._embedded_pages = {}
        panel._last_terminal_page = "project-abc"
        panel._show_terminal = MagicMock()
        return panel

    def test_successful_embed_does_not_retry(self):
        import panels.center_panel as cp

        panel = self._panel()
        panel._embedded_pages["embed-1"] = 12345

        with patch.object(panel, "_do_embed_window", return_value=True):
            with patch.object(cp.GLib, "timeout_add") as timeout_add:
                result = panel._try_embed_window(12345, "embed-1")

        self.assertFalse(result)
        timeout_add.assert_not_called()
        panel._show_terminal.assert_not_called()

    def test_failed_embed_schedules_retry_within_max_attempts(self):
        import panels.center_panel as cp

        panel = self._panel()
        panel._embedded_pages["embed-1"] = 12345

        with patch.object(panel, "_do_embed_window", side_effect=RuntimeError):
            with patch.object(cp.GLib, "timeout_add") as timeout_add:
                result = panel._try_embed_window(12345, "embed-1", _attempt=0)

        self.assertFalse(result)
        timeout_add.assert_called_once_with(
            300, panel._try_embed_window, 12345, "embed-1", 1
        )
        panel._show_terminal.assert_not_called()

    def test_last_attempt_exhausted_restores_terminal_and_removes_page(self):
        import panels.center_panel as cp

        panel = self._panel()
        panel._embedded_pages["embed-1"] = 12345

        with patch.object(panel, "_do_embed_window", side_effect=RuntimeError):
            with patch.object(cp.GLib, "timeout_add") as timeout_add:
                result = panel._try_embed_window(12345, "embed-1", _attempt=4)

        self.assertFalse(result)
        timeout_add.assert_not_called()
        panel._show_terminal.assert_called_once_with("project-abc")
        self.assertNotIn("embed-1", panel._embedded_pages)

    def test_embed_cancelled_externally_is_noop(self):
        """If embed-page key is removed before retry fires, skip silently."""
        import panels.center_panel as cp

        panel = self._panel()
        # _embedded_pages does NOT contain "embed-1"

        with patch.object(panel, "_do_embed_window") as do_embed:
            with patch.object(cp.GLib, "timeout_add"):
                result = panel._try_embed_window(12345, "embed-1")

        self.assertFalse(result)
        do_embed.assert_not_called()
        panel._show_terminal.assert_not_called()

    def test_do_embed_window_raises_not_implemented(self):
        panel = self._panel()
        with self.assertRaises(NotImplementedError):
            panel._do_embed_window(12345, "embed-1")


if __name__ == "__main__":
    unittest.main()
