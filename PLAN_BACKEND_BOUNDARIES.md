# Incremental Backend Boundary Plan

## Summary

Keep the current Tauri + React architecture and evolve the backend toward explicit
project-centric services. Do not rewrite the frontend or storage in one pass. The
first phase should make project switching a backend-coordinated workflow that
receives the frontend's current runtime snapshot, persists it, coordinates
windows/download routing, loads the next runtime snapshot, and emits one restored
snapshot back to the frontend. Later phases can move more runtime authority fully
backend-side.

## Key Changes

- Introduce a backend `ProjectRuntimeService` as the central coordinator for
  active project state.
- Keep existing Tauri commands, but route project-switch behavior through the new
  service instead of spreading it across frontend stores and individual commands.
- In the first phase, treat React/Zustand as the source for live UI runtime state
  and pass that state to the backend during switching.
- Preserve current `project.json`, global state files, and Python-era schema
  compatibility during the transition.
- Add `.eldrun/` project-local runtime storage gradually, starting as an optional
  mirror of existing state rather than the only source of truth.
- Keep React, Zustand, xterm.js, `portable-pty`, Rust, Tauri, and the current
  X11/KDE/null backend adapters.
- Include active-project download routing (`~/eldrun/downloads`) in the project
  switch workflow.

## Module Layout

```
src-tauri/src/
  services/
    project_runtime.rs   ← new coordinator (owns switching workflow)
    terminal_service.rs  ← wraps PtyRegistry
    window_service.rs    ← wraps WindowRegistry + workspace.rs platform adapters
    restore_service.rs   ← wraps existing restore_open_apps() + tab restore
    download_routing.rs  ← wraps update_downloads_symlink + browser prefs
    file_nav_service.rs  ← Phase 2 only; new backend state, no existing equivalent
  commands/              ← thin Tauri dispatch layer; command names stay stable
  platform/              ← unchanged (x11, wayland_kde, windows, null)
  storage.rs             ← unchanged
  schema/                ← existing structs + new .eldrun/ session structs
```

Lock acquisition order whenever multiple guards are held simultaneously:
`PtyRegistry` → `WindowRegistry` → `WorkspaceState`

## Implementation Steps

1. **Define Backend Runtime Boundaries** *(Phase 1)*
   - Add the `services/` module directory with the modules listed above.
   - Initially these modules should wrap existing command logic instead of
     replacing it.
   - Keep public Tauri command payloads camelCase-compatible.

2. **Create Project Runtime Model** *(Phase 1)*
   - Define a backend runtime model containing `project_id`, `project_dir`,
     terminal tab layout metadata, optional live PTY IDs, tracked project windows,
     file browser tab state, download target state, and active layout metadata.
   - Define a frontend-to-backend switch snapshot containing the previous
     project's current tab layout, active tab, file browser tab state, right-panel
     file folder, and active layout metadata.
   - Treat global apps separately from project runtime.
   - Root terminal remains a special runtime scope, not a normal project.

3. **Move Project Switching Into Backend** *(Phase 1)*
   - Add a command
     `switch_project_runtime(projectId, previousProjectId, previousSnapshot)`.
   - `previousSnapshot` carries: current tab layout, active tab index, file
     browser tab state, right-panel folder, active layout metadata, and
     `flush_secs: f64` so the backend can flush project time atomically in one
     round trip (no separate `timer_flush_project` call needed from the frontend).
   - The command should: flush time, save the previous snapshot, hide/park
     previous project-owned windows, update `~/eldrun/downloads` for the next
     project, load next project runtime state, restore tracked standalone project
     apps, show/unpark next project-owned windows, and emit
     `project-runtime-switched` with payload
     `{ projectId, tabLayout, activeTabIndex, fileTabs, rightPanelFolder, openedWindowIds }`.
   - This command replaces the existing `switch_project_windows` Tauri command.
     `switch_project_windows` becomes an internal function called by
     `window_service.rs`; it is not removed from the public command table yet
     but is marked deprecated in a comment.
   - The `WindowService` calls `show_window`/`hide_window` on the
     `WorkspaceBackend` trait per window. On X11 these are implemented as
     virtual-desktop moves (parking); that is an X11 adapter detail, not a
     service-layer concept. The `workspace_switch` Tauri command, which calls
     `backend.switch_to_project()`, is therefore redundant with the abstract
     per-window interface and should not be called by the new service layer.
   - Update `stores/projects.ts` (currently the only caller of
     `switch_project_windows`) to call `switch_project_runtime` instead.
   - During this phase, the backend restores terminal and file browser metadata;
     the frontend still owns live React component instances and applies the
     emitted snapshot to Zustand/local UI state.

4. **TerminalService** *(Phase 1 — layout/metadata only; PTY resurrection Phase 2+)*
   - Wrap existing PTY registry and commands behind service methods for spawn,
     write, resize, kill, list live sessions, save tab metadata, and restore tab
     metadata.
   - Keep current xterm.js frontend behavior.
   - Persist terminal layout first. Existing mounted frontend `TerminalView`
     instances keep live PTYs alive across project switches; restored metadata
     must not cause duplicate `pty_spawn` calls for already-live tabs.
   - Defer backend-owned PTY resurrection, shell history capture, and transcripts
     to later phases.
   - Treat Claude, Codex, Gemini, Vibe, and plain shell as terminal session kinds.

5. **WindowService** *(Phase 1 — show/hide + registry; durable metadata Phase 2)*
   - Wrap current `WindowRegistry`, `workspace.rs`, and platform adapters.
   - Separate project-owned windows, global role windows, restored project apps,
     and manually launched or unassigned windows.
   - For the first phase, project-owned windows are file-browser-origin windows
     plus restored standalone project apps. Global role windows and manually
     launched unassigned windows must remain cross-project.
   - The abstract interface is `show_window(id)` / `hide_window(id)` on the
     `WorkspaceBackend` trait. On X11, these are implemented as virtual-desktop
     moves (parking to desktop 1, restoring to desktop 0). This is a platform
     adapter detail — `WindowService` never calls `switch_to_project` directly.
   - Add durable project-window metadata later under
     `.eldrun/sessions/windows.json`.
   - Do not attempt app embedding in the MVP boundary work.

6. **RestoreService** *(Phase 1 — tabs + apps + windows; transcripts/crash recovery Phase 2+)*
   - Introduce restore as an explicit backend workflow.
   - Wrap the existing `restore_open_apps()` in `commands/apps.rs` — do not
     reimplement it.
   - First phase restore should cover tab layout, file browser tabs, tracked
     standalone project apps, and project-owned visible/hidden windows.
   - First phase restore returns metadata only for terminal/file tabs; it does not
     recreate dead PTYs or replay terminal output.
   - Later phases can add terminal transcripts, agent transcripts, crash
     recovery, window positions/sizes/focus, and layout snapshots.

7. **FileNavigationService** *(Phase 2 — after project switching is stable)*
   - No backend state exists for file navigation today; all of it lives in the
     frontend `stores/tabs.ts`. This step introduces new backend state, not just
     a wrapper around existing commands.
   - Wrap existing `list_dir`, create, rename, delete, and MIME detection
     commands behind the service interface.
   - Add runtime state for right-panel current folder, center file-browser tabs,
     and breadcrumbs/history.
   - Defer `notify` file watching and `git2` badges until after runtime switching
     is stable.

8. **DownloadRoutingService** *(Phase 1)*
   - Wrap `update_downloads_symlink` and browser download preference setup behind
     the project switch workflow.
   - On project switch, point `~/eldrun/downloads` at the next project directory
     when a project is active.
   - For the root runtime, point `~/eldrun/downloads` at the root work directory
     so downloads do not continue targeting the previous active project.

9. **Storage Migration** *(Phase 1 — compatibility layer; `.eldrun/` as primary source Phase 2)*
   - Keep current global state under `~/.local/share/eldrun/`.
   - Keep current per-project `project.json` as the compatibility source.
   - Add optional project-local runtime files: `.eldrun/state.json`,
     `.eldrun/sessions/terminals.json`, `.eldrun/sessions/windows.json`,
     `.eldrun/sessions/filetabs.json`, and `.eldrun/sessions/layout.json`.
   - Initially write both old and new shapes where practical.
   - Read old shape first if `.eldrun/` is missing.
   - Do not migrate human docs like `AGENTS.md`, `STATUS.md`, or `TODO.md` into
     `.eldrun/`.
   - Add `.eldrun/` to the `.gitignore` written by the project scaffold in
     `commands/projects.rs` — it is runtime state and must not be committed.
   - Treat `.eldrun/` as internal runtime storage. Add it to frontend internal
     file filtering if it should remain hidden even when hidden files are shown.

## Test Plan

- Add backend unit tests for runtime state load/save with old `project.json`
  compatibility.
- Add tests for project switching with mocked services:
  - old project saved
  - old windows hidden
  - downloads symlink updated for the new active project
  - new project restored
  - global app windows ignored
  - manually launched unassigned windows ignored
  - restored standalone project apps treated as project-owned
  - root runtime handled correctly
- Add schema roundtrip tests for new `.eldrun/sessions/*` files.
- Add frontend tests or focused store tests for applying a restored runtime
  snapshot without respawning already-live terminal tabs.
- Keep existing required verification:
  - `npm run build`
  - `cd src-tauri && cargo test`
  - `git diff --check`
- Runtime validation of live window parking should remain human-run only because
  agents must not launch a second Eldrun instance.

## Assumptions

- Tauri + React remains the frontend stack.
- The first goal is backend clarity and restore reliability, not a frontend
  rewrite.
- X11/Cinnamon remains the primary MVP target.
- KDE support stays adapter-based.
- Global apps remain cross-project unless explicitly assigned to a project.
- Existing user state must continue to round-trip cleanly.
