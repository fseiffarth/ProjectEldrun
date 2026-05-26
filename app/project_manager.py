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


def sanitize_name(name: str) -> str:
    name = name.lower().strip()
    name = re.sub(r"[\s_]+", "-", name)
    name = re.sub(r"[^a-z0-9-]", "", name)
    name = re.sub(r"-+", "-", name).strip("-")
    return name


_SCAFFOLD: dict[str, str] = {
    "AGENTS.md":       "# {name}\n\n## Purpose\n\n## Key conventions\n",
    "CLAUDE.md":       "# {name}\n\n- **Directory:** `{directory}`\n- **Type:** {git_type}\n\n## What this project is\n\n",
    ".gitignore":      ".env\n__pycache__/\n*.pyc\nnode_modules/\n.DS_Store\n*.log\ndist/\nbuild/\n.venv/\n",
    "TODO.md":         "# {name} — TODO\n",
    "ROADMAP.md":      "# {name} — Roadmap\n",
    "project.json":    '{{\n  "name": "{name}",\n  "directory": "{directory}",\n  "git_type": "{git_type}",\n  "time": {{\n    "total_s": 0,\n    "recent_sessions": []\n  }}\n}}\n',
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
