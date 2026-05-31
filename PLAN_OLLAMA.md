# Ollama Models as Mistral Vibe Agent Tabs

## Summary

Add a first-class "local model as agent tab" path: when a user selects an
Ollama model from the New agent dropdown, Eldrun should open a persistent VTE
tab running Mistral Vibe (`vibe`) against that local Ollama model instead of
opening the current GTK Ollama dialog.

This follows Mistral Vibe's documented local-provider support: Vibe can target
OpenAI-compatible APIs, Ollama is listed as a supported local backend, and
`VIBE_HOME` can isolate config/state from the user's global `~/.vibe` setup.

## Key Changes

- Keep Claude, Codex, and Gemini as direct CLI agent commands.
- Replace `OllamaDialog` for agent-dropdown Ollama selections with a new
  `_add_vibe_ollama_terminal` method that opens a persistent VTE tab.
- Preserve `OllamaDialog` for bottom-bar "Ask Ollama" and file-tree "Ask
  Ollama"; only the New agent dropdown changes behavior.
- Label local model tabs with the model name directly (e.g. `llama3.1`),
  numbered the same way as Claude/Codex/Gemini tabs.
- Persist vibe tabs through the existing `project.json["tab_layout"]` mechanism
  (with an added `model` field).

## Implementation Details

All changes are in `app/panels/center_panel.py` and
`tests/test_center_panel_logic.py`.

### New module-level helpers (`center_panel.py`)

**`_vibe_sandbox_dir(directory: str) -> pathlib.Path`**

Returns the vibe config subdir inside the project (or root) sandbox:
`<directory>/.eldrun/sandbox/config/vibe`. For `directory == _ROOT_DIR`,
uses `~/eldrun/root/.eldrun/sandbox/config/vibe` (same pattern).

**`_write_vibe_config(model: str, ollama_host: str, vibe_dir: pathlib.Path)`**

Writes a sandboxed `config.toml` before spawning. Assumed schema (verify field
names against vibe docs once installed):

```toml
active_model = "<safe_alias>"
enable_telemetry = false
enable_auto_update = false

[[providers]]
name = "ollama-local"
api_base = "<ollama_host>/v1"
api_style = "openai"      # ← verify field name from vibe docs

[[models]]
name = "<model>"
provider = "ollama-local"
alias = "<safe_alias>"
```

`safe_alias` is the model name with non-alphanumeric chars replaced by `_`.

**`_vibe_ollama_envv(directory: str, model: str, ollama_host: str) -> list[str]`**

Builds the child environment list for vibe spawns:
- For project dirs: calls `_project_sandbox_envv(directory)` (which already
  sets `XDG_CONFIG_HOME`) and appends `VIBE_HOME=<vibe_sandbox_dir>`.
- For `_ROOT_DIR`: `_project_sandbox_envv` returns `None`, so build from
  `os.environ` directly and append `VIBE_HOME`. Always returns a list, never
  `None`.

**`_show_vibe_missing_dialog(parent)`**

Shows an `Adw.AlertDialog` when `vibe` is not found in PATH, so no broken
tab is opened and the user gets actionable feedback.

### New method `CenterPanel._add_vibe_ollama_terminal`

```python
def _add_vibe_ollama_terminal(self, model: str, task_title: str = "",
                               _show: bool = True, _restore_dir: str = "",
                               _restore_label: str = ""):
```

- **Guard at top**: `if not GLib.find_program_in_path("vibe"): _show_vibe_missing_dialog(...); return`
- Resolves `ollama_host` from `self._settings_manager` or falls back to
  `"http://localhost:11434"`.
- Calls `_write_vibe_config(model, ollama_host, vibe_dir)` before spawn.
- Stores in `_agent_info[page_key]`:
  ```python
  {"cmd": "vibe", "model": model, "directory": directory,
   "label_base": model, "label_index": label_index}
  ```
  Note: uses `model` as `label_base` directly — `_agent_label_base` is not
  called and does not need to be changed.
- Spawns: `_spawn(terminal, directory, _resolve_command("vibe"), on_spawned,
  envv=_vibe_ollama_envv(directory, model, ollama_host))`
- Feeds task prompt via same 350 ms `GLib.timeout_add(_feed_agent_task)` pattern.
- Calls `self._save_tab_layout()` at end.

### Modified: `_on_add_agent` closure (`center_panel.py:708–718`)

Replace the `OllamaDialog` branch:

```python
# before
OllamaDialog(self.get_root(), self._ollama_client,
             initial_prompt=task_title, model=model).present()
# after
self._add_vibe_ollama_terminal(model, task_title=task_title)
```

### Modified: `_on_agent_exited` (`center_panel.py:902–918`)

Add a vibe respawn branch after `self._terminal_pids.pop(page_key, None)`:

```python
if info.get("model"):   # vibe-backed tab
    ollama_host = ...   # same host-resolution as above
    _write_vibe_config(info["model"], ollama_host,
                       _vibe_sandbox_dir(info["directory"]))
    _spawn(terminal, info["directory"], _resolve_command("vibe"), on_respawn,
           envv=_vibe_ollama_envv(info["directory"], info["model"], ollama_host))
else:                   # standard CLI agent — unchanged
    _spawn(terminal, info["directory"], _resolve_command(info["cmd"]),
           on_respawn, envv=_project_sandbox_envv(info["directory"]))
```

### Modified: `_save_tab_layout` (`center_panel.py:1204–1209`)

Include `model` when present:

```python
entry = {"key": key, "label": label,
         "cmd": info.get("cmd", ""), "cwd": info.get("directory", "")}
if info.get("model"):
    entry["model"] = info["model"]
layout.append(entry)
```

### Modified: `_restore_tab_layout` (`center_panel.py:1225–1243`)

Route vibe entries to the new method:

```python
if key.startswith("agent-"):
    model = entry.get("model")
    if model:
        self._add_vibe_ollama_terminal(
            model, _show=False, _restore_dir=cwd, _restore_label=label)
    else:
        self._add_agent_terminal(
            cmd, _show=False, _restore_dir=cwd, _restore_label=label)
```

## Assumptions to Verify Before Implementing

1. **vibe config.toml field names** — `api_style`, `api_base`, `[[providers]]`,
   `[[models]]` must be confirmed from vibe docs or `vibe --help`/`vibe init`
   once installed (`vibe` is not currently on this machine).
2. **vibe executable name** — assumed `vibe`; confirm with `which vibe` after
   install.
3. **Task input via stdin** — confirm vibe accepts prompts on stdin the same way
   as claude/codex/gemini before relying on `_feed_agent_task`.

## Tests

Add `TestVibeOllamaAgentTab` to `tests/test_center_panel_logic.py`:

| Test | What it verifies |
|------|-----------------|
| `test_ollama_model_selection_calls_vibe_path` | Selecting an Ollama model calls `_add_vibe_ollama_terminal`, not `OllamaDialog` |
| `test_vibe_agent_info_stores_model_and_cmd` | `_agent_info` has `cmd="vibe"`, `model="llama3.1"`, `label_base="llama3.1"` |
| `test_save_tab_layout_includes_model_field` | Saved layout entry includes `"model"` key |
| `test_restore_vibe_tab_calls_add_vibe_method` | Layout entry with `model` routes to `_add_vibe_ollama_terminal` |
| `test_vibe_envv_includes_vibe_home` | `_vibe_ollama_envv` output includes `VIBE_HOME=...` |
| `test_missing_vibe_shows_dialog_not_tab` | When vibe not in PATH, no tab is created and dialog method is called |
| `test_vibe_config_toml_written_to_sandbox` | `_write_vibe_config` creates `config.toml` in correct sandbox path |
| `test_task_prompt_fed_to_vibe_tab` | `_feed_agent_task` is scheduled after spawn |
| `test_agent_exited_respawns_vibe_with_correct_env` | `_on_agent_exited` uses vibe path when `info["model"]` is set |

Run:

```bash
python3 -m unittest
python3 -m py_compile app/eldrun.py app/window.py app/project_manager.py \
  app/new_project_dialog.py app/import_project_dialog.py app/settings_manager.py \
  app/default_apps_manager.py app/network_monitor.py app/time_tracker.py \
  app/project_stats.py app/workspace_manager.py app/panels/*.py app/backends/*.py
```

Runtime: ask user to restart Eldrun, right-click the tab bar, select a local
Ollama model, and confirm a VTE terminal opens labeled with the model name (not
a dialog). Switch projects and back to confirm tab restore.
