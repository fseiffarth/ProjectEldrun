# Eldrun

A GTK4 terminal manager for AI-assisted development. Three-column layout — project file tree, terminal(s), and project list — so you can run `claude` in each project directory without switching windows.

```
┌────────────┬───────────────────────────┬────────────┐
│  OPEN APPS │  terminal / app view       │  Root btn  │
│  (filtered │                            │  ────────  │
│   by proj) │                            │  PROJECTS  │
│  ──────────│                            │  proj-a  × │
│  PROJECT   │                            │  proj-b  × │
│  file tree │                            │  ────────  │
│            │                            │     +      │
└────────────┴───────────────────────────┴────────────┘
```

## Requirements

- Python 3.11+
- GTK 4, Libadwaita, VTE 3.91

```bash
# Debian / Ubuntu
sudo apt install python3 python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 \
    gir1.2-vte-3.91 gir1.2-gdkx11-4.0
pip3 install --user python-xlib
```

## Run

```bash
cd app && python3 eldrun.py
```

Or install the desktop launcher:

```bash
cp eldrun.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications/
```

## Features

- **Root button** — opens a terminal in `~/eldrun/` (the workspace root)
- **+ button** — popover with **New Project** (creates git repo + scaffold under `~/eldrun/projects/<name>/`) and **Import Project** (copies an existing folder in)
- **× on a project row** — closes that project's terminal and removes it from the list
- **Active project indicator** — red border on the active row in the project list
- **Search field** — type to filter projects; Enter on a unique match opens it immediately
- **Left panel** — file tree for the active project + open-apps browser that tracks and restores files/apps across project switches
- **Window chrome** — custom minimize / maximize / close buttons; drag the header to move
- **F11** — toggle fullscreen

Projects are stored as git repositories. Each new project gets scaffold files (`CLAUDE.md`, `AGENTS.md`, `TODO.md`, `ROADMAP.md`, etc.) committed on creation.

See [DOCUMENTATION.md](DOCUMENTATION.md) for full architecture details.
