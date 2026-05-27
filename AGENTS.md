# ProjectEldrun

## Purpose

ProjectEldrun, or Eldrun, is a GTK4 desktop workspace for AI-assisted
development. It manages a root control terminal, one terminal per active
project, a bottom project switcher, a right-side project file browser, app
launching/embedding, time tracking, and optional Cinnamon workspace integration.

## Key conventions

- App code lives under `app/`; the entry point is `app/eldrun.py`.
- The UI is composed by `app/window.py`, with `CenterPanel`,
  `FileTreePanel` from the historical `app/panels/right_panel.py` filename, and
  `BottomPanel`.
- Managed projects normally live under `~/eldrun/projects/<sanitized-name>/`.
  The root terminal uses `~/eldrun/root/`.
- Global state lives in `~/.local/share/eldrun/`, especially `projects.json`,
  `settings.json`, `default_apps.json`, `time_log.json`, and
  `active_session.json`.
- Project-local state lives in each project's `project.json`; current open-app
  metadata is stored in `project.json["open_apps"]`.
- New/imported projects are scaffolded with `AGENTS.md`, `CLAUDE.md`,
  `.claude/settings.json`, `.gitignore`, `TODO.md`, `ROADMAP.md`, `STATUS.md`,
  and `DOCUMENTATION.md`.
- X11 embedding and workspace control are best-effort features. Wayland support
  is not implemented for those paths.

## Development workflow

- Prefer small, focused changes that match the existing GTK4/Python style.
- Use `rg` for code search.
- Do not rename `app/panels/right_panel.py` casually; it is documented as a
  historical filename whose live widget is `FileTreePanel`.
- Avoid unrelated rewrites in docs, generated state, or project metadata.
- Before handing off code changes, run at least:

```bash
python3 -m unittest
```

For syntax checks, use:

```bash
python3 -m py_compile app/eldrun.py app/window.py app/project_manager.py \
  app/new_project_dialog.py app/import_project_dialog.py app/settings_manager.py \
  app/default_apps_manager.py app/network_monitor.py app/time_tracker.py \
  app/project_stats.py app/workspace_manager.py app/panels/*.py
```

## Running locally

Preferred launcher:

```bash
./start-eldrun.sh
```

Direct run:

```bash
cd app && python3 eldrun.py
```
