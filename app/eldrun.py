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
    box-shadow: -4px 0 16px rgba(0, 0, 0, 0.5);
}
.panel-header {
    font-size: 11px;
    color: #8b949e;
    font-weight: bold;
    letter-spacing: 0.5px;
}

/* Adwaita gives ListBox a white background by default; make it transparent
   so the panel background shows through and our label colors are readable. */
listbox {
    background: transparent;
    background-color: transparent;
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
    color: #e6edf3 !important;
}
.project-row image,
.project-row:selected image,
.project-row:focus:selected image {
    color: #8b949e !important;
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
.project-row-dragging {
    opacity: 0.45;
}
.drag-over-top {
    border-top: 2px solid #388bfd;
}
.drag-over-bottom {
    border-bottom: 2px solid #388bfd;
}
.drag-over-left {
    border-left: 2px solid #388bfd;
}
.drag-over-right {
    border-right: 2px solid #388bfd;
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

/* ── header time label ───────────────────────────────────── */
.header-time-label {
    font-size: 11px;
    color: #8b949e;
    font-weight: 500;
    margin-end: 4px;
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
    min-height: 6px;
}
progressbar.project-time-bar trough {
    min-height: 6px;
    border-radius: 3px;
    background-color: #ffffff;
    border: 1px solid #000000;
}
progressbar.project-time-bar progress {
    background-color: #388bfd;
    border-radius: 3px;
    min-height: 6px;
}
.project-time-label {
    font-size: 10px;
    color: #e6edf3 !important;
    min-width: 32px;
}

/* ── inline panel toggle button (in PROJECTS header) ────── */
button.panel-toggle-inline {
    min-width: 18px;
    min-height: 18px;
    padding: 0 3px;
    font-size: 13px;
    color: #8b949e;
    border-radius: 4px;
}
button.panel-toggle-inline:hover { color: #e6edf3; }

/* ── terminal back button (overlay on center panel) ──────── */
button.terminal-back-btn {
    background-color: rgba(22, 27, 34, 0.88);
    color: #e6edf3;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    margin: 8px;
}
button.terminal-back-btn:hover { background-color: rgba(48, 54, 61, 0.96); }

/* ── center panel tab bar ────────────────────────────────── */
.center-tab-bar-scroll {
    background-color: #161b22;
    border-bottom: 1px solid #30363d;
}
.center-tab-bar {
    background-color: #161b22;
}
.center-tab {
    border-radius: 6px 6px 0 0;
    padding: 4px 10px;
    background-color: transparent;
    color: #8b949e;
    font-size: 12px;
    border: 1px solid transparent;
    border-bottom: none;
}
.center-tab:hover {
    background-color: #21262d;
    color: #e6edf3;
}
.center-tab-active {
    background-color: #0d1117;
    color: #e6edf3;
    border-color: #30363d;
    border-bottom: 1px solid #0d1117;
}

/* ── bottom panel ────────────────────────────────────────── */
.bottom-panel {
    background-color: #161b22;
    border-top: 1px solid #30363d;
    min-height: 40px;
}
.project-pill {
    border-radius: 12px;
    padding: 0;
    min-height: 28px;
    background-color: #21262d;
    color: #8b949e;
    border: 1px solid #30363d;
}
.project-pill:hover {
    background-color: #30363d;
    color: #e6edf3;
}
.project-pill-active {
    background-color: rgba(56, 139, 253, 0.2);
    color: #e6edf3;
    border-color: #388bfd;
}
.project-pill-warm {
    border-color: rgba(56, 139, 253, 0.5);
}
.project-pill label { color: inherit; }
.pill-dot {
    font-size: 8px;
    color: #484f58;
}
.project-pill-active .pill-dot { color: #388bfd; }
.project-pill-warm .pill-dot { color: #58a6ff; }
.bottom-root-btn {
    font-size: 12px;
    min-height: 28px;
    padding: 0 10px;
    border-radius: 6px;
}
.bottom-add-btn {
    font-size: 16px;
    font-weight: bold;
    min-width: 32px;
    min-height: 28px;
    background-color: #238636;
    color: #ffffff;
    border-radius: 6px;
    border: none;
    padding: 0 10px;
}
.bottom-add-btn:hover { background-color: #2ea043; }
.bottom-add-btn:active { background-color: #1a7f37; }
.bottom-toggle-btn {
    font-size: 13px;
    color: #8b949e;
    min-width: 20px;
    min-height: 28px;
    padding: 0 4px;
    border-radius: 4px;
}
.bottom-toggle-btn:hover { color: #e6edf3; }
.bottom-panel searchentry {
    min-height: 28px;
    font-size: 12px;
    border-radius: 6px;
    background-color: #21262d;
    color: #e6edf3;
    border: 1px solid #30363d;
}
.bottom-panel searchentry:focus {
    border-color: #388bfd;
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
    box-shadow: -4px 0 16px rgba(0, 0, 0, 0.18);
}
.panel-header {
    font-size: 11px;
    color: #57606a;
    font-weight: bold;
    letter-spacing: 0.5px;
}
listbox {
    background: transparent;
    background-color: transparent;
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
    color: #000000 !important;
}
.project-row image,
.project-row:selected image,
.project-row:focus:selected image {
    color: #57606a !important;
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
.project-row-dragging { opacity: 0.45; }
.drag-over-top { border-top: 2px solid #0969da; }
.drag-over-bottom { border-bottom: 2px solid #0969da; }
.drag-over-left { border-left: 2px solid #0969da; }
.drag-over-right { border-right: 2px solid #0969da; }
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

/* ── header time label ───────────────────────────────────── */
.header-time-label {
    font-size: 11px;
    color: #57606a;
    font-weight: 500;
    margin-end: 4px;
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
    min-height: 6px;
}
progressbar.project-time-bar trough {
    min-height: 6px;
    border-radius: 3px;
    background-color: #ffffff;
    border: 1px solid #000000;
}
progressbar.project-time-bar progress {
    background-color: #0969da;
    border-radius: 3px;
    min-height: 6px;
}
.project-time-label {
    font-size: 10px;
    color: #24292f !important;
    min-width: 32px;
}

/* ── inline panel toggle button (light) ─────────────────── */
button.panel-toggle-inline {
    min-width: 18px;
    min-height: 18px;
    padding: 0 3px;
    font-size: 13px;
    color: #57606a;
    border-radius: 4px;
}
button.panel-toggle-inline:hover { color: #24292f; }

/* ── terminal back button (light) ───────────────────────── */
button.terminal-back-btn {
    background-color: rgba(246, 248, 250, 0.88);
    color: #24292f;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    margin: 8px;
}
button.terminal-back-btn:hover { background-color: rgba(234, 238, 242, 0.96); }

/* ── center panel tab bar (light) ────────────────────────── */
.center-tab-bar-scroll {
    background-color: #f6f8fa;
    border-bottom: 1px solid #d0d7de;
}
.center-tab-bar {
    background-color: #f6f8fa;
}
.center-tab {
    border-radius: 6px 6px 0 0;
    padding: 4px 10px;
    background-color: transparent;
    color: #57606a;
    font-size: 12px;
    border: 1px solid transparent;
    border-bottom: none;
}
.center-tab:hover {
    background-color: #eaeef2;
    color: #24292f;
}
.center-tab-active {
    background-color: #ffffff;
    color: #24292f;
    border-color: #d0d7de;
    border-bottom: 1px solid #ffffff;
}

/* ── bottom panel (light) ────────────────────────────────── */
.bottom-panel {
    background-color: #f6f8fa;
    border-top: 1px solid #d0d7de;
    min-height: 40px;
}
.project-pill {
    border-radius: 12px;
    padding: 0;
    min-height: 28px;
    background-color: #eaeef2;
    color: #57606a;
    border: 1px solid #d0d7de;
}
.project-pill:hover {
    background-color: #d0d7de;
    color: #24292f;
}
.project-pill-active {
    background-color: rgba(9, 105, 218, 0.12);
    color: #24292f;
    border-color: #0969da;
}
.project-pill-warm {
    border-color: rgba(9, 105, 218, 0.5);
}
.project-pill label { color: inherit; }
.pill-dot {
    font-size: 8px;
    color: #8c959f;
}
.project-pill-active .pill-dot { color: #0969da; }
.project-pill-warm .pill-dot { color: #0550ae; }
.bottom-root-btn {
    font-size: 12px;
    min-height: 28px;
    padding: 0 10px;
    border-radius: 6px;
}
.bottom-add-btn {
    font-size: 16px;
    font-weight: bold;
    min-width: 32px;
    min-height: 28px;
    background-color: #2da44e;
    color: #ffffff;
    border-radius: 6px;
    border: none;
    padding: 0 10px;
}
.bottom-add-btn:hover { background-color: #2c974b; }
.bottom-add-btn:active { background-color: #26843f; }
.bottom-toggle-btn {
    font-size: 13px;
    color: #57606a;
    min-width: 20px;
    min-height: 28px;
    padding: 0 4px;
    border-radius: 4px;
}
.bottom-toggle-btn:hover { color: #24292f; }
.bottom-panel searchentry {
    min-height: 28px;
    font-size: 12px;
    border-radius: 6px;
    background-color: #eaeef2;
    color: #24292f;
    border: 1px solid #d0d7de;
}
.bottom-panel searchentry:focus {
    border-color: #0969da;
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
        Gtk.Window.set_default_icon_name("io.github.fseiffarth.eldrun")
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
