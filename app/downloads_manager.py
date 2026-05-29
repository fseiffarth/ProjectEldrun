"""
Manages ~/eldrun/downloads symlink and browser download-directory preferences.

Symlink is updated on every project switch.
Browser prefs are written unconditionally on Eldrun startup (assumes browser
has not yet started).
"""

import configparser
import json
import os
import pathlib
import re


_LINK = pathlib.Path.home() / "eldrun" / "downloads"

_FF_MARKER_START = "# BEGIN eldrun-downloads\n"
_FF_MARKER_END   = "# END eldrun-downloads\n"


# ── symlink ───────────────────────────────────────────────────────────────────

def update_project_downloads(project_dir: str | None) -> None:
    """Point ~/eldrun/downloads at the active project's tmp/downloads, or root's."""
    if project_dir:
        target = pathlib.Path(project_dir) / "tmp" / "downloads"
    else:
        target = pathlib.Path.home() / "eldrun" / "root" / "tmp" / "downloads"
    _update_symlink(target)


def _update_symlink(target: pathlib.Path) -> None:
    try:
        target.mkdir(parents=True, exist_ok=True)
        _LINK.parent.mkdir(parents=True, exist_ok=True)
        tmp = _LINK.parent / (_LINK.name + ".tmp")
        tmp.unlink(missing_ok=True)
        os.symlink(target, tmp)
        os.replace(tmp, _LINK)  # atomic on Linux
    except Exception:
        pass


# ── browser prefs ─────────────────────────────────────────────────────────────

def apply_browser_download_dir() -> None:
    """Set ~/eldrun/downloads as the download directory in all detected browsers."""
    _apply_firefox()
    for name in ("google-chrome", "chromium", "chromium-browser"):
        _apply_chromium(name)


# Firefox

def _firefox_profile() -> pathlib.Path | None:
    ini = pathlib.Path.home() / ".mozilla" / "firefox" / "profiles.ini"
    if not ini.exists():
        return None
    cp = configparser.ConfigParser()
    cp.read(ini)
    rel = None
    for s in cp.sections():
        if s.lower().startswith("install"):
            rel = cp.get(s, "Default", fallback=None)
            if rel:
                break
    if not rel:
        for s in cp.sections():
            if s.lower().startswith("profile"):
                if cp.get(s, "Default", fallback="0") == "1":
                    rel = cp.get(s, "Path", fallback=None)
                    break
    if not rel:
        for s in cp.sections():
            if s.lower().startswith("profile"):
                rel = cp.get(s, "Path", fallback=None)
                if rel:
                    break
    if not rel:
        return None
    d = pathlib.Path.home() / ".mozilla" / "firefox" / rel
    return d if d.exists() else None


def _ff_write_prefs(path: pathlib.Path, kvs: dict[str, str]) -> None:
    if not path.exists():
        return
    text = path.read_text(errors="replace")
    for key, raw in kvs.items():
        line = f'user_pref("{key}", {raw});'
        pat = re.compile(r'user_pref\("' + re.escape(key) + r'",\s*.*?\);')
        text = pat.sub(line, text) if pat.search(text) else (
            text.rstrip("\n") + "\n" + line + "\n"
        )
    path.write_text(text)


def _ff_write_user_js(path: pathlib.Path, kvs: dict[str, str]) -> None:
    existing = path.read_text(errors="replace") if path.exists() else ""
    existing = re.sub(
        re.escape(_FF_MARKER_START) + r".*?" + re.escape(_FF_MARKER_END),
        "",
        existing,
        flags=re.DOTALL,
    )
    lines = [_FF_MARKER_START]
    for key, raw in kvs.items():
        lines.append(f'user_pref("{key}", {raw});\n')
    lines.append(_FF_MARKER_END)
    path.write_text(existing.rstrip("\n") + "\n" + "".join(lines))


def _apply_firefox() -> None:
    profile = _firefox_profile()
    if not profile:
        return
    kvs = {
        "browser.download.dir":            f'"{_LINK}"',
        "browser.download.folderList":     "2",
        "browser.download.useDownloadDir": "true",
    }
    _ff_write_prefs(profile / "prefs.js", kvs)
    _ff_write_user_js(profile / "user.js", kvs)


# Chromium-based

def _apply_chromium(name: str) -> None:
    path = pathlib.Path.home() / ".config" / name / "Default" / "Preferences"
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text())
        data.setdefault("download", {})["default_directory"] = str(_LINK)
        data["download"]["directory_upgrade"] = True
        path.write_text(json.dumps(data))
    except Exception:
        pass
