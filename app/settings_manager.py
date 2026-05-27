import json
import os

from gi.repository import GLib

_SETTINGS_FILE = os.path.join(GLib.get_user_data_dir(), "eldrun", "settings.json")

_DEFAULTS: dict = {
    "terminal_command": "claude",
    "workspace_management": False,
}


class SettingsManager:
    def __init__(self):
        self._data: dict = dict(_DEFAULTS)
        self._load()

    def _load(self):
        try:
            with open(_SETTINGS_FILE, "r", encoding="utf-8") as f:
                self._data.update(json.load(f))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass

    def _save(self):
        os.makedirs(os.path.dirname(_SETTINGS_FILE), exist_ok=True)
        tmp = _SETTINGS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2)
        os.replace(tmp, _SETTINGS_FILE)

    def get(self, key: str):
        return self._data.get(key, _DEFAULTS.get(key))

    def set(self, key: str, value):
        self._data[key] = value
        self._save()
