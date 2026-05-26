"""Phase 15 — Per-project time tracking; syncs time data into global projects.json."""

import json
import os
import pathlib
import time
from datetime import date, datetime, timezone

from gi.repository import GLib

DATA_DIR = os.path.join(GLib.get_user_data_dir(), "eldrun")
_TIME_LOG_FILE = os.path.join(DATA_DIR, "time_log.json")
_ACTIVE_SESSION_FILE = os.path.join(DATA_DIR, "active_session.json")
_PROJECTS_FILE = os.path.join(DATA_DIR, "projects.json")

_MAX_PROJECT_SESSIONS = 20


def format_duration(seconds: float) -> str:
    """Return 'Xh Ym' string from a seconds value."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    return f"{h}h {m}m"


class TimeTracker:
    """Records which project is active and how long, persisting to time_log.json.

    Call on_project_activated(project) / on_project_deactivated() whenever the
    visible center-panel page changes.

    Pass data_dir in tests to isolate file I/O to a temp directory.
    """

    def __init__(self, data_dir: str | None = None):
        _dir = data_dir or DATA_DIR
        os.makedirs(_dir, exist_ok=True)
        self._time_log_file = os.path.join(_dir, "time_log.json")
        self._active_session_file = os.path.join(_dir, "active_session.json")
        self._project_id: str | None = None
        self._project: dict | None = None
        self._start_monotonic: float | None = None
        self._start_real: datetime | None = None
        self._close_orphan_session()

    # ── public API ────────────────────────────────────────────────────────────

    def on_project_activated(self, project: dict):
        """Call when a project terminal becomes the active page."""
        if self._project_id is not None:
            self._close_session()
        self._project_id = project["id"]
        self._project = project
        self._start_monotonic = time.monotonic()
        self._start_real = datetime.now(timezone.utc)
        self._save_active_session()

    def on_project_deactivated(self):
        """Call when leaving any project terminal (Root, empty, or app embed)."""
        if self._project_id is not None:
            self._close_session()
        self._project_id = None
        self._project = None
        self._start_monotonic = None
        self._start_real = None
        self._clear_active_session()

    def get_today_totals(self) -> dict[str, float]:
        """Return {project_id: total_seconds_today} from the persisted log."""
        today = date.today().isoformat()
        totals: dict[str, float] = {}
        for entry in self._load_log():
            if entry.get("date") == today:
                pid = entry.get("project_id")
                if pid:
                    totals[pid] = totals.get(pid, 0.0) + entry.get("duration_s", 0.0)
        return totals

    # ── session lifecycle ──────────────────────────────────────────────────────

    def _close_session(self):
        if self._project_id is None or self._start_monotonic is None:
            return
        duration = time.monotonic() - self._start_monotonic
        start_iso = (self._start_real or datetime.now(timezone.utc)).isoformat()
        entry = {
            "project_id": self._project_id,
            "date": date.today().isoformat(),
            "start_iso": start_iso,
            "duration_s": round(duration, 1),
        }
        self._append_log(entry)
        if self._project:
            self._update_project_json(self._project, entry)

    # ── orphan-session (startup resume) ───────────────────────────────────────

    def _save_active_session(self):
        data = {
            "project_id": self._project_id,
            "start_real": self._start_real.isoformat() if self._start_real else None,
        }
        try:
            with open(self._active_session_file, "w", encoding="utf-8") as f:
                json.dump(data, f)
        except OSError:
            pass

    def _clear_active_session(self):
        try:
            os.unlink(self._active_session_file)
        except OSError:
            pass

    def _close_orphan_session(self):
        """On startup, close any session that was left open when the app last quit."""
        try:
            with open(self._active_session_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except OSError:
            return  # file does not exist — normal case
        except json.JSONDecodeError:
            self._clear_active_session()  # corrupt sentinel — remove it
            return
        pid = data.get("project_id")
        start_str = data.get("start_real")
        if not pid or not start_str:
            self._clear_active_session()
            return
        try:
            start = datetime.fromisoformat(start_str)
        except (ValueError, TypeError):
            self._clear_active_session()
            return
        now = datetime.now(timezone.utc)
        duration = (now - start).total_seconds()
        if duration > 0:
            entry = {
                "project_id": pid,
                "date": start.date().isoformat(),
                "start_iso": start_str,
                "duration_s": round(duration, 1),
            }
            self._append_log(entry)
        self._clear_active_session()

    # ── log persistence ────────────────────────────────────────────────────────

    def _load_log(self) -> list[dict]:
        try:
            with open(self._time_log_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            return []

    def _append_log(self, entry: dict):
        log = self._load_log()
        log.append(entry)
        tmp = self._time_log_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(log, f, indent=2)
        os.replace(tmp, self._time_log_file)

    # ── global projects.json time sync ─────────────────────────────────────────

    def _update_project_json(self, project: dict, _new_entry: dict):
        try:
            with open(_PROJECTS_FILE, "r", encoding="utf-8") as f:
                projects = json.load(f)
        except (OSError, json.JSONDecodeError):
            return

        entry = next((p for p in projects if p.get("id") == project["id"]), None)
        if entry is None:
            return

        all_sessions = [
            e for e in self._load_log()
            if e.get("project_id") == project["id"]
        ]
        recent = all_sessions[-_MAX_PROJECT_SESSIONS:]
        total_s = sum(e.get("duration_s", 0) for e in all_sessions)

        entry["time"] = {
            "total_s": total_s,
            "recent_sessions": [
                {
                    "date": e.get("date", ""),
                    "start": e.get("start_iso", "")[:16].replace("T", " "),
                    "duration_s": e.get("duration_s", 0),
                }
                for e in reversed(recent)
            ],
        }

        tmp = _PROJECTS_FILE + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(projects, f, indent=2)
            os.replace(tmp, _PROJECTS_FILE)
        except OSError:
            pass
