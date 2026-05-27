# Eldrun

Eldrun is a GTK4 desktop workspace for AI-assisted development. It keeps a root
control terminal, one terminal per active project, a project switcher, and a
project file browser in one window so each project can run an agent command such
as `claude` or `codex` from its own directory.

The current UI is a custom header, a center tab stack, a bottom project bar, and
a right-side file tree overlay:

![Current Eldrun screen](screenshots/eldrun-current.png)

```text
+--------------------------------------------------------------+
| network  14:32                                      window UI |
+--------------------------------------------------------------+
| Terminal/App tabs                                             |
|                                                              ||
| Root/project terminal, embedded app attempt, or placeholder  || PROJECT
|                                                              || file tree
|                                                              || open windows
+--------------------------------------------------------------+
| Root | Search... | project pills...        | settings | + | > |
+--------------------------------------------------------------+
```

## Requirements

- Python 3.11+
- GTK 4, Libadwaita, VTE 3.91
- X11 for app-window embedding and Cinnamon workspace management
- `python-xlib` for X11 window tracking

```bash
# Debian / Ubuntu
sudo apt install python3 python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 \
    gir1.2-vte-3.91 gir1.2-gdkx11-4.0
pip3 install --user python-xlib
```

## Run

```bash
./start-eldrun.sh
```

or:

```bash
cd app && python3 eldrun.py
```

To install the desktop launcher, adjust `Exec=` in `Eldrun.app.desktop` if this
checkout lives somewhere else, then copy it into your local applications folder:

```bash
cp Eldrun.app.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications/
```

## Main Features

- **Root terminal**: opens in `~/eldrun/root/` and carries root workspace context
  files for managing Eldrun itself.
- **Project terminals**: each active project gets a VTE terminal in its project
  directory. The terminal command is configurable as `claude` or `codex`; missing
  commands fall back to the system shell.
- **Project creation/import**: the `+` button creates a new git-backed project or
  imports an existing directory by keeping, copying, or moving it.
- **Bottom project bar**: project pills can be activated, closed, searched, and
  reordered by drag and drop.
- **Right file tree overlay**: browse, open, create, rename, delete, color-label,
  reveal, and inspect project files.
- **Default app mapping**: file extensions can use global defaults or per-project
  overrides stored in JSON.
- **App tabs/open windows**: double-clicking a file launches its app, tries to
  embed the X11 window in the center panel, and falls back to a standalone window
  entry if embedding fails.
- **Time tracking and stats**: Eldrun records active project sessions, writes
  summaries into project metadata, and shows hover stats on project pills.
- **Network indicator**: probes connectivity and shows online/offline plus wired
  or wireless state.
- **Workspace management**: optional Cinnamon integration can allocate one desktop
  workspace per active project and keep Eldrun sticky.
- **Theme and keyboard controls**: settings include dark/light mode and terminal
  command. `F11` toggles fullscreen and `Super` toggles panels.

## Project Storage

Managed projects normally live under `~/eldrun/projects/<sanitized-name>/`.
Imported projects can also be registered in place.

Global Eldrun state lives in `~/.local/share/eldrun/`:

- `projects.json`: lightweight index containing project id, name, status,
  ordering, and the path to each project's local metadata file.
- `settings.json`: terminal command, theme, workspace-management setting, and
  future user preferences.
- `default_apps.json`: global file-extension to application command map.
- `time_log.json` and `active_session.json`: session time tracking.

Project-local state lives in each project's `project.json`, alongside scaffolded
files such as `AGENTS.md`, `CLAUDE.md`, `TODO.md`, `ROADMAP.md`, `STATUS.md`,
and `DOCUMENTATION.md`.

See [DOCUMENTATION.md](DOCUMENTATION.md) for the detailed architecture, data
schemas, behavior notes, and known limitations.
