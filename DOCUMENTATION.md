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
- **+** — opens a popover with **New Project** and **Import Project** actions. Import supports three modes: **Keep location** (register in place), **Copy**, or **Move** — see [Importing an existing project](#importing-an-existing-project).
- **× on a row** — closes that project's terminal and removes it from the list.
- **Active project** — marked with a red border on its row in the right panel.
- **Search field** — type to filter the project list; Enter on a single match opens it.
- **F11** — toggle fullscreen. Window chrome provides minimize / maximize / close.
- Left panel is shown only when a project terminal is active.
- "OPEN APPS" tracks files/apps opened in the current project and restores them on re-activation.

### Creating a new project

Click **+** → **New Project** in the right panel to open the dialog.

#### 1 — Fill in the dialog

| Field | Behaviour |
|-------|-----------|
| **Name** | Free-text. Shown as-is in the project list. |
| **Visibility** | `private` or `public`. Stored in `CLAUDE.md` for reference. |
| **Path preview** | Updates live to `~/eldrun/projects/<sanitized-name>`. |

Name sanitization rules (applied to produce the directory name):
- Lowercased and stripped of leading/trailing whitespace.
- Spaces and underscores collapsed to hyphens.
- Any character that is not `a–z`, `0–9`, or `-` is removed.
- Consecutive hyphens are collapsed; leading/trailing hyphens are stripped.

Example: `"My New Project!"` → directory name `my-new-project`.

If the sanitized name is empty or the target directory already exists, the dialog shows a conflict warning and the **Create** button is disabled.

#### 2 — What Eldrun does on confirmation

1. **Creates the directory** `~/eldrun/projects/<sanitized-name>/`.
2. **Runs `git init --initial-branch=main`** (falls back to `git init` on older git).
3. **Writes all scaffold files** (see below).
4. **Commits** everything as `"Initial project scaffold"` with author `Eldrun <eldrun@local>`.
5. **Registers the project** in `~/.local/share/eldrun/projects.json` with a new UUID, the display name, the directory path, visibility, creation timestamp, and `status: "active"`.
6. **Opens a terminal** for the project in the center panel and adds a row to the right-panel list.

#### 3 — Scaffold files

Every new project directory contains these files after creation:

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent-facing instructions: project purpose and key conventions. Claude reads this to understand scope and rules. |
| `CLAUDE.md` | Claude Code context: directory path and visibility type. Extend this with architecture notes, commands, and gotchas as the project grows. |
| `.gitignore` | Sensible defaults covering Python, Node, macOS, and common build artifacts. |
| `TODO.md` | Task list for the project. |
| `ROADMAP.md` | Long-term plans and milestones. |
| `project.json` | Machine-readable project state: name, directory, git type, status (`current` / `active` / `inactive`), and time tracking data (total seconds, recent sessions). Updated automatically by Eldrun after each session. |
| `DOCUMENTATION.md` | Project-level documentation (this file pattern). |

Initial file contents (where `{name}` is the display name, `{directory}` is the absolute path, `{git_type}` is `private` or `public`):

**`AGENTS.md`**
```markdown
# {name}

## Purpose

## Key conventions
```

**`CLAUDE.md`**
```markdown
# {name}

- **Directory:** `{directory}`
- **Type:** {git_type}

## What this project is

```

**`.gitignore`**
```
.env
__pycache__/
*.pyc
node_modules/
.DS_Store
*.log
dist/
build/
.venv/
```

**`TODO.md`**
```markdown
# {name} — TODO
```

**`ROADMAP.md`**
```markdown
# {name} — Roadmap
```

**`project.json`**
```json
{
  "name": "{name}",
  "directory": "{directory}",
  "git_type": "{git_type}",
  "status": "inactive",
  "time": {
    "total_s": 0,
    "recent_sessions": []
  }
}
```

**`DOCUMENTATION.md`**
```markdown
# {name} — Documentation
```

#### 4 — Registry entry

The new project is appended to `~/.local/share/eldrun/projects.json` as:

```json
{
  "id": "<uuid4>",
  "name": "<display name>",
  "directory": "/home/<user>/eldrun/projects/<sanitized-name>",
  "git_type": "private",
  "created_at": "<ISO 8601 UTC timestamp>",
  "status": "active",
  "position": <integer ordering weight>
}
```

`shell_pid` is held in memory only and never written to disk.

---

### Importing an existing project

Click **+** → **Import Project**, then browse to an existing directory.

Three import modes are available:

| Mode | What happens |
|------|-------------|
| **Keep location** (default) | Registers the folder in place — no files are moved or copied. |
| **Copy** | Copies the folder to `~/eldrun/projects/<sanitized-name>/` (`.git/` is excluded). |
| **Move** | Moves the folder to `~/eldrun/projects/<sanitized-name>/`. |

In all modes, any scaffold files that are missing from the target directory are created automatically (existing files are never overwritten). If the directory has no `.git/` folder, `git init` is run and the result is committed as `"Register existing project"` (keep mode) or `"Import existing project"` (copy/move).

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

## Global data files

All global Eldrun state lives under `~/.local/share/eldrun/`. These files are managed entirely by Eldrun and should not be edited by hand.

| File | Managed by | Purpose |
|------|-----------|---------|
| `projects.json` | `ProjectManager` | Registry of every known project — paths, statuses, positions, and metadata. |
| `time_log.json` | `TimeTracker` | Append-only log of all work sessions across all projects. |
| `active_session.json` | `TimeTracker` | Sentinel written at session start and deleted on clean close; used to synthesise a closing entry after a crash. |
| `settings.json` | `SettingsManager` | User-configurable app settings (e.g. `terminal_command`). |
| `default_apps.json` | `DefaultAppsManager` | Global `extension → app` map, bootstrapped from system MIME defaults and editable via the "File Type Apps" settings window. |

### `projects.json` schema

Array of project objects. Each entry:

```json
{
  "id": "<uuid4>",
  "name": "My Project",
  "directory": "/home/<user>/eldrun/projects/my-project",
  "git_type": "private",
  "created_at": "2025-05-01T10:00:00+00:00",
  "status": "inactive",
  "position": 10
}
```

| Field | Values | Meaning |
|-------|--------|---------|
| `status` | `"current"` | The project whose terminal is shown in the center panel (at most one at a time). |
| | `"active"` | In the right-panel list with a running terminal, but not the foreground view. |
| | `"inactive"` | Registered globally but not shown in the panel and has no running terminal. |
| `position` | integer | Sort weight for ordering rows in the right panel; lower = higher. |

`shell_pid` is tracked in memory only and never written to disk.

### `time_log.json` schema

Array of session records, one per closed session:

```json
[
  {
    "project_id": "<uuid4>",
    "date": "2025-05-01",
    "start_iso": "2025-05-01T10:00:00+00:00",
    "duration_s": 3600
  }
]
```

### `settings.json` schema

```json
{
  "terminal_command": "claude"
}
```

`terminal_command` is the executable spawned in each project terminal (default: `claude`; fallback: `bash`).

### `default_apps.json` schema

```json
{
  ".py": "code",
  ".md": "marktext",
  ".pdf": "evince"
}
```

Maps file extension (with leading `.`) to the executable name used to open files of that type globally. Per-project overrides live in `<project_dir>/project_default_apps.json` with the same schema.

## Roadmap

- Wayland support (replace X11 reparenting with a proper compositor protocol)
- GitHub integration: push `public` projects on creation
- Multi-window support
- Per-project Claude model selection
