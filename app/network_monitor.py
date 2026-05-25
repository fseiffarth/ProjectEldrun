"""Phase 14 — Background network connectivity probe."""

import pathlib
import socket
import threading
import time

from gi.repository import GLib


def detect_connection_type(
    net_dir: pathlib.Path | None = None,
) -> str:
    """Return 'wlan', 'lan', or 'disconnected' based on /sys/class/net/.

    Iterates network interfaces; skips loopback; returns 'wlan' if any
    up interface has a wireless/ subdirectory, else 'lan' for any up
    interface, else 'disconnected'.

    net_dir: override the sysfs path (used in tests).
    """
    if net_dir is None:
        net_dir = pathlib.Path("/sys/class/net")
    try:
        for iface in sorted(net_dir.iterdir()):
            if iface.name == "lo":
                continue
            try:
                state = (iface / "operstate").read_text().strip()
            except OSError:
                continue
            if state != "up":
                continue
            if (iface / "wireless").is_dir():
                return "wlan"
            return "lan"
    except OSError:
        pass
    return "disconnected"


class NetworkMonitor:
    """Probes 1.1.1.1:53 every 5 s and calls on_status_changed on transitions.

    on_status_changed(is_online: bool, last_success_ts: float | None)
    The callback is always invoked on the GTK main thread via GLib.idle_add.
    """

    _PROBE_HOST = "1.1.1.1"
    _PROBE_PORT = 53
    _PROBE_TIMEOUT = 3  # seconds
    _INTERVAL = 5       # seconds between probes

    def __init__(self, on_status_changed):
        self._on_status_changed = on_status_changed
        self._online: bool | None = None       # None = not yet probed
        self._last_success: float | None = None
        self._connection_type: str = "disconnected"
        self._running = True
        self._thread = threading.Thread(target=self._probe_loop, daemon=True)
        self._thread.start()

    # ── public ────────────────────────────────────────────────────────────────

    def stop(self):
        self._running = False

    @property
    def is_online(self) -> bool:
        return self._online is True

    @property
    def connection_type(self) -> str:
        return self._connection_type

    # ── internal ──────────────────────────────────────────────────────────────

    def _probe(self) -> bool:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(self._PROBE_TIMEOUT)
            result = sock.connect_ex((self._PROBE_HOST, self._PROBE_PORT))
            sock.close()
            return result == 0
        except Exception:
            return False

    def _probe_loop(self):
        while self._running:
            online = self._probe()
            ct = detect_connection_type()
            if online:
                self._last_success = time.time()
            online_changed = online != self._online
            ct_changed = ct != self._connection_type
            self._online = online
            self._connection_type = ct
            if online_changed or ct_changed:
                ts = self._last_success
                GLib.idle_add(
                    lambda o=online, t=ts, c=ct: (self._on_status_changed(o, t, c), False)[1]
                )
            time.sleep(self._INTERVAL)
