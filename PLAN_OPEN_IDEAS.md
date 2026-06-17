# Open Ideas — Grouped & Numbered Implementation Plan

## Context

`open_ideas.md` holds 25 loose ideas spanning the right file-tree panel, the
bottom project switcher, X11/KDE workspace switching, project import/publishing,
git tooling, branding, and session restore. The goal of this plan is **not** to
implement everything at once, but to organize the ideas into coherent groups
with stable numbers so you can say "do #14" and I can act on a well-scoped unit.

Exploration confirmed several ideas are partially built already — those notes are
called out per item so we don't rebuild existing infrastructure.

Numbering is **global and stable** (1–25). Groups are ordered roughly by
suggested sequence (quick wins and prerequisites first), but you can pick any
item in any order.

---

## Group A — Right Panel: File Tree & Navigation ✅ DONE
*Files: `src/components/files/FileTree.tsx`, `fileUtils.ts`, `RightPanel.tsx`, `src/styles/themes.css`. Backend create/delete commands already exist in `commands/projects.rs`.*

1. ✅ **Create file / folder from right-click.** Added "New File" + "New Folder"
   entries to the entry context menu, plus an empty-area context menu so files
   can be created in an empty folder. Both reuse the `window.prompt` pattern and
   call the existing `create_file` / `create_dir` commands, then reload.

2. ✅ **Show long file/folder names in full.** Added a native `title={e.name}` to
   the `.file-name` span so the full name shows on hover (CSS ellipsis kept).

3. ✅ **Show parent folders when inside a subfolder.** Replaced the single
   "↑ .." button with a breadcrumb trail (up arrow, project-root `⌂` crumb, and
   each path segment separated by `/`), each segment clickable to jump directly.

---

## Group B — Right Panel: Git Status Markers ✅ DONE
*Files: `src-tauri/src/commands/git.rs` (`git_file_statuses`), `FileTree.tsx` (`STATUS_COLOR`, `GitMarker`), `fileUtils.ts`.*

4. ✅ **Fix incorrect git colors.** Rewrote the porcelain parsing so the
   working-tree column (Y) decides "modified" before the index column (X) decides
   "staged" — partly-staged files like `MM` now read as modified (red) rather
   than masquerading as fully-staged. Bubbling priority is now
   modified > untracked > staged > unpushed > ignored.

5. ✅ **Richer marker scheme.** `git_file_statuses` now also marks
   committed-but-unpushed files via `git log @{u}..`. Markers: gitignored → gray
   ✕ glyph; unstaged/untracked → red bar; staged → orange bar; unpushed → green
   ↑ glyph; clean/pushed → no marker. (Ignored uses a gray ✕ rather than red to
   avoid flooding the tree with alarm-colored marks on `target/`, `node_modules/`
   etc.; trivially switchable in `STATUS_COLOR`.)

6. ✅ **Show `.gitignore` in the tree.** `visibleEntries` now keeps `.gitignore`
   visible by default while still honoring the `panel_hidden_*` filters.

---

## Group C — Right Panel: Git History & Commit UI ✅ DONE
*Files: `src/components/files/GitHistory.tsx` (new), `RightPanel.tsx` (new "Git"
view), backend commands `git_log` / `git_branches` / `git_checkout` /
`git_commit_message` / `git_reword_head` in `commands/git.rs`.*

7. ✅ **Git history view.** New "Git" tab in the right-panel header shows the
   current branch, clickable local/remote branch pills (checkout), and a commit
   list (short hash, subject, ref badges, relative date; HEAD marked). Backend
   `git_log`, `git_branches`, `git_checkout` added.

8. ✅ **Click a commit → commit-message window.** Clicking a commit opens a modal
   showing its full message. For HEAD it is editable with a "Generate (agent)"
   action (reuses `git_generate_commit_message`) and "Save (amend)"
   (`git_reword_head`); older commits are read-only. A "Checkout" action checks
   out the commit (detached). Full message fetched via `git_commit_message`.

---

## Group D — Bottom Panel: Project Pill polish ✅ DONE
*Files: `src/components/projects/ProjectPill.tsx`, `src/stores/activity.ts` (new),
`src/components/layout/AppShell.tsx`, `BottomBar.tsx`, `src/stores/projects.ts`,
backend `commands/terminal.rs` (`project_cpu_percent`), `commands/projects.rs`
(`set_project_description`), `src-tauri/src/sysstat.rs` (new). Test:
`src/__tests__/PillRunningIndicator.test.ts`.*

9. ✅ **Running-task indicator on pills.** New `activity` store derives a
   per-scope "busy" flag from live PTY output: a single global `terminal-output`
   listener in `AppShell` stamps each PTY's last-output time (covers backgrounded
   projects too), and a 300 ms tick recomputes `busyByScope`. Busy pills show the
   three-dot `OrbitSpinner` tinted green (`.pill-running-spinner`).

10. ✅ **Right-click → change description.** Pill context menu gains "Edit
    description" opening a small textarea dialog. Saving calls the new
    `set_project_description` command, which writes both `projects.json` (the
    pill list) and the project's `project.json`, then mirrors the cleaned value
    into the store.

11. ✅ **Hover → per-project CPU %.** Hover popup now shows live CPU%, polled
    every 1.5 s while open. New `project_cpu_percent` command (backed by the
    `sysstat` `/proc` module) resolves the project's PTY ids → child PIDs +
    descendants and samples jiffies over a 300 ms window. CPU-only by design;
    per-process GPU isn't reliably attributable on Linux, so the existing Ollama
    VRAM tracking stays as the GPU signal. No-op (returns 0) off Linux.

12. ✅ **Suppress default webview reload/inspect on right-click.** The
    `.bottom-bar` container now `preventDefault`s `contextmenu`, so a right-click
    anywhere on the bar surfaces only our pill menu, never Reload/Inspect.

---

## Group E — Bottom Panel: Meta-Project Grouping (new feature)
*Files: data model (`schema/project.rs`/`projects.rs`, `types/index.ts`), `BottomBar.tsx`, `ProjectPill.tsx`. No grouping concept exists today.*

13. **Project boxes / meta-project management.** Right-click to create a named,
    renamable box (e.g. PaperBox, CodingBox) that groups projects, with
    drag-and-drop of pills into boxes. Requires a new grouping field in the
    project/entry schema plus drag-drop UI and grouped rendering. Largest bottom-
    panel item.

---

## Group F — Layout fix
*Files: `src/components/layout/AppShell.tsx`, `RightPanel.tsx`, `themes.css` (z-index/positioning ~366-388, 1489-1660).*

14. **Stop bottom/right panel intersection.** Currently right panel is z-10,
    bottom bar z-25, sharing the bottom-right corner. Make the right panel's
    bottom end sit **above** the bottom bar (inset the right panel so it stops at
    the bottom bar's top edge, or restack) so they no longer overlap.

---

## Group G — Workspace Switching / Platform Stability
*Files: `src-tauri/src/platform/x11.rs`, `wayland_kde.rs`, `null.rs`, `services/window_service.rs`, `services/project_runtime.rs`, `commands/workspace.rs`.*

15. **Securely move opened files/windows to the hidden workspace on switch
    (X11).** Fix the reported issue where files/windows opened in one project
    aren't reliably parked on the hidden desktop when switching. Investigate the
    move-retry logic (x11.rs ~retry 5×30ms) and window registry coverage.

16. **Make X11 workspace switching rock-solid.** Broader hardening of the
    two-desktop parking model — fix all known races/flakiness around
    show/hide/switch. (#15 is a specific symptom of this.)

17. **Preserve window z-order across switches.** Today `show_window` always
    raises to `Above` (x11.rs:120), losing stacking order. Track per-window
    z-order in the window registry/session and restore it on show.

18. **KDE Plasma i3-style workspace mode.** Explore an i3-like tiling/workspace
    behavior on KDE Plasma. Note: KDE Wayland per-window show/hide is currently a
    **no-op** (`wayland_kde.rs:74-80`) and needs KWin scripting first — this is
    research + sizable backend work.

19. **Cross-platform verification: Windows, macOS, KDE Plasma.** Verify the app
    runs and degrades gracefully where workspace backends are absent (null
    backend) and KDE works. Mostly QA + targeted fixes.

---

## Group H — Project Model, Import & Publishing
*Files: `src-tauri/src/commands/projects.rs` (scaffold ~346-393, create ~442-486, import ~501-601), `BottomBar.tsx` create/import dialog, `schema/project.rs`.*

20. **No-scaffold option for import.** `import_project` always calls
    `scaffold_project` (projects.rs:557). Add a checkbox in the import dialog and
    a request flag to skip scaffolding for projects that already have their own
    files.

21. **Rename public/private → local/remote.** The field is a flexible string
    `git_type` (`schema/project.rs:78`) and the UI label is already "Visibility"
    with private/public options (`BottomBar.tsx:1076`). Change options to
    local/remote (keeping public/private as the underlying remote sense) and
    migrate existing values.

22. **"Make repo public" publish check.** Add a flow/check around publishing a
    repo to a remote (e.g. GitHub) — there is **no** GitHub/publish logic in the
    codebase today, so this defines new backend integration. Pairs with #21.

---

## Group I — Git Worktree (new feature)
*No worktree code exists anywhere today.*

23. **Git worktree support.** Add backend commands to create/list/remove git
    worktrees and surface them in the UI (likely tied to Group C history view
    and/or project switching). Net-new feature; scope to be defined when picked.

---

## Group J — Session Restore
*Files: `src-tauri/src/schema/active_session.rs` (defined but unused), `services/project_runtime.rs`, `terminal_service.rs`, `src/stores/tabs.ts`, `CenterPanel.tsx`.*

24. **Restore/resume agent sessions.** Terminal/tab layout persistence already
    exists (`.eldrun/sessions/terminals.json`), but app-startup restore via
    `active_session.json` is **unused**. Wire up restoring the full prior session
    (active project, tabs, windows) on launch. Feasibility note: resuming the
    actual *agent* process state depends on the agent CLI's own resume support;
    realistic scope is restoring tabs + relaunching the agent, not live state.

---

## Group K — Branding ✅ DONE
*Files: `src/assets/logo.svg` (new), `src/components/layout/HeaderBar.tsx`, `src-tauri/icons/*`.*

25. ✅ **Redraw the Eldrun logo in SVG.** Recreated the logo as a clean,
    symmetric vector (`logo.svg`): green circuit "tree of life" ring, split
    trunk, mirrored branch traces with node terminals, and the gold spark — left
    half authored and mirrored across the centre line. Header now imports the SVG
    (`logo.png` removed). OS app icons (`32x32`, `128x128`, `128x128@2x`,
    `icon.ico`, `icon.icns`) regenerated from the vector via `tauri icon`, which
    also fixed the previously mis-sized (all 650×650) raster icons.

---

## Suggested sequencing (optional)

- **Quick wins first:** 1, 2, 3, 6, 10, 12, 20, 25(branding=#25).
- **Then correctness:** 4 → 5, 14, 15/16/17 (X11 stability).
- **Then larger features:** 7 (git history) → 8, 9 (running indicator),
  11 (cpu/gpu), 13 (project boxes), 18 (KDE i3), 22 (publish), 23 (worktree),
  24 (session restore).

## Verification approach (per item, when implemented)

- Frontend changes: `npx tsc --noEmit`, plus existing/added tests under
  `src/__tests__/` (e.g. the session-restore test for Group J).
- Backend changes: `cargo test --manifest-path src-tauri/Cargo.toml`.
- Runtime validation: **do not** launch Eldrun from the agent — ask you to
  restart your running instance to verify workspace/window/UI behavior.

---

*This is an organizational plan. Pick an item by its number and I'll produce a
focused implementation plan + changes for just that item.*
