# ProjectEldrun - Status

This file is the short current-state snapshot. It should not contain generated
time logs or long-form design notes; those belong in Eldrun runtime state and
`DOCUMENTATION.md`.

Last reviewed: 2026-08-31

## Current State

- Version: `0.1.58` (Tauri 2 + React + TypeScript). Python/GTK4 code dropped.
- Primary target: Linux desktop (X11 and KDE Wayland). Windows ships as an
  alpha (CI-verified only); macOS has core parity but cannot be built on Linux.
- All 10 migration phases from TauriRust.md are complete and merged.
- **Landed since this file was last accurate (v0.1.0 → v0.1.45):** mount-free
  remote/SSH projects with git lockstep + multi-host workers, per-project Docker
  session containers, embedded IMAP/SMTP mail with a sealed local store and an
  OpenPGP track, calendar + CalDAV accounts and a Trello-style to-do board, the
  native "Deck" presenter, a broad viewer set (table/notebook/diff/search,
  mermaid+katex, sqlite, media, html/svg, image annotation, xlsx), popout
  subwindows, the Agent Skills library, HPC/SLURM support, and full 5-language
  i18n (5571 keys).
- **Landed since (v0.1.45 → v0.1.58):** the Eldrun Mobile companion PWA
  (`mobile-web/`) reaching agent tabs through a loopback sidecar, VM projects as
  a third trust tier, the default-on bubblewrap fence for local agents
  (`services::agent_fence`), boxes with N:M membership, the keyboard-steering
  mode + shortcut sheet, the Theme Customizer with saved presets, the header
  status cluster, the `ELDRUN_HOME` dev sandbox launcher, and the agent warm-up
  cron.
- **Verification status is the important caveat:** most of the above is
  code-complete but has never been run in a live Eldrun. See `TODO.md`'s status
  legend — Done ≠ Tested — and the `UntestedTag` pills in the UI.
- App shell: root terminal, project terminals, agent tabs (Claude/Codex/Gemini/
  Vibe/Shell), bottom project switcher, right file tree, global app toolbar,
  hover-revealed panels, time tracking, and optional workspace management.
- Local Ollama support: installed models appear as Local Agent tab choices,
  local tabs run through Vibe with isolated per-model `VIBE_HOME` configs, and
  the Settings Ollama panel can list, install/update, unload, and delete models.
- Hover-revealed UI: the two side panels (global app bar, right file panel)
  appear on pointer hover and auto-close when the pointer leaves; the project
  switcher lives in the top header bar.
- Project pill hover shows path, status, and today's active time.
- Session state (tab layout, `open_apps`) is persisted per project id OUTSIDE
  the project tree, in `<state_dir>/sessions/<id>/terminals.json`; the in-project
  copy is legacy/export-only and `open_apps` is never adopted from it.
  `project.json` keeps project identity, remote specs, and runtime settings.
- External window tracking replaces X11 embedding; file opens use `xdg-open`.
- X11 two-desktop parking model and KDE Wayland per-project virtual desktop
  model are both implemented. KDE 5 and KDE 6 are supported.
- Downloads symlink (`~/eldrun/downloads`) and Firefox/Chromium preference
  editing are implemented.
- `F11` toggles fullscreen; `Super` toggles all panels.
- Crash logging to `~/.local/share/eldrun/crash.log`.
- Packaging: Debian `.deb` and AppImage targets.
- Current documentation pass updated `README.md`, `DOCUMENTATION.md`, and this
  status snapshot for the Ollama model-management and local-agent changes.

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

- Frontend tests: `npm test` — 3534 tests across 303 files, all passing.
- Tauri/Rust tests: `cargo test` in `src-tauri/` (schema round-trip tests plus
  service-level regression tests).
- Frontend build: `npm run build` (TypeScript + Vite; must be clean). It is the
  ONLY gate that type-checks — `npm test` and ESLint do not — and it builds the
  `mobile-web/` bundle too, so a type error there fails it.
- Lint: `npm run lint` and `cargo clippy … -D warnings`, both at zero and both
  CI gates. Local clippy ≠ CI clippy (CI uses today's stable).
- Privacy: `scripts/privacy-check.sh` must pass before every push (git hook +
  a CI job); this repo is public.
- All of the above run in CI on Linux, Windows, and macOS.
- Runtime validation needs a human-run Eldrun session. Agents must not launch a
  second Eldrun instance for verification.

## Known Rough Edges

- KDE Wayland workspace management is implemented but needs live-session QA.
- KDE 5 Wayland: `XMLHttpRequest file://` in KWin scripting may be sandboxed;
  window enumeration falls back to tracked-only mode if the file write fails.
- Tab layout is persisted but PTYs do not survive app restarts; terminals
  respawn their child processes on next activation. Shell and files tabs restore;
  Claude/Codex agent tabs with a `sessionId` resume through the session hooks,
  while Gemini/Vibe restore is more limited. Long-running work on a remote host
  survives via tmux sessions instead.
- Ollama pulls/updates depend on network access to the Ollama registry and can
  take minutes for large models.
- Starting the system Ollama service depends on local user permissions; Eldrun
  falls back to a user `ollama serve` process when needed.
- Open-app restore is best-effort relaunch; the geometry of *externally launched
  app* windows is not restored. Eldrun's own main window does reopen on the
  monitor, at the position/size, and in the maximized state it was last closed in.
- Download routing browser preference edits assume the browser is not running.

## Time Log

Tracked in Eldrun runtime state (`~/.local/share/eldrun/time_log.json`), not here —
see this file's header. The previous truncated raw table was removed 2026-07-28.
