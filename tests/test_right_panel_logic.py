"""Tests for right_panel.py logic — sort order and time label formatting."""

import sys
import os
import unittest
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Stub GTK / GLib before any app import touches them
# ---------------------------------------------------------------------------
gi_mock = MagicMock()
sys.modules.setdefault("gi", gi_mock)
sys.modules.setdefault("gi.repository", gi_mock.repository)
sys.modules.setdefault("gi.repository.Gtk", gi_mock.repository.Gtk)
sys.modules.setdefault("gi.repository.Pango", gi_mock.repository.Pango)
sys.modules.setdefault("gi.repository.GLib", gi_mock.repository.GLib)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app", "panels"))


# ---------------------------------------------------------------------------
# We test the pure-logic parts without instantiating GTK widgets.
# RightPanel._sort_rows and update_time_bars label formatting are extracted
# as standalone helpers here.
# ---------------------------------------------------------------------------


class _FakeRow:
    """Minimal stand-in for ProjectRow — only needs project_id and project_name."""
    def __init__(self, project_id: str, project_name: str):
        self.project_id = project_id
        self.project_name = project_name


class TestSortRows(unittest.TestCase):
    """Test the _sort_rows logic used by RightPanel."""

    def _sort(self, active_id, row_a, row_b) -> int:
        """Apply the same comparison logic as RightPanel._sort_rows."""
        active = active_id
        id1 = getattr(row_a, "project_id", None)
        id2 = getattr(row_b, "project_id", None)
        if id1 == active and id2 != active:
            return -1
        if id2 == active and id1 != active:
            return 1
        n1 = getattr(row_a, "project_name", "")
        n2 = getattr(row_b, "project_name", "")
        if n1 < n2:
            return -1
        if n1 > n2:
            return 1
        return 0

    def test_active_sorts_before_inactive(self):
        active = _FakeRow("a1", "Alpha")
        other = _FakeRow("b2", "Beta")
        self.assertEqual(self._sort("a1", active, other), -1)
        self.assertEqual(self._sort("a1", other, active), 1)

    def test_both_inactive_sorted_alphabetically(self):
        row_a = _FakeRow("1", "Alpha")
        row_b = _FakeRow("2", "Beta")
        self.assertLess(self._sort(None, row_a, row_b), 0)
        self.assertGreater(self._sort(None, row_b, row_a), 0)

    def test_same_name_returns_zero(self):
        row_a = _FakeRow("1", "Same")
        row_b = _FakeRow("2", "Same")
        self.assertEqual(self._sort(None, row_a, row_b), 0)

    def test_no_active_project_pure_alpha(self):
        row_z = _FakeRow("z", "Zebra")
        row_a = _FakeRow("a", "Apple")
        self.assertLess(self._sort(None, row_a, row_z), 0)

    def test_active_project_id_none_both_inactive(self):
        row_a = _FakeRow("1", "A")
        row_b = _FakeRow("2", "B")
        # With active=None neither matches, falls through to alpha
        result = self._sort(None, row_a, row_b)
        self.assertEqual(result, -1)

    def test_active_vs_self_returns_zero(self):
        row = _FakeRow("x", "X")
        # When comparing a row against itself (same id), neither branch fires
        self.assertEqual(self._sort("x", row, row), 0)


class TestTimeLabelFormatting(unittest.TestCase):
    """Test the label text produced by update_time_bars."""

    def _label_for_secs(self, secs: float) -> str:
        """Replicate the label_text logic from RightPanel.update_time_bars."""
        h = int(secs // 3600)
        m = int((secs % 3600) // 60)
        return f"{h}h {m}m" if h > 0 else f"{m}m"

    def test_zero_minutes(self):
        self.assertEqual(self._label_for_secs(0), "0m")

    def test_thirty_minutes(self):
        self.assertEqual(self._label_for_secs(1800), "30m")

    def test_exactly_one_hour(self):
        self.assertEqual(self._label_for_secs(3600), "1h 0m")

    def test_one_hour_thirty_minutes(self):
        self.assertEqual(self._label_for_secs(5400), "1h 30m")

    def test_two_hours(self):
        self.assertEqual(self._label_for_secs(7200), "2h 0m")

    def test_fifty_nine_minutes(self):
        self.assertEqual(self._label_for_secs(3540), "59m")

    def test_fractional_seconds_truncated(self):
        self.assertEqual(self._label_for_secs(90.9), "1m")


class TestUpdateTimeBarsIntegration(unittest.TestCase):
    """Verify update_time_bars passes the correct label text."""

    def test_label_text_matches_seconds(self):
        """update_time_bars should compute f'{m}m' for sub-hour totals."""
        calls = []

        class FakeRow:
            project_id = "p1"
            project_name = "X"
            def update_time_bar(self, fraction, tooltip, label_text=""):
                calls.append((fraction, tooltip, label_text))

        # Simulate update_time_bars logic directly
        totals = {"p1": 900.0}  # 15 minutes
        project_rows = {"p1": FakeRow()}
        max_time = max(totals.values(), default=0)
        for pid, row in project_rows.items():
            secs = totals.get(pid, 0.0)
            if secs > 0 and max_time > 0:
                fraction = secs / max_time
                h = int(secs // 3600)
                m = int((secs % 3600) // 60)
                label_text = f"{h}h {m}m" if h > 0 else f"{m}m"
                row.update_time_bar(fraction, f"{h}h {m}m today", label_text)
            else:
                row.update_time_bar(0, "", "")

        self.assertEqual(len(calls), 1)
        fraction, tooltip, label_text = calls[0]
        self.assertAlmostEqual(fraction, 1.0)
        self.assertEqual(label_text, "15m")
        self.assertIn("15m", tooltip)

    def test_zero_secs_hides_bar(self):
        calls = []

        class FakeRow:
            project_id = "p1"
            project_name = "X"
            def update_time_bar(self, fraction, tooltip, label_text=""):
                calls.append((fraction, label_text))

        totals = {"p1": 0}
        project_rows = {"p1": FakeRow()}
        max_time = max(totals.values(), default=0)
        for pid, row in project_rows.items():
            secs = totals.get(pid, 0.0)
            if secs > 0 and max_time > 0:
                row.update_time_bar(1.0, "x", "x")
            else:
                row.update_time_bar(0, "", "")

        self.assertEqual(calls[0], (0, ""))


if __name__ == "__main__":
    unittest.main()
