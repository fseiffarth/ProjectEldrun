# ProjectEldrun - Status

This file is the short current-state snapshot. It should not contain generated
time logs or long-form design notes; those belong in Eldrun runtime state and
`DOCUMENTATION.md`.

Last reviewed: 2026-05-31

## Current State

- Version: `0.0.18`.
- Primary target: Linux desktop (X11 and KDE Wayland).
- Main app shell is in place: root terminal, project terminals, agent tabs,
  bottom project switcher, right file tree, global app toolbar, settings, time
  tracking, and optional workspace management.
- Claude and Codex are first-class VTE agent commands.
- Global apps are cross-project shortcuts stored in
  `settings.json["global_apps"]`; they are separate from project file-extension
  defaults.
- Browser download routing uses `~/eldrun/downloads`, a symlink that follows the
  active project or falls back to the root workspace.
- **KDE Plasma backend** (Phase 6a + 6b): full workspace isolation on KDE X11
  and KDE Wayland. X11 uses the 2-desktop Xlib EWMH model. KDE Wayland uses a
  per-project virtual desktop model: each project gets a dedicated KDE virtual
  desktop; switching projects switches the active desktop via
  `VirtualDesktopManager.current` (DBus). Eldrun is made sticky at startup so
  it remains visible across all desktops. KDE 5 and KDE 6 are both supported.

## Quality Snapshot

- Unit tests cover project management, settings, default apps, global apps,
  network detection, time tracking, workspace helpers, download routing, app
  picker behavior, panel-adjacent logic, and the KDE Plasma backend
  (X11 + Wayland paths).
- Last agent-run checks:
  - `python3 -m unittest`
  - `python3 -m py_compile app/eldrun.py app/window.py app/project_manager.py app/new_project_dialog.py app/import_project_dialog.py app/settings_manager.py app/default_apps_manager.py app/network_monitor.py app/time_tracker.py app/project_stats.py app/workspace_manager.py app/panels/*.py`
- Runtime validation still needs a human-run Eldrun session. Agents should not
  launch a second Eldrun instance for verification.

## Known Rough Edges

- X11 embedding, launch-or-raise, and sticky windows are best-effort and need
  live-session testing.
- KDE Wayland backend needs live-session QA before 0.2.0 version bump.
- KDE 5 Wayland: `XMLHttpRequest file://` in KWin scripting may be sandboxed;
  window enumeration falls back to tracked-only mode if the file write fails.
- Open-app restore uses a 500 ms startup delay to avoid a GTK4 frame-clock
  reentrance crash (`get_monitor_at_surface` during the first idle callback).
- Extra agent/plain terminal tab layout is runtime state and is not restored
  across restarts.

## Time Log

Total: 64h 26m

| Date | Start | Duration |
|------|-------|----------|
| 2026-05-31 | 2026-05-31 19:36 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:35 | 0h 1m |
| 2026-05-31 | 2026-05-31 19:32 | 0h 3m |
| 2026-05-31 | 2026-05-31 19:29 | 0h 2m |
| 2026-05-31 | 2026-05-31 19:28 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:25 | 0h 3m |
| 2026-05-31 | 2026-05-31 19:25 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:23 | 0h 2m |
| 2026-05-31 | 2026-05-31 19:22 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:21 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:20 | 0h 1m |
| 2026-05-31 | 2026-05-31 19:19 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:02 | 0h 15m |
| 2026-05-31 | 2026-05-31 19:01 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:01 | 0h 0m |
| 2026-05-31 | 2026-05-31 18:58 | 0h 2m |
| 2026-05-31 | 2026-05-31 18:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 18:57 | 0h 1m |
| 2026-05-31 | 2026-05-31 18:56 | 0h 0m |
| 2026-05-31 | 2026-05-31 18:56 | 0h 0m |
