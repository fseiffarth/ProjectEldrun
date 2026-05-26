import json
import os
import pathlib
import re
import shutil
import subprocess
import uuid
from datetime import datetime, timezone

from gi.repository import GLib

DATA_DIR = os.path.join(GLib.get_user_data_dir(), "eldrun")
PROJECTS_FILE = os.path.join(DATA_DIR, "projects.json")
WORKSPACE_ROOT = pathlib.Path.home() / "eldrun"
PROJECTS_ROOT = pathlib.Path.home() / "eldrun" / "projects"
ROOT_DIR = pathlib.Path.home() / "eldrun" / "root"


def sanitize_name(name: str) -> str:
    name = name.lower().strip()
    name = re.sub(r"[\s_]+", "-", name)
    name = re.sub(r"[^a-z0-9-]", "", name)
    name = re.sub(r"-+", "-", name).strip("-")
    return name


_ROOT_CLAUDE_MD = """\
# Eldrun Workspace Root

This is the root terminal for the Eldrun workspace at `~/eldrun/`.
It is the central control terminal for managing Eldrun itself — not for project work.

## Workspace layout

- `~/eldrun/root/` — working directory for this root terminal
- `~/eldrun/projects/` — all Eldrun-managed project directories; each is a git repo

## Global data files

Eldrun stores its registry and logs under `~/.local/share/eldrun/`:
- `projects.json` — registry of all known projects (id, name, path, status)
- `time_log.json` — append-only session time log
- `settings.json` — user settings (terminal command, color scheme, etc.)
- `default_apps.json` — global file-type → app map

## What this terminal is for

Use this terminal exclusively for Eldrun workspace-level tasks:

- **Project search** — find projects by name or path across the full registry
- **Project status changes** — set a project to `current`, `active`, or `inactive`
  by editing `~/.local/share/eldrun/projects.json`
- **Adding new projects** — via Eldrun's **+** button (preferred) or by calling
  `ProjectManager.create_project()` directly
- **Importing existing projects** — via Eldrun's **Import Project** dialog (keep
  location, copy, or move modes)
- **Eldrun settings** — edit `~/.local/share/eldrun/settings.json` to change the
  terminal command, color scheme, or other app-wide options
- **Global default apps** — edit `~/.local/share/eldrun/default_apps.json` to set
  the default application for a file extension across all projects
- **Installing new applications** — run package manager commands (`apt`, `pip`,
  `npm`, etc.) to install tools that will be available across all projects

For work inside a specific project, switch to that project's terminal in the right panel.
"""

_ROOT_AGENTS_MD = """\
# Eldrun Root Terminal — Agent Instructions

## Role

You are the Eldrun workspace manager. Your job in this terminal is to help the user
control Eldrun itself: projects, settings, default apps, and installed tools.
You do not do project-level development work here.

## Permitted actions

- Read and write `~/.local/share/eldrun/` (project registry, settings, default apps,
  time log)
- Read and write `~/eldrun/root/` (this working directory)
- Read project directories under `~/eldrun/projects/` for discovery and inspection
- Run package manager commands (`apt`, `pip`, `npm`, `cargo`, etc.) to install
  applications system-wide or for the current user

## Restricted actions

- Do not write to project directories under `~/eldrun/projects/` unless the user
  explicitly asks — project work belongs in each project's own terminal
- Do not modify files outside `~/eldrun/` and `~/.local/share/eldrun/` without
  explicit instruction

## Key tasks and how to do them

**Search projects**
Read `~/.local/share/eldrun/projects.json` and filter by name, path, or status.

**Change a project's status**
Edit the `status` field in the matching entry in `~/.local/share/eldrun/projects.json`
to `"current"`, `"active"`, or `"inactive"`. At most one project should be `"current"`.
Also update the `status` field in that project's own `project.json`.

**Add or import a project**
Ask the user to use Eldrun's **+** button — this ensures the project is scaffolded
correctly and registered with the right UUID and metadata.

**Change Eldrun settings**
Edit `~/.local/share/eldrun/settings.json`. Current keys:
- `terminal_command` — executable spawned in each terminal (default: `"claude"`)
- `color_scheme` — `"dark"` or `"light"`

**Set a global default app for a file type**
Edit `~/.local/share/eldrun/default_apps.json`. Format: `{ ".ext": "app-executable" }`.
Per-project overrides live in `<project_dir>/project_default_apps.json`.

**Install a new application**
Run the appropriate package manager command and confirm the binary is on `$PATH`.
"""


def _write_root_context_files():
    ROOT_DIR.mkdir(parents=True, exist_ok=True)
    for filename, content in (("CLAUDE.md", _ROOT_CLAUDE_MD), ("AGENTS.md", _ROOT_AGENTS_MD)):
        (ROOT_DIR / filename).write_text(content, encoding="utf-8")


_SCAFFOLD: dict[str, str] = {
    "AGENTS.md":       "# {name}\n\n## Purpose\n\n## Key conventions\n",
    "CLAUDE.md":       "# {name}\n\n- **Directory:** `{directory}`\n- **Type:** {git_type}\n\n## What this project is\n\n",
    ".gitignore":      ".env\n__pycache__/\n*.pyc\nnode_modules/\n.DS_Store\n*.log\ndist/\nbuild/\n.venv/\n",
    "TODO.md":         "# {name} — TODO\n",
    "ROADMAP.md":      "# {name} — Roadmap\n",
    "project.json":    '{{\n  "name": "{name}",\n  "directory": "{directory}",\n  "git_type": "{git_type}",\n  "status": "inactive",\n  "time": {{\n    "total_s": 0,\n    "recent_sessions": []\n  }}\n}}\n',
    "DOCUMENTATION.md":"# {name} — Documentation\n",
}


def _render_scaffold(template: str, name: str, directory: str, git_type: str) -> str:
    return template.format(name=name, directory=directory, git_type=git_type)


def _write_scaffold(name: str, directory: str, git_type: str):
    for filename, tmpl in _SCAFFOLD.items():
        with open(os.path.join(directory, filename), "w", encoding="utf-8") as f:
            f.write(_render_scaffold(tmpl, name, directory, git_type))


def _write_scaffold_missing(name: str, directory: str, git_type: str, existing: set):
    for filename, tmpl in _SCAFFOLD.items():
        if filename not in existing:
            with open(os.path.join(directory, filename), "w", encoding="utf-8") as f:
                f.write(_render_scaffold(tmpl, name, directory, git_type))


def _git_init(directory: str):
    try:
        subprocess.run(
            ["git", "init", "--initial-branch=main"],
            cwd=directory, check=True, capture_output=True,
        )
    except subprocess.CalledProcessError:
        subprocess.run(
            ["git", "init"],
            cwd=directory, check=True, capture_output=True,
        )


def _git_commit(directory: str, message: str):
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "Eldrun",
        "GIT_AUTHOR_EMAIL": "eldrun@local",
        "GIT_COMMITTER_NAME": "Eldrun",
        "GIT_COMMITTER_EMAIL": "eldrun@local",
    }
    subprocess.run(["git", "add", "-A"], cwd=directory, check=True, capture_output=True)
    try:
        subprocess.run(
            ["git", "commit", "-m", message],
            cwd=directory, check=True, capture_output=True, env=env,
        )
    except subprocess.CalledProcessError:
        pass  # nothing to commit


class ProjectManager:
    def __init__(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
        _write_root_context_files()
        self.projects: list[dict] = []
        self._load()
        self._migrate()

    # ── persistence ───────────────────────────────────────────────────────────

    def _load(self):
        if not os.path.exists(PROJECTS_FILE):
            return
        try:
            with open(PROJECTS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.projects = data if isinstance(data, list) else []
        except (json.JSONDecodeError, OSError):
            self.projects = []
        for i, p in enumerate(self.projects):
            if "status" not in p:
                p["status"] = "inactive"
            if "position" not in p:
                p["position"] = i * 10

    def _save(self):
        serializable = [
            {k: v for k, v in p.items() if k != "shell_pid"}
            for p in self.projects
        ]
        tmp = PROJECTS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(serializable, f, indent=2)
        os.replace(tmp, PROJECTS_FILE)

    def _migrate(self):
        """Move projects from ~/eldrun/<name>/ to ~/eldrun/projects/<name>/."""
        updated = False
        for p in self.projects:
            old_dir = pathlib.Path(p["directory"])
            if (old_dir.parent == WORKSPACE_ROOT
                    and old_dir.name != "projects"
                    and old_dir.is_dir()):
                new_dir = PROJECTS_ROOT / old_dir.name
                if not new_dir.exists():
                    old_dir.rename(new_dir)
                    p["directory"] = str(new_dir)
                    updated = True
        if updated:
            self._save()

    # ── public API ────────────────────────────────────────────────────────────

    def _next_position(self) -> int:
        if not self.projects:
            return 0
        return max(p.get("position", 0) for p in self.projects) + 10

    def add_project(self, name: str, directory: str, git_type: str = "private") -> dict:
        project = {
            "id": str(uuid.uuid4()),
            "name": name,
            "directory": directory,
            "git_type": git_type,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "shell_pid": None,
            "status": "active",
            "position": self._next_position(),
        }
        self.projects.append(project)
        self._save()
        return project

    def remove_project(self, project_id: str):
        self.projects = [p for p in self.projects if p["id"] != project_id]
        self._save()

    def set_project_status(self, project_id: str, status: str):
        project = self.get_project(project_id)
        if project is not None:
            project["status"] = status
            self._save()

    def deactivate_project(self, project_id: str):
        """Hide a project from the panel but keep it in the registry."""
        self.set_project_status(project_id, "inactive")

    def get_visible_projects(self) -> list:
        """Return projects that should appear in the right panel."""
        return [p for p in self.projects if p.get("status") in ("active", "current")]

    def set_project_position(self, project_id: str, position: int):
        project = self.get_project(project_id)
        if project is not None:
            project["position"] = position
            self._save()

    def set_all_inactive(self):
        """Mark every project inactive (called on clean shutdown)."""
        for p in self.projects:
            if p.get("status") in ("active", "current"):
                p["status"] = "inactive"
        self._save()

    def get_project(self, project_id: str) -> dict | None:
        return next((p for p in self.projects if p["id"] == project_id), None)

    def set_shell_pid(self, project_id: str, pid: int):
        project = self.get_project(project_id)
        if project is not None:
            project["shell_pid"] = pid

    def create_project(self, name: str, git_type: str) -> dict:
        safe = sanitize_name(name)
        if not safe:
            raise ValueError("Project name is invalid")
        directory = str(PROJECTS_ROOT / safe)
        os.makedirs(directory)  # raises FileExistsError if already exists

        _git_init(directory)
        _write_scaffold(name, directory, git_type)
        _git_commit(directory, "Initial project scaffold")

        return self.add_project(name, directory, git_type)

    def import_project(self, source_dir: str, name: str, git_type: str,
                       mode: str = "keep") -> dict:
        """Import a project.

        mode:
          'keep' — register source_dir in place without copying (default)
          'copy' — copy source_dir into ~/eldrun/projects/<name>/
          'move' — move source_dir into ~/eldrun/projects/<name>/
        """
        if not name.strip():
            raise ValueError("Project name is invalid")

        if mode == "keep":
            target = pathlib.Path(source_dir)
            existing = {f.name for f in target.iterdir() if f.is_file()}
            _write_scaffold_missing(name, str(target), git_type, existing)
            if not (target / ".git").is_dir():
                _git_init(str(target))
                _git_commit(str(target), "Register existing project")
            return self.add_project(name, str(target), git_type)

        safe = sanitize_name(name)
        if not safe:
            raise ValueError("Project name is invalid")
        dest = PROJECTS_ROOT / safe
        if dest.exists():
            raise FileExistsError(f"Destination '{safe}' already exists")

        if mode == "copy":
            shutil.copytree(
                source_dir, str(dest),
                ignore=shutil.ignore_patterns(".git"),
            )
        elif mode == "move":
            shutil.move(source_dir, str(dest))
        else:
            raise ValueError(f"Unknown import mode: {mode!r}")

        existing = {f.name for f in dest.iterdir() if f.is_file()}
        _write_scaffold_missing(name, str(dest), git_type, existing)

        _git_init(str(dest))
        _git_commit(str(dest), "Import existing project")

        return self.add_project(name, str(dest), git_type)
