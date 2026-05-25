# ProjectEldrun — Documentation

Eldrun is a GTK4 terminal manager for AI-assisted development. It provides a
three-column layout — project file tree, terminal(s), and project list — so
you can run `claude` in each project directory without leaving the window.

## Install

### Dependencies

```bash
# Debian / Ubuntu
sudo apt install python3 python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 \
    gir1.2-vte-3.91 gir1.2-gdkx11-4.0
pip3 install --user python-xlib
```

> **Note:** GTK ≥ 4.10 is required for `Gtk.FileChooserNative` used in the Import dialog.
> On older GTK the import button will open a native OS folder chooser that may look different.

### Desktop launcher

```bash
cp eldrun.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications/
```

Adjust the `Exec=` path in `eldrun.desktop` if you cloned to a different
location.

## Usage

Launch with:

```bash
cd app && python3 eldrun.py
```

Or via the desktop launcher if installed.

### Layout

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

- **Root** (red) — opens a `claude`/bash terminal in `~/eldrun/` (workspace root).
- **+** — opens a popover with **New Project** and **Import Project** actions.
- **× on a row** — closes that project's terminal and removes it from the list.
- **Active project** — marked with a red border on its row in the right panel.
- **Search field** — type to filter the project list; Enter on a single match opens it.
- **F11** — toggle fullscreen. Window chrome provides minimize / maximize / close.
- Left panel is shown only when a project terminal is active.
- "OPEN APPS" tracks files/apps opened in the current project and restores them on re-activation.

### New project dialog

- Enter a name (auto-sanitized to lowercase-hyphenated form).
- Choose `private` or `public` visibility (stored in `CLAUDE.md` scaffold).
- A live path preview shows `~/eldrun/projects/<sanitized-name>`.
- Eldrun runs `git init`, writes scaffold files, and commits them.

### Import project dialog

- Click **+** → **Import Project**, then browse to an existing directory.
- The folder is copied to `~/eldrun/projects/<name>/` (`.git/` is excluded and re-initialised).
- Any missing scaffold files are added automatically.

### Scaffold files

Each new project gets:

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent instructions for Claude |
| `CLAUDE.md` | Project context for Claude |
| `.gitignore` | Sensible defaults |
| `TODO.md` | Task list |
| `ROADMAP.md` | Long-term plans |
| `STATUS.md` | Current status |
| `DOCUMENTATION.md` | This file pattern |
| `open_apps.json` | Auto-managed; tracks open files/apps for this project |

## Architecture

```
EldrunApp (Adw.Application)
└── EldrunWindow (Adw.ApplicationWindow)
    ├── LeftPanel  — EWMH app list + project file tree
    ├── CenterPanel — Gtk.Stack of Vte.Terminal pages
    └── RightPanel — Root button + project list
```

`ProjectManager` persists projects to `~/.local/share/eldrun/projects.json`.
Projects are created under `~/eldrun/` and are full git repos.

## Roadmap

- Wayland support (replace X11 reparenting with a proper compositor protocol)
- GitHub integration: push `public` projects on creation
- Multi-window support
- Per-project Claude model selection
