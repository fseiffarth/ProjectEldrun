# ProjectEldrun - Roadmap

This file captures product direction and sequencing. Concrete implementation
tasks live in `TODO.md`; current status and validation notes live in
`STATUS.md`; current behavior and architecture live in `DOCUMENTATION.md`.

## Near Term

- Stabilize the current GTK shell: hover-revealed panels, header tab bar,
  bottom project switcher, settings windows, and global app toolbar.
- Harden project context routing: file tree state, active-project download
  symlink, app defaults, time tracking, and task metadata should reliably follow
  the active project.
- Improve coverage around the new local AI, app picker, download routing, and
  window-layout helpers without requiring a live display server.
- Keep docs split by purpose so generated runtime state does not churn tracked
  project files.

## Core Reliability

- Make standalone open-app handling reliable before extending embedding. File
  opens should launch, track, close, and restore predictably even when X11
  reparenting fails.
- Treat X11 embedding as an enhancement path. It needs recovery that always
  returns the center panel to a valid terminal or app state when window probing
  fails.
- Tighten workspace-management behavior for Cinnamon, GNOME, and `wmctrl`,
  including cleanup after normal exits and clear warnings for hard-kill cases.
- Keep runtime-generated state in `~/.local/share/eldrun/` or project-local
  `project.json`, not in human-maintained markdown files.

## Local AI

- Turn Ollama support from a lightweight prompt dialog into a useful local AI
  surface: status indication, model selection, privacy labeling, and explicit
  daemon lifecycle controls.
- Add context-aware helpers only after the basic Ollama path is stable:
  terminal hints, suggested files, suggested projects, and semantic project
  search.
- Keep Claude/Codex terminal agents and Ollama dialog behavior clearly separate
  unless a persistent local-agent terminal mode is intentionally designed.

## App and Workspace Integration

- Keep global apps separate from project-owned apps. Browser, mail, calendar,
  notes, screenshot, and similar roles should stay visible across workspaces and
  avoid being assigned to a project.
- Route common URI schemes through the global app launcher instead of bare
  `xdg-open` calls.
- Improve file opening around system MIME defaults, per-project overrides, and
  the app picker so users can correct defaults without leaving Eldrun.

## Platform Direction

- X11 remains the supported target for embedding, launch-or-raise, sticky
  windows, and full workspace control.
- KDE Plasma (X11 and Wayland) now has a first-class backend. KDE Wayland
  virtual desktop isolation is implemented; live-session QA is needed before
  the 0.2.0 version bump.
- For non-KDE Wayland compositors (Sway, Hyprland, GNOME on Wayland), workspace
  switching, sticky-window state, launch-or-raise, and app embedding are not yet
  implemented — each would require a compositor-specific backend.
- Cross-platform Windows/macOS support is out of scope for the current GTK/VTE
  architecture.
