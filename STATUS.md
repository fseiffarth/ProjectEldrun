# ProjectEldrun - Status

This file is the short current-state snapshot. It should not contain generated
time logs or long-form design notes; those belong in Eldrun runtime state and
`DOCUMENTATION.md`.

Last reviewed: 2026-06-01

## Current State

- Version: `0.1.0` (Tauri 2 + React + TypeScript). Python/GTK4 code dropped.
- Primary target: Linux desktop (X11 and KDE Wayland).
- All 10 migration phases from TauriRust.md are complete and merged.
- App shell: root terminal, project terminals, agent tabs (Claude/Codex/Gemini/
  Vibe/Shell), bottom project switcher, right file tree, global app toolbar,
  hover-revealed panels, time tracking, and optional workspace management.
- Hover-revealed UI: all three side panels (global app bar, right file panel,
  bottom bar) appear on pointer hover and auto-close when the pointer leaves.
- Project pill hover shows path, status, and today's active time.
- Tab layout is persisted per project in `project.json["tab_layout"]`.
- External window tracking replaces X11 embedding; file opens use `xdg-open`.
- X11 two-desktop parking model and KDE Wayland per-project virtual desktop
  model are both implemented. KDE 5 and KDE 6 are supported.
- Downloads symlink (`~/eldrun/downloads`) and Firefox/Chromium preference
  editing are implemented.
- `F11` toggles fullscreen; `Super` toggles all panels.
- Crash logging to `~/.local/share/eldrun/crash.log`.
- Packaging: Debian `.deb` and AppImage targets.

## Completed Migration Phases

- **Phase 1**: Rust schema harness (serde models + 15 round-trip tests, backup-before-write)
- **Phase 2**: Tauri v2 shell + React/TS frontend (4 themes, layout, settings/projects IPC)
- **Phase 3**: xterm.js + portable-pty terminal MVP (batched output, crash-loop guard)
- **Phase 4**: Project CRUD, scaffold writer, validated file tree, MIME detection
- **Phase 5**: TabBar with Claude/Codex/Gemini/Shell tabs, tab layout persistence
- **Phase 6**: External window tracking; `open_file` via xdg-open
- **Phase 7**: X11 EWMH two-desktop backend + KDE Wayland per-project desktop + null backend
- **Phase 8**: Downloads symlink + browser pref editing, F11/Super shortcuts, crash logging, packaging
- **Phase 9**: Full UI overhaul — hover panels, project management dialogs (`tauri-plugin-dialog`)
- **Phase 10**: Python GTK app dropped; time-today popup on project pill hover

## Quality Snapshot

- Tauri/Rust tests: `cargo test` in `src-tauri/` (15 schema round-trip tests passing).
- Frontend build: `npm run build` (TypeScript + Vite; must be clean).
- Runtime validation needs a human-run Eldrun session. Agents must not launch a
  second Eldrun instance for verification.

## Known Rough Edges

- KDE Wayland workspace management is implemented but needs live-session QA.
- KDE 5 Wayland: `XMLHttpRequest file://` in KWin scripting may be sandboxed;
  window enumeration falls back to tracked-only mode if the file write fails.
- Tab layout is persisted but PTYs do not survive app restarts; terminals
  respawn their child processes on next activation.
- Open-app restore is best-effort relaunch; window geometry is not restored.
- Download routing browser preference edits assume the browser is not running.

## Time Log

Total: 75h 20m

| Date | Start | Duration |
|------|-------|----------|
| 2026-06-01 | 2026-06-01 06:31 | 0h 0m |
| 2026-06-01 | 2026-06-01 06:31 | 0h 0m |
| 2026-06-01 | 2026-06-01 06:31 | 0h 0m |
| 2026-06-01 | 2026-06-01 06:31 | 0h 0m |
| 2026-06-01 | 2026-06-01 06:31 | 0h 0m |
| 2026-06-01 | 2026-06-01 06:31 | 0h 0m |
| 2026-05-31 | 2026-05-31 20:40 | 9h 50m |
| 2026-05-31 | 2026-05-31 20:39 | 0h 0m |
| 2026-05-31 | 2026-05-31 20:39 | 0h 0m |
| 2026-05-31 | 2026-05-31 20:37 | 0h 1m |
| 2026-05-31 | 2026-05-31 20:24 | 0h 13m |
| 2026-05-31 | 2026-05-31 20:23 | 0h 0m |
| 2026-05-31 | 2026-05-31 20:23 | 0h 0m |
| 2026-05-31 | 2026-05-31 20:18 | 0h 5m |
| 2026-05-31 | 2026-05-31 20:18 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:58 | 0h 20m |
| 2026-05-31 | 2026-05-31 19:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:58 | 0h 0m |
