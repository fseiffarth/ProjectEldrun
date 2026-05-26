"""Background project statistics scanner — writes stats into local project.json."""

import colorsys
import hashlib
import json
import os
import pathlib
import threading
from datetime import date, datetime

DATA_DIR = os.path.join(os.path.expanduser("~"), ".local", "share", "eldrun")
_TIME_LOG = os.path.join(DATA_DIR, "time_log.json")
_LOCAL_FILE = "project.json"
_SKIP_DIR_NAMES = {".git"}
_SKIP_FILE_NAMES = {".eldrun_colors.json"}


def _scan_file_types(directory: str) -> dict:
    stats: dict[str, dict] = {}
    root = pathlib.Path(directory)
    try:
        for p in root.rglob("*"):
            rel = p.relative_to(root)
            parts = rel.parts
            if any(part in _SKIP_DIR_NAMES or part.startswith(".") for part in parts[:-1]):
                continue
            if not p.is_file():
                continue
            if p.name in _SKIP_FILE_NAMES or p.name.startswith("."):
                continue
            ext = p.suffix.lower() or "(none)"
            try:
                size = p.stat().st_size
            except OSError:
                size = 0
            e = stats.setdefault(ext, {"count": 0, "bytes": 0})
            e["count"] += 1
            e["bytes"] += size
    except OSError:
        pass
    return stats


def _read_time_log() -> list:
    try:
        with open(_TIME_LOG, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _compute_time(project_id: str, log: list) -> tuple:
    today = date.today().isoformat()
    today_s = sum(e.get("duration_s", 0) for e in log
                  if e.get("project_id") == project_id and e.get("date") == today)
    total_s = sum(e.get("duration_s", 0) for e in log
                  if e.get("project_id") == project_id)
    return float(today_s), float(total_s)


def _write_stats(project: dict) -> None:
    directory = project.get("directory", "")
    if not directory or not pathlib.Path(directory).is_dir():
        return

    local_path = pathlib.Path(directory) / _LOCAL_FILE

    # Read existing local data to preserve all other fields
    try:
        with open(local_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        data = {k: v for k, v in project.items() if k != "shell_pid"}

    log = _read_time_log()
    today_s, total_s = _compute_time(project["id"], log)

    data["file_type_stats"] = _scan_file_types(directory)
    data["time_today_s"] = today_s
    data["time_total_s"] = total_s
    data["last_updated"] = datetime.now().isoformat()

    tmp = str(local_path) + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, str(local_path))
    except OSError:
        pass


def scan_project_background(project: dict) -> None:
    """Start a daemon thread to scan a project and write stats into its local project.json."""
    threading.Thread(target=_write_stats, args=(project,), daemon=True).start()


def get_project_stats(project: dict) -> dict | None:
    """Read stats fields from the project's local project.json."""
    directory = project.get("directory", "")
    if not directory:
        return None
    local_path = pathlib.Path(directory) / _LOCAL_FILE
    try:
        with open(local_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    if "file_type_stats" not in data:
        return None
    return {
        "file_type_stats": data.get("file_type_stats", {}),
        "time_today_s": data.get("time_today_s", 0.0),
        "time_total_s": data.get("time_total_s", 0.0),
        "last_updated": data.get("last_updated"),
    }


def ext_color_hex(ext: str) -> str:
    """Return a CSS hex color string for the given file extension."""
    h = int(hashlib.md5(ext.encode()).hexdigest(), 16)
    hue = (h % 360) / 360.0
    r, g, b = colorsys.hsv_to_rgb(hue, 0.65, 0.80)
    return f"#{int(r*255):02x}{int(g*255):02x}{int(b*255):02x}"
