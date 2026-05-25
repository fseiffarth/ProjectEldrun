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
/* Prevent Adwaita from forcing white text / blue background on selection.
   GTK4 requires explicit type selectors (label, image) — the * wildcard
   does not reliably override per-widget-type Adwaita rules. */
.project-row:selected,
.project-row:focus:selected {
    background-color: transparent;
    background: none;
    box-shadow: none;
}
.project-row label,
.project-row:selected label,
.project-row:focus:selected label {
    color: #e6edf3;
}
.project-row image,
.project-row:selected image,
.project-row:focus:selected image {
    color: #8b949e;
}
.project-row-active {
    border: 2px solid #388bfd;
    border-radius: 6px;
    margin: 2px 4px;
}
.project-row-warm {
    background-color: rgba(56, 139, 253, 0.12);
}
.project-row-warm.project-row-active {
    background-color: rgba(56, 139, 253, 0.12);
    border: 2px solid #388bfd;
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

/* ── panel edge toggle buttons ───────────────────────────── */
button.panel-edge-btn {
    min-width: 16px;
    min-height: 40px;
    padding: 0 2px;
    font-size: 12px;
    color: #388bfd;
    background-color: #1c2128;
    border-radius: 4px;
    border: 1px solid #388bfd;
}
button.panel-edge-btn:hover {
    color: #ffffff;
    background-color: #388bfd;
}

/* ── status lamp (Phase 14) ──────────────────────────────── */
.status-lamp {
    font-size: 11px;
    min-width: 12px;
    margin-start: 6px;
    margin-end: 2px;
}
.status-online { color: #3fb950; }
.status-offline { color: #f85149; }
.conn-type-label {
    font-size: 10px;
    color: #8b949e;
    margin-end: 4px;
}

/* ── offline banner (Phase 14) ───────────────────────────── */
.offline-banner {
    background-color: rgba(248, 81, 73, 0.88);
    color: #ffffff;
    font-size: 12px;
    font-weight: 600;
    padding: 4px 20px;
    border-radius: 0 0 6px 6px;
}

/* ── project time bar (Phase 15) ─────────────────────────── */
progressbar.project-time-bar {
    min-height: 4px;
}
progressbar.project-time-bar trough {
    min-height: 4px;
    border-radius: 2px;
    background-color: #21262d;
}
progressbar.project-time-bar progress {
    background-color: rgba(56, 139, 253, 0.65);
    border-radius: 2px;
    min-height: 4px;
}
.project-time-label {
    font-size: 9px;
    color: #8b949e;
    min-width: 28px;
}
"""

_CSS_LIGHT = """
window {
    background-color: #ffffff;
    color: #24292f;
}
.app-header {
    background-color: #f6f8fa;
    border-bottom: 1px solid #d0d7de;
    min-height: 36px;
    padding: 0 6px;
}
.app-title {
    font-size: 12px;
    color: #57606a;
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
.new-project-btn {
    font-size: 24px;
    font-weight: bold;
    min-width: 56px;
    min-height: 48px;
    background-color: #2da44e;
    color: #ffffff;
    border-radius: 8px;
    border: none;
    padding: 0 20px;
}
.new-project-btn:hover { background-color: #2c974b; }
.new-project-btn:active { background-color: #26843f; }
.panel-left {
    background-color: #f6f8fa;
    border-right: 1px solid #d0d7de;
}
.panel-right {
    background-color: #f6f8fa;
    border-left: 1px solid #d0d7de;
}
.panel-header {
    font-size: 11px;
    color: #57606a;
    font-weight: bold;
    letter-spacing: 0.5px;
}
.project-row { border-bottom: 1px solid #d8dee4; }
.project-row:selected,
.project-row:focus:selected {
    background-color: transparent;
    background: none;
    box-shadow: none;
}
.project-row label,
.project-row:selected label,
.project-row:focus:selected label {
    color: #000000;
}
.project-row image,
.project-row:selected image,
.project-row:focus:selected image {
    color: #57606a;
}
.project-row-active {
    border: 2px solid #0969da;
    border-radius: 6px;
    margin: 2px 4px;
}
.project-row-warm { background-color: rgba(9, 105, 218, 0.08); }
.project-row-warm.project-row-active {
    background-color: rgba(9, 105, 218, 0.08);
    border: 2px solid #0969da;
    border-radius: 6px;
    margin: 2px 4px;
}
.close-btn {
    font-size: 13px;
    color: #57606a;
    padding: 0 4px;
    min-width: 20px;
    min-height: 20px;
}
.close-btn:hover { color: #f85149; }
.app-row { border-bottom: 1px solid #d8dee4; }
.app-row:hover { background-color: #f3f4f6; }
.app-running { color: #2da44e; font-size: 10px; }
.app-stopped { color: #8c959f; font-size: 10px; }
.placeholder-label { color: #8c959f; font-size: 16px; }
button.panel-edge-btn {
    min-width: 16px;
    min-height: 40px;
    padding: 0 2px;
    font-size: 12px;
    color: #0969da;
    background-color: #ddf4ff;
    border-radius: 4px;
    border: 1px solid #0969da;
}
button.panel-edge-btn:hover {
    color: #ffffff;
    background-color: #0969da;
}

/* ── status lamp (Phase 14) ──────────────────────────────── */
.status-lamp {
    font-size: 11px;
    min-width: 12px;
    margin-start: 6px;
    margin-end: 2px;
}
.status-online { color: #2da44e; }
.status-offline { color: #cf222e; }
.conn-type-label {
    font-size: 10px;
    color: #57606a;
    margin-end: 4px;
}

/* ── offline banner (Phase 14) ───────────────────────────── */
.offline-banner {
    background-color: rgba(207, 34, 46, 0.88);
    color: #ffffff;
    font-size: 12px;
    font-weight: 600;
    padding: 4px 20px;
    border-radius: 0 0 6px 6px;
}

/* ── project time bar (Phase 15) ─────────────────────────── */
progressbar.project-time-bar {
    min-height: 4px;
}
progressbar.project-time-bar trough {
    min-height: 4px;
    border-radius: 2px;
    background-color: #d0d7de;
}
progressbar.project-time-bar progress {
    background-color: rgba(9, 105, 218, 0.65);
    border-radius: 2px;
    min-height: 4px;
}
.project-time-label {
    font-size: 9px;
    color: #57606a;
    min-width: 28px;
}
"""


_css_provider: Gtk.CssProvider | None = None


def set_theme(dark: bool):
    global _css_provider
    display = Gdk.Display.get_default()
    if _css_provider is not None:
        Gtk.StyleContext.remove_provider_for_display(display, _css_provider)
    _css_provider = Gtk.CssProvider()
    _css_provider.load_from_data(_CSS if dark else _CSS_LIGHT, -1)
    Gtk.StyleContext.add_provider_for_display(
        display,
        _css_provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    )


def _apply_css():
    set_theme(True)


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
