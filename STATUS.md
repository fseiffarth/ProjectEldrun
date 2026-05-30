# ProjectEldrun - Status

This file is the short current-state snapshot. It should not contain generated
time logs or long-form design notes; those belong in Eldrun runtime state and
`DOCUMENTATION.md`.

Last reviewed: 2026-05-29

## Current State

- Version: `0.0.7`.
- Primary target: Linux desktop on X11, developed mainly against Cinnamon.
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

## Quality Snapshot

- Unit tests cover project management, settings, default apps, global apps,
  network detection, time tracking, workspace helpers, Ollama client behavior,
  download routing, app picker behavior, and panel-adjacent logic.
- Last agent-run checks:
  - `python3 -m unittest`
  - `python3 -m py_compile app/eldrun.py app/window.py app/project_manager.py app/new_project_dialog.py app/import_project_dialog.py app/settings_manager.py app/default_apps_manager.py app/network_monitor.py app/time_tracker.py app/project_stats.py app/workspace_manager.py app/panels/*.py`
- Runtime validation still needs a human-run Eldrun session. Agents should not
  launch a second Eldrun instance for verification.

## Known Rough Edges

- X11 embedding, launch-or-raise, sticky windows, and workspace control are
  best-effort and need live-session testing.
- Wayland support is not implemented for embedding and workspace manipulation.
- Open-app restore has metadata support but is not yet a robust current feature.
- Extra agent/plain terminal tab layout is runtime state and is not restored
  across restarts.
- Ollama autostart is partial; daemon cleanup should be verified manually.

## Time Log

Total: 41h 14m

| Date | Start | Duration |
|------|-------|----------|
| 2026-05-30 | 2026-05-30 20:18 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
| 2026-05-30 | 2026-05-30 20:17 | 0h 0m |
