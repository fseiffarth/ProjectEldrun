#!/usr/bin/env python3
"""Entry point for ProjectEldrun."""

import signal
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("Gdk", "4.0")
gi.require_version("Vte", "3.91")
from gi.repository import Gtk, Adw, Gdk, GLib


_CSS = """
/* ── global ─────────────────────────────────────────────── */
window {
    background-color: #0d1117;
    color: #e6edf3;
}

/* ── custom header bar ───────────────────────────────────── */
.app-header {
    background-color: #161b22;
    border-bottom: 1px solid #30363d;
    min-height: 36px;
    padding: 0 6px;
}
.app-title {
    font-size: 12px;
    color: #8b949e;
    font-weight: 600;
    letter-spacing: 0.5px;
}
button.wm-btn {
    min-width: 14px;
    min-height: 14px;
    padding: 0;
    margin: 0 3px;
    border-radius: 7px;
    border: none;
    box-shadow: none;
}
button.wm-btn:focus { box-shadow: none; outline: none; }
button.wm-btn.wm-close { background-color: #f85149; }
button.wm-btn.wm-close:hover { background-color: #ff6b6b; }
button.wm-btn.wm-minimize { background-color: #e3b341; }
button.wm-btn.wm-minimize:hover { background-color: #f0c040; }
button.wm-btn.wm-maximize { background-color: #3fb950; }
button.wm-btn.wm-maximize:hover { background-color: #56d364; }

/* ── new-project button ──────────────────────────────────── */
.new-project-btn {
    font-size: 24px;
    font-weight: bold;
    min-width: 56px;
    min-height: 48px;
    background-color: #238636;
    color: #ffffff;
    border-radius: 8px;
    border: none;
    padding: 0 20px;
}
.new-project-btn:hover {
    background-color: #2ea043;
}
.new-project-btn:active {
    background-color: #1a7f37;
}

/* ── side panels ─────────────────────────────────────────── */
.panel-left {
    background-color: #161b22;
    border-right: 1px solid #30363d;
}
.panel-right {
    background-color: #161b22;
    border-left: 1px solid #30363d;
}
.panel-header {
    font-size: 11px;
    color: #8b949e;
    font-weight: bold;
    letter-spacing: 0.5px;
}

/* ── project rows ────────────────────────────────────────── */
.project-row {
    border-bottom: 1px solid #21262d;
}
.project-row:selected,
.project-row:selected * {
    background-color: #1f6feb;
    color: #ffffff;
}
.project-row-active {
    border: 2px solid #f85149;
    border-radius: 6px;
    margin: 2px 4px;
}
.close-btn {
    font-size: 13px;
    color: #8b949e;
    padding: 0 4px;
    min-width: 20px;
    min-height: 20px;
}
.close-btn:hover {
    color: #f85149;
}

/* ── app list rows ───────────────────────────────────────── */
.app-row {
    border-bottom: 1px solid #21262d;
}
.app-row:hover {
    background-color: #21262d;
}
.app-running { color: #3fb950; font-size: 10px; }
.app-stopped { color: #484f58; font-size: 10px; }

/* ── center placeholder ──────────────────────────────────── */
.placeholder-label {
    color: #484f58;
    font-size: 16px;
}
"""


def _apply_css():
    provider = Gtk.CssProvider()
    provider.load_from_data(_CSS, -1)
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(),
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    )


class EldrunApp(Adw.Application):
    def __init__(self):
        import gi as _gi
        _gi.require_version("Gio", "2.0")
        from gi.repository import Gio as _Gio
        # NON_UNIQUE lets multiple dev instances run simultaneously.
        super().__init__(
            application_id="io.github.fseiffarth.eldrun",
            flags=_Gio.ApplicationFlags.NON_UNIQUE,
        )

    def do_activate(self):
        _apply_css()
        from window import EldrunWindow
        win = EldrunWindow(application=self)
        win.present()


def main():
    app = EldrunApp()
    # Schedule quit on the GLib loop — safe to call from a Python signal handler.
    signal.signal(signal.SIGTERM, lambda *_: GLib.idle_add(app.quit))
    signal.signal(signal.SIGINT,  lambda *_: GLib.idle_add(app.quit))
    sys.exit(app.run(sys.argv))


if __name__ == "__main__":
    main()
