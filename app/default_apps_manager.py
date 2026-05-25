import json
import os
import pathlib
import subprocess

from gi.repository import GLib

_GLOBAL_FILE = os.path.join(GLib.get_user_data_dir(), "eldrun", "default_apps.json")

# Common extension → MIME type for bootstrap
_EXT_MIME = {
    ".py":   "text/x-python",
    ".js":   "application/javascript",
    ".ts":   "application/typescript",
    ".html": "text/html",
    ".css":  "text/css",
    ".md":   "text/markdown",
    ".txt":  "text/plain",
    ".json": "application/json",
    ".xml":  "application/xml",
    ".yaml": "application/x-yaml",
    ".yml":  "application/x-yaml",
    ".sh":   "application/x-sh",
    ".pdf":  "application/pdf",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg":  "image/svg+xml",
    ".mp4":  "video/mp4",
    ".mp3":  "audio/mpeg",
    ".rs":   "text/x-rust",
    ".go":   "text/x-go",
    ".c":    "text/x-csrc",
    ".cpp":  "text/x-c++src",
    ".h":    "text/x-chdr",
    ".toml": "application/toml",
}


def _find_desktop_file(name: str) -> str | None:
    dirs = [
        pathlib.Path.home() / ".local/share/applications",
        pathlib.Path("/usr/share/applications"),
        pathlib.Path("/usr/local/share/applications"),
    ]
    for d in dirs:
        f = d / name
        if f.exists():
            return str(f)
    return None


def _exec_from_desktop(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("Exec="):
                    parts = line[5:].split()
                    parts = [p for p in parts if not p.startswith("%")]
                    if parts:
                        return parts[0]
    except OSError:
        pass
    return None


def _system_app_for_mime(mime: str) -> str | None:
    try:
        r = subprocess.run(
            ["xdg-mime", "query", "default", mime],
            capture_output=True, text=True, timeout=3,
        )
        desktop = r.stdout.strip()
        if not desktop:
            return None
        dp = _find_desktop_file(desktop)
        if dp:
            return _exec_from_desktop(dp)
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def _mime_for_file(path: str) -> str | None:
    try:
        r = subprocess.run(
            ["xdg-mime", "query", "filetype", path],
            capture_output=True, text=True, timeout=3,
        )
        m = r.stdout.strip()
        return m or None
    except (OSError, subprocess.TimeoutExpired):
        return None


def get_installed_apps() -> list[dict]:
    """Scan .desktop files and return installed apps sorted by name.

    Each entry: {name, exec, icon}
    """
    seen_execs: set[str] = set()
    apps: list[dict] = []
    dirs = [
        pathlib.Path.home() / ".local/share/applications",
        pathlib.Path("/usr/share/applications"),
        pathlib.Path("/usr/local/share/applications"),
    ]
    for d in dirs:
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.desktop")):
            name = exec_cmd = icon = None
            in_entry = False
            no_display = False
            try:
                with open(f, "r", encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        line = line.strip()
                        if line.startswith("["):
                            in_entry = (line == "[Desktop Entry]")
                            continue
                        if not in_entry:
                            continue
                        if line.startswith("Name=") and name is None:
                            name = line[5:]
                        elif line.startswith("Exec=") and exec_cmd is None:
                            parts = line[5:].split()
                            parts = [p for p in parts if not p.startswith("%")]
                            if parts:
                                exec_cmd = parts[0]
                        elif line.startswith("Icon=") and icon is None:
                            icon = line[5:]
                        elif line == "NoDisplay=true":
                            no_display = True
            except OSError:
                continue
            if no_display or not name or not exec_cmd:
                continue
            if exec_cmd in seen_execs:
                continue
            seen_execs.add(exec_cmd)
            apps.append({
                "name": name,
                "exec": exec_cmd,
                "icon": icon or "application-x-executable-symbolic",
            })
    return sorted(apps, key=lambda x: x["name"].lower())


class DefaultAppsManager:
    """Global and per-project filetype → app mappings."""

    def __init__(self):
        self._path = pathlib.Path(_GLOBAL_FILE)
        self._map: dict[str, str] = self._load(self._path)

    # ── persistence ───────────────────────────────────────────────────────────

    def _load(self, path: pathlib.Path) -> dict:
        if not path.exists():
            return {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (json.JSONDecodeError, OSError):
            return {}

    def _save_global(self):
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = str(self._path) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._map, f, indent=2, sort_keys=True)
        os.replace(tmp, str(self._path))

    def _proj_path(self, project_dir: str) -> pathlib.Path:
        return pathlib.Path(project_dir) / "project_default_apps.json"

    # ── project-level map ──────────────────────────────────────────────────────

    def get_project_map(self, project_dir: str) -> dict:
        return self._load(self._proj_path(project_dir))

    def set_project_app(self, project_dir: str, ext: str, app: str):
        m = self.get_project_map(project_dir)
        m[ext.lower()] = app
        p = self._proj_path(project_dir)
        tmp = str(p) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(m, f, indent=2, sort_keys=True)
        os.replace(tmp, str(p))

    # ── global map ────────────────────────────────────────────────────────────

    def get_global_map(self) -> dict:
        return dict(self._map)

    def set_global_app(self, ext: str, app: str):
        self._map[ext.lower()] = app
        self._save_global()

    def remove_global_app(self, ext: str):
        self._map.pop(ext.lower(), None)
        self._save_global()

    # ── lookup ────────────────────────────────────────────────────────────────

    def get_app_for_file(self, file_path: str, project_dir: str | None = None) -> str | None:
        """Return app command: project map → global map → system xdg-mime."""
        ext = pathlib.Path(file_path).suffix.lower()
        if not ext:
            return None
        if project_dir:
            pm = self.get_project_map(project_dir)
            if ext in pm:
                return pm[ext]
        if ext in self._map:
            return self._map[ext]
        mime = _EXT_MIME.get(ext) or _mime_for_file(file_path)
        if mime:
            return _system_app_for_mime(mime)
        return None

    # ── bootstrap ─────────────────────────────────────────────────────────────

    def bootstrap_from_system(self):
        """One-time: populate global map from system defaults for common types."""
        changed = False
        for ext, mime in _EXT_MIME.items():
            if ext not in self._map:
                app = _system_app_for_mime(mime)
                if app:
                    self._map[ext] = app
                    changed = True
        if changed:
            self._save_global()
