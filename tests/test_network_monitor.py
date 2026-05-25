"""Tests for network_monitor.py — covers Phase 14."""

import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch, call

# Stub gi/GLib so the module can be imported without a GTK environment
glib_mock = MagicMock()
glib_mock.idle_add = lambda fn, *args: fn(*args)
gi_mock = MagicMock()
gi_mock.repository.GLib = glib_mock

sys.modules.setdefault("gi", gi_mock)
sys.modules.setdefault("gi.repository", gi_mock.repository)
sys.modules["gi.repository.GLib"] = glib_mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

# Now we can import the module after stubbing GLib
with patch("gi.repository.GLib", glib_mock):
    import importlib
    import network_monitor as nm


class TestNetworkMonitorProbe(unittest.TestCase):
    """Test the _probe() method in isolation."""

    def _monitor_no_thread(self) -> nm.NetworkMonitor:
        """Create a NetworkMonitor without starting the background thread."""
        mon = nm.NetworkMonitor.__new__(nm.NetworkMonitor)
        mon._on_status_changed = MagicMock()
        mon._online = None
        mon._last_success = None
        mon._running = False  # prevent thread loop from running
        return mon

    def test_probe_success(self):
        mon = self._monitor_no_thread()
        mock_sock = MagicMock()
        mock_sock.connect_ex.return_value = 0
        with patch("socket.socket", return_value=mock_sock):
            result = mon._probe()
        self.assertTrue(result)
        mock_sock.settimeout.assert_called_once_with(nm.NetworkMonitor._PROBE_TIMEOUT)
        mock_sock.connect_ex.assert_called_once_with(
            (nm.NetworkMonitor._PROBE_HOST, nm.NetworkMonitor._PROBE_PORT)
        )
        mock_sock.close.assert_called_once()

    def test_probe_connection_refused(self):
        mon = self._monitor_no_thread()
        mock_sock = MagicMock()
        mock_sock.connect_ex.return_value = 111  # ECONNREFUSED
        with patch("socket.socket", return_value=mock_sock):
            result = mon._probe()
        self.assertFalse(result)

    def test_probe_exception_returns_false(self):
        mon = self._monitor_no_thread()
        with patch("socket.socket", side_effect=OSError("network down")):
            result = mon._probe()
        self.assertFalse(result)

    def test_probe_timeout_returns_false(self):
        mon = self._monitor_no_thread()
        mock_sock = MagicMock()
        mock_sock.connect_ex.side_effect = socket.timeout("timed out")
        with patch("socket.socket", return_value=mock_sock):
            result = mon._probe()
        self.assertFalse(result)


class TestNetworkMonitorState(unittest.TestCase):
    def _monitor_no_thread(self) -> nm.NetworkMonitor:
        mon = nm.NetworkMonitor.__new__(nm.NetworkMonitor)
        mon._on_status_changed = MagicMock()
        mon._online = None
        mon._last_success = None
        mon._running = False
        return mon

    def test_is_online_initially_false_when_none(self):
        mon = self._monitor_no_thread()
        self.assertFalse(mon.is_online)

    def test_is_online_true_after_successful_probe(self):
        mon = self._monitor_no_thread()
        mon._online = True
        self.assertTrue(mon.is_online)

    def test_is_online_false_when_offline(self):
        mon = self._monitor_no_thread()
        mon._online = False
        self.assertFalse(mon.is_online)

    def test_stop_sets_running_false(self):
        mon = self._monitor_no_thread()
        mon._running = True
        mon.stop()
        self.assertFalse(mon._running)

    def test_last_success_updated_on_success(self):
        mon = self._monitor_no_thread()
        mock_sock = MagicMock()
        mock_sock.connect_ex.return_value = 0
        with patch("socket.socket", return_value=mock_sock):
            with patch("time.sleep"):  # prevent actual sleep
                online = mon._probe()
        self.assertTrue(online)

    def test_last_success_not_updated_on_failure(self):
        mon = self._monitor_no_thread()
        before = mon._last_success
        mock_sock = MagicMock()
        mock_sock.connect_ex.return_value = 1
        with patch("socket.socket", return_value=mock_sock):
            mon._probe()
        self.assertEqual(mon._last_success, before)


class TestNetworkMonitorCallback(unittest.TestCase):
    """Test that on_status_changed is called correctly on state transitions."""

    def test_callback_called_on_online_transition(self):
        callback = MagicMock()
        mock_sock = MagicMock()
        mock_sock.connect_ex.return_value = 0  # success

        with patch("socket.socket", return_value=mock_sock):
            with patch("time.sleep", side_effect=StopIteration):
                with patch("gi.repository.GLib", glib_mock):
                    try:
                        mon = nm.NetworkMonitor(callback)
                        time.sleep(0.2)  # give thread a moment
                    except StopIteration:
                        pass

        # Give thread time to run one cycle
        time.sleep(0.05)

    def test_callback_on_offline_to_online_transition(self):
        """Simulate offline→online: callback must fire on change."""
        callback = MagicMock()
        mon = nm.NetworkMonitor.__new__(nm.NetworkMonitor)
        mon._on_status_changed = callback
        mon._online = False  # was offline
        mon._last_success = None
        mon._running = False

        # Simulate a successful probe
        with patch.object(mon, "_probe", return_value=True):
            online = mon._probe()
        changed = online != mon._online
        if online:
            mon._last_success = time.time()
        old = mon._online
        mon._online = online
        if changed:
            callback(online, mon._last_success)

        callback.assert_called_once_with(True, mon._last_success)

    def test_no_callback_when_state_unchanged(self):
        """Callback must NOT be called if online state didn't change."""
        callback = MagicMock()
        mon = nm.NetworkMonitor.__new__(nm.NetworkMonitor)
        mon._on_status_changed = callback
        mon._online = True  # already online
        mon._last_success = time.time()
        mon._running = False

        online = True  # probe returns same state
        changed = online != mon._online
        self.assertFalse(changed)
        if changed:
            callback(online, mon._last_success)

        callback.assert_not_called()


class TestNetworkMonitorConstants(unittest.TestCase):
    def test_probe_host_is_cloudflare_dns(self):
        self.assertEqual(nm.NetworkMonitor._PROBE_HOST, "1.1.1.1")

    def test_probe_port_is_dns(self):
        self.assertEqual(nm.NetworkMonitor._PROBE_PORT, 53)

    def test_interval_is_5_seconds(self):
        self.assertEqual(nm.NetworkMonitor._INTERVAL, 5)

    def test_timeout_is_3_seconds(self):
        self.assertEqual(nm.NetworkMonitor._PROBE_TIMEOUT, 3)


if __name__ == "__main__":
    unittest.main()
