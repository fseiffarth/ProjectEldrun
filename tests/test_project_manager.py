"""Tests for project_manager.py — covers Phases 0, 1, 3, 5."""

import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

# ---------------------------------------------------------------------------
# Patch gi / GLib before importing the module under test so that the test can
# run without a running GLib main loop or DISPLAY.
# ---------------------------------------------------------------------------
gi_mock = MagicMock()
gi_mock.repository.GLib.get_user_data_dir.return_value = "/tmp/eldrun_test"
sys.modules.setdefault("gi", gi_mock)
sys.modules.setdefault("gi.repository", gi_mock.repository)

# Now patch the concrete attribute that project_manager.py uses at module level
# (from gi.repository import GLib → GLib.get_user_data_dir())
glib_mock = MagicMock()
glib_mock.get_user_data_dir.return_value = "/tmp/eldrun_test_pm"

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

with patch.dict("sys.modules", {"gi": gi_mock, "gi.repository": gi_mock.repository}):
    with patch("gi.repository.GLib", glib_mock):
        import importlib
        import project_manager as _pm_module
        # Reload with patched GLib so DATA_DIR / PROJECTS_FILE get correct tmp values
        # We will override these in setUp instead.


class TestSanitizeName(unittest.TestCase):
    def test_basic_name(self):
        self.assertEqual(_pm_module.sanitize_name("My Project"), "my-project")

    def test_underscores_become_dashes(self):
        self.assertEqual(_pm_module.sanitize_name("foo_bar"), "foo-bar")

    def test_special_chars_stripped(self):
        self.assertEqual(_pm_module.sanitize_name("Hello! World@2024"), "hello-world2024")

    def test_multiple_dashes_collapsed(self):
        self.assertEqual(_pm_module.sanitize_name("a---b"), "a-b")

    def test_leading_trailing_dashes_stripped(self):
        self.assertEqual(_pm_module.sanitize_name("--foo--"), "foo")

    def test_empty_string(self):
        self.assertEqual(_pm_module.sanitize_name(""), "")

    def test_only_symbols(self):
        self.assertEqual(_pm_module.sanitize_name("@@@"), "")

    def test_numeric(self):
        self.assertEqual(_pm_module.sanitize_name("123"), "123")

    def test_mixed_case(self):
        self.assertEqual(_pm_module.sanitize_name("MyApp"), "myapp")

    def test_spaces_become_dashes(self):
        self.assertEqual(_pm_module.sanitize_name("hello world"), "hello-world")


class TestRenderScaffold(unittest.TestCase):
    def test_substitution(self):
        tmpl = "# {name}\ndir={directory}\ntype={git_type}"
        result = _pm_module._render_scaffold(tmpl, "Foo", "/tmp/foo", "public")
        self.assertIn("# Foo", result)
        self.assertIn("dir=/tmp/foo", result)
        self.assertIn("type=public", result)

    def test_no_extra_placeholders(self):
        tmpl = "static text"
        result = _pm_module._render_scaffold(tmpl, "x", "/y", "z")
        self.assertEqual(result, "static text")


class TestProjectManager(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.data_dir = os.path.join(self.tmpdir, "eldrun")
        os.makedirs(self.data_dir)
        self.projects_file = os.path.join(self.data_dir, "projects.json")
        self.projects_root = os.path.join(self.tmpdir, "projects")
        self.root_dir = os.path.join(self.tmpdir, "root")
        os.makedirs(self.projects_root)

        # Patch module-level constants so our temp dirs are used
        self._patch_data_dir = patch.object(_pm_module, "DATA_DIR", self.data_dir)
        self._patch_proj_file = patch.object(_pm_module, "PROJECTS_FILE", self.projects_file)
        import pathlib
        self._patch_proj_root = patch.object(
            _pm_module, "PROJECTS_ROOT", pathlib.Path(self.projects_root)
        )
        self._patch_ws_root = patch.object(
            _pm_module, "WORKSPACE_ROOT", pathlib.Path(self.tmpdir)
        )
        self._patch_root_dir = patch.object(
            _pm_module, "ROOT_DIR", pathlib.Path(self.root_dir)
        )
        self._patch_data_dir.start()
        self._patch_proj_file.start()
        self._patch_proj_root.start()
        self._patch_ws_root.start()
        self._patch_root_dir.start()

        # Suppress subprocess calls (git init/commit)
        self._patch_git_init = patch.object(_pm_module, "_git_init")
        self._patch_git_commit = patch.object(_pm_module, "_git_commit")
        self._patch_git_init.start()
        self._patch_git_commit.start()

    def tearDown(self):
        self._patch_data_dir.stop()
        self._patch_proj_file.stop()
        self._patch_proj_root.stop()
        self._patch_ws_root.stop()
        self._patch_root_dir.stop()
        self._patch_git_init.stop()
        self._patch_git_commit.stop()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_pm(self):
        return _pm_module.ProjectManager()

    def test_empty_load(self):
        pm = self._make_pm()
        self.assertEqual(pm.projects, [])

    def test_add_project(self):
        pm = self._make_pm()
        p = pm.add_project("Test", "/tmp/test", "private")
        self.assertEqual(p["name"], "Test")
        self.assertEqual(p["directory"], "/tmp/test")
        self.assertEqual(p["git_type"], "private")
        self.assertIn("id", p)
        self.assertIn("created_at", p)
        self.assertIsNone(p.get("shell_pid") if "shell_pid" in p else None)

    def test_add_project_persisted(self):
        pm = self._make_pm()
        pm.add_project("Alpha", "/tmp/alpha", "private")
        pm2 = self._make_pm()
        self.assertEqual(len(pm2.projects), 1)
        self.assertEqual(pm2.projects[0]["name"], "Alpha")

    def test_shell_pid_not_persisted(self):
        pm = self._make_pm()
        p = pm.add_project("Beta", "/tmp/beta", "private")
        pm.set_shell_pid(p["id"], 1234)
        pm2 = self._make_pm()
        # shell_pid must be absent or None after reload
        p2 = pm2.get_project(p["id"])
        self.assertNotEqual(p2.get("shell_pid"), 1234)

    def test_remove_project(self):
        pm = self._make_pm()
        p = pm.add_project("Gamma", "/tmp/g", "private")
        pm.remove_project(p["id"])
        self.assertEqual(pm.projects, [])

    def test_remove_unknown_id_no_error(self):
        pm = self._make_pm()
        pm.remove_project("nonexistent-id")  # must not raise

    def test_get_project_found(self):
        pm = self._make_pm()
        p = pm.add_project("Delta", "/tmp/d", "public")
        found = pm.get_project(p["id"])
        self.assertIsNotNone(found)
        self.assertEqual(found["name"], "Delta")

    def test_get_project_not_found(self):
        pm = self._make_pm()
        self.assertIsNone(pm.get_project("unknown"))

    def test_set_shell_pid(self):
        pm = self._make_pm()
        p = pm.add_project("Epsilon", "/tmp/e", "private")
        pm.set_shell_pid(p["id"], 9999)
        p2 = pm.get_project(p["id"])
        self.assertEqual(p2["shell_pid"], 9999)

    def test_set_agent_task_persists_to_local_project_json(self):
        pm = self._make_pm()
        project_dir = os.path.join(self.tmpdir, "agent-project")
        os.makedirs(project_dir)
        p = pm.add_project("Agent Project", project_dir, "private")
        task = {
            "task_key": "project-" + p["id"],
            "task_title": "Fix the task tooltip",
            "task_status": "active",
            "task_updated_at": "2026-05-29T10:00:00+00:00",
        }

        pm.set_agent_task(p["id"], task)

        with open(os.path.join(project_dir, "project.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["agent_tasks"], [task])

    def test_set_agent_task_replaces_existing_task_with_same_key(self):
        pm = self._make_pm()
        project_dir = os.path.join(self.tmpdir, "agent-project")
        os.makedirs(project_dir)
        p = pm.add_project("Agent Project", project_dir, "private")

        pm.set_agent_task(p["id"], {"task_key": "agent-1", "task_title": "Old"})
        pm.set_agent_task(p["id"], {"task_key": "agent-1", "task_title": "New"})

        with open(os.path.join(project_dir, "project.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["agent_tasks"], [{"task_key": "agent-1", "task_title": "New"}])

    def test_set_agent_task_limits_persisted_history_to_max_tasks(self):
        pm = self._make_pm()
        project_dir = os.path.join(self.tmpdir, "agent-project")
        os.makedirs(project_dir)
        p = pm.add_project("Agent Project", project_dir, "private")

        for idx in range(_pm_module.MAX_AGENT_TASKS + 5):
            pm.set_agent_task(
                p["id"],
                {"task_key": f"agent-{idx}", "task_title": f"Task {idx}"},
            )

        with open(os.path.join(project_dir, "project.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(len(data["agent_tasks"]), _pm_module.MAX_AGENT_TASKS)
        self.assertEqual(data["agent_tasks"][0]["task_key"], "agent-24")
        self.assertEqual(data["agent_tasks"][-1]["task_key"], "agent-5")

    def test_set_agent_task_ignores_missing_task_key(self):
        pm = self._make_pm()
        project_dir = os.path.join(self.tmpdir, "agent-project")
        os.makedirs(project_dir)
        p = pm.add_project("Agent Project", project_dir, "private")

        pm.set_agent_task(p["id"], {"task_title": "No key"})

        with open(os.path.join(project_dir, "project.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertNotIn("agent_tasks", data)

    def test_clear_agent_task_removes_matching_record(self):
        pm = self._make_pm()
        project_dir = os.path.join(self.tmpdir, "agent-project")
        os.makedirs(project_dir)
        p = pm.add_project("Agent Project", project_dir, "private")
        task = {
            "task_key": "project-" + p["id"],
            "task_title": "Fix the task tooltip",
            "task_status": "active",
            "task_updated_at": "2026-05-29T10:00:00+00:00",
        }
        pm.set_agent_task(p["id"], task)

        pm.clear_agent_task(p["id"], task["task_key"])

        with open(os.path.join(project_dir, "project.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["agent_tasks"], [])

    def test_create_project_makes_dir(self):
        pm = self._make_pm()
        p = pm.create_project("My App", "private")
        expected_dir = os.path.join(self.projects_root, "my-app")
        self.assertTrue(os.path.isdir(expected_dir))
        self.assertEqual(p["directory"], expected_dir)

    def test_create_project_duplicate_raises(self):
        pm = self._make_pm()
        pm.create_project("Dup", "private")
        with self.assertRaises(FileExistsError):
            pm.create_project("Dup", "private")

    def test_create_project_invalid_name_raises(self):
        pm = self._make_pm()
        with self.assertRaises(ValueError):
            pm.create_project("@@@", "private")

    def test_scaffold_files_written(self):
        pm = self._make_pm()
        pm.create_project("Scaffold Test", "private")
        expected_dir = os.path.join(self.projects_root, "scaffold-test")
        for fname in ("AGENTS.md", "CLAUDE.md", ".gitignore", "TODO.md",
                      "ROADMAP.md", "STATUS.md", "DOCUMENTATION.md"):
            self.assertTrue(
                os.path.exists(os.path.join(expected_dir, fname)),
                f"Missing scaffold file: {fname}",
            )

    # ── import mode: copy (original behaviour) ────────────────────────────────

    def test_import_project_copy_copies_files(self):
        src = os.path.join(self.tmpdir, "source_proj")
        os.makedirs(src)
        with open(os.path.join(src, "README.md"), "w") as f:
            f.write("# Source\n")

        pm = self._make_pm()
        p = pm.import_project(src, "Imported Proj", "private", mode="copy")
        expected_dir = os.path.join(self.projects_root, "imported-proj")
        self.assertTrue(os.path.isdir(expected_dir))
        self.assertTrue(os.path.exists(os.path.join(expected_dir, "README.md")))
        self.assertEqual(p["name"], "Imported Proj")
        self.assertEqual(p["directory"], expected_dir)
        # Source still exists (copy, not move)
        self.assertTrue(os.path.isdir(src))

    def test_import_project_copy_dest_exists_raises(self):
        src = os.path.join(self.tmpdir, "src2")
        os.makedirs(src)
        pm = self._make_pm()
        pm.import_project(src, "Clash", "private", mode="copy")
        src2 = os.path.join(self.tmpdir, "src3")
        os.makedirs(src2)
        with self.assertRaises(FileExistsError):
            pm.import_project(src2, "Clash", "private", mode="copy")

    # ── import mode: keep (default) ───────────────────────────────────────────

    def test_import_project_keep_registers_in_place(self):
        src = os.path.join(self.tmpdir, "source_keep")
        os.makedirs(src)
        with open(os.path.join(src, "README.md"), "w") as f:
            f.write("# Keep\n")

        pm = self._make_pm()
        p = pm.import_project(src, "Keep Proj", "private", mode="keep")
        # Directory is the original source; nothing was copied
        self.assertEqual(p["directory"], src)
        self.assertTrue(os.path.isdir(src))

    def test_import_project_keep_is_default(self):
        src = os.path.join(self.tmpdir, "source_default")
        os.makedirs(src)
        pm = self._make_pm()
        p = pm.import_project(src, "Default Mode", "private")
        self.assertEqual(p["directory"], src)

    def test_import_project_keep_adds_scaffold(self):
        src = os.path.join(self.tmpdir, "source_scaffold")
        os.makedirs(src)
        pm = self._make_pm()
        pm.import_project(src, "Scaffold Keep", "private", mode="keep")
        self.assertTrue(os.path.exists(os.path.join(src, "TODO.md")))

    # ── import mode: move ─────────────────────────────────────────────────────

    def test_import_project_move_removes_source(self):
        src = os.path.join(self.tmpdir, "source_move")
        os.makedirs(src)
        with open(os.path.join(src, "README.md"), "w") as f:
            f.write("# Move\n")

        pm = self._make_pm()
        p = pm.import_project(src, "Moved Proj", "private", mode="move")
        expected_dir = os.path.join(self.projects_root, "moved-proj")
        self.assertEqual(p["directory"], expected_dir)
        self.assertTrue(os.path.isdir(expected_dir))
        self.assertTrue(os.path.exists(os.path.join(expected_dir, "README.md")))
        # Original source should be gone
        self.assertFalse(os.path.isdir(src))

    def test_import_project_invalid_mode_raises(self):
        src = os.path.join(self.tmpdir, "source_bad")
        os.makedirs(src)
        pm = self._make_pm()
        with self.assertRaises(ValueError):
            pm.import_project(src, "Bad Mode", "private", mode="invalid")

    def test_import_project_empty_name_raises(self):
        src = os.path.join(self.tmpdir, "source_empty")
        os.makedirs(src)
        pm = self._make_pm()
        with self.assertRaises(ValueError):
            pm.import_project(src, "", "private", mode="keep")

    def test_migration_moves_old_project(self):
        import pathlib
        # Place a project directly under WORKSPACE_ROOT (old layout)
        old_dir = pathlib.Path(self.tmpdir) / "old-project"
        old_dir.mkdir()
        data = [{"id": "abc", "name": "Old", "directory": str(old_dir), "git_type": "private",
                 "created_at": "2024-01-01T00:00:00+00:00"}]
        with open(self.projects_file, "w") as f:
            json.dump(data, f)

        pm = self._make_pm()
        p = pm.get_project("abc")
        new_expected = os.path.join(self.projects_root, "old-project")
        self.assertEqual(p["directory"], new_expected)
        self.assertTrue(os.path.isdir(new_expected))


class TestWriteScaffoldMissing(unittest.TestCase):
    def test_only_missing_files_written(self):
        with tempfile.TemporaryDirectory() as d:
            # Pre-create CLAUDE.md — should NOT be overwritten
            claude_path = os.path.join(d, "CLAUDE.md")
            with open(claude_path, "w") as f:
                f.write("custom content")

            existing = {"CLAUDE.md"}
            _pm_module._write_scaffold_missing("Test", d, "private", existing)

            # Custom content preserved
            with open(claude_path) as f:
                self.assertEqual(f.read(), "custom content")

            # Other scaffold files created
            self.assertTrue(os.path.exists(os.path.join(d, "TODO.md")))
            self.assertTrue(os.path.exists(os.path.join(d, "AGENTS.md")))


if __name__ == "__main__":
    unittest.main()
