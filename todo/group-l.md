## Group L — Center Panel: Tabs, Subwindows & Navigation
*Builds on Group D.11 (tiling split subwindows). All items share the center-panel
files: `src/stores/tabs.ts` (per-scope layout tree `layoutByScope`,
`focusedGroupByScope`, active tab), `src/components/layout/CenterPanel.tsx`,
`src/components/tabs/Subwindow.tsx` / `src/components/tabs/TabBar.tsx`,
`src/stores/projects.ts`. #42 additionally needs a Tauri multi-window surface
(`src-tauri/src/lib.rs`, `tauri.conf.json`) + the platform show/hide path
(`platform/x11.rs`, `platform/wayland_kde.rs`, `services/window_service.rs`,
`services/project_runtime.rs`); #55–#57 touch `schema/project.rs`; #62 touches
`src/App.tsx` (global key handlers). #55 (mapping bug) and #62 (keyboard nav) are
correctness/UX work atop the same layout model #42 detaches.*

42. **Drag a subwindow out of the Eldrun main window.** ✅ Implemented · 🧪 Awaiting
    live multi-window QA. Let a tiling subwindow
    (a tab group from Group D.11/#36) be dragged out of the main window and become
    its own standalone OS window, while keeping it bound to its project. The
    detached window must follow the **same hide/show logic as on project switch**:
    when the user switches projects in the main window, a detached subwindow
    belonging to the now-inactive project is parked/hidden on the hidden workspace
    (and re-shown on switching back) exactly like other project-owned windows,
    rather than floating free across all projects.
    Settled decisions (v1): detach gesture = explicit **pop-out button** (drag-past-
    edge deferred — WebKitGTK risk); detached window is a **second Tauri
    `WebviewWindow`** loading the same bundle under `?detached=<scope>:<groupId>`
    rendering one group (inert to project switches); the group leaves `layoutByScope`
    and is tracked in `detachedGroupsByScope` while its tab payloads stay in the
    shared store (PTYs never unmount); detached `TerminalView` is **attach-only**
    (no `pty_spawn`/no kill-on-unmount — output is broadcast by id; blank until next
    output, no scrollback restore); restart re-docks (session-only) but a detached
    group's tabs stay in `project.json` mid-session; parking reuses the existing
    `project_runtime::switch` path via an `ORIGIN_DETACHED_SUBWINDOW` tracked window
    + a hardened X11 `set_parkable` override (main window structurally never
    parkable) **and** a backend-independent Tauri `hide()/show()` fallback so
    Wayland/KDE/null also hide an inactive project's detached window; re-attach via
    dock-back button + dock-on-close (`onCloseRequested`) **and Ctrl+drag-to-dock**:
    Ctrl+dragging the popout's tab bar streams the gesture (screen coords, via the
    `DETACHED_DRAG_*` events) to the main window, which maps them to client space,
    shows the normal drop preview, and docks the group on release over a subwindow
    (`attachGroup` with the resolved edge/center target) — released outside the main
    window or on Escape, the popout stays floating. A plain (non-Ctrl) tab-bar drag
    still hands off to the WM for a native window move.
    Plan/reviews: `docs/group_l_42_detach_plan.md`,
    `docs/group_l_42_detach_plan_review.md`, `docs/group_l_42_detach_review_code.md`.
    *Files: `src/stores/detached.ts`, `src/stores/tabs.ts`,
    `src/components/layout/DetachedApp.tsx` / `DetachedCenterPanel.tsx` /
    `AppShell.tsx`, `src/components/tabs/TabBar.tsx`,
    `src/components/terminal/TerminalView.tsx`, `src/App.tsx`;
    `src-tauri/src/commands/subwindow.rs`, `platform/x11.rs` / `platform/mod.rs`,
    `services/window_service.rs` / `services/project_runtime.rs`, `lib.rs`,
    `tauri.conf.json`, `capabilities/default.json`.*
    - [x] 🤖 Automated test — `SubwindowDetach`, `DetachedSync`, `DetachedHost`,
      `TerminalAttachOnly` (frontend) + `window_service` detached-labels selector
      (backend). tsc clean; 30 #42 frontend tests pass; cargo 373 pass.
    - [ ] 🖐️ Manual test — needs backend rebuild + live run (pop-out spawns &
      seeds, PTY attaches without respawn, X11 park + Tauri hide on switch,
      Wayland hide fallback, dock-back & dock-on-close, main window never parked).

55. **[Bug] Fix tab→project mapping leak.** A tab can show up under the wrong
    project — e.g. the ProjectEldrun main window showing a `TODO.md` tab that
    belongs to a different project. This must never happen. Audit tab persistence
    / restore and the per-scope layout keying (`layoutByScope`, `tab_layout`/
    `tab_groups`, scope ids) so tabs are strictly bound to their owning project.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

56. **Right-click a tab → start renaming.** A right-click on a tab should
    immediately enter inline rename mode (rather than going through a menu).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

57. **Open `README.md` by default for a project with no tab.** When a project is
    opened/activated and has no tabs to restore, show its `README.md` in an
    in-app viewer tab by default (uses the Group D.14 viewer).
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

62. **Fast keyboard navigation across projects / subwindows / tabs.** Make the
    whole app steerable from the keyboard with no mouse required. Needs design
    choices, but the target set: a fast fullscreen mode for a tab/subwindow,
    keyboard switching between projects, between subwindows (e.g. `Shift`+arrows
    to focus subwindows), between tabs in a subwindow (e.g. `Shift`+`Tab`), and
    between projects (e.g. `Shift`+`Ctrl`+`Tab`), plus closing tabs/subwindows —
    all keyboard-driven.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test

82. **Native keyboard file-tree navigation (no mouse).** Make the right-panel
    file tree (`FileTree.tsx`) fully steerable from the keyboard — arrow/`j`/`k`
    to move the selection cursor, `←`/`→` (or `h`/`l`) to collapse/expand a
    directory, `Enter` to open the selected file in a tab, plus wheel-style fast
    scrolling so a long tree can be traversed without reaching for the mouse.
    Builds on #62 (keyboard nav) and the Group D.1 file tree.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

83. **One key shows the radial "pie" project view (as in the root project).**
    A single keypress brings up the same radial/pie project-blob view used by the
    root project (the 3D project blob default root tab, see `ProjectBlobPane.tsx`)
    as a fast project switcher overlay — invoked purely from the keyboard.
    Builds on #62.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

84. **Keyboard navigation within the pie view.** Once the radial/pie view (#83)
    is open, additional keys step the selection around the pie (e.g. arrows /
    rotate keys to move between wedges, `Enter` to activate the highlighted
    project, `Esc` to dismiss) so a project can be picked entirely by keyboard.
    Builds on #83.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

85. **Keyboard tab/subwindow management (split, detach, move).** Drive the whole
    Group D.11 tiling layout from the keyboard with no mouse: split the focused
    subwindow horizontally/vertically into a new tab group, move the focused tab
    into an adjacent subwindow (or a fresh split), detach the focused subwindow
    into its own OS window (the #42 pop-out gesture, keyboard-triggered), and
    re-dock it — all via shortcuts. Builds on #62 and #42 (detached subwindows).
    *Files: `src/stores/tabs.ts` (split/move on `layoutByScope`),
    `src/components/tabs/Subwindow.tsx`/`TabBar.tsx`,
    `src/stores/detached.ts` + `src/components/layout/DetachedApp.tsx`,
    `src/App.tsx` (global key handlers).*
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

---
