#!/usr/bin/env python3
"""Entry point for ProjectEldrun."""

__version__ = "0.0.12"

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


def _preferred_gsk_renderer(environ=os.environ) -> str | None:
    """Return the GSK_RENDERER value to set, or None to leave it alone.

    On Cinnamon/X11 the cairo renderer avoids one class of VTE flicker but
    writes frames via XPutImage without vsync, causing horizontal tearing
    artifacts (reddish bands spanning the full screen width) especially at
    high refresh rates.  The ngl renderer uses OpenGL with a proper swap-sync
    path so the compositor always scans out a complete frame.

    We only act when the caller has not already set GSK_RENDERER, so an
    explicit override in the environment is always respected.  Set
    ELDRUN_DISABLE_RENDERER_WORKAROUND=1 to skip this logic entirely.
    """
    if environ.get("GSK_RENDERER"):
        return None
    if environ.get("ELDRUN_DISABLE_RENDERER_WORKAROUND") == "1":
        return None
    session_type = environ.get("XDG_SESSION_TYPE", "").lower()
    desktop = environ.get("XDG_CURRENT_DESKTOP", "").lower()
    if session_type == "x11" and "cinnamon" in desktop:
        return "ngl"
    return None


def _log_renderer_selection(
    environ=os.environ,
    existing_renderer: str | None = None,
    selected_renderer: str | None = None,
) -> None:
    if environ.get("ELDRUN_RENDERER_DEBUG") != "1":
        return
    print(
        "[renderer]",
        f"session_type={environ.get('XDG_SESSION_TYPE', '') or '<unset>'}",
        f"desktop={environ.get('XDG_CURRENT_DESKTOP', '') or '<unset>'}",
        f"existing={existing_renderer or '<unset>'}",
        f"selected={selected_renderer or '<none>'}",
        f"effective={environ.get('GSK_RENDERER', '') or '<unset>'}",
    )


_existing_renderer = os.environ.get("GSK_RENDERER")
_renderer = _preferred_gsk_renderer()
if _renderer is not None:
    os.environ["GSK_RENDERER"] = _renderer
_log_renderer_selection(os.environ, _existing_renderer, _renderer)

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
window.csd {
    box-shadow: none;
    border-radius: 0;
}
windowcontents,
windowcontents > * {
    margin: 0;
    padding: 0;
    border-radius: 0;
}

/* ── custom header bar ───────────────────────────────────── */
.app-header {
    background-color: #161b22;
    border-bottom: 1px solid #30363d;
    min-height: 40px;
    padding: 0 10px;
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
.panel-right separator {
    background-color: rgba(139, 148, 158, 0.2);
}
.panel-right button.flat {
    color: #8b949e;
}
.panel-right button.flat:hover {
    background-color: rgba(56, 139, 253, 0.14);
    color: #e6edf3;
}
.panel-right .right-panel-surface {
    margin: 0 0 0 8px;
    border: 1px solid rgba(139, 148, 158, 0.16);
    border-radius: 7px;
    background-color: rgba(13, 17, 23, 0.34);
    box-shadow: inset 0 1px 0 rgba(240, 246, 252, 0.04);
}
.panel-right .right-tree-surface {
    margin-top: 2px;
}
.panel-right .right-file-tree.view {
    background-color: transparent;
    color: #e6edf3;
    padding: 3px 2px;
}
.panel-right .right-file-tree.view:hover {
    background-color: rgba(56, 139, 253, 0.1);
}
.panel-right .right-file-tree.view:selected,
.panel-right .right-file-tree.view:focus:selected {
    background-color: rgba(56, 139, 253, 0.24);
    color: #ffffff;
}
.panel-right .right-open-windows-section {
    margin-bottom: 6px;
}
.panel-right .right-open-windows-list row {
    border-radius: 6px;
    margin: 2px 4px;
    background-color: transparent;
}
.panel-right .right-open-windows-list row:hover {
    background-color: rgba(56, 139, 253, 0.14);
}
.panel-right .right-open-windows-list label {
    color: #e6edf3;
}
.panel-right .right-open-windows-list image {
    color: #8b949e;
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
.project-pill-draggable {
    box-shadow: inset 0 3px 0 #58a6ff;
    border-color: #58a6ff;
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
    margin-start: 0;
    margin-end: 0;
}
.status-online { color: #3fb950; }
.status-offline { color: #f85149; }
.conn-type-label {
    font-size: 10px;
    color: #8b949e;
    margin-end: 0;
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
    border-radius: 5px;
    padding: 1px 7px;
    margin-start: 0;
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

/* ── global apps toolbar (G6.6) ──────────────────────────── */
.global-apps-toggle-bar {
    min-height: 8px;
    background: radial-gradient(ellipse 55% 100% at 50% 0%, rgba(56,139,253,0.65) 0%, rgba(56,139,253,0.25) 65%, transparent 100%);
    transition: background 150ms ease;
}
.global-apps-toggle-bar:hover {
    background: radial-gradient(ellipse 55% 100% at 50% 0%, rgba(56,139,253,0.9) 0%, rgba(56,139,253,0.4) 65%, transparent 100%);
}
.file-tree-toggle-strip {
    min-width: 8px;
    background: radial-gradient(ellipse 100% 55% at 100% 50%, rgba(56,139,253,0.65) 0%, rgba(56,139,253,0.25) 65%, transparent 100%);
    transition: background 150ms ease;
}
.file-tree-toggle-strip:hover {
    background: radial-gradient(ellipse 100% 55% at 100% 50%, rgba(56,139,253,0.9) 0%, rgba(56,139,253,0.4) 65%, transparent 100%);
}
.bottom-toggle-strip {
    min-height: 16px;
    background: radial-gradient(ellipse 55% 100% at 50% 100%, rgba(56,139,253,0.65) 0%, rgba(56,139,253,0.25) 65%, transparent 100%);
    transition: background 150ms ease;
}
.bottom-toggle-strip:hover {
    background: radial-gradient(ellipse 55% 100% at 50% 100%, rgba(56,139,253,0.9) 0%, rgba(56,139,253,0.4) 65%, transparent 100%);
}
.global-apps-toggle-bar.panel-open:hover,
.file-tree-toggle-strip.panel-open:hover,
.bottom-toggle-strip.panel-open:hover { background: transparent; }
.global-apps-toolbar {
    background-color: #0d1117;
    border: 1px solid #30363d;
    border-radius: 10px;
    padding: 2px 6px;
}
.global-apps-toolbar button.global-app-btn {
    min-width: 30px;
    min-height: 28px;
    padding: 3px 5px;
    border-radius: 6px;
    color: #8b949e;
}
.global-apps-toolbar button.global-app-btn:hover {
    background-color: rgba(56, 139, 253, 0.16);
    color: #e6edf3;
}
.global-apps-toolbar button.global-app-btn:disabled {
    color: #3d444d;
}

/* ── bottom panel ────────────────────────────────────────── */
.bottom-panel {
    background-color: #161b22;
    border-top: 1px solid #30363d;
    min-height: 48px;
}
.project-pill {
    border-radius: 0;
    padding: 0 6px 0 0;
    min-height: 40px;
    margin-top: 3px;
    margin-bottom: 3px;
    background-color: #1c2128;
    color: #c9d1d9;
    border: 1px solid #30363d;
    box-shadow: inset 0 3px 0 #d29922;
}
.project-pill:hover {
    background-color: #262d36;
    color: #e6edf3;
    border-color: #484f58;
}
.project-pill-active {
    background-color: rgba(56, 139, 253, 0.18);
    color: #e6edf3;
    border-color: #388bfd;
    box-shadow: inset 0 3px 0 #388bfd;
}
.project-pill label { color: inherit; }
.pill-folder-icon {
    color: #d29922;
}
.project-pill-active .pill-folder-icon { color: #58a6ff; }
.bottom-root-btn {
    font-size: 12px;
    min-width: 40px;
    min-height: 40px;
    padding: 0;
    border-radius: 6px;
    background-color: #1c2128;
    color: #c9d1d9;
    border: 1px solid #30363d;
    box-shadow: inset 0 3px 0 #d29922;
}
.bottom-root-btn:hover {
    background-color: #262d36;
    color: #e6edf3;
    border-color: #484f58;
}
.bottom-root-btn-active {
    background-color: rgba(56, 139, 253, 0.18);
    color: #e6edf3;
    border-color: #388bfd;
    box-shadow: inset 0 3px 0 #388bfd;
}
.bottom-root-btn image { color: inherit; }
.bottom-root-btn-active image { color: #58a6ff; }
.bottom-add-btn {
    font-size: 16px;
    font-weight: bold;
    min-width: 32px;
    min-height: 40px;
    background-color: #388bfd;
    color: #ffffff;
    border-radius: 6px;
    border: none;
    padding: 0 10px;
}
.bottom-add-btn:hover { background-color: #58a6ff; }
.bottom-add-btn:active { background-color: #1f6feb; }
.bottom-toggle-btn {
    font-size: 13px;
    color: #8b949e;
    min-width: 20px;
    min-height: 40px;
    padding: 0 4px;
    border-radius: 4px;
}
.bottom-toggle-btn:hover { color: #e6edf3; }
.bottom-panel searchentry {
    min-height: 40px;
    font-size: 12px;
    border-radius: 6px;
    background-color: #21262d;
    color: #e6edf3;
    border: 1px solid #30363d;
}
.bottom-panel searchentry entry {
    min-height: 40px;
    border-radius: 6px;
}
.bottom-panel searchentry:focus {
    border-color: #388bfd;
}
.bottom-panel entry.bottom-ollama-entry {
    min-height: 40px;
    font-size: 12px;
    border-radius: 6px;
    background-color: #21262d;
    color: #e6edf3;
    border: 1px solid #30363d;
    padding: 0 8px;
}
.bottom-panel entry.bottom-ollama-entry text {
    color: #e6edf3;
}
.bottom-panel entry.bottom-ollama-entry:focus {
    border-color: #388bfd;
}
/* ── screenshot toast ────────────────────────────────────── */
.screenshot-toast {
    background-color: rgba(22, 27, 34, 0.92);
    color: #e6edf3;
    border-radius: 20px;
    border: 1px solid #30363d;
    padding: 8px 16px;
    font-size: 13px;
}
"""

_CSS_LIGHT = """
window {
    background-color: #ffffff;
    color: #24292f;
}
window.csd {
    box-shadow: none;
    border-radius: 0;
}
windowcontents,
windowcontents > * {
    margin: 0;
    padding: 0;
    border-radius: 0;
}
.app-header {
    background-color: #f6f8fa;
    border-bottom: 1px solid #d0d7de;
    min-height: 40px;
    padding: 0 10px;
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
.panel-right separator {
    background-color: rgba(87, 96, 106, 0.2);
}
.panel-right button.flat {
    color: #57606a;
}
.panel-right button.flat:hover {
    background-color: rgba(9, 105, 218, 0.1);
    color: #24292f;
}
.panel-right .right-panel-surface {
    margin: 0 0 0 8px;
    border: 1px solid rgba(87, 96, 106, 0.16);
    border-radius: 7px;
    background-color: rgba(255, 255, 255, 0.74);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
}
.panel-right .right-tree-surface {
    margin-top: 2px;
}
.panel-right .right-file-tree.view {
    background-color: transparent;
    color: #24292f;
    padding: 3px 2px;
}
.panel-right .right-file-tree.view:hover {
    background-color: rgba(9, 105, 218, 0.08);
}
.panel-right .right-file-tree.view:selected,
.panel-right .right-file-tree.view:focus:selected {
    background-color: rgba(9, 105, 218, 0.18);
    color: #24292f;
}
.panel-right .right-open-windows-section {
    margin-bottom: 6px;
}
.panel-right .right-open-windows-list row {
    border-radius: 6px;
    margin: 2px 4px;
    background-color: transparent;
}
.panel-right .right-open-windows-list row:hover {
    background-color: rgba(9, 105, 218, 0.1);
}
.panel-right .right-open-windows-list label {
    color: #24292f;
}
.panel-right .right-open-windows-list image {
    color: #57606a;
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
.project-pill-draggable { box-shadow: inset 0 3px 0 #0969da; border-color: #0969da; }
.drag-over-top { border-top: 2px solid #0969da; }
.drag-over-bottom { border-bottom: 2px solid #0969da; }
.drag-over-left { border-left: 2px solid #0969da; }
.drag-over-right { border-right: 2px solid #0969da; }
.app-row { border-bottom: 1px solid #d8dee4; }
.app-row:hover { background-color: #f3f4f6; }
.app-running { color: #2da44e; font-size: 10px; }
.app-stopped { color: #8c959f; font-size: 10px; }
.placeholder-label { color: #8c959f; font-size: 16px; }
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
    margin-start: 0;
    margin-end: 0;
}
.status-online { color: #2da44e; }
.status-offline { color: #cf222e; }
.conn-type-label {
    font-size: 10px;
    color: #57606a;
    margin-end: 0;
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
    border-radius: 5px;
    padding: 1px 7px;
    margin-start: 0;
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

/* ── global apps toolbar (light, G6.6) ───────────────────── */
.global-apps-toggle-bar {
    min-height: 8px;
    background: radial-gradient(ellipse 55% 100% at 50% 0%, rgba(9,105,218,0.6) 0%, rgba(9,105,218,0.22) 65%, transparent 100%);
    transition: background 150ms ease;
}
.global-apps-toggle-bar:hover {
    background: radial-gradient(ellipse 55% 100% at 50% 0%, rgba(9,105,218,0.85) 0%, rgba(9,105,218,0.38) 65%, transparent 100%);
}
.file-tree-toggle-strip {
    min-width: 8px;
    background: radial-gradient(ellipse 100% 55% at 100% 50%, rgba(9,105,218,0.6) 0%, rgba(9,105,218,0.22) 65%, transparent 100%);
    transition: background 150ms ease;
}
.file-tree-toggle-strip:hover {
    background: radial-gradient(ellipse 100% 55% at 100% 50%, rgba(9,105,218,0.85) 0%, rgba(9,105,218,0.38) 65%, transparent 100%);
}
.bottom-toggle-strip {
    min-height: 8px;
    background: radial-gradient(ellipse 55% 100% at 50% 100%, rgba(9,105,218,0.6) 0%, rgba(9,105,218,0.22) 65%, transparent 100%);
    transition: background 150ms ease;
}
.bottom-toggle-strip:hover {
    background: radial-gradient(ellipse 55% 100% at 50% 100%, rgba(9,105,218,0.85) 0%, rgba(9,105,218,0.38) 65%, transparent 100%);
}
.global-apps-toggle-bar.panel-open:hover,
.file-tree-toggle-strip.panel-open:hover,
.bottom-toggle-strip.panel-open:hover { background: transparent; }
.global-apps-toolbar {
    background-color: #ffffff;
    border: 1px solid #d0d7de;
    border-radius: 10px;
    padding: 2px 6px;
}
.global-apps-toolbar button.global-app-btn {
    min-width: 30px;
    min-height: 28px;
    padding: 3px 5px;
    border-radius: 6px;
    color: #57606a;
}
.global-apps-toolbar button.global-app-btn:hover {
    background-color: rgba(9, 105, 218, 0.1);
    color: #24292f;
}
.global-apps-toolbar button.global-app-btn:disabled {
    color: #8c959f;
}

/* ── bottom panel (light) ────────────────────────────────── */
.bottom-panel {
    background-color: #f6f8fa;
    border-top: 1px solid #d0d7de;
    min-height: 48px;
}
.project-pill {
    border-radius: 0;
    padding: 0 6px 0 0;
    min-height: 40px;
    margin-top: 3px;
    margin-bottom: 3px;
    background-color: #ffffff;
    color: #24292f;
    border: 1px solid #d0d7de;
    box-shadow: inset 0 3px 0 #bf8700;
}
.project-pill:hover {
    background-color: #f6f8fa;
    color: #24292f;
    border-color: #8c959f;
}
.project-pill-active {
    background-color: rgba(9, 105, 218, 0.10);
    color: #24292f;
    border-color: #0969da;
    box-shadow: inset 0 3px 0 #0969da;
}
.project-pill label { color: inherit; }
.pill-folder-icon {
    color: #bf8700;
}
.project-pill-active .pill-folder-icon { color: #0969da; }
.bottom-root-btn {
    font-size: 12px;
    min-width: 40px;
    min-height: 40px;
    padding: 0;
    border-radius: 6px;
    background-color: #ffffff;
    color: #24292f;
    border: 1px solid #d0d7de;
    box-shadow: inset 0 3px 0 #bf8700;
}
.bottom-root-btn:hover {
    background-color: #f6f8fa;
    color: #24292f;
    border-color: #8c959f;
}
.bottom-root-btn-active {
    background-color: rgba(9, 105, 218, 0.10);
    color: #24292f;
    border-color: #0969da;
    box-shadow: inset 0 3px 0 #0969da;
}
.bottom-root-btn image { color: inherit; }
.bottom-root-btn-active image { color: #0969da; }
.bottom-add-btn {
    font-size: 16px;
    font-weight: bold;
    min-width: 32px;
    min-height: 40px;
    background-color: #0969da;
    color: #ffffff;
    border-radius: 6px;
    border: none;
    padding: 0 10px;
}
.bottom-add-btn:hover { background-color: #0550ae; }
.bottom-add-btn:active { background-color: #054da7; }
.bottom-toggle-btn {
    font-size: 13px;
    color: #57606a;
    min-width: 20px;
    min-height: 40px;
    padding: 0 4px;
    border-radius: 4px;
}
.bottom-toggle-btn:hover { color: #24292f; }
.bottom-panel searchentry {
    min-height: 40px;
    font-size: 12px;
    border-radius: 6px;
    background-color: #eaeef2;
    color: #24292f;
    border: 1px solid #d0d7de;
}
.bottom-panel searchentry entry {
    min-height: 40px;
    border-radius: 6px;
}
.bottom-panel searchentry:focus {
    border-color: #0969da;
}
.bottom-panel entry.bottom-ollama-entry {
    min-height: 40px;
    font-size: 12px;
    border-radius: 6px;
    background-color: #eaeef2;
    color: #24292f;
    border: 1px solid #d0d7de;
    padding: 0 8px;
}
.bottom-panel entry.bottom-ollama-entry text {
    color: #24292f;
}
.bottom-panel entry.bottom-ollama-entry:focus {
    border-color: #0969da;
}
/* ── screenshot toast ────────────────────────────────────── */
.screenshot-toast {
    background-color: rgba(255, 255, 255, 0.92);
    color: #24292f;
    border-radius: 20px;
    border: 1px solid #d0d7de;
    padding: 8px 16px;
    font-size: 13px;
}
"""

_CSS_FANCY_DARK = _CSS + """
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
button.panel-toggle-inline,
button.terminal-back-btn,
.center-tab,
.bottom-root-btn,
.bottom-add-btn,
.bottom-toggle-btn,
.bottom-panel searchentry,
.bottom-panel searchentry entry,
.bottom-panel entry.bottom-ollama-entry,
.debug-badge,
.offline-banner,
progressbar.project-time-bar trough,
progressbar.project-time-bar progress {
    border-radius: 0;
}
.new-project-btn {
    background-color: #2dd4bf;
    color: #07131f;
}
.new-project-btn:hover {
    background-color: #5ff0db;
}
.new-project-btn:active {
    background-color: #1fb8a8;
}
.bottom-add-btn {
    background-color: #36c5f0;
    color: #07131f;
}
.bottom-add-btn:hover {
    background-color: #5edcff;
}
.bottom-add-btn:active {
    background-color: #1ca7d8;
}
.panel-left,
.panel-right {
    background: linear-gradient(180deg, #101624 0%, #16213a 48%, #241735 100%);
    border-color: rgba(94, 220, 255, 0.22);
}
.panel-right {
    background: linear-gradient(90deg, #101624 0%, #16213a 48%, #241735 100%);
    border-left: 1px solid rgba(94, 220, 255, 0.35);
}
.panel-right separator {
    background-color: rgba(94, 220, 255, 0.18);
}
.panel-right button.flat:hover {
    background-color: rgba(45, 212, 191, 0.14);
    color: #f4f8ff;
}
.panel-right .right-panel-surface {
    border-color: rgba(94, 220, 255, 0.16);
    border-radius: 0;
    background-color: rgba(7, 19, 31, 0.34);
    box-shadow: inset 0 1px 0 rgba(139, 233, 255, 0.06);
}
.panel-right .right-file-tree.view:hover,
.panel-right .right-open-windows-list row:hover {
    background-color: rgba(45, 212, 191, 0.12);
}
.panel-right .right-file-tree.view:selected,
.panel-right .right-file-tree.view:focus:selected {
    background-color: rgba(45, 212, 191, 0.22);
    color: #f4f8ff;
}
.panel-right .right-open-windows-list label {
    color: #f4f8ff;
}
.panel-right .right-open-windows-list image {
    color: #8ca3c7;
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
.status-offline {
    color: #ff5c8a;
}
.debug-badge {
    color: #ffd166;
    background-color: rgba(255, 209, 102, 0.13);
    border-color: rgba(255, 209, 102, 0.38);
    border-radius: 5px;
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
    margin-top: 0;
    margin-start: 0;
    margin-end: 0;
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
    margin-top: 0;
    margin-start: 0;
    margin-end: 0;
}
.tab-drag-over-left,
.tab-drag-over-right {
    border-color: #b388ff;
}
.bottom-panel {
    background: linear-gradient(90deg, #101624 0%, #16213a 48%, #241735 100%);
    border-top-color: rgba(94, 220, 255, 0.35);
}
.project-pill {
    background-color: #18243b;
    color: #d8e2f3;
    border-color: #293852;
    box-shadow: inset 0 3px 0 #ffd166;
}
.project-pill:hover {
    background-color: #22304a;
    color: #f4f8ff;
    border-color: rgba(94, 220, 255, 0.38);
}
.project-pill-active {
    background-color: rgba(54, 197, 240, 0.16);
    color: #f4f8ff;
    border-color: #36c5f0;
    box-shadow: inset 0 3px 0 #36c5f0;
}
.pill-folder-icon {
    color: #ffd166;
}
.project-pill-active .pill-folder-icon {
    color: #36c5f0;
}
.bottom-root-btn {
    background-color: #18243b;
    color: #d8e2f3;
    border-color: #293852;
    box-shadow: inset 0 3px 0 #ffd166;
}
.bottom-root-btn:hover {
    background-color: #22304a;
    color: #f4f8ff;
    border-color: rgba(94, 220, 255, 0.38);
}
.bottom-root-btn-active {
    background-color: rgba(54, 197, 240, 0.16);
    color: #f4f8ff;
    border-color: #36c5f0;
    box-shadow: inset 0 3px 0 #36c5f0;
}
.bottom-root-btn-active image {
    color: #36c5f0;
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
.bottom-panel entry.bottom-ollama-entry {
    background-color: #18243b;
    color: #f4f8ff;
    border-color: #293852;
}
.bottom-panel entry.bottom-ollama-entry text {
    color: #f4f8ff;
}
.bottom-panel .project-search-entry,
.bottom-panel entry.project-search-entry,
.bottom-panel .project-search-entry text,
.bottom-panel entry.project-search-entry text,
.bottom-panel entry.bottom-ollama-entry {
    border-radius: 0;
}
.bottom-panel searchentry:focus {
    border-color: #36c5f0;
}
.bottom-panel entry.bottom-ollama-entry:focus {
    border-color: #36c5f0;
}
.global-apps-toggle-bar {
    background: radial-gradient(ellipse 55% 100% at 50% 0%, rgba(54,197,240,0.65) 0%, rgba(54,197,240,0.22) 65%, transparent 100%);
}
.global-apps-toggle-bar:hover {
    background: radial-gradient(ellipse 55% 100% at 50% 0%, rgba(54,197,240,0.9) 0%, rgba(54,197,240,0.38) 65%, transparent 100%);
}
.file-tree-toggle-strip {
    background: radial-gradient(ellipse 100% 55% at 100% 50%, rgba(54,197,240,0.65) 0%, rgba(54,197,240,0.22) 65%, transparent 100%);
}
.file-tree-toggle-strip:hover {
    background: radial-gradient(ellipse 100% 55% at 100% 50%, rgba(54,197,240,0.9) 0%, rgba(54,197,240,0.38) 65%, transparent 100%);
}
.bottom-toggle-strip {
    background: radial-gradient(ellipse 55% 100% at 50% 100%, rgba(54,197,240,0.65) 0%, rgba(54,197,240,0.22) 65%, transparent 100%);
}
.bottom-toggle-strip:hover {
    background: radial-gradient(ellipse 55% 100% at 50% 100%, rgba(54,197,240,0.9) 0%, rgba(54,197,240,0.38) 65%, transparent 100%);
}
.global-apps-toolbar {
    background-color: #101624;
    border-color: #1e2d45;
}
.global-apps-toolbar button.global-app-btn {
    color: #8ca3c7;
}
.global-apps-toolbar button.global-app-btn:hover {
    background-color: rgba(54, 197, 240, 0.14);
    color: #d8e2f3;
}
.global-apps-toolbar button.global-app-btn:disabled {
    color: #2d3a50;
}
"""


_CSS_FANCY_LIGHT = _CSS_LIGHT + """
/* ── fancy bright theme overrides ───────────────────────── */
window {
    background-color: #f7fbff;
    color: #172033;
}
.app-header {
    background: linear-gradient(90deg, #f7fbff 0%, #e8f7ff 48%, #f5ecff 100%);
    border-bottom: 1px solid rgba(9, 105, 218, 0.24);
}
.app-title {
    color: #0969da;
}
button.wm-btn.wm-close { background-color: #ff5c8a; }
button.wm-btn.wm-close:hover { background-color: #d7256f; }
button.wm-btn.wm-minimize { background-color: #ffd166; }
button.wm-btn.wm-minimize:hover { background-color: #b7791f; }
button.wm-btn.wm-maximize { background-color: #7ee787; }
button.wm-btn.wm-maximize:hover { background-color: #1f883d; }
button,
button.wm-btn,
.new-project-btn,
button.panel-toggle-inline,
button.terminal-back-btn,
.center-tab,
.bottom-root-btn,
.bottom-add-btn,
.bottom-toggle-btn,
.bottom-panel searchentry,
.bottom-panel searchentry entry,
.bottom-panel entry.bottom-ollama-entry,
.debug-badge,
.offline-banner,
progressbar.project-time-bar trough,
progressbar.project-time-bar progress {
    border-radius: 0;
}
.new-project-btn {
    background-color: #2dd4bf;
    color: #07131f;
}
.new-project-btn:hover {
    background-color: #14b8a6;
}
.new-project-btn:active {
    background-color: #0d9488;
}
.bottom-add-btn {
    background-color: #0969da;
    color: #ffffff;
}
.bottom-add-btn:hover {
    background-color: #0550ae;
    color: #ffffff;
}
.bottom-add-btn:active {
    background-color: #054da7;
    color: #ffffff;
}
.panel-left,
.panel-right {
    background: linear-gradient(180deg, #f7fbff 0%, #e8f7ff 48%, #f5ecff 100%);
    border-color: rgba(9, 105, 218, 0.18);
}
.panel-right {
    background: linear-gradient(90deg, #f7fbff 0%, #e8f7ff 48%, #f5ecff 100%);
    border-left: 1px solid rgba(9, 105, 218, 0.24);
}
.panel-right separator {
    background-color: rgba(9, 105, 218, 0.16);
}
.panel-right button.flat:hover {
    background-color: rgba(20, 184, 166, 0.12);
    color: #172033;
}
.panel-right .right-panel-surface {
    border-color: rgba(9, 105, 218, 0.14);
    border-radius: 0;
    background-color: rgba(255, 255, 255, 0.62);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
}
.panel-right .right-file-tree.view:hover,
.panel-right .right-open-windows-list row:hover {
    background-color: rgba(20, 184, 166, 0.1);
}
.panel-right .right-file-tree.view:selected,
.panel-right .right-file-tree.view:focus:selected {
    background-color: rgba(20, 184, 166, 0.18);
    color: #172033;
}
.panel-right .right-open-windows-list label {
    color: #172033;
}
.panel-right .right-open-windows-list image {
    color: #5b6f91;
}
.panel-header,
.conn-type-label,
.header-time-label {
    color: #5b6f91;
}
.project-row {
    border-bottom-color: #d8e8f8;
}
.project-row label,
.project-row:selected label,
.project-row:focus:selected label {
    color: #172033 !important;
}
.project-row image,
.project-row:selected image,
.project-row:focus:selected image {
    color: #0969da !important;
}
.project-row-active,
.project-row-warm.project-row-active {
    border-color: #0969da;
}
.project-row-warm {
    background-color: rgba(9, 105, 218, 0.1);
}
.close-btn:hover {
    color: #d7256f;
}
.drag-over-top,
.drag-over-bottom,
.drag-over-left,
.drag-over-right {
    border-color: #8250df;
}
.app-row {
    border-bottom-color: #d8e8f8;
}
.app-row:hover {
    background-color: #e8f7ff;
}
.app-running,
.status-online {
    color: #1f883d;
}
.app-stopped,
.placeholder-label,
.app-version-label {
    color: #7b8da8;
}
.status-offline {
    color: #d7256f;
}
.debug-badge {
    color: #9a6700;
    background-color: rgba(255, 209, 102, 0.25);
    border-color: rgba(154, 103, 0, 0.35);
    border-radius: 5px;
}
.pill-ws-badge {
    color: #d7256f;
}
.offline-banner {
    background-color: rgba(215, 37, 111, 0.88);
}
progressbar.project-time-bar trough {
    background-color: #edf4fb;
    border-color: #c9dff3;
}
progressbar.project-time-bar progress {
    background: linear-gradient(90deg, #0969da 0%, #8250df 100%);
}
.project-time-label {
    color: #172033 !important;
}
button.panel-toggle-inline {
    color: #5b6f91;
}
button.panel-toggle-inline:hover {
    color: #172033;
}
button.terminal-back-btn {
    background-color: rgba(247, 251, 255, 0.94);
    color: #172033;
    border-color: rgba(9, 105, 218, 0.28);
}
button.terminal-back-btn:hover {
    background-color: rgba(232, 247, 255, 0.98);
}
.center-tab {
    color: #5b6f91;
    margin-top: 0;
    margin-start: 0;
    margin-end: 0;
}
.center-tab:hover {
    background-color: rgba(9, 105, 218, 0.08);
    color: #172033;
    border-top-color: rgba(9, 105, 218, 0.45);
}
.center-tab-active {
    background: linear-gradient(180deg, #eef7ff 0%, #f7fbff 100%);
    color: #172033;
    border-top-color: #0969da;
    border-left-color: rgba(9, 105, 218, 0.28);
    border-right-color: rgba(130, 80, 223, 0.28);
    border-bottom-color: #f7fbff;
    box-shadow: 0 -1px 10px rgba(9, 105, 218, 0.12);
    margin-top: 0;
    margin-start: 0;
    margin-end: 0;
}
.tab-drag-over-left,
.tab-drag-over-right {
    border-color: #8250df;
}
.bottom-panel {
    background: linear-gradient(90deg, #f7fbff 0%, #e8f7ff 48%, #f5ecff 100%);
    border-top-color: rgba(9, 105, 218, 0.24);
}
.project-pill {
    background-color: #ffffff;
    color: #2f3a4f;
    border-color: #c9dff3;
    box-shadow: inset 0 3px 0 #b7791f;
}
.project-pill:hover {
    background-color: #e8f7ff;
    color: #172033;
    border-color: rgba(9, 105, 218, 0.35);
}
.project-pill-active {
    background-color: rgba(9, 105, 218, 0.1);
    color: #172033;
    border-color: #0969da;
    box-shadow: inset 0 3px 0 #0969da;
}
.pill-folder-icon {
    color: #b7791f;
}
.project-pill-active .pill-folder-icon {
    color: #0969da;
}
.bottom-root-btn {
    background-color: #ffffff;
    color: #2f3a4f;
    border-color: #c9dff3;
    box-shadow: inset 0 3px 0 #b7791f;
}
.bottom-root-btn:hover {
    background-color: #e8f7ff;
    color: #172033;
    border-color: rgba(9, 105, 218, 0.35);
}
.bottom-root-btn-active {
    background-color: rgba(9, 105, 218, 0.1);
    color: #172033;
    border-color: #0969da;
    box-shadow: inset 0 3px 0 #0969da;
}
.bottom-root-btn-active image {
    color: #0969da;
}
.bottom-toggle-btn {
    color: #5b6f91;
}
.bottom-toggle-btn:hover {
    color: #172033;
}
.bottom-panel searchentry {
    background-color: #ffffff;
    color: #172033;
    border-color: #c9dff3;
}
.bottom-panel entry.bottom-ollama-entry {
    background-color: #ffffff;
    color: #172033;
    border-color: #c9dff3;
}
.bottom-panel entry.bottom-ollama-entry text {
    color: #172033;
}
.bottom-panel .project-search-entry,
.bottom-panel entry.project-search-entry,
.bottom-panel .project-search-entry text,
.bottom-panel entry.project-search-entry text,
.bottom-panel entry.bottom-ollama-entry {
    border-radius: 0;
}
.bottom-panel searchentry:focus {
    border-color: #0969da;
}
.bottom-panel entry.bottom-ollama-entry:focus {
    border-color: #0969da;
}
.global-apps-toggle-bar {
    background: radial-gradient(ellipse 55% 100% at 50% 0%, rgba(9,105,218,0.5) 0%, rgba(9,105,218,0.18) 65%, transparent 100%);
}
.global-apps-toggle-bar:hover {
    background: radial-gradient(ellipse 55% 100% at 50% 0%, rgba(9,105,218,0.75) 0%, rgba(9,105,218,0.32) 65%, transparent 100%);
}
.file-tree-toggle-strip {
    background: radial-gradient(ellipse 100% 55% at 100% 50%, rgba(9,105,218,0.5) 0%, rgba(9,105,218,0.18) 65%, transparent 100%);
}
.file-tree-toggle-strip:hover {
    background: radial-gradient(ellipse 100% 55% at 100% 50%, rgba(9,105,218,0.75) 0%, rgba(9,105,218,0.32) 65%, transparent 100%);
}
.bottom-toggle-strip {
    background: radial-gradient(ellipse 55% 100% at 50% 100%, rgba(9,105,218,0.5) 0%, rgba(9,105,218,0.18) 65%, transparent 100%);
}
.bottom-toggle-strip:hover {
    background: radial-gradient(ellipse 55% 100% at 50% 100%, rgba(9,105,218,0.75) 0%, rgba(9,105,218,0.32) 65%, transparent 100%);
}
.global-apps-toolbar {
    background-color: #f7fbff;
    border-color: #c9dff3;
}
.global-apps-toolbar button.global-app-btn {
    color: #5b6f91;
}
.global-apps-toolbar button.global-app-btn:hover {
    background-color: rgba(9, 105, 218, 0.1);
    color: #172033;
}
"""


_css_provider: Gtk.CssProvider | None = None


def _normalize_theme(scheme) -> str:
    if isinstance(scheme, bool):
        return "dark" if scheme else "light"
    if scheme == "fancy":
        return "fancy_dark"
    if scheme in ("dark", "light", "fancy_dark", "fancy_light"):
        return scheme
    return "fancy_dark"


def set_theme(scheme):
    global _css_provider
    display = Gdk.Display.get_default()
    if _css_provider is not None:
        Gtk.StyleContext.remove_provider_for_display(display, _css_provider)
    _css_provider = Gtk.CssProvider()
    scheme = _normalize_theme(scheme)
    css = {
        "dark": _CSS,
        "light": _CSS_LIGHT,
        "fancy_dark": _CSS_FANCY_DARK,
        "fancy_light": _CSS_FANCY_LIGHT,
    }[scheme]
    _css_provider.load_from_data(css, -1)
    Gtk.StyleContext.add_provider_for_display(
        display,
        _css_provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    )


def _apply_css():
    set_theme("dark")


def _application_init_kwargs() -> dict[str, str]:
    return {"application_id": "io.github.fseiffarth.eldrun"}


class EldrunApp(Adw.Application):
    def __init__(self):
        super().__init__(**_application_init_kwargs())

    def do_activate(self):
        win = self.props.active_window
        if win is not None:
            win.present()
            return
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
