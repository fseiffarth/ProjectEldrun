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

LOCAL_PROJECT_FILE = "project.json"
MAX_AGENT_TASKS = 20

# Keys kept only in the global index; everything else lives in local project.json
_GLOBAL_KEYS = {"id", "name", "status", "position", "local_file"}
# Keys that exist only at runtime and are never persisted
_RUNTIME_KEYS = {"shell_pid"}
_EXTERNAL_KEYS: set = set()


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
- `projects.json` — lightweight index of all known projects (id, name, status, position, local_file)
- `time_log.json` — append-only session time log
- `settings.json` — user settings (terminal command, color scheme, etc.)
- `default_apps.json` — global file-type → app map

## Per-project data files

Each project directory `~/eldrun/projects/<name>/` contains:
- `project.json` — all project-local data: directory, git_type, created_at,
  file_type_stats, time data, default_apps (per-project file-type overrides)

## What this terminal is for

Use this terminal exclusively for Eldrun workspace-level tasks:

- **Project search** — find projects by name or path across the full registry
- **Project status changes** — set a project to `current`, `active`, or `inactive`
  by editing `~/.local/share/eldrun/projects.json`
- **Adding new projects** — via Eldrun's **+** button (preferred)
- **Importing existing projects** — via Eldrun's **Import Project** dialog
- **Eldrun settings** — edit `~/.local/share/eldrun/settings.json`
- **Global default apps** — edit `~/.local/share/eldrun/default_apps.json`
- **Installing new applications** — run package manager commands
"""

_ROOT_AGENTS_MD = """\
# Eldrun Root Terminal — Agent Instructions

## Role

You are the Eldrun workspace manager. Your job in this terminal is to help the user
control Eldrun itself: projects, settings, default apps, and installed tools.
You do not do project-level development work here.

## Storage layout

- `~/.local/share/eldrun/projects.json` — global index; each entry has only:
  id, name, status, position, local_file (path to the project's project.json)
- `<project_dir>/project.json` — per-project data: directory, git_type, created_at,
  file_type_stats, time_today_s, time_total_s, time sessions, default_apps

## Permitted actions

- Read and write `~/.local/share/eldrun/` (project index, settings, default apps, time log)
- Read and write `~/eldrun/root/` (this working directory)
- Read project directories under `~/eldrun/projects/` for discovery and inspection
- Run package manager commands to install applications

## Restricted actions

- Do not write to project directories under `~/eldrun/projects/` unless the user
  explicitly asks — project work belongs in each project's own terminal

## Key tasks

**Search projects**
Read `~/.local/share/eldrun/projects.json` and follow `local_file` links to get details.

**Change a project's status**
Edit the `status` field in the matching entry in `~/.local/share/eldrun/projects.json`.
At most one project should be `"current"`.

**Add or import a project**
Ask the user to use Eldrun's **+** button to ensure correct scaffolding and registration.

**Change Eldrun settings**
Edit `~/.local/share/eldrun/settings.json`. Current keys:
- `terminal_command` — executable spawned in each terminal (default: `"claude"`)
- `color_scheme` — `"dark"`, `"light"`, `"fancy_dark"`, or `"fancy_light"`

**Set a global default app for a file type**
Edit `~/.local/share/eldrun/default_apps.json`. Format: `{ ".ext": "app-executable" }`.
Per-project overrides live in `<project_dir>/project.json` under the `"default_apps"` key.

**Install a new application**
Run the appropriate package manager command and confirm the binary is on `$PATH`.
"""


_ROOT_GEMINI_MD = """\
# Eldrun Root Terminal — Gemini Instructions

## Role

You are the Eldrun workspace manager. Your job in this terminal is to help the user
control Eldrun itself: projects, settings, default apps, and installed tools.
You do not do project-level development work here.

## Storage layout

- `~/.local/share/eldrun/projects.json` — global index; each entry has only:
  id, name, status, position, local_file (path to the project's project.json)
- `<project_dir>/project.json` — per-project data: directory, git_type, created_at,
  file_type_stats, time_today_s, time_total_s, time sessions, default_apps

## Permitted actions

- Read and write `~/.local/share/eldrun/` (project index, settings, default apps, time log)
- Read and write `~/eldrun/root/` (this working directory)
- Read project directories under `~/eldrun/projects/` for discovery and inspection
- Run package manager commands to install applications

## Restricted actions

- Do not write to project directories under `~/eldrun/projects/` unless the user
  explicitly asks — project work belongs in each project's own terminal

## Key tasks

**Search projects**
Read `~/.local/share/eldrun/projects.json` and follow `local_file` links to get details.

**Change a project's status**
Edit the `status` field in the matching entry in `~/.local/share/eldrun/projects.json`.
At most one project should be `"current"`.

**Add or import a project**
Ask the user to use Eldrun's **+** button to ensure correct scaffolding and registration.

**Change Eldrun settings**
Edit `~/.local/share/eldrun/settings.json`. Current keys:
- `terminal_command` — executable spawned in each terminal (default: `"claude"`)
- `color_scheme` — `"dark"`, `"light"`, `"fancy_dark"`, or `"fancy_light"`

**Set a global default app for a file type**
Edit `~/.local/share/eldrun/default_apps.json`. Format: `{ ".ext": "app-executable" }`.
Per-project overrides live in `<project_dir>/project.json` under the `"default_apps"` key.

**Install a new application**
Run the appropriate package manager command and confirm the binary is on `$PATH`.
"""


def _write_root_context_files():
    ROOT_DIR.mkdir(parents=True, exist_ok=True)
    for filename, content in (
        ("CLAUDE.md", _ROOT_CLAUDE_MD),
        ("AGENTS.md", _ROOT_AGENTS_MD),
        ("GEMINI.md", _ROOT_GEMINI_MD),
    ):
        (ROOT_DIR / filename).write_text(content, encoding="utf-8")


_SCAFFOLD: dict[str, str] = {
    "AGENTS.md": """\
# {name}

## Purpose

Describe what this project does and what an agent session here is expected to accomplish.

## Scope and permissions

You are working inside the project directory `{directory}`.

**Full read/write access:**
- Everything under `{directory}/`

**Read-only (do not write outside your project):**
- `~/.local/share/eldrun/` — Eldrun global data, managed by Eldrun itself
- Other project directories under `~/eldrun/projects/`
- Any path outside `{directory}/`

If you need to change Eldrun settings or project metadata, ask the user to use the Eldrun UI or the root terminal.

## Key conventions
""",
    "CLAUDE.md":        "# {name}\n\n- **Directory:** `{directory}`\n- **Type:** {git_type}\n\n## What this project is\n\n",
    "GEMINI.md":        "# {name}\n\n- **Directory:** `{directory}`\n- **Type:** {git_type}\n\n## What this project is\n\n",
    ".gitignore":       ".env\n__pycache__/\n*.pyc\nnode_modules/\n.DS_Store\n*.log\ndist/\nbuild/\n.venv/\n",
    "TODO.md":          "# {name} — TODO\n",
    "ROADMAP.md":       "# {name} — Roadmap\n",
    "STATUS.md":        "# {name} — Status\n",
    "DOCUMENTATION.md": "# {name} — Documentation\n",
    ".claude/settings.json": """\
{
  "permissions": {
    "allow": [
      "Read(**)",
      "Edit({directory}/**)",
      "Write({directory}/**)"
    ],
    "deny": [
      "Edit(~/.local/share/eldrun/**)",
      "Write(~/.local/share/eldrun/**)"
    ]
  }
}
""",
}


def _render_scaffold(template: str, name: str, directory: str, git_type: str) -> str:
    return (template
            .replace("{name}", name)
            .replace("{directory}", directory)
            .replace("{git_type}", git_type))


def _write_scaffold(name: str, directory: str, git_type: str):
    for filename, tmpl in _SCAFFOLD.items():
        full_path = os.path.join(directory, filename)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "w", encoding="utf-8") as f:
            f.write(_render_scaffold(tmpl, name, directory, git_type))


def _write_scaffold_missing(name: str, directory: str, git_type: str, existing: set):
    for filename, tmpl in _SCAFFOLD.items():
        full_path = os.path.join(directory, filename)
        if not os.path.exists(full_path):
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "w", encoding="utf-8") as f:
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


def _git_has_remote(directory: str) -> bool:
    """Return True if the git repo at directory has a remote named 'origin'."""
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=directory, capture_output=True,
        )
        return result.returncode == 0
    except Exception:
        return False


def create_remote_repo(directory: str, repo_name: str, git_type: str,
                       profile_url: str, token: str) -> str:
    """Create a remote repository on GitHub/GitLab and add it as git remote origin.

    Detects host from profile_url (e.g. https://github.com/user or
    https://gitlab.example.com/user).  Returns the clone URL added as origin.
    """
    import urllib.request
    from urllib.parse import urlparse

    profile_url = profile_url.rstrip("/")
    parsed = urlparse(profile_url)
    host = parsed.netloc.lower()

    if "github.com" in host:
        api_url = "https://api.github.com/user/repos"
        payload = json.dumps({
            "name": repo_name,
            "private": git_type == "private",
            "auto_init": False,
        }).encode("utf-8")
        req = urllib.request.Request(
            api_url,
            data=payload,
            headers={
                "Authorization": f"token {token}",
                "Accept": "application/vnd.github.v3+json",
                "Content-Type": "application/json",
                "User-Agent": "Eldrun/1.0",
            },
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        clone_url = data["clone_url"]
    else:
        # GitLab (gitlab.com or self-hosted) — also used as fallback
        scheme = parsed.scheme or "https"
        api_host = f"{scheme}://{parsed.netloc}"
        api_url = f"{api_host}/api/v4/projects"
        visibility = "private" if git_type == "private" else "public"
        payload = json.dumps({
            "name": repo_name,
            "visibility": visibility,
            "initialize_with_readme": False,
        }).encode("utf-8")
        req = urllib.request.Request(
            api_url,
            data=payload,
            headers={
                "PRIVATE-TOKEN": token,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        clone_url = data["http_url_to_repo"]

    subprocess.run(
        ["git", "remote", "add", "origin", clone_url],
        cwd=directory, check=True, capture_output=True,
    )
    subprocess.run(
        ["git", "push", "-u", "origin", "HEAD"],
        cwd=directory, capture_output=True,
    )
    return clone_url


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
            raw_entries = data if isinstance(data, list) else []
        except (json.JSONDecodeError, OSError):
            raw_entries = []

        self.projects = []
        for i, entry in enumerate(raw_entries):
            if "status" not in entry:
                entry["status"] = "inactive"
            if "position" not in entry:
                entry["position"] = i * 10

            # Resolve local_file — derive from directory if missing (old format)
            local_file = entry.get("local_file")
            if not local_file:
                directory = entry.get("directory", "")
                if directory:
                    local_file = str(pathlib.Path(directory) / LOCAL_PROJECT_FILE)

            # Load local project.json and merge with global index entry
            if local_file and os.path.exists(local_file):
                try:
                    with open(local_file, "r", encoding="utf-8") as f:
                        local_data = json.load(f)
                    project = {**local_data}
                    # Global index is canonical for these fields
                    project["id"] = entry["id"]
                    project["name"] = entry["name"]
                    project["status"] = entry.get("status", "inactive")
                    project["position"] = entry.get("position", 0)
                    project["local_file"] = local_file
                except (json.JSONDecodeError, OSError):
                    project = dict(entry)
                    if local_file:
                        project["local_file"] = local_file
            else:
                # Old format or local file not yet created
                project = dict(entry)
                if local_file:
                    project["local_file"] = local_file

            self.projects.append(project)

    def _save(self):
        """Write the global index — lightweight entries only."""
        index = []
        for p in self.projects:
            directory = p.get("directory", "")
            local_file = p.get("local_file") or (
                str(pathlib.Path(directory) / LOCAL_PROJECT_FILE) if directory else ""
            )
            index.append({
                "id": p["id"],
                "name": p["name"],
                "status": p.get("status", "inactive"),
                "position": p.get("position", 0),
                "local_file": local_file,
            })
        tmp = PROJECTS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(index, f, indent=2)
        os.replace(tmp, PROJECTS_FILE)

    def _save_local(self, project: dict):
        """Write all project-local data to <project_dir>/project.json."""
        directory = project.get("directory", "")
        if not directory:
            return
        local_path = pathlib.Path(directory) / LOCAL_PROJECT_FILE
        # Read existing to preserve any externally-managed keys
        existing = {}
        if local_path.exists():
            try:
                with open(local_path, "r", encoding="utf-8") as f:
                    existing = json.load(f)
                if not isinstance(existing, dict):
                    existing = {}
            except (json.JSONDecodeError, OSError):
                existing = {}
        for k, v in project.items():
            if k not in _RUNTIME_KEYS and k not in _EXTERNAL_KEYS:
                existing[k] = v
        tmp = str(local_path) + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(existing, f, indent=2)
            os.replace(tmp, str(local_path))
        except OSError:
            pass

    def _migrate(self):
        """Run one-time migrations to bring data up to the current format."""
        updated = False

        for p in self.projects:
            # Old migration: move from ~/eldrun/<name>/ to ~/eldrun/projects/<name>/
            old_dir = pathlib.Path(p.get("directory", ""))
            if (os.path.abspath(str(old_dir.parent)) == os.path.abspath(str(WORKSPACE_ROOT))
                    and old_dir.name != "projects"
                    and old_dir.is_dir()):
                new_dir = PROJECTS_ROOT / old_dir.name
                if not new_dir.exists():
                    old_dir.rename(new_dir)
                    p["directory"] = str(new_dir)
                    updated = True

            # New migration: ensure local_file is set and local project.json exists
            directory = p.get("directory", "")
            if not directory:
                continue
            expected_local = str(pathlib.Path(directory) / LOCAL_PROJECT_FILE)
            if p.get("local_file") != expected_local:
                p["local_file"] = expected_local
                updated = True

            # Migrate old project_default_apps.json into project.json["default_apps"]
            old_dam_path = pathlib.Path(directory) / "project_default_apps.json"
            local_path = pathlib.Path(expected_local)
            if old_dam_path.exists() and local_path.exists():
                try:
                    with open(old_dam_path, "r", encoding="utf-8") as f:
                        old_apps = json.load(f)
                    with open(local_path, "r", encoding="utf-8") as f:
                        local_data = json.load(f)
                    if "default_apps" not in local_data and isinstance(old_apps, dict):
                        local_data["default_apps"] = old_apps
                        tmp = str(local_path) + ".tmp"
                        with open(tmp, "w", encoding="utf-8") as f:
                            json.dump(local_data, f, indent=2)
                        os.replace(tmp, str(local_path))
                        old_dam_path.rename(str(old_dam_path) + ".migrated")
                        updated = True
                except (OSError, json.JSONDecodeError):
                    pass

            # Create local project.json if it doesn't exist yet
            if not pathlib.Path(expected_local).exists():
                self._save_local(p)
                updated = True

            # Create .claude/settings.json if missing (permission boundary)
            settings_path = pathlib.Path(directory) / ".claude" / "settings.json"
            if not settings_path.exists():
                settings_path.parent.mkdir(parents=True, exist_ok=True)
                content = _render_scaffold(
                    _SCAFFOLD[".claude/settings.json"],
                    p.get("name", ""),
                    directory,
                    p.get("git_type", "private"),
                )
                try:
                    settings_path.write_text(content, encoding="utf-8")
                    updated = True
                except OSError:
                    pass

        if updated:
            self._save()

    # ── public API ────────────────────────────────────────────────────────────

    def _next_position(self) -> int:
        if not self.projects:
            return 0
        return max(p.get("position", 0) for p in self.projects) + 10

    def add_project(self, name: str, directory: str, git_type: str = "private") -> dict:
        local_file = str(pathlib.Path(directory) / LOCAL_PROJECT_FILE)
        project = {
            "id": str(uuid.uuid4()),
            "name": name,
            "directory": directory,
            "git_type": git_type,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "shell_pid": None,
            "status": "active",
            "position": self._next_position(),
            "local_file": local_file,
        }
        self.projects.append(project)
        self._save_local(project)
        self._save()
        return project

    def remove_project(self, project_id: str):
        self.projects = [p for p in self.projects if p["id"] != project_id]
        self._save()

    def set_project_status(self, project_id: str, status: str):
        project = self.get_project(project_id)
        if project is not None:
            project["status"] = status
            self._save()  # status is a global-index concern

    def deactivate_project(self, project_id: str):
        """Hide a project from the panel but keep it in the registry."""
        self.set_project_status(project_id, "inactive")

    def get_visible_projects(self) -> list:
        """Return active/current projects sorted by position, matching pill bar order."""
        visible = [p for p in self.projects if p.get("status") in ("active", "current")]
        return sorted(visible, key=lambda p: p.get("position", 0))

    def set_project_position(self, project_id: str, position: int):
        project = self.get_project(project_id)
        if project is not None:
            project["position"] = position
            self._save()  # position is a global-index concern

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

    def set_agent_task(self, project_id: str, task: dict):
        """Persist the current task metadata for one project agent tab."""
        project = self.get_project(project_id)
        if project is None:
            return
        task_key = task.get("task_key")
        if not task_key:
            return
        existing = project.get("agent_tasks", [])
        if not isinstance(existing, list):
            existing = []
        tasks = [
            t for t in existing
            if isinstance(t, dict) and t.get("task_key") != task_key
        ]
        tasks.insert(0, task)
        project["agent_tasks"] = tasks[:MAX_AGENT_TASKS]
        self._save_local(project)

    def clear_agent_task(self, project_id: str, task_key: str):
        """Remove persisted task metadata for one project agent tab."""
        project = self.get_project(project_id)
        if project is None or not task_key:
            return
        existing = project.get("agent_tasks", [])
        if not isinstance(existing, list):
            return
        tasks = [
            t for t in existing
            if isinstance(t, dict) and t.get("task_key") != task_key
        ]
        project["agent_tasks"] = tasks
        self._save_local(project)

    def add_open_app(self, project_id: str, exec_cmd: str, file_path: str):
        """Record that a file was opened with exec_cmd for this project."""
        project = self.get_project(project_id)
        if project is None or not exec_cmd or not file_path:
            return
        apps = project.get("open_apps", [])
        if not isinstance(apps, list):
            apps = []
        # De-duplicate by (exec, file) pair; keep the most recent at the front
        apps = [a for a in apps
                if not (a.get("exec") == exec_cmd and a.get("file") == file_path)]
        apps.insert(0, {"exec": exec_cmd, "file": file_path})
        project["open_apps"] = apps[:50]
        self._save_local(project)

    def get_open_apps(self, project_id: str) -> list[dict]:
        """Return the list of open app entries for this project."""
        project = self.get_project(project_id)
        if project is None:
            return []
        apps = project.get("open_apps", [])
        return apps if isinstance(apps, list) else []

    def clear_open_apps(self, project_id: str):
        """Clear all open app entries for this project."""
        project = self.get_project(project_id)
        if project is None:
            return
        project["open_apps"] = []
        self._save_local(project)

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
