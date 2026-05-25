"""Tests for time_tracker.py — covers Phase 15."""

import json
import os
import sys
import tempfile
import time
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

# Stub gi/GLib so the module can be imported without GTK
glib_mock = MagicMock()
glib_mock.get_user_data_dir.return_value = "/tmp/eldrun_tt_test"
gi_mock = MagicMock()
gi_mock.repository.GLib = glib_mock
sys.modules.setdefault("gi", gi_mock)
sys.modules.setdefault("gi.repository", gi_mock.repository)
sys.modules["gi.repository.GLib"] = glib_mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import time_tracker as _tt_mod


def _make_tracker(data_dir: str) -> _tt_mod.TimeTracker:
    """Create a TimeTracker isolated to data_dir."""
    return _tt_mod.TimeTracker(data_dir=data_dir)


class TestFormatDuration(unittest.TestCase):
    def test_zero(self):
        self.assertEqual(_tt_mod.format_duration(0), "0h 0m")

    def test_one_hour(self):
        self.assertEqual(_tt_mod.format_duration(3600), "1h 0m")

    def test_ninety_minutes(self):
        self.assertEqual(_tt_mod.format_duration(5400), "1h 30m")

    def test_seconds_truncated(self):
        self.assertEqual(_tt_mod.format_duration(3661), "1h 1m")

    def test_less_than_one_hour(self):
        self.assertEqual(_tt_mod.format_duration(1800), "0h 30m")

    def test_two_hours(self):
        self.assertEqual(_tt_mod.format_duration(7200), "2h 0m")

    def test_large_value(self):
        self.assertEqual(_tt_mod.format_duration(86400), "24h 0m")  # 24h


class TestTimeTrackerTodayTotals(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_empty_log_returns_empty(self):
        t = _make_tracker(self.tmpdir)
        self.assertEqual(t.get_today_totals(), {})

    def test_today_entry_counted(self):
        today = date.today().isoformat()
        t = _make_tracker(self.tmpdir)
        t._append_log({"project_id": "p1", "date": today,
                       "start_iso": "2024-01-01T10:00:00+00:00", "duration_s": 3600.0})
        totals = t.get_today_totals()
        self.assertAlmostEqual(totals.get("p1", 0), 3600.0)

    def test_yesterday_entry_excluded(self):
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        t = _make_tracker(self.tmpdir)
        t._append_log({"project_id": "p1", "date": yesterday,
                       "start_iso": "2024-01-01T10:00:00+00:00", "duration_s": 3600.0})
        totals = t.get_today_totals()
        self.assertNotIn("p1", totals)

    def test_multiple_entries_summed(self):
        today = date.today().isoformat()
        t = _make_tracker(self.tmpdir)
        for secs in [1800.0, 900.0]:
            t._append_log({"project_id": "p1", "date": today,
                           "start_iso": "T", "duration_s": secs})
        totals = t.get_today_totals()
        self.assertAlmostEqual(totals.get("p1", 0), 2700.0)

    def test_multiple_projects(self):
        today = date.today().isoformat()
        t = _make_tracker(self.tmpdir)
        t._append_log({"project_id": "p1", "date": today, "start_iso": "T", "duration_s": 600.0})
        t._append_log({"project_id": "p2", "date": today, "start_iso": "T", "duration_s": 1200.0})
        totals = t.get_today_totals()
        self.assertAlmostEqual(totals["p1"], 600.0)
        self.assertAlmostEqual(totals["p2"], 1200.0)

    def test_only_today_aggregated(self):
        today = date.today().isoformat()
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        t = _make_tracker(self.tmpdir)
        t._append_log({"project_id": "p1", "date": today, "start_iso": "T", "duration_s": 600.0})
        t._append_log({"project_id": "p1", "date": yesterday, "start_iso": "T", "duration_s": 3600.0})
        totals = t.get_today_totals()
        self.assertAlmostEqual(totals["p1"], 600.0)


class TestTimeTrackerSessionLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.proj_dir = os.path.join(self.tmpdir, "proj")
        os.makedirs(self.proj_dir)
        self.project = {"id": "test-proj", "name": "Test", "directory": self.proj_dir}

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_on_project_activated_sets_state(self):
        t = _make_tracker(self.tmpdir)
        t.on_project_activated(self.project)
        self.assertEqual(t._project_id, "test-proj")
        self.assertIsNotNone(t._start_monotonic)
        self.assertIsNotNone(t._start_real)

    def test_on_project_deactivated_clears_state(self):
        t = _make_tracker(self.tmpdir)
        t.on_project_activated(self.project)
        t.on_project_deactivated()
        self.assertIsNone(t._project_id)
        self.assertIsNone(t._start_monotonic)

    def test_session_appended_to_log_on_deactivate(self):
        t = _make_tracker(self.tmpdir)
        t.on_project_activated(self.project)
        time.sleep(0.05)
        t.on_project_deactivated()
        log = t._load_log()
        self.assertEqual(len(log), 1)
        entry = log[0]
        self.assertEqual(entry["project_id"], "test-proj")
        self.assertGreater(entry["duration_s"], 0)
        self.assertEqual(entry["date"], date.today().isoformat())

    def test_session_appended_on_project_switch(self):
        t = _make_tracker(self.tmpdir)
        proj2 = {"id": "proj2", "name": "P2", "directory": self.proj_dir}
        t.on_project_activated(self.project)
        time.sleep(0.02)
        t.on_project_activated(proj2)  # implicitly closes first session
        log = t._load_log()
        self.assertEqual(len(log), 1)
        self.assertEqual(log[0]["project_id"], "test-proj")

    def test_active_session_file_created_on_activate(self):
        t = _make_tracker(self.tmpdir)
        t.on_project_activated(self.project)
        self.assertTrue(os.path.exists(t._active_session_file))
        with open(t._active_session_file) as f:
            data = json.load(f)
        self.assertEqual(data["project_id"], "test-proj")

    def test_active_session_file_removed_on_deactivate(self):
        t = _make_tracker(self.tmpdir)
        t.on_project_activated(self.project)
        t.on_project_deactivated()
        self.assertFalse(os.path.exists(t._active_session_file))

    def test_double_deactivate_no_error(self):
        t = _make_tracker(self.tmpdir)
        t.on_project_deactivated()  # must not raise

    def test_duration_is_positive(self):
        t = _make_tracker(self.tmpdir)
        t.on_project_activated(self.project)
        time.sleep(0.1)
        t.on_project_deactivated()
        log = t._load_log()
        self.assertGreater(log[0]["duration_s"], 0)

    def test_second_activation_records_previous(self):
        t = _make_tracker(self.tmpdir)
        proj2 = {"id": "p2", "name": "P2", "directory": self.proj_dir}
        t.on_project_activated(self.project)
        time.sleep(0.02)
        t.on_project_activated(proj2)
        time.sleep(0.02)
        t.on_project_deactivated()
        log = t._load_log()
        self.assertEqual(len(log), 2)
        project_ids = {e["project_id"] for e in log}
        self.assertIn("test-proj", project_ids)
        self.assertIn("p2", project_ids)


class TestTimeTrackerOrphanSession(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_orphan_session_closed_on_startup(self):
        two_min_ago = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
        active_file = os.path.join(self.tmpdir, "active_session.json")
        with open(active_file, "w") as f:
            json.dump({"project_id": "orphan-proj", "start_real": two_min_ago}, f)

        t = _make_tracker(self.tmpdir)
        log = t._load_log()
        self.assertEqual(len(log), 1)
        self.assertEqual(log[0]["project_id"], "orphan-proj")
        self.assertGreater(log[0]["duration_s"], 100)
        self.assertFalse(os.path.exists(t._active_session_file))

    def test_corrupt_sentinel_cleared_without_log_entry(self):
        active_file = os.path.join(self.tmpdir, "active_session.json")
        with open(active_file, "w") as f:
            f.write("not json")

        t = _make_tracker(self.tmpdir)
        self.assertEqual(t._load_log(), [])
        self.assertFalse(os.path.exists(t._active_session_file))

    def test_sentinel_with_missing_fields_cleared(self):
        active_file = os.path.join(self.tmpdir, "active_session.json")
        with open(active_file, "w") as f:
            json.dump({"project_id": None, "start_real": None}, f)

        t = _make_tracker(self.tmpdir)
        self.assertEqual(t._load_log(), [])
        self.assertFalse(os.path.exists(t._active_session_file))

    def test_no_sentinel_no_error(self):
        t = _make_tracker(self.tmpdir)  # must not raise
        self.assertEqual(t._load_log(), [])

    def test_orphan_date_from_start_real(self):
        """Orphan entry date must match the start_real date, not today."""
        old_date = "2024-01-15"
        start_real = f"{old_date}T10:00:00+00:00"
        active_file = os.path.join(self.tmpdir, "active_session.json")
        with open(active_file, "w") as f:
            json.dump({"project_id": "p1", "start_real": start_real}, f)

        t = _make_tracker(self.tmpdir)
        log = t._load_log()
        self.assertEqual(log[0]["date"], old_date)


class TestTimeTrackerStatusMd(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.proj_dir = os.path.join(self.tmpdir, "proj")
        os.makedirs(self.proj_dir)
        self.project = {"id": "p1", "name": "P1", "directory": self.proj_dir}
        self.status_path = os.path.join(self.proj_dir, "STATUS.md")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_status_md_created_if_absent(self):
        t = _make_tracker(self.tmpdir)
        entry = {"project_id": "p1", "date": date.today().isoformat(),
                 "start_iso": "2024-01-01T10:00:00+00:00", "duration_s": 3600.0}
        t._append_log(entry)
        t._update_status_md(self.project, entry)
        self.assertTrue(os.path.exists(self.status_path))
        with open(self.status_path) as _f:
            content = _f.read()
        self.assertIn("## Time Log", content)
        self.assertIn("Total:", content)

    def test_status_md_section_replaced(self):
        with open(self.status_path, "w") as f:
            f.write("# P1 — Status\n\n## Time Log\n\nOld content here.\n")
        t = _make_tracker(self.tmpdir)
        entry = {"project_id": "p1", "date": date.today().isoformat(),
                 "start_iso": "2024-01-01T11:00:00+00:00", "duration_s": 7200.0}
        t._append_log(entry)
        t._update_status_md(self.project, entry)
        with open(self.status_path) as _f:
            content = _f.read()
        self.assertNotIn("Old content here.", content)
        self.assertIn("2h 0m", content)

    def test_status_md_section_appended_to_existing(self):
        with open(self.status_path, "w") as f:
            f.write("# P1 — Status\n\nSome notes.\n")
        t = _make_tracker(self.tmpdir)
        entry = {"project_id": "p1", "date": date.today().isoformat(),
                 "start_iso": "2024-01-01T09:00:00+00:00", "duration_s": 1800.0}
        t._append_log(entry)
        t._update_status_md(self.project, entry)
        with open(self.status_path) as _f:
            content = _f.read()
        self.assertIn("Some notes.", content)
        self.assertIn("## Time Log", content)

    def test_total_duration_formatted(self):
        t = _make_tracker(self.tmpdir)
        today = date.today().isoformat()
        for secs in [3600.0, 1800.0]:
            t._append_log({"project_id": "p1", "date": today,
                           "start_iso": "2024-01-01T10:00:00+00:00", "duration_s": secs})
        entry = t._load_log()[-1]
        t._update_status_md(self.project, entry)
        with open(self.status_path) as _f:
            content = _f.read()
        self.assertIn("Total: 1h 30m", content)

    def test_missing_directory_no_error(self):
        t = _make_tracker(self.tmpdir)
        bad_project = {"id": "x", "name": "X", "directory": "/nonexistent/dir"}
        entry = {"project_id": "x", "date": date.today().isoformat(),
                 "start_iso": "T", "duration_s": 1.0}
        t._update_status_md(bad_project, entry)  # must not raise

    def test_table_row_in_status_md(self):
        t = _make_tracker(self.tmpdir)
        entry = {"project_id": "p1", "date": "2024-06-01",
                 "start_iso": "2024-06-01T10:30:00+00:00", "duration_s": 3600.0}
        t._append_log(entry)
        t._update_status_md(self.project, entry)
        with open(self.status_path) as _f:
            content = _f.read()
        self.assertIn("| 2024-06-01 |", content)
        self.assertIn("1h 0m", content)

    def test_no_directory_in_project_no_error(self):
        t = _make_tracker(self.tmpdir)
        bad_project = {"id": "x", "name": "X"}  # no 'directory' key
        t._update_status_md(bad_project, {})  # must not raise

    def test_previous_section_content_removed(self):
        with open(self.status_path, "w") as f:
            f.write("# Title\n\n## Time Log\n\nTotal: 0h 0m\n\n## Other\n\nKeep this.\n")
        t = _make_tracker(self.tmpdir)
        entry = {"project_id": "p1", "date": "2024-06-01",
                 "start_iso": "2024-06-01T10:00:00+00:00", "duration_s": 600.0}
        t._append_log(entry)
        t._update_status_md(self.project, entry)
        with open(self.status_path) as _f:
            content = _f.read()
        self.assertIn("## Other", content)
        self.assertIn("Keep this.", content)


class TestAppendLog(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_append_creates_file(self):
        t = _make_tracker(self.tmpdir)
        t._append_log({"project_id": "x", "date": "2024-01-01", "start_iso": "T",
                       "duration_s": 1.0})
        self.assertTrue(os.path.exists(t._time_log_file))

    def test_append_accumulates(self):
        t = _make_tracker(self.tmpdir)
        for i in range(3):
            t._append_log({"project_id": f"p{i}", "date": "2024-01-01",
                           "start_iso": "T", "duration_s": float(i)})
        log = t._load_log()
        self.assertEqual(len(log), 3)

    def test_load_log_empty_returns_empty(self):
        t = _make_tracker(self.tmpdir)
        self.assertEqual(t._load_log(), [])

    def test_load_log_corrupt_returns_empty(self):
        t = _make_tracker(self.tmpdir)
        with open(t._time_log_file, "w") as f:
            f.write("{not a list}")
        self.assertEqual(t._load_log(), [])

    def test_atomic_write_no_tmp_leftover(self):
        t = _make_tracker(self.tmpdir)
        t._append_log({"project_id": "a", "date": "d", "start_iso": "T", "duration_s": 1.0})
        self.assertFalse(os.path.exists(t._time_log_file + ".tmp"))

    def test_log_is_valid_json(self):
        t = _make_tracker(self.tmpdir)
        t._append_log({"project_id": "p", "date": "2024-01-01", "start_iso": "T",
                       "duration_s": 42.5})
        with open(t._time_log_file) as f:
            data = json.load(f)
        self.assertEqual(len(data), 1)
        self.assertAlmostEqual(data[0]["duration_s"], 42.5)


if __name__ == "__main__":
    unittest.main()
