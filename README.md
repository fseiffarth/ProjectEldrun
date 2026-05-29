# Eldrun

Eldrun is a desktop orchestration and project-management app built around agent
terminals. It gives each active project its own working context, keeps Claude,
Codex, and plain shell terminals close at hand, and wraps them with project
switching, file browsing, app launching, time tracking, and optional desktop
workspace routing.

The goal is to make AI-assisted development feel less like a pile of terminals
and more like an operational cockpit: one root control terminal for managing the
workspace, one or more agent terminals per project, a persistent project bar, a
hover-revealed file panel, and cross-project app controls that stay available
while you move between projects.

![Current Eldrun screen](screenshots/eldrun-current.png)

```text
+------------------------------------------------------------------+
| network/status        agent + terminal tabs       app shortcuts  |
+------------------------------------------------------------------+
|                                                                  |
| Root/project agent terminal, shell terminal, or embedded app      |
|                                                                  | PROJECT
|                                                                  | file tree
|                                                                  | open windows
+------------------------------------------------------------------+
| Root | Search... | project pills...             | settings | +   |
+------------------------------------------------------------------+
```

## Requirements

- Python 3.11+
- GTK 4, Libadwaita, VTE 3.91
- X11 for app-window embedding, launch-or-raise, sticky app windows, and
  workspace control
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

- **Agent-terminal orchestration**: create Claude or Codex tabs from the tab bar,
  rename and close them, reorder tabs by drag and drop, and add plain shell
  terminals when an agent is not needed.
- **Root control terminal**: opens in `~/eldrun/root/` with workspace-level
  context files for managing Eldrun and the broader project set.
- **Project terminals**: each active project gets a project-scoped terminal in
  its directory. The default agent command is configurable as `claude` or
  `codex`, with shell fallback if the command is missing.
- **Project creation and import**: the `+` button creates a new git-backed
  project or imports an existing directory by keeping, copying, or moving it.
- **Bottom project bar**: project pills activate, close, search, and reorder
  projects, show warm/open-app state, and expose time/file-type stats.
- **Hover-revealed right file panel**: when the file panel is hidden, a small
  edge control near the upper-right side opens it on hover; the control
  disappears while the panel is open.
- **Project file operations**: browse, open, create, rename, delete,
  color-label, reveal, and inspect project files.
- **Default app mapping**: file extensions can use per-project overrides, global
  defaults, system MIME defaults, or a manual "Open With" picker.
- **App tabs and open windows**: file opens can create app tabs and attempt X11
  embedding; failed embeds are tracked as standalone open windows in the right
  panel.
- **Global app toolbar**: cross-project roles such as Browser, Mail, Calendar,
  File Manager, Password Manager, Notes, Screenshot, and System Monitor can be
  shown as toolbar shortcuts.
- **Launch-or-raise global apps**: global app buttons raise an existing matching
  window when possible, otherwise launch a new instance and mark it sticky across
  workspaces.
- **Region screenshots**: the screenshot global app can launch common screenshot
  tools in interactive region-selection mode.
- **Time tracking and stats**: Eldrun records active project sessions, writes
  summaries into project metadata, and shows stats on project pills.
- **Network indicator**: probes connectivity and shows online/offline plus wired
  or wireless state.
- **Workspace management**: optional Cinnamon, GNOME, or `wmctrl` integration can
  allocate one desktop workspace per active project and keep Eldrun sticky.
- **Themes and keyboard controls**: settings include Dark, Bright, Fancy Dark,
  Fancy Bright, terminal command, global apps, file-type defaults, and workspace
  management. `F11` toggles fullscreen and `Super` toggles panel visibility.
- **Safer quit flow**: closing Eldrun shows a confirmation dialog and cleans up
  managed workspace state on normal exit.

## Project Storage

Managed projects normally live under `~/eldrun/projects/<sanitized-name>/`.
Imported projects can also be registered in place.

Global Eldrun state lives in `~/.local/share/eldrun/`:

- `projects.json`: lightweight index containing project id, name, status,
  ordering, and the path to each project's local metadata file.
- `settings.json`: terminal command, theme, workspace-management setting, global
  app registry, and other user preferences.
- `default_apps.json`: global file-extension to application command map.
- `time_log.json` and `active_session.json`: session time tracking.

Project-local state lives in each project's `project.json`, alongside scaffolded
files such as `AGENTS.md`, `CLAUDE.md`, `TODO.md`, `ROADMAP.md`, `STATUS.md`,
and `DOCUMENTATION.md`. Current open-app metadata is stored in
`project.json["open_apps"]`.

See [DOCUMENTATION.md](DOCUMENTATION.md) for the detailed architecture, data
schemas, behavior notes, and known limitations.
