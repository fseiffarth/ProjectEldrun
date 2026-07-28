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

64. **[Bug] Right-panel Apps list must drop closed app windows.** A project-opened
    external app appears in the right-panel "Apps" list but doesn't disappear when
    the app/window is closed. Fix the add/remove lifecycle so the list reflects
    live windows. Doubles as a window-tracking test surface: on hover, show the
    entry's window id, monitor id, and z-order.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test

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
