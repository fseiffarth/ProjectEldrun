# Eldrun — Vision Implementation Plan

This document maps the current codebase (v0.0.10) against the strategic vision in `VISION.md`
and provides a sequenced implementation plan for closing the gap. Concrete per-session task
tracking belongs in `TODO.md`; completed work is in `TODO_history.md`.

---

## Vision Summary

Four core principles from `VISION.md`:

1. **Project ownership** — A project owns its apps, windows, terminals, files, Git state,
   notes, AI context, layout, and tasks. Nothing shared between projects by accident.
2. **Context restoration** — Selecting a project fully restores the previous working context
   without manual app re-opening.
3. **Virtual project spaces** — The mental model is "project A appears, project B disappears",
   not "switch workspace". The technical mechanism can vary per desktop.
4. **Backend adapter architecture** — Core logic (project model, window registry, layout state,
   switch logic) is desktop-agnostic. Each compositor/DE is a swappable adapter.

**Ultimate target:** The user does not open applications. The user opens projects.

**MVP target:** Cinnamon X11 + Parking Workspace + Project Registry + App Launcher +
Layout Restore. Everything else is later-phase or post-MVP work.

---

## Gap Analysis: v0.0.10 vs Vision

| Area | Vision requires | Current state | Gap |
|------|-----------------|---------------|-----|
| App/window ownership | Projects own their windows; switching hides old windows, shows new | Parking workspace exists; project-owned standalone app tracking is still incomplete (ISSUE-008) | High |
| Standalone file open | Launch externally and record in `open_apps`; no embedding required for baseline | File opens use `launch_on_other_monitor()` and record `exec`/`file`, but entries lack `mode`, PID, and live-state metadata (G4.5) | High |
| App restore on re-activation | Relaunch restorable standalone entries automatically on project switch/startup | `_restore_project_apps()` relaunches saved `exec`/`file` entries, but needs mode-aware restore and stale-entry handling (G4.6) | High |
| Tab layout persistence | Terminal/agent tab set restored after restart/re-activation | Not persisted; tabs always start fresh | High |
| Project-scoped window list | Only show windows belonging to current project | Current source of truth should be active project `open_apps`; live PID/XID enrichment is still missing (ISSUE-002, G4.4) | Medium |
| Backend adapter architecture | Core + swappable adapters (Cinnamon, KDE, GNOME, etc.) | Cinnamon/X11 primitives mixed into `workspace_manager.py` and `window.py` | Medium |
| Local AI (G5) | Ollama status UI, per-project models, privacy label, terminal hints, semantic search, suggestions | Base client/dialog/settings/model listing and optional autostart exist; higher-level project-aware features remain | Medium |
| Global apps | Cross-project app roles stay separate from project-owned windows | Registry, settings, toolbar, launch-or-raise, sticky windows, and toolbar popover handling exist; URI routing remains | Low |
| URI routing | Links from terminals/file tree routed through global apps | Missing (G6.7); should use existing global app roles | Low |
| Theme propagation | Standalone apps get GTK_THEME env; embedded apps get XSETTINGS update | Missing (G3.2, G3.5) | Low |
| Rendering flicker | Stable frame presentation under high CPU | Cinnamon/X11 `ngl` renderer workaround exists; broader X11 behavior may still need validation (ISSUE-018) | Low |
| Platform expansion | KDE, Hyprland, GNOME Shell, Sway adapters | Cinnamon/GNOME only | Future |

---

## Implementation Phases

### Phase 1 — Complete App/Window Ownership (G4 group)

**Goal:** Projects reliably own standalone app launches before embedding is treated as
an enhancement. A file open creates a tracked standalone entry that follows the project
across switches and can be restored on re-activation.

This is the highest-priority gap. Without it the core promise — "project owns its apps" —
is not met even for the Cinnamon X11 MVP.

#### Steps

**1a — Standalone file-open baseline (G4.5)**

Keep the current standalone launch path (`launch_on_other_monitor()`), but make the
recorded metadata explicit and restorable. Extend `ProjectManager.add_open_app()` so it
can persist the process returned by `FileTreePanel._open_file()`:

```python
# project.json["open_apps"] remains a list, not a dict keyed by extension.
{
    "exec": app,
    "file": path,
    "mode": "standalone",
    "pid": proc.pid,
    "opened_at": time.time()
}
```

Key files: `app/panels/right_panel.py`, `app/project_manager.py`,
`app/launch_helpers.py`.

Acceptance: double-clicking a file opens it in a standalone window; entry appears in
`project.json["open_apps"]` with `exec`, `file`, `mode`, `pid`, and `opened_at`; center
panel stays on the terminal.

---

**1b — Add `mode` field to all open_apps writes (G4.1)**

Every write to `project.json["open_apps"]` must carry `"mode": "standalone"`. Entries
created before this change (missing `mode`) are treated as legacy standalone/unknown
entries and remain restorable if they have valid `exec` and `file` fields.

---

**1c — Project-scoped window list (G4.4)**

Use active project metadata as the source of truth: the open-apps section shows entries
from the current project's `project.json["open_apps"]`, not all desktop windows. Add
best-effort live enrichment by checking stored `pid`/future `xid` values to mark entries
as running, stale, or restorable.

Do not make `psutil` a required dependency in this phase. PID/XID checks should degrade
gracefully when process or X11 inspection is unavailable.

Key files: `app/panels/right_panel.py`, `app/project_manager.py`.

---

**1d — Standalone app restore on re-activation (G4.6)**

In `window.py` -> `_restore_project_apps`, after terminal setup:

```python
for entry in project_manager.get_open_apps(project_id):
    mode = entry.get("mode") or "standalone"
    if mode == "standalone" and entry.get("exec") and entry.get("file"):
        launch_on_other_monitor([entry["exec"], entry["file"]], anchor_window=self)
```

Skip entries without `exec` or `file`, and skip missing files. Treat `mode == "embed"` as
future embedding metadata, not part of the standalone restore path. Add a restore setting
only if product behavior needs a user-visible opt-out; otherwise keep the initial
implementation mode-aware and automatic.

---

**1e — X11 embedding hardening (G4.8 Stage 2)**

Once standalone ownership is stable and manually validated, re-introduce embedding as an
*enhancement*, not the primary path. In a new or restored `center_panel.py` embedding path:

- Retry up to 5×, 300 ms apart, using `GLib.timeout_add`
- On any exception: restore last terminal page immediately
- Never leave the center panel in a blank/unknown state

Key files: `app/panels/center_panel.py`, `app/panels/right_panel.py`.

---

**1f — Reconnect AppRow click → embed (G4.8 Stage 3)**

Wire `FileTreePanel` open-windows rows so entries with a known XID can attempt embed or
raise behavior. Poll EWMH only while the panel is visible or the project is active, and
store XID as best-effort metadata rather than a required field.

Gate this step on Stage 2 being verified in a live session (ISSUE-001).

---

### Phase 2 — Complete Context Restoration

**Goal:** Switching to a project fully restores what the user left: same terminal tabs,
same agent commands, same standalone apps open.

#### Steps

**2a — Tab layout persistence**

Save to `project.json["tab_layout"]` on every tab add/remove/rename:

```json
"tab_layout": [
  {"key": "claude-0", "label": "Claude", "cmd": "claude", "cwd": "/project"},
  {"key": "shell-1", "label": "build", "cmd": "$SHELL", "cwd": "/project"}
]
```

Key file: `app/panels/center_panel.py` — hook into `_add_tab`, close, rename, and reorder
paths. Existing `agent_tasks` persistence should be preserved and associated with the
restored tab keys where possible.

**2b — Tab layout restore on activation**

In the project activation flow, restore the saved tab set before defaulting to a fresh
agent terminal. Keep the existing no-tabs empty state if the user intentionally closed all
tabs.

**2c — Standalone app GTK_THEME env (G3.2)**

In app launch helpers, inject:

```python
env = os.environ.copy()
env["GTK_THEME"] = "Adwaita:dark" if dark_mode else "Adwaita"
```

Use this from standalone project launches and global app launches without duplicating
theme logic at every call site.

**2d — Embedded app theme propagation (G3.5)**

After embedded apps are stable, iterate open embed tabs on theme changes and send an
XSETTINGS `Net/ThemeName` change via python-xlib. No-op gracefully if the window is gone.

---

### Phase 3 — Backend Adapter Architecture

**Goal:** Extract all desktop-specific window control into a swappable adapter layer so
the core project-switch logic is compositor-agnostic. Required before adding KDE/Hyprland
support without forking the core.

#### Target structure

```
app/
  workspace_core.py            # ProjectSpaceBackend ABC + ProjectWindowRegistry
  backends/
    __init__.py                # detect_backend() → returns best available adapter
    cinnamon_x11.py            # existing X11/xlib/wmctrl logic, moved here
    gnome.py                   # existing DBus/GNOME Shell logic, moved here
    null.py                    # no-op for unsupported compositors
```

#### Stable interface (workspace_core.py)

```python
class ProjectSpaceBackend(ABC):
    def is_available(self) -> bool: ...
    def prepare(self) -> None: ...
    def open_project(self, project_id: str) -> None: ...
    def close_project(self, project_id: str) -> None: ...
    def activate_project(self, project_id: str, previous_project_id: str | None) -> None: ...
    def assign_window_to_project(self, window_id: int, project_id: str) -> None: ...
    def save_project_layout(self, project_id: str) -> None: ...
    def restore_project_layout(self, project_id: str) -> None: ...
    def make_global_window(self, window_id: int) -> None: ...
    def cleanup(self) -> None: ...
```

`window.py` calls only `ProjectSpaceBackend` methods. It never imports `python-xlib`
directly.

Method intent:

- `prepare()` sets up backend-level state such as Cinnamon's two-workspace model.
- `open_project()` prepares/registers project-space tracking.
- `close_project()` unregisters project-space state; it does not kill user app windows
  unless a future behavior explicitly opts into that.
- `activate_project()` shows/restores the target project's windows and layout while
  parking the previous project as needed.
- `assign_window_to_project()` binds a launched app window to the owning project.
- `make_global_window()` marks cross-project global app windows as sticky or otherwise
  excluded from project moves.

#### Migration steps

1. Create `workspace_core.py` with `ProjectSpaceBackend` and a `ProjectWindowRegistry`
   that maps `xid → project_id`.
2. Move current `WorkspaceManager` Cinnamon/X11 and wmctrl behavior into
   `backends/cinnamon_x11.py`.
3. Move GNOME DBus/gsettings behavior into `backends/gnome.py`.
4. Write `backends/detect_backend()` — probes `XDG_CURRENT_DESKTOP`, `WAYLAND_DISPLAY`, etc.
5. Update `window.py` to call `self._project_space_backend = detect_backend()` and replace
   direct workspace-manager calls.
6. Keep `workspace_manager.py` as a thin shim or remove it once fully migrated.

Acceptance: `python3 -m unittest` still passes; Cinnamon X11 behavior is identical; adding
a new adapter is a single new file in `backends/`.

---

### Phase 4 — Local AI Integration (G5 group)

**Goal:** Make Ollama a first-class project-aware AI surface: daemon lifecycle, per-project
model selection, privacy boundary, context-aware hints, and intelligent suggestions.

#### Steps

Current baseline: `OllamaClient` supports streamed HTTP generation and model listing;
settings include host/model/autostart; the UI has an Ollama dialog, bottom prompt entry,
file-tree "Ask Ollama", and local-model entries in the agent popover. Phase 4 upgrades
that baseline into a project-aware local AI surface.

**4a — Ollama status indicator (G5.1)**

- Keep the existing optional `ollama serve` autostart/cleanup path.
- Add a small colored dot to the right of the network lamp in the header:
  - Green = Ollama ready (`/api/tags` returns 200)
  - Grey = offline/not running
- Probe every 10 s with `GLib.timeout_add(10000, ...)`.

Key files: `app/window.py`, `app/ollama_client.py`.

**4b — Per-project model selection (G5.2)**

- Add `"ollama_model"` field to `project.json` (falls back to global settings default).
- Show a project-level model selector where project settings already live.
- Pass the active project's selected model into `OllamaClient.ask()` call sites instead of
  making the client depend directly on project state.

**4c — Local AI privacy badge (G5.3)**

Add a local-AI label or lock icon to all Ollama-generated output surfaces:
`OllamaDialog`, the terminal hints strip (4d), and suggestion sections (4f–4g).

**4d — Terminal scrollback hints (G5.4)**

Below the active VTE terminal, show a collapsible 1-line hint strip. When the user has
been idle for 5 s and the last terminal output contains an error or warning pattern, pipe
the last 50 scrollback lines to Ollama and display the first sentence of the response.

Key file: `app/panels/center_panel.py`.

**4e — Semantic project search (G5.5)**

In the project search popover, after the plain text match, run an embedding-ranked pass:

1. For each project, embed `<name>: <first 200 chars of STATUS.md>` via Ollama
   `/api/embeddings`.
2. Embed the search query the same way.
3. Rank results by cosine similarity; surface as a secondary "Semantic matches" section.

New file: `app/ai_search.py`.

**4f — Startup project suggestions (G5.6)**

On `_on_map`, fire an async Ollama request with:
- Recent `git log --oneline -20` from all active projects
- Current date/time
- Prompt: "Which 2-3 projects is the user most likely continuing today?"

Surface result as a soft highlight or pinned pill at the top of the bottom bar.

**4g — App/file suggestions per project (G5.7)**

On project activation, send recent commits + `project.json["open_apps"]` history to
Ollama and surface a "Suggested files" section at the top of the file tree.

---

### Phase 5 — URI Routing and Rendering Polish

**Goal:** Close the remaining small open items.

**5a — URI scheme routing (G6.7)**

In `center_panel.py`, connect VTE `hyperlink-hover-uri` signal. When the user activates a
link (Ctrl+click or Enter on hover), intercept:

```python
def _on_uri_activated(self, terminal, uri, button):
    scheme = uri.split(":")[0]
    if scheme in ("http", "https", "mailto", "webcal"):
        self._global_apps_manager.launch_role_for_uri(scheme, uri)
        return True  # consumed
```

Add `launch_role_for_uri(scheme, uri)` to `GlobalAppsManager` and implement it on top of
the existing global app role registry and launch-or-raise behavior:
- `http`/`https` → browser role
- `mailto` → mail role
- `webcal` → calendar role

Also hook file-tree open for `.url` / `.webloc` files.

**5b — Rendering flicker follow-up (ISSUE-018)**

`app/eldrun.py` already has `_preferred_gsk_renderer()` and respects
`ELDRUN_DISABLE_RENDERER_WORKAROUND=1`. Evaluate whether to extend the Cinnamon/X11
selection to all X11 sessions:

```python
if os.environ.get("XDG_SESSION_TYPE") == "x11":
    os.environ.setdefault("GSK_RENDERER", "ngl")
```

If broadened, update the renderer-selection unit tests and keep explicit environment
overrides respected.

**5c — Version bump to 0.1.0**

After Phase 1–5 are complete and manually verified, bump `__version__` in `app/eldrun.py`
to `0.1.0`. This is the first version where the Cinnamon X11 MVP vision is substantially
met: projects own their apps, context is restored on switch, and the backend is adapter-
ready.

---

### Phase 6 — Platform Expansion (Post-MVP)

Build additional backend adapters in sequence. Each is a self-contained file in
`app/backends/`; core logic stays untouched.

| Priority | Adapter | Key mechanism |
|----------|---------|---------------|
| 1 | **KDE/KWin** (`backends/kde_kwin.py`) | KWin scripting via `org.kde.KWin` DBus; `KWinScript` for layout/workspace control |
| 2 | **Hyprland** (`backends/hyprland.py`) | `hyprctl dispatch` + IPC socket at `$HYPRLAND_INSTANCE_SIGNATURE` |
| 3 | **i3/Sway** (`backends/i3_sway.py`) | `i3ipc` Python bindings; `move container to workspace` commands |
| 4 | **GNOME Shell extension** | JavaScript extension exposing DBus methods; Eldrun calls them |
| 5 | **Wayland compositor** | Long-term; wlroots/Smithay base; Eldrun as compositor plugin or standalone WM |

The `detect_backend()` function in `backends/__init__.py` auto-selects by probing
`XDG_CURRENT_DESKTOP`, `WAYLAND_DISPLAY`, and tool availability.

---

## Version Roadmap

| Version | Key milestone |
|---------|--------------|
| `0.0.10` | Current: core shell, agent tabs, file tree, global apps, settings, workspace management, base Ollama, renderer workaround |
| `0.0.11` | Phase 1 complete: standalone file-open metadata, project-scoped open-app list, mode-aware app restore |
| `0.0.12` | Phase 2 complete: tab layout persistence and fuller context restoration |
| `0.0.13` | Phase 3 complete: backend adapter architecture refactored |
| `0.0.14` | Phase 4 complete: Ollama status, per-project models, terminal hints, semantic search |
| `0.0.15` | Phase 5 complete: URI routing and renderer follow-up |
| `0.1.0` | Cinnamon X11 MVP fully matches vision; bump to `0.1.x` series |
| `0.2.0` | First non-Cinnamon adapter stable (KDE or Hyprland) |

---

## Verification Per Phase

After each phase, run:

```bash
python3 -m py_compile app/eldrun.py app/window.py app/project_manager.py \
  app/new_project_dialog.py app/import_project_dialog.py app/settings_manager.py \
  app/default_apps_manager.py app/network_monitor.py app/time_tracker.py \
  app/project_stats.py app/workspace_manager.py app/panels/*.py

python3 -m unittest
```

Runtime validation (phases 1, 2, 4) requires a live Eldrun session. Do not launch a
second Eldrun instance from an agent terminal. Ask the user to restart the running
instance for manual QA.

---

## Deferred Items

These remain deliberately outside the near-term MVP implementation phases:

- **Wayland compositor** path — no concrete timeline; deferred to Phase 6 long-term.
- **Windows/macOS** — explicitly out of scope for the current GTK/VTE architecture.
