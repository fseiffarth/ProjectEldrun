## Group R — Right Panel: Polish & App-Window Tracking
*Files: `src/components/layout/RightPanel.tsx`, `src/styles/themes.css`,
`src/stores/windows.ts`, backend `commands/apps.rs` + window tracking in
`services/window_service.rs`/`platform/x11.rs`. The pin toggle itself is done
(Group D.13 / #37); these are follow-on polish + a tracking-display bug.*

63. **Pin needle black in dark fancy mode.** The right-panel pin (📌) needle isn't
    legible in the dark "fancy" theme — make it black (or otherwise contrast-fix)
    in that mode.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

64. **[Bug] Right-panel Apps list must drop closed app windows.** A project-opened
    external app appears in the right-panel "Apps" list but doesn't disappear when
    the app/window is closed. Fix the add/remove lifecycle so the list reflects
    live windows. Doubles as a window-tracking test surface: on hover, show the
    entry's window id, monitor id, and z-order.
    Implemented 2026-08-30, **never live-tested**: every launch keeps its `Child`
    and a wait-thread reconciles the registry on exit (hand-offs to an existing
    instance keep a pid-0 delist-only row when their window survives), emitting
    `app-windows-changed` → scoped store refresh; `get_opened_windows` prunes
    dead-pid rows as a backstop; × now **closes** the app via
    `close_tracked_window` (subtree SIGTERM→KILL, untrack fallback for pid-0
    rows); the list is per-scope (merge-refresh store + per-render filter, root/
    box scopes included) and the Apps-view origin set grew `restored`/
    `downloads`/`blob_file_viewer`, kept in step with parking. The hover
    window-id/monitor/z-order debug surface is NOT built.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

65. **Nested-repo git view: remote support.** The right panel's git section now
    auto-detects a nested git repo under the browsed folder (`git_repo_root`) and
    re-roots status/commit/push/history at it, with a toggle back to the project
    repo — but **local projects only**. Extend to remote (SSH) projects: run
    `git rev-parse --show-toplevel` over SSH in `remote_path/rel`, and give
    `remote_target_for_dir` a way to map a nested host toplevel back to the
    project's `RemoteSpec` (currently a directory reverse-lookup that won't match
    a deeper subpath). Related out-of-scope note: per-file tree git markers stay
    project-scoped, not re-rooted per nested repo.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

66. **Share the remaining per-surface probes across file-viewer instances.** The
    same `ProjectFilesView` is mounted many times over at once (right panel, each
    Files (Project) tab, each subwindow's docked file column, main window + every
    popout). The persistent-session list was pulled out into one shared, refcounted
    reading (`src/stores/hostSessions.ts`); the same duplication remains for the
    HPC probes, which are per-project facts held per surface:
    `slurmAvailable(projectDir)` (one SSH round trip per mounted viewer),
    `slurmQueue` (a 7s poll per viewer showing the Jobs view — so a cancel in one
    surface lingers in the others), and `wsAvailable` + `wsList` (two round trips
    per mounted viewer for any project recording a workspace, since the expiry
    banner reads them in *every* view). Move them behind the same
    retain/release + shared-list pattern. Deliberately NOT in scope: the git
    section — `effectiveGitRoot` follows each surface's own browsed folder (nested
    repo detection), so those probes are genuinely per-surface.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

67. **Alerts group in the file viewer.** A collapsible "Alerts" group
    below the file tree in `ProjectFilesView` (so it lands in the right panel and
    every Files (Project) tab alike), merging the three things that can need the
    user *now* into one time-ordered strip: priority-marked mail, calendar entries
    about to start, and to-do cards at or past their due date. **On by default**
    (`files_alerts`, which *is* the group's visibility — the toolbar 🔔 writes it,
    so a close persists rather than returning at the next remount, and the button
    renders either way so the × is never a one-way door), with a lookahead window
    (`files_alerts_days`) and per-source
    opt-outs (`files_alerts_sources`); the mail source stays additionally gated by
    the `mail_client` experimental flag. Reads only the stores that already own
    these rows — `calendar.json`'s events/tasks and the local mail priority index
    — so there is no fourth store and no cached copy of a deadline to go stale.
    Pure selectors in `src/lib/alerts.ts` (clock passed in, so the boundary cases
    are testable), the reads in `useAlertsFeed`, the chrome in `AlertsSection`.
    Implemented 2026-07-29, **never live-tested**.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

68. **Merge the two project searches into the tree's search box.** The toolbar
    "Search" view (`SearchPanel`) duplicated the in-tree search
    (`FileTreeSearch`) with strictly less capability — content-only, no scope,
    no reveal, every hit opened as raw text, and on a remote project it silently
    searched the local mirror. Deleted the view (main toolbar + box member-root
    mini toolbar), extracted the shared pure pieces into
    `src/lib/projectSearch.ts` (`SearchMatch`, `matchParts`, `rankNameMatches`),
    and a remote-source tree now shows a "switch the source to Local to search"
    hint in the box's place instead of nothing. Implemented 2026-08-31.
    Follow-ups, deliberately out of scope: `QuickOpen` (Ctrl+P) is a third
    name-search implementation (true fuzzy, `lib/fuzzy.ts`) that could share
    `list_project_paths` plumbing; a host-side `project_search` over SSH would
    let the Remote source search for real.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

69. **Fold the tree's search away, and move 🔍 / ↻ into the Files/Git/Apps row.**
    The search box + its mode pills cost two permanent rows of every surface that
    renders `FileTree` — worst in the side panel, where they are rows of files
    not shown. Search now starts CLOSED and its chrome lives in the view
    toolbar: `ProjectFilesView` owns the fold (`searchOpen`) and a re-list
    counter (`refreshNonce`), `ProjectFilesPane` forwards both to every tree
    below it (a box's N roots fold as one), and `FileTree` draws neither button
    when a host passes them — so closed, it spends no row at all. The refresh
    button moved up with it: it shared the search row, and leaving it behind
    would have kept that row alive for one button. Closing clears the query (an
    effect on the fold, since the toolbar closes it without calling into the
    tree); Escape clears, then folds. A bare `<FileTree>` with neither prop keeps
    its own inline toggle. Implemented 2026-08-31.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

244. **[Bug] The panel asked its questions in two different chromes.** "New File"
    in the side panel opened `window.prompt()` — which WebKitGTK draws as an
    origin-titled browser alert ("localhost:1420 says" in a dev window, a blank
    system box in a packaged one) — while the rename gesture right next to it
    opened Eldrun's own dialog. Auditing the rest of the panel found the same
    split everywhere: New Folder, New Presentation, the sessions kill/rename,
    the SLURM cancel/watch, the HPC workspace extend and project move, the log
    copy, every destructive git confirm (lockstep resolve, pairing overwrite,
    backup restore, worktree remove/force-remove/lock) and the remarks
    edit/delete.
    `RenameDialog`'s chrome is generalized into
    `src/components/common/PromptDialogs.tsx` — `TextPromptDialog`,
    `ConfirmDialog`, `MessageDialog` on the `.file-delete-dialog` surface, plus a
    `useDialogs()` hook that returns `await`-able versions so a handler that had
    a `window.confirm` in the middle of it keeps its straight-line shape.
    `RenameDialog` is now a thin wrapper over `TextPromptDialog`, so the two can
    no longer drift. Two behaviours come with it: a create that fails keeps the
    dialog open with the typed name and the reason (the native prompt threw both
    away), and the validators that were alerts — a tmux-safe session name, a
    workspace day count — land under the field instead of in a second box.
    A `reset --hard` warning that *lists paths* is also finally readable, since
    the strings' newlines survive (`.file-delete-body`).
    Frontend: `components/common/PromptDialogs.tsx` (new),
    `components/files/{RenameDialog,FileTree,FileBrowser,ProjectFilesView,GitHistory,RemarksPane}.tsx`,
    `styles/file-tree.css`, `lib/i18n.ts` + the four dictionaries.
    Implemented 2026-09-01.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test — in the side panel, right-click the tree background →
      **New File**: an Eldrun dialog opens (accent top rail, "Creating in
      &lt;folder&gt;"), Enter creates, and a name that already exists keeps the
      dialog open with the error under the field. Same for New Folder and New
      Presentation, and in the middle file browser. Then check one confirm
      (Git → a worktree Remove, or Sessions → kill) and one report (Jobs → Copy
      logs): no browser-titled box appears anywhere.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

252. **The side panel forgot which view it was on.** The Files / Git / Apps /
    Agents switcher lived in `ProjectFilesView`'s own state, and the panel
    remounts on both of the things that end a sitting: a project switch (the
    panel is keyed by project id) and a relaunch. So a user working out of Git
    or Agents re-picked it after every switch. The selection now round-trips
    through `settings.side_panel_view` — the panel reads it and writes it back
    on each switch, riding the settings `extra` catch-all like
    `side_panel_edge`, so no backend field was needed. The viewer keeps its own
    copy for the paint (a click shows immediately rather than after the write
    comes back) and folds in the host's value whenever it *changes*, which also
    covers a settings load landing after the panel mounted. A stored view whose
    button this project has no reason to show — Orange/Sessions off a remote
    project, Jobs off a SLURM host, Remarks with the flag off — renders as Files
    without overwriting what is stored, so it returns on a project that has it;
    that also keeps the async SLURM probe from being raced into a room with no
    door out. The Files (Project) tab and the docked subwindow sidebar pass
    neither prop and still open on Files: each is opened for a folder, not
    resumed.
    Frontend: `types/index.ts` (`FilesPanelView`, `Settings.side_panel_view`),
    `components/files/ProjectFilesView.tsx`, `components/layout/SidePanel.tsx`.
    Implemented 2026-09-02, **not live-tested**.
    - [x] 🤖 Automated test — `SidePanelViewMemory`
    - [ ] 🖐️ Manual test — open the side panel, switch to **Git** (or Agents),
      switch to another project and back: the panel is still on that view.
      Quit and relaunch: still there. Then, on a **local** project, confirm the
      panel does not open into a Sessions/Jobs view it has no button for.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
