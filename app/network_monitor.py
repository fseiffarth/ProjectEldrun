"""Phase 14 — Background network connectivity probe."""

import socket
import threading
import time

from gi.repository import GLib


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
        self._running = True
        self._thread = threading.Thread(target=self._probe_loop, daemon=True)
        self._thread.start()

    # ── public ────────────────────────────────────────────────────────────────

    def stop(self):
        self._running = False

    @property
    def is_online(self) -> bool:
        return self._online is True

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
            if online:
                self._last_success = time.time()
            changed = online != self._online
            self._online = online
            if changed:
                ts = self._last_success
                GLib.idle_add(
                    lambda o=online, t=ts: (self._on_status_changed(o, t), False)[1]
                )
            time.sleep(self._INTERVAL)
