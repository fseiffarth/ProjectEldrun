# ProjectEldrun - Status

This file is the short current-state snapshot. It should not contain generated
time logs or long-form design notes; those belong in Eldrun runtime state and
`DOCUMENTATION.md`.

Last reviewed: 2026-05-31

## Current State

- Version: `0.0.18` (Python/GTK4 app); Tauri migration on `rust_migration` branch.
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

## Tauri Migration (rust_migration branch)

All 8 phases from TauriRust.md are implemented:
- **Phase 1**: Rust schema harness (serde models + 15 round-trip tests, backup-before-write)
- **Phase 2**: Tauri v2 shell + React/TS frontend (4 themes, layout, settings/projects IPC)
- **Phase 3**: xterm.js + portable-pty terminal MVP (batched output, crash-loop guard, ready event)
- **Phase 4**: Project CRUD, scaffold writer, validated file tree, MIME detection
- **Phase 5**: TabBar with Claude/Codex/Gemini/Shell tabs, tab layout persistence
- **Phase 6**: External window tracking replaces X11 embedding; open_file via xdg-open
- **Phase 7**: X11 EWMH two-desktop backend + KDE Wayland per-project desktop + null backend
- **Phase 8**: Downloads symlink + browser pref editing, F11/Super shortcuts, crash logging, deb+AppImage packaging

Build: `. ~/.cargo/env && cargo build && npm run build`
Tests: `. ~/.cargo/env && cargo test` (15 passing)

Needs live QA before promotion to main: terminal resize/exit/paste, workspace switching, browser pref editing.

## Quality Snapshot

- Python app unit tests: `python3 -m unittest` (132 passing on main branch).
- Tauri migration tests: `cargo test` (15 schema round-trip tests passing).
- Last agent-run checks (Python app):
  - `python3 -m unittest`
  - `python3 -m py_compile app/eldrun.py app/window.py ...`
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

Total: 65h 13m

| Date | Start | Duration |
|------|-------|----------|
| 2026-05-31 | 2026-05-31 20:23 | 0h 0m |
| 2026-05-31 | 2026-05-31 20:23 | 0h 0m |
| 2026-05-31 | 2026-05-31 20:18 | 0h 5m |
| 2026-05-31 | 2026-05-31 20:18 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:58 | 0h 20m |
| 2026-05-31 | 2026-05-31 19:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:58 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:57 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:56 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:55 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:55 | 0h 0m |
| 2026-05-31 | 2026-05-31 19:54 | 0h 1m |
| 2026-05-31 | 2026-05-31 19:49 | 0h 5m |
| 2026-05-31 | 2026-05-31 19:48 | 0h 0m |
