# ProjectEldrun - Status

This file is the short current-state snapshot. It should not contain generated
time logs or long-form design notes; those belong in Eldrun runtime state and
`DOCUMENTATION.md`.

Last reviewed: 2026-05-31

## Current State

- Version: `0.0.17`.
- Primary target: Linux desktop (X11 and KDE Wayland).
- Main app shell is in place: root terminal, project terminals, agent tabs,
  bottom project switcher, right file tree, global app toolbar, settings, time
  tracking, and optional workspace management.
- Claude and Codex are first-class VTE agent commands. Ollama is integrated via
  a GTK dialog and HTTP streaming, not as a persistent terminal tab.
- Global apps are cross-project shortcuts stored in
  `settings.json["global_apps"]`; they are separate from project file-extension
  defaults.
- Browser download routing uses `~/eldrun/downloads`, a symlink that follows the
  active project or falls back to the root workspace.
- **KDE Plasma backend** (Phase 6a + 6b): full workspace isolation on KDE X11
  and KDE Wayland via Xlib EWMH (X11) and KWin JS scripting / DBus (Wayland).
  KDE 5 and KDE 6 are both supported.

## Quality Snapshot

- Unit tests cover project management, settings, default apps, global apps,
  network detection, time tracking, workspace helpers, Ollama client behavior,
  download routing, app picker behavior, panel-adjacent logic, and the KDE
  Plasma backend (X11 + Wayland paths, ~127 tests).
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
- Ollama autostart is partial; daemon cleanup should be verified manually.

## Time Log

Total: 57h 36m

| Date | Start | Duration |
|------|-------|----------|
| 2026-05-31 | 2026-05-31 12:41 | 0h 0m |
| 2026-05-31 | 2026-05-31 12:41 | 0h 0m |
| 2026-05-31 | 2026-05-31 12:00 | 0h 40m |
| 2026-05-31 | 2026-05-31 11:58 | 0h 2m |
| 2026-05-31 | 2026-05-31 11:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 11:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 11:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 11:57 | 0h 0m |
| 2026-05-31 | 2026-05-31 11:57 | 0h 0m |
| 2026-05-31 | 2026-05-31 11:25 | 0h 32m |
| 2026-05-31 | 2026-05-31 10:32 | 0h 52m |
| 2026-05-31 | 2026-05-31 10:32 | 0h 0m |
| 2026-05-31 | 2026-05-31 10:32 | 0h 0m |
| 2026-05-31 | 2026-05-31 10:31 | 0h 0m |
| 2026-05-31 | 2026-05-31 10:31 | 0h 0m |
| 2026-05-31 | 2026-05-31 10:24 | 0h 6m |
| 2026-05-31 | 2026-05-31 10:24 | 0h 0m |
| 2026-05-31 | 2026-05-31 10:23 | 0h 0m |
| 2026-05-31 | 2026-05-31 10:22 | 0h 0m |
| 2026-05-31 | 2026-05-31 10:14 | 0h 8m |
