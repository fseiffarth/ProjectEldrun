"""Tests for monitor selection used by external launch routing."""

import os
import sys
import types
import unittest
from unittest.mock import patch


sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import launch_helpers as lh


class _Rect:
    def __init__(self, x, y, width, height):
        self.x = x
        self.y = y
        self.width = width
        self.height = height


class _Monitor:
    def __init__(self, name, rect):
        self._name = name
        self._rect = rect

    def get_connector(self):
        return self._name

    def get_geometry(self):
        return self._rect


class _MonitorList:
    def __init__(self, monitors):
        self._monitors = list(monitors)

    def get_n_items(self):
        return len(self._monitors)

    def get_item(self, idx):
        return self._monitors[idx]


class _Surface:
    pass


class _AnchorWindow:
    def __init__(self, surface):
        self._surface = surface

    def get_surface(self):
        return self._surface


class _Display:
    def __init__(self, monitors, current):
        self._monitors = _MonitorList(monitors)
        self._current = current

    def get_monitors(self):
        return self._monitors

    def get_monitor_at_surface(self, surface):
        if surface is None:
            return None
        return self._current


class TestLaunchHelperMonitorSelection(unittest.TestCase):
    def test_single_monitor_returns_none(self):
        primary = _Monitor("HDMI-1", _Rect(0, 0, 1920, 1080))
        display = _Display([primary], primary)

        with patch.object(lh, "_display_and_gdk", return_value=(display, None)):
            self.assertIsNone(lh.get_other_monitor_geometry(_AnchorWindow(_Surface())))

    def test_two_monitors_picks_the_other_one(self):
        primary = _Monitor("HDMI-1", _Rect(0, 0, 1920, 1080))
        other = _Monitor("DP-1", _Rect(1920, 0, 1920, 1080))
        display = _Display([primary, other], primary)

        with patch.object(lh, "_display_and_gdk", return_value=(display, None)):
            geom = lh.get_other_monitor_geometry(_AnchorWindow(_Surface()))

        self.assertEqual((geom.x, geom.y, geom.width, geom.height), (1920, 0, 1920, 1080))

    def test_three_monitors_selects_first_non_eldrun_monitor(self):
        left = _Monitor("HDMI-1", _Rect(0, 0, 1920, 1080))
        middle = _Monitor("DP-1", _Rect(1920, 0, 1920, 1080))
        right = _Monitor("HDMI-2", _Rect(3840, 0, 1920, 1080))
        display = _Display([left, middle, right], middle)

        with patch.object(lh, "_display_and_gdk", return_value=(display, None)):
            geom = lh.get_other_monitor_geometry(_AnchorWindow(_Surface()))

        self.assertEqual((geom.x, geom.y, geom.width, geom.height), (0, 0, 1920, 1080))


if __name__ == "__main__":
    unittest.main()
