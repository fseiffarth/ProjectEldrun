# ProjectEldrun — Roadmap

This file captures product direction and sequencing. Concrete implementation
tasks live in `TODO.md`; current status and validation notes live in
`STATUS.md`; current behavior and architecture live in `DOCUMENTATION.md`.

## Deferred Features

- **Agent session resume**: on project restore, detect the most-recent agent
  session file (`.claude/projects/<encoded-path>/*.jsonl`, codex sessions dir,
  `.gemini/history/`, vibe `$VIBE_HOME/logs/session/`) and pass `--resume <id>`
  when spawning the restored agent tab so the conversation continues across
  Eldrun restarts. Removed (2026-06-07) because detection was unreliable and
  the `--resume` flag conflicted with fresh-start behavior the user wanted.
  Also needs multi-tab disambiguation (each tab must track its own session ID,
  not the project-global most-recent one).

## Near Term

- Live-session QA: terminal resize/exit/paste, project switch, workspace
  switching (X11 and KDE Wayland), download routing, browser pref editing.
- Promote `rust_migration` to `main` after QA passes.
- Harden project context routing: file tree state, active-project download
  symlink, app defaults, time tracking, and tab layout should reliably follow
  the active project.
- Improve coverage for terminal lifecycle, project CRUD, and workspace backends
  without requiring a live display server.
- Keep docs split by purpose so generated runtime state does not churn tracked
  project files.

## Core Reliability

- Make standalone open-app handling reliable before extending it. File opens
  should launch, track, and restore predictably.
- Tighten workspace-management behavior for X11 and KDE Wayland, including
  cleanup after normal exits and clear warnings for kill-9 cases.
- Keep runtime-generated state in `~/.local/share/eldrun/` or project-local
  `project.json`, not in human-maintained markdown files.

## App and Workspace Integration

- Keep global apps separate from project-owned apps. Browser, mail, calendar,
  notes, screenshot, and similar roles should stay visible across workspaces
  and avoid being assigned to a project.
- Route common URI schemes from terminal links through the global app launcher.
- Improve file opening around system MIME defaults, per-project overrides, and
  the app picker so users can correct defaults without leaving Eldrun.

## Platform Direction

- Linux X11 is the primary target for launch-or-raise, sticky windows, and
  full workspace control.
- KDE Plasma (X11 and Wayland) has a first-class backend. KDE Wayland
  per-project virtual desktop isolation is implemented; live-session QA is
  needed before the 0.2.0 version bump.
- For non-KDE Wayland compositors (Sway, Hyprland, GNOME on Wayland), workspace
  switching, sticky-window state, launch-or-raise, and app embedding are not
  implemented — each requires a compositor-specific backend.
- Windows/macOS builds are experimental shells until native default-app, window,
  download, and workspace integrations are added.
