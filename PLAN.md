# ProjectEldrun Plan

This file is the single home for open implementation plans. Completed planning
items have been removed from the old platform/backend plan files and are
captured, where relevant, in `STATUS.md` and `DOCUMENTATION.md`.

## Backend Runtime Follow-Ups

The first backend runtime boundary pass is implemented: project switching is
coordinated through `switch_project_runtime`, core services live under
`src-tauri/src/services/`, tab/file/layout/window metadata is mirrored into
`.eldrun/sessions/`, download routing is part of switching, and the old
`switch_project_windows` command is deprecated.

Open work:

- Add backend-owned PTY resurrection after app restart, including dead-session
  detection and a clear frontend policy for whether to respawn, mark dead, or
  offer manual restart.
- Add terminal and agent transcript storage if restart recovery needs readable
  historical output rather than metadata-only restoration.
- Promote `.eldrun/` runtime files from optional mirrors to the primary source
  once compatibility reads from `project.json` have been validated.
- Add durable project-window metadata under `.eldrun/sessions/windows.json`
  beyond registry IDs, including window role/origin, restore command, optional
  file target, and future geometry/focus fields.
- Move file navigation runtime state backend-side after switching remains
  stable: center file tabs, right-panel folder, breadcrumbs, and history.
- Add focused tests for backend runtime switching with mocked services,
  especially time flushing, old-project save, project-window hide/show,
  download routing, root runtime handling, and no respawn of already-live tabs.

## Windows Follow-Ups

Windows support has moved beyond the original compile plan. Current code already
has platform-aware state paths, default shell fallback, browser profile paths,
network detection, Windows app icon helpers, NSIS packaging, and a Windows CI
package job.

Open work:

- Validate a real Windows build and runtime on Windows 10 build 1903+ and
  Windows 11, including ConPTY behavior in xterm.js.
- Decide whether to replace the current command-based PID liveness check with a
  native Windows API implementation.
- Add native window tracking with `EnumWindows` and `GetWindowThreadProcessId`
  if project-owned standalone windows need reliable show/hide behavior on
  Windows.
- Decide whether to add a Windows unhandled-exception crash hook; current crash
  logging is still primarily Unix-oriented.
- Document or improve download routing on Windows, where directory symlinks may
  require Developer Mode or elevated permissions.
- Add runtime QA for browser download preference editing on Firefox, Chrome,
  Chromium, and Chrome Beta profile layouts.

## macOS Follow-Ups

macOS has initial cross-platform code support for state paths, default shell,
browser profile paths, network detection, Unix symlinks, and null workspace
backend fallback.

Open work:

- Add macOS bundle support once distribution is needed: `dmg` or `app` target,
  `minimumSystemVersion`, and CI/package artifact handling.
- Add Hardened Runtime entitlements only if signing/notarization is pursued;
  do not enable App Sandbox because PTY support depends on unrestricted POSIX
  PTY access.
- Validate a real macOS build on Apple Silicon and, if needed, Intel.
- Add native app icon resolution for `.app` bundles if the UI needs resolved
  macOS application icons.
- Add native window tracking with Accessibility APIs or `CGWindowList` only if
  project-owned standalone windows need reliable show/hide behavior on macOS.
- Keep the null workspace backend as the default macOS behavior unless a clear
  user-facing need justifies Accessibility permissions or private APIs.

## Verification

For docs-only changes, run:

```bash
git diff --check
```

For code changes that implement any item above, also run the applicable project
checks:

```bash
npm run build
cd src-tauri && cargo test
```

Runtime validation of workspace/window behavior should remain human-run. Agents
must not launch a second Eldrun instance for verification.
