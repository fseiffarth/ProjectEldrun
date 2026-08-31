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
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

55. **[Bug] Fix tab→project mapping leak.** A tab can show up under the wrong
    project — e.g. the ProjectEldrun main window showing a `TODO.md` tab that
    belongs to a different project. This must never happen. Audit tab persistence
    / restore and the per-scope layout keying (`layoutByScope`, `tab_layout`/
    `tab_groups`, scope ids) so tabs are strictly bound to their owning project.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

56. **Right-click a tab → start renaming.** Shipped as **Shift+right-click**
    (`TabBar.tsx:200,210,640`); plain right-click still opens the context menu.
    Amend the wording or change the binding — as written the item doesn't match
    the code.
    - [x] 🤖 Automated test — `src/__tests__/TabInlineRename.test.tsx`
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

57. **Open `README.md` by default for a project with no tab.** ⛔ **REVERTED —
    was implemented, then deliberately removed.** When a project is
    opened/activated and has no tabs to restore, show its `README.md` in an
    in-app viewer tab by default (uses the Group D.14 viewer).
    - `src/components/layout/CenterPanel.tsx:250` now reads: *"we no longer seed
      a default README.md tab"* — an empty scope shows a Subwindow with a `+`
      instead (see [Tab persistence policy]). Boxes below are stale from the
      original implementation.
    - [ ] 🤖 Automated test — n/a while reverted.
    - [ ] 🖐️ Manual test — n/a while reverted.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
    - **Decide:** restore the behaviour, or close this item as withdrawn.

62. **Fast keyboard navigation across projects / subwindows / tabs.** Make the
    whole app steerable from the keyboard with no mouse required. Needs design
    choices, but the target set: a fast fullscreen mode for a tab/subwindow,
    keyboard switching between projects, between subwindows (e.g. `Shift`+arrows
    to focus subwindows), between tabs in a subwindow (e.g. `Shift`+`Tab`), and
    between projects (e.g. `Shift`+`Ctrl`+`Tab`), plus closing tabs/subwindows —
    all keyboard-driven.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

82. **Native keyboard file-tree navigation (no mouse).** Make the right-panel
    file tree (`FileTree.tsx`) fully steerable from the keyboard — arrow/`j`/`k`
    to move the selection cursor, `←`/`→` (or `h`/`l`) to collapse/expand a
    directory, `Enter` to open the selected file in a tab, plus wheel-style fast
    scrolling so a long tree can be traversed without reaching for the mouse.
    Builds on #62 (keyboard nav) and the Group D.1 file tree.
    - **PARTIAL, not unstarted.** `FileTree.tsx:1332 handleTreeKeyDown` already
      handles `Enter` / `Escape` / `Delete` — but only once something has been
      selected with the mouse. Genuinely missing: cursor movement
      (`↑`/`↓`/`j`/`k`), `←`/`→` expand-collapse, and fast scrolling.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

83. **One key shows the radial "pie" project view (as in the root project).**
    A single keypress brings up the same radial/pie project-blob view used by the
    root project (the 3D project blob default root tab, see `ProjectBlobPane.tsx`)
    as a fast project switcher overlay — invoked purely from the keyboard.
    Builds on #62.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

84. **Keyboard navigation within the pie view.** Once the radial/pie view (#83)
    is open, additional keys step the selection around the pie (e.g. arrows /
    rotate keys to move between wedges, `Enter` to activate the highlighted
    project, `Esc` to dismiss) so a project can be picked entirely by keyboard.
    Builds on #83.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

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
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

213. **Live-QA the keyboard steering system (#62 follow-on).** ✅ Implemented ·
    🧪 Awaiting live QA. Verify the four new surfaces together: steering mode
    (Ctrl+Shift+Space toggles it, even from a focused terminal; digit stations
    1 = root / 2+ = pills incl. Trash, arrow-key subwindow focus with the
    relative ↓/↑ badges, Tab/Shift+Tab tab cycling, F/P/W toggles, S/?/Esc/Enter
    exits, bottom-center legend + station chips on the pills), the F1 shortcut
    cheat sheet (grouped bindings, "customized" marks, fixed keys, ⚙ menu
    entry), Settings → Keyboard Shortcuts (grouped rows, conflict warning on
    colliding chords, Reset all, the new Ctrl+Shift+← cycle-back), and the
    "Steer with the keyboard" lesson (basics tier — its enter-mode task must
    complete when the legend appears).
    *Files: `src/lib/shortcuts.ts`, `src/hooks/useKeyboard.ts`,
    `src/stores/keyboardSteering.ts`, `src/components/layout/SteeringLegend.tsx`
    / `ShortcutHelpOverlay.tsx`, `src/lib/lessons.ts`.*
    - [x] 🤖 Automated test — `src/__tests__/Shortcuts.test.ts` (chord helpers,
      grouping, conflicts, fixed chords); the i18n parity tests cover the
      lesson keys.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

215. **Live-QA the install overlay terminal.** ✅ Implemented · 🧪 Awaiting live
    QA. Every one-click install (`runInstallInTab`: Ollama/agent CLI installs,
    the LaTeX/MiKTeX prompt, `gh`/`glab` install + auth login, custom-agent
    install commands) now also opens a centered overlay terminal attached to
    the same root-scope PTY, replacing the open-time toast. Verify: the
    overlay shows the install live and accepts input (a sudo password);
    closing it (×, backdrop, Escape outside the terminal) leaves the install
    running in the root tab and raises the "still running in the root
    terminal" toast; the root tab shows the full output when opened later
    (client buffer + backend replay); closing the root tab while the overlay
    is up takes the overlay down silently; Escape typed into the terminal does
    NOT close the overlay.
    *Files: `src/lib/installCommand.ts`, `src/stores/installOverlay.ts`,
    `src/components/layout/InstallOverlay.tsx`, `src/components/layout/AppShell.tsx`,
    `src/styles/settings-chrome.css`.*
    - [x] 🤖 Automated test — `src/__tests__/InstallOverlay.test.tsx` (tab+PTY
      wiring, attach-only props, close hand-off toast, dead-tab silent close).
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

216. **Live-QA the scheduled agent warm-up (Manage CLIs → Scheduled warm-up).**
    ✅ Implemented · 🧪 Awaiting live QA. An agent CLI's allowance is a window
    that opens on the first message (Claude's is five hours), so this sends one
    `Test` at times the user picks, **in the background** — the CLI's own
    one-shot mode (`claude -p`, `codex exec`, `gemini -p`, …) as a detached,
    windowless process run by `agent_warmup` in `<state_dir>/agent-cron/`, no
    tab, no terminal, no project (it used to type into a Trash agent tab;
    reworked 2026-08-31) — to put the window where they want it. Settings → Manage CLIs carries one card: master switch, a
    global time list, an **All agents** toggle (default off, a bulk flip of the
    per-agent flags), and a **button grid** of every installed agent (the
    file-hiding endings grid — pressed = participates, greyed = no
    non-interactive mode); an agent that is on gets a row below the grid for
    its own times (override the global list) and "Next: 06:00 tomorrow". The scheduler is `AgentCronHost` at the shell —
    main window only, one-minute tick, a 5-minute grace after each slot and
    **never** a late fire, with the fired slots in localStorage so a reload does
    not resend. Verify: the grid buttons press/unpress and the All toggle
    reads on only when every capable agent is on (and one unpress turns it
    off again); agents without a recipe (aider, cline, …) are disabled with
    the reason in their tip; a time two minutes out fires once
    and only once (a `claude -p Test` process appears in `ps` and exits within
    seconds; no tab or window opens; `claude /usage` afterwards shows the
    session window running); a second window (popout) sends nothing; a slot
    missed while the app was closed is skipped, not sent at launch; the chips read in the user's 12/24-hour setting; the panel's warnings
    render for "armed with no times" and "master switch off". Settings ride the
    backend `extra` catch-all, so **no backend restart is needed**.
    *Files: `src/lib/agentCron.ts`, `src/lib/agentCronRun.ts`,
    `src/components/layout/AgentCronHost.tsx`,
    `src/components/layout/SettingsSubPanels.tsx`, `src/styles/header-menus.css`,
    `src/types/index.ts`, `src/lib/i18n.ts` (+ the four dictionaries).*
    - [x] 🤖 Automated test — `src/__tests__/AgentCron.test.ts` (parse/format,
      per-agent override vs. the global list, the three conditions for being
      scheduled, the grace window and the never-fire-late rule, the fired-slot
      key across midnight, next-run, and the config editors).
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

---
