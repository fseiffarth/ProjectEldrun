#!/usr/bin/env python3
"""Entry point for ProjectEldrun."""

__version__ = "0.0.4"

_debug_enabled: bool = True


def set_debug(enabled: bool) -> None:
    global _debug_enabled
    _debug_enabled = enabled


def is_debug() -> bool:
    return _debug_enabled


def dprint(*args, **kwargs) -> None:
    if _debug_enabled:
        print("[DEBUG]", *args, **kwargs)


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
    min-height: 40px;
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
.app-version-label {
    font-size: 10px;
    color: #484f58;
    font-weight: 500;
}
.debug-badge {
    font-size: 9px;
    font-weight: 700;
    color: #e3b341;
    background-color: rgba(227, 179, 65, 0.12);
    border: 1px solid rgba(227, 179, 65, 0.35);
    border-radius: 3px;
    padding: 0 4px;
    margin-start: 4px;
}
.pill-ws-badge {
    font-size: 9px;
    font-weight: 700;
    color: #f85149;
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
    background-color: transparent;
}
.center-tab-bar {
    background-color: transparent;
    min-height: 30px;
}
.center-tab {
    border-radius: 6px 6px 0 0;
    padding: 4px 12px;
    background-color: transparent;
    color: #6e7681;
    font-size: 12px;
    border: 1px solid transparent;
    border-top: 2px solid transparent;
    border-bottom: 1px solid transparent;
    margin-top: 3px;
    margin-start: 2px;
    margin-end: 2px;
}
.center-tab:hover {
    background-color: #1f2937;
    color: #c9d1d9;
    border-top-color: #30363d;
    border-left-color: #30363d;
    border-right-color: #30363d;
}
.center-tab-active {
    background: linear-gradient(180deg, #1c2433 0%, #0d1117 100%);
    color: #e6edf3;
    border-top: 2px solid #388bfd;
    border-left: 1px solid #30363d;
    border-right: 1px solid #30363d;
    border-bottom: 1px solid #0d1117;
    box-shadow: 0 -1px 6px rgba(56, 139, 253, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.04);
    margin-top: 3px;
    margin-start: 2px;
    margin-end: 2px;
}
.center-tab-dragging { opacity: 0.5; }
.tab-drag-over-left  { border-left:  2px solid #388bfd; }
.tab-drag-over-right { border-right: 2px solid #388bfd; }

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
.bottom-root-btn-active {
    box-shadow: inset 0 0 0 2px #388bfd;
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
    min-height: 40px;
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
.app-version-label {
    font-size: 10px;
    color: #8c959f;
    font-weight: 500;
}
.debug-badge {
    font-size: 9px;
    font-weight: 700;
    color: #9a6700;
    background-color: rgba(154, 103, 0, 0.08);
    border: 1px solid rgba(154, 103, 0, 0.3);
    border-radius: 3px;
    padding: 0 4px;
    margin-start: 4px;
}
.pill-ws-badge {
    font-size: 9px;
    font-weight: 700;
    color: #cf222e;
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
    background-color: transparent;
}
.center-tab-bar {
    background-color: transparent;
    min-height: 30px;
}
.center-tab {
    border-radius: 6px 6px 0 0;
    padding: 4px 12px;
    background-color: transparent;
    color: #57606a;
    font-size: 12px;
    border: 1px solid transparent;
    border-top: 2px solid transparent;
    border-bottom: 1px solid transparent;
    margin-top: 3px;
    margin-start: 2px;
    margin-end: 2px;
}
.center-tab:hover {
    background-color: #e8ecf0;
    color: #24292f;
    border-top-color: #d0d7de;
    border-left-color: #d0d7de;
    border-right-color: #d0d7de;
}
.center-tab-active {
    background: linear-gradient(180deg, #ffffff 0%, #f6f8fa 100%);
    color: #24292f;
    border-top: 2px solid #0969da;
    border-left: 1px solid #d0d7de;
    border-right: 1px solid #d0d7de;
    border-bottom: 1px solid #ffffff;
    box-shadow: 0 -1px 6px rgba(9, 105, 218, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.8);
    margin-top: 3px;
    margin-start: 2px;
    margin-end: 2px;
}
.center-tab-dragging { opacity: 0.5; }
.tab-drag-over-left  { border-left:  2px solid #0969da; }
.tab-drag-over-right { border-right: 2px solid #0969da; }

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
.bottom-root-btn-active {
    box-shadow: inset 0 0 0 2px #0969da;
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

_CSS_FANCY = _CSS + """
/* ── fancy modern theme overrides ───────────────────────── */
window {
    background-color: #101624;
    color: #f4f8ff;
}
.app-header {
    background: linear-gradient(90deg, #101624 0%, #16213a 48%, #241735 100%);
    border-bottom: 1px solid rgba(94, 220, 255, 0.35);
}
.app-title {
    color: #8be9ff;
}
button.wm-btn.wm-close { background-color: #ff5c8a; }
button.wm-btn.wm-close:hover { background-color: #ff7a9f; }
button.wm-btn.wm-minimize { background-color: #ffd166; }
button.wm-btn.wm-minimize:hover { background-color: #ffe08a; }
button.wm-btn.wm-maximize { background-color: #7ee787; }
button.wm-btn.wm-maximize:hover { background-color: #9cffb1; }
button,
button.wm-btn,
.new-project-btn,
button.panel-edge-btn,
button.panel-toggle-inline,
button.terminal-back-btn,
.center-tab,
.project-pill,
.bottom-root-btn,
.bottom-add-btn,
.bottom-toggle-btn,
.bottom-panel searchentry,
.debug-badge,
.offline-banner,
progressbar.project-time-bar trough,
progressbar.project-time-bar progress {
    border-radius: 0;
}
.new-project-btn,
.bottom-add-btn {
    background-color: #2dd4bf;
    color: #07131f;
}
.new-project-btn:hover,
.bottom-add-btn:hover {
    background-color: #5ff0db;
}
.new-project-btn:active,
.bottom-add-btn:active {
    background-color: #1fb8a8;
}
.panel-left,
.panel-right {
    background-color: #121a2b;
    border-color: rgba(94, 220, 255, 0.22);
}
.panel-right {
    box-shadow: -4px 0 18px rgba(45, 212, 191, 0.14);
}
.panel-header,
.conn-type-label,
.header-time-label {
    color: #8ca3c7;
}
.project-row {
    border-bottom-color: #22304a;
}
.project-row label,
.project-row:selected label,
.project-row:focus:selected label {
    color: #f4f8ff !important;
}
.project-row image,
.project-row:selected image,
.project-row:focus:selected image {
    color: #8be9ff !important;
}
.project-row-active,
.project-row-warm.project-row-active {
    border-color: #36c5f0;
}
.project-row-warm {
    background-color: rgba(54, 197, 240, 0.13);
}
.close-btn:hover {
    color: #ff5c8a;
}
.drag-over-top,
.drag-over-bottom,
.drag-over-left,
.drag-over-right {
    border-color: #b388ff;
}
.app-row {
    border-bottom-color: #22304a;
}
.app-row:hover {
    background-color: #19243a;
}
.app-running,
.status-online {
    color: #7ee787;
}
.app-stopped,
.placeholder-label,
.app-version-label {
    color: #687899;
}
button.panel-edge-btn {
    color: #36c5f0;
    background-color: #152039;
    border-color: #36c5f0;
}
button.panel-edge-btn:hover {
    color: #07131f;
    background-color: #36c5f0;
}
.status-offline {
    color: #ff5c8a;
}
.debug-badge {
    color: #ffd166;
    background-color: rgba(255, 209, 102, 0.13);
    border-color: rgba(255, 209, 102, 0.38);
}
.pill-ws-badge {
    color: #ff5c8a;
}
.offline-banner {
    background-color: rgba(255, 92, 138, 0.88);
}
progressbar.project-time-bar trough {
    background-color: #0b1220;
    border-color: #273654;
}
progressbar.project-time-bar progress {
    background: linear-gradient(90deg, #36c5f0 0%, #b388ff 100%);
}
.project-time-label {
    color: #d8e2f3 !important;
}
button.panel-toggle-inline {
    color: #8ca3c7;
}
button.panel-toggle-inline:hover {
    color: #f4f8ff;
}
button.terminal-back-btn {
    background-color: rgba(18, 26, 43, 0.92);
    color: #f4f8ff;
    border-color: rgba(94, 220, 255, 0.32);
}
button.terminal-back-btn:hover {
    background-color: rgba(36, 49, 78, 0.96);
}
.center-tab {
    color: #8ca3c7;
}
.center-tab:hover {
    background-color: rgba(54, 197, 240, 0.1);
    color: #f4f8ff;
    border-top-color: rgba(54, 197, 240, 0.55);
}
.center-tab-active {
    background: linear-gradient(180deg, #1d2b48 0%, #121a2b 100%);
    color: #f4f8ff;
    border-top-color: #36c5f0;
    border-left-color: rgba(54, 197, 240, 0.35);
    border-right-color: rgba(179, 136, 255, 0.35);
    border-bottom-color: #121a2b;
    box-shadow: 0 -1px 10px rgba(54, 197, 240, 0.16);
}
.tab-drag-over-left,
.tab-drag-over-right {
    border-color: #b388ff;
}
.bottom-panel {
    background-color: #121a2b;
    border-top-color: rgba(94, 220, 255, 0.25);
}
.project-pill {
    background-color: #18243b;
    color: #d8e2f3;
    border-color: #293852;
}
.project-pill:hover {
    background-color: #22304a;
    color: #f4f8ff;
}
.project-pill-active {
    background-color: rgba(54, 197, 240, 0.16);
    color: #f4f8ff;
    border-color: #36c5f0;
}
.project-pill-warm {
    border-color: rgba(179, 136, 255, 0.62);
}
.pill-dot {
    color: #687899;
}
.project-pill-active .pill-dot {
    color: #36c5f0;
}
.project-pill-warm .pill-dot {
    color: #b388ff;
}
.bottom-root-btn-active {
    box-shadow: inset 0 0 0 2px #36c5f0;
}
.bottom-toggle-btn {
    color: #8ca3c7;
}
.bottom-toggle-btn:hover {
    color: #f4f8ff;
}
.bottom-panel searchentry {
    background-color: #18243b;
    color: #f4f8ff;
    border-color: #293852;
}
.bottom-panel searchentry:focus {
    border-color: #36c5f0;
}
"""


_css_provider: Gtk.CssProvider | None = None


def _normalize_theme(scheme) -> str:
    if isinstance(scheme, bool):
        return "dark" if scheme else "light"
    if scheme in ("dark", "light", "fancy"):
        return scheme
    return "dark"


def set_theme(scheme):
    global _css_provider
    display = Gdk.Display.get_default()
    if _css_provider is not None:
        Gtk.StyleContext.remove_provider_for_display(display, _css_provider)
    _css_provider = Gtk.CssProvider()
    scheme = _normalize_theme(scheme)
    css = {"dark": _CSS, "light": _CSS_LIGHT, "fancy": _CSS_FANCY}[scheme]
    _css_provider.load_from_data(css, -1)
    Gtk.StyleContext.add_provider_for_display(
        display,
        _css_provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    )


def _apply_css():
    set_theme("dark")


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
