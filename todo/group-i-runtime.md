## Group I — Backend Runtime Follow-Ups
*Files: `src-tauri/src/services/` (`project_runtime.rs`, `terminal_service.rs`,
`window_service.rs`), `commands/`, `.eldrun/sessions/` mirrors, `schema/`. The
first backend runtime boundary pass is implemented: project switching is
coordinated through `switch_project_runtime`, core services live under
`services/`, tab/file/layout/window metadata is mirrored into
`.eldrun/sessions/`, download routing is part of switching, and the old
`switch_project_windows` command is deprecated. Related to #24 (session restore),
but backend-owned.*

32. **Backend runtime follow-ups.** Remaining backend-side work on the runtime
    boundary, each independently pickable:
    - Backend-owned PTY resurrection after app restart, including dead-session
      detection and a clear frontend policy (respawn, mark dead, or manual
      restart).
    - Terminal/agent transcript storage if restart recovery needs readable
      historical output rather than metadata-only restoration.
    - ⛔ ~~Promote `.eldrun/` runtime files from optional mirrors to the primary
      source once compatibility reads from `project.json` are validated.~~
      **OBSOLETE — superseded by the sandbox-hardening decision, which went the
      opposite way.** The state dir is now primary and the project-tree copy is
      export-only, enforced by `tests/project_tree_intent.rs` (see
      `schema/session.rs:8-16`, `services/terminal_service.rs`). Promoting
      in-tree files back to primary would reintroduce the attacker-controlled
      -input problem that change was made to close.
    - Durable project-window metadata under `.eldrun/sessions/windows.json`
      beyond registry IDs (window role/origin, restore command, optional file
      target, future geometry/focus fields).
    - Move file-navigation runtime state backend-side once switching is stable:
      center file tabs, right-panel folder, breadcrumbs, history.
      **Mostly done** — center file tabs and the right-panel folder now live
      backend-side (`services/project_runtime.rs:317,352,368`,
      `schema/session.rs:49-58` `FileTabSession`, persisted as `filetabs.json`).
      Remaining: breadcrumbs and history.
    - Focused tests for backend runtime switching with mocked services
      (time flushing, old-project save, project-window hide/show, download
      routing, root runtime handling, no respawn of already-live tabs).

---
