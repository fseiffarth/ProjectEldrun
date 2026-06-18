# ProjectEldrun Plan — Grouped & Numbered Open Ideas

## Context

This is the single home for open implementation plans, organized into coherent
groups with stable numbers. The raw idea dump lives in `open_ideas.md` (29 loose
ideas spanning the right file-tree panel, the bottom project switcher, X11/KDE
workspace switching, project import/publishing, git tooling, drag-and-drop
reordering, remote/SSH projects, branding, and session restore); cross-platform
Windows/macOS follow-ups (#30–#31), backend runtime follow-ups (#32), and the
global-app URI-routing item (#33) were consolidated here from the former separate
plan file and the old `TODO.md`. The goal of this plan is
**not** to implement everything at once, but to organize the ideas into coherent
groups with stable numbers so you can say "do #14" and I can act on a
well-scoped unit.

Exploration confirmed several ideas are partially built already — those notes are
called out per item so we don't rebuild existing infrastructure.

Numbering is **global and stable** (1–35); new ideas are appended with new
numbers so existing references never shift. Open groups are lettered A, B, C…
(roughly in suggested sequence); completed groups are renumbered D.1, D.2… and
collected at the **end** of this file. You can pick any item in any order.

## Status legend — Done ≠ Tested

Three independent axes are tracked per item:

- **✅ Done** — code-complete: written, type-checks (`npx tsc --noEmit`) and/or
  compiles (`cargo test`/`cargo build`). Says nothing about whether it actually
  works.
- **🤖 Automated** — an automated test (vitest under `src/__tests__/` or a Rust
  `cargo test`) exercises the behavior and passes on the current code.
- **🖐️ Manual** — runtime QA in a live Eldrun confirms the behavior by hand.

Each done feature carries two checkboxes — one per verification axis — with an
example test in words to guide both. A feature is fully **🧪 Tested** only when
**both** boxes are ticked.

> ✅ **Automated coverage complete; 🖐️ manual QA still pending.** Every done
> feature below now has a passing automated test (frontend `vitest` +
> backend `cargo test`), so all 🤖 boxes are ticked — the sole exception is
> **#25** (logo/icons), which is purely visual and has no meaningful automated
> test. A few are partial (noted inline): **#11** covers the CPU sampling
> helpers but not the live % readout, and **#22** covers `shell_quote` argv
> escaping but not the full `gh`/`ssh` publish flow. **No 🖐️ Manual box is
> ticked yet** — nothing has been runtime-QA'd in a live Eldrun, so treat each
> feature as fully 🧪 Tested only once its manual box also flips.

---

## Group A — Bottom Panel: Meta-Project Grouping (new feature)
*Files: data model (`schema/project.rs`/`projects.rs`, `types/index.ts`), `BottomBar.tsx`, `ProjectPill.tsx`. No grouping concept exists today.*

13. **Project boxes / meta-project management.** Right-click to create a named,
    renamable box (e.g. PaperBox, CodingBox) that groups projects, with
    drag-and-drop of pills into boxes. Requires a new grouping field in the
    project/entry schema plus drag-drop UI and grouped rendering. Largest bottom-
    panel item.

---

## Group B — Layout fix
*Files: `src/components/layout/AppShell.tsx`, `RightPanel.tsx`, `themes.css` (z-index/positioning ~366-388, 1489-1660).*

14. **Stop bottom/right panel intersection.** Currently right panel is z-10,
    bottom bar z-25, sharing the bottom-right corner. Make the right panel's
    bottom end sit **above** the bottom bar (inset the right panel so it stops at
    the bottom bar's top edge, or restack) so they no longer overlap.

---

## Group C — Workspace Switching / Platform Stability
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
    backend) and KDE works. Mostly QA + targeted fixes. OS-specific build,
    packaging, and native-window work is tracked separately in Group H (#30/#31).

---

## Group E — Git Worktree (new feature)
*No worktree code exists anywhere today.*

23. **Git worktree support.** Add backend commands to create/list/remove git
    worktrees and surface them in the UI (likely tied to Group D.3 history view
    and/or project switching). Net-new feature; scope to be defined when picked.

---

## Group F — Session Restore
*Files: `src-tauri/src/schema/active_session.rs` (defined but unused), `services/project_runtime.rs`, `terminal_service.rs`, `src/stores/tabs.ts`, `CenterPanel.tsx`.*

24. **Restore/resume agent sessions.** Terminal/tab layout persistence already
    exists (`.eldrun/sessions/terminals.json`), but app-startup restore via
    `active_session.json` is **unused**. Wire up restoring the full prior session
    (active project, tabs, windows) on launch. Feasibility note: resuming the
    actual *agent* process state depends on the agent CLI's own resume support;
    realistic scope is restoring tabs + relaunching the agent, not live state.
    Agent-resume approach (migrated from TODO `ISSUE-RESUME`): when restoring a
    tab, detect that tab's most recent agent session ID from the agent's own
    session directory — Claude Code `~/.claude/projects/<encoded>/`, Codex
    `~/.codex/sessions/`, Gemini `~/.gemini/history/`, Vibe
    `$VIBE_HOME/logs/session/` — and pass `--resume <id>` when respawning. A
    prior attempt was removed 2026-06-07 because detection was unreliable and
    **each tab must track its own distinct session ID** (not the project-global
    latest) to work with multi-agent setups; solve per-tab session tracking
    before relying on `--resume`.

---

## Group G — Remote / SSH Projects (new feature)
*Files: `src-tauri/src/schema/project.rs` (project model is local-only:
`directory` is a local path, no host/remote fields), `services/project_runtime.rs`,
`terminal/` (PTY cwd), `commands/projects.rs` (create/import), file-tree
commands. No remote/SSH concept exists today.*

28. ✅ **SSH-based projects (remote path, local agent).** Implemented via an
    **sshfs mount**: a remote project's bytes live on `host:remote_path` and are
    mounted to `~/.local/share/eldrun/mounts/<project-id>/`; the project's
    `directory` points at that mountpoint so the file tree, terminal cwd, and git
    keep working unchanged. New `RemoteSpec` (`user?`, `host`, `port?`,
    `remote_path`) on the project schema + `projects.json` `extra`. New
    `commands/ssh.rs` (`ssh_connect`, `ssh_default_dir`, `ssh_list_dir`,
    `ensure_project_mounted`) shells out to system `ssh` in `BatchMode=yes`
    (keys/agent/`~/.ssh/config` are the source of truth; no in-app passwords).
    New `services/ssh_mount.rs` handles mount/unmount lifecycle (idempotent
    mount, `/proc/mounts` check, `fusermount -u` with `umount` fallback,
    sshfs-missing guard, unmount-all on app exit). `create_project`/
    `import_project` accept an optional `remote` and scaffold over the mount
    (remote import is `keep`-only). `BottomBar.tsx` add/import dialog gains an
    SSH-address field + Connect and an in-app remote folder browser. Active
    remote project is mounted on startup (best-effort, non-blocking) and on
    switch. Requires `sshfs`/FUSE locally. **Runtime QA pending** (agents can't
    launch Eldrun); password/interactive auth out of scope for v1;
    project-removal unmount is a follow-up (no delete command exists yet — stale
    mounts are cleaned up on next app exit). See `docs/ssh_projects_plan.md`.
    - *Test (e.g.):* add a project via SSH address against a key-auth host
      → folder browser lists the remote dir, the project mounts under
      `mounts/<id>/`, terminal cwd + file tree work on the remote files, and the
      mount is cleaned up on app exit.
    - [x] 🤖 Automated test — `services/ssh_mount.rs` unit tests (validate_arg, mountpoint_for, sshfs_args)
    - [ ] 🖐️ Manual test

---

## Group H — Cross-Platform: Windows & macOS Support (new feature)
*Files: `src-tauri/src/platform/*`, `services/`,
`terminal/` (PTY), `commands/` (downloads, crash logging), `src-tauri/tauri.conf.json`
(bundle targets), `.github/workflows/ci-cd.yml` (package jobs). Both OSes already
have cross-platform foundations — platform-aware state paths, default-shell
fallback, browser profile paths, network detection — so this is follow-up work,
not a from-scratch port. Builds on / supersedes the OS half of #19 (Group C).*

30. **Windows support follow-ups.** Windows is past the compile stage (state
    paths, shell fallback, browser profiles, network detection, app-icon
    helpers, NSIS packaging, and a Windows CI package job all exist). Remaining:
    validate a real build/runtime on Win 10 1903+ and Win 11 (incl. ConPTY
    behavior in xterm.js); decide whether to replace the command-based PID
    liveness check with a native Windows API; add native window tracking
    (`EnumWindows` + `GetWindowThreadProcessId`) if project-owned standalone
    windows need reliable show/hide; decide on a Windows unhandled-exception
    crash hook (current crash logging is Unix-oriented); document/improve
    download routing where directory symlinks need Developer Mode or elevation;
    and QA browser download-preference editing across Firefox/Chrome/Chromium/
    Chrome Beta profile layouts.

31. **macOS support follow-ups.** macOS has initial cross-platform code (state
    paths, default shell, browser profiles, network detection, Unix symlinks,
    null workspace-backend fallback). Remaining: add bundle support when
    distribution is needed (`dmg`/`app` target, `minimumSystemVersion`, CI
    artifact handling); add Hardened Runtime entitlements **only** if
    signing/notarization is pursued — do **not** enable App Sandbox (PTY needs
    unrestricted POSIX PTY access); validate a real build on Apple Silicon (and
    Intel if needed); add native app-icon resolution for `.app` bundles if the UI
    needs resolved macOS icons; add native window tracking (Accessibility APIs or
    `CGWindowList`) only if project-owned standalone windows need reliable
    show/hide; and keep the null workspace backend as the default unless a clear
    need justifies Accessibility permissions or private APIs.

---

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
    - Promote `.eldrun/` runtime files from optional mirrors to the primary
      source once compatibility reads from `project.json` are validated.
    - Durable project-window metadata under `.eldrun/sessions/windows.json`
      beyond registry IDs (window role/origin, restore command, optional file
      target, future geometry/focus fields).
    - Move file-navigation runtime state backend-side once switching is stable:
      center file tabs, right-panel folder, breadcrumbs, history.
    - Focused tests for backend runtime switching with mocked services
      (time flushing, old-project save, project-window hide/show, download
      routing, root runtime handling, no respawn of already-live tabs).

---

## Group J — Global Apps: URI Scheme Routing (new feature)
*Files: `src/components/layout/GlobalAppBar.tsx` (roles + launch-or-raise),
`src-tauri/src/commands/apps.rs` (`launch_app`, `open_file`), terminal/file-tree
link handling. The global-apps suite (role registry, launch-or-raise, settings
UI) is already implemented — this is the one remaining global-apps item.*

33. **URI scheme routing** (migrated from TODO `G6.7`). Intercept `http://`,
    `https://`, `mailto:`, and `webcal:` links opened from within terminals or
    the file tree and route them through the global-app launch-or-raise flow
    (`launch_app`, keyed by the `browser` / `mail` / `calendar` roles) instead of
    a bare `xdg-open` call, so links open in the user's configured global app.

---

Sequencing is **group-wise** — tackle whole groups in this order, since items
within a group share files and context:

- **Quick wins next:** B (layout fix — single z-index/positioning change),
  J (URI routing #33 — last remaining global-apps item).
- **Then correctness/stability:** C (X11/KDE workspace switching) — the
  highest-risk area; do #15/#16/#17 together.
- **Then larger features:**
  A (project boxes, builds on the done drag-drop) → E (git worktree) →
  F (session restore) → G (remote/SSH projects, largest net-new backend).
- **Cross-platform (parallel track):** H (Windows #30 / macOS #31 follow-ups) —
  validate builds & packaging per OS; can proceed alongside the above.
- **Backend runtime (ongoing):** I (#32) — backend-owned runtime hardening
  (PTY resurrection, `.eldrun/` promotion, durable window metadata, tests);
  pairs with F (session restore).

## Verification approach (per item, when implemented)

- Frontend changes: `npx tsc --noEmit`, plus existing/added tests under
  `src/__tests__/` (e.g. the session-restore test for Group F).
- Backend changes: `cargo test --manifest-path src-tauri/Cargo.toml`.
- Runtime validation: **do not** launch Eldrun from the agent — ask you to
  restart your running instance to verify workspace/window/UI behavior.

---

# ✅ Done (code-complete) — 🤖 Automated ✅ · 🖐️ Manual pending

Code-complete groups, renumbered D.1, D.2… and kept at the end of the file. Item
numbers stay global and stable. **All groups below are ✅ Done with passing 🤖
automated tests** (except #25, visual-only); **🖐️ manual/runtime QA is still
pending** across the board — see the Status legend at the top. Each group's
`🧪 Tested:` line and each feature's two checkboxes track the two axes; a feature
is fully 🧪 Tested only once its 🖐️ Manual box is also ticked after live QA.

## Group D.1 — Right Panel: File Tree & Navigation ✅ Done · 🧪 Untested
*Files: `src/components/files/FileTree.tsx`, `fileUtils.ts`, `RightPanel.tsx`, `src/styles/themes.css`. Backend create/delete commands already exist in `commands/projects.rs`.*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

1. ✅ **Create file / folder from right-click.** Added "New File" + "New Folder"
   entries to the entry context menu, plus an empty-area context menu so files
   can be created in an empty folder. Both reuse the `window.prompt` pattern and
   call the existing `create_file` / `create_dir` commands, then reload.
   - *Test (e.g.):* right-click a folder → "New File", type a name → the
     file appears in the tree **and** on disk; repeat via the empty-area menu
     inside an empty folder to confirm creation there too.
   - [x] 🤖 Automated test — `FileTreeNav.test.tsx`
   - [ ] 🖐️ Manual test

2. ✅ **Show long file/folder names in full.** Added a native `title={e.name}` to
   the `.file-name` span so the full name shows on hover (CSS ellipsis kept).
   - *Test (e.g.):* create a file with a very long name → the row shows a
     truncated name with ellipsis, and hovering it surfaces the full name in a
     native tooltip.
   - [x] 🤖 Automated test — `FileTreeNav.test.tsx`
   - [ ] 🖐️ Manual test

3. ✅ **Show parent folders when inside a subfolder.** Replaced the single
   "↑ .." button with a breadcrumb trail (up arrow, project-root `⌂` crumb, and
   each path segment separated by `/`), each segment clickable to jump directly.
   - *Test (e.g.):* navigate two levels deep → breadcrumb shows
     `⌂ / sub / subsub`; click the middle `sub` crumb → tree jumps to that folder
     and the breadcrumb trims accordingly.
   - [x] 🤖 Automated test — `FileTreeNav.test.tsx`
   - [ ] 🖐️ Manual test

---

## Group D.2 — Right Panel: Git Status Markers ✅ Done · 🧪 Untested
*Files: `src-tauri/src/commands/git.rs` (`git_file_statuses`), `FileTree.tsx` (`STATUS_COLOR`, `GitMarker`), `fileUtils.ts`.*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

4. ✅ **Fix incorrect git colors.** Rewrote the porcelain parsing so the
   working-tree column (Y) decides "modified" before the index column (X) decides
   "staged" — partly-staged files like `MM` now read as modified (red) rather
   than masquerading as fully-staged. Bubbling priority is now
   modified > untracked > staged > unpushed > ignored.
   - *Test (e.g.):* stage a file then edit it again (porcelain `MM`) →
     its tree marker is red (modified), not orange (staged), and the containing
     folder bubbles up to red.
   - [x] 🤖 Automated test — `GitStatusColors.test.tsx` (STATUS_COLOR mapping)
   - [ ] 🖐️ Manual test

5. ✅ **Richer marker scheme.** `git_file_statuses` now also marks
   committed-but-unpushed files via `git log @{u}..`. Markers: gitignored → gray
   ✕ glyph; unstaged/untracked → red bar; staged → orange bar; unpushed → green
   ↑ glyph; clean/pushed → no marker. (Ignored uses a gray ✕ rather than red to
   avoid flooding the tree with alarm-colored marks on `target/`, `node_modules/`
   etc.; trivially switchable in `STATUS_COLOR`.)
   - *Test (e.g.):* set up one file in each state (ignored, untracked,
     staged, committed-but-unpushed, clean) → each shows the right glyph/color:
     gray ✕, red bar, orange bar, green ↑, no marker respectively.
   - [x] 🤖 Automated test — `GitStatusColors.test.tsx` (STATUS_COLOR mapping)
   - [ ] 🖐️ Manual test

6. ✅ **Show `.gitignore` in the tree.** `visibleEntries` now keeps `.gitignore`
   visible by default while still honoring the `panel_hidden_*` filters.
   - *Test (e.g.):* in a project with a `.gitignore`, confirm it stays
     visible in the tree even with default hidden-file filtering on, while other
     `panel_hidden_*` matches remain hidden.
   - [x] 🤖 Automated test — `GitignoreVisible.test.ts`
   - [ ] 🖐️ Manual test

---

## Group D.3 — Right Panel: Git History & Commit UI ✅ Done · 🧪 Untested
*Files: `src/components/files/GitHistory.tsx` (new), `RightPanel.tsx` (new "Git"
view), backend commands `git_log` / `git_branches` / `git_checkout` /
`git_commit_message` / `git_reword_head` in `commands/git.rs`.*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

7. ✅ **Git history view.** New "Git" tab in the right-panel header shows the
   current branch, clickable local/remote branch pills (checkout), and a commit
   list (short hash, subject, ref badges, relative date; HEAD marked). Backend
   `git_log`, `git_branches`, `git_checkout` added.
   - *Test (e.g.):* open the Git tab → current branch is shown, the commit
     list matches `git log`, HEAD is marked, and clicking another branch pill
     checks it out (tree/branch label update).
   - [x] 🤖 Automated test — `GitHistory.test.tsx`
   - [ ] 🖐️ Manual test

8. ✅ **Click a commit → commit-message window.** Clicking a commit opens a modal
   showing its full message. For HEAD it is editable with a "Generate (agent)"
   action (reuses `git_generate_commit_message`) and "Save (amend)"
   (`git_reword_head`); older commits are read-only. A "Checkout" action checks
   out the commit (detached). Full message fetched via `git_commit_message`.
   - *Test (e.g.):* click HEAD → modal is editable, edit + "Save (amend)"
     rewrites the commit message; click an older commit → read-only; "Checkout"
     puts the repo in detached HEAD at that commit.
   - [x] 🤖 Automated test — `GitHistory.test.tsx`
   - [ ] 🖐️ Manual test

---

## Group D.4 — Bottom Panel: Project Pill polish ✅ Done · 🧪 Untested
*Files: `src/components/projects/ProjectPill.tsx`, `src/stores/activity.ts` (new),
`src/components/layout/AppShell.tsx`, `BottomBar.tsx`, `src/stores/projects.ts`,
backend `commands/terminal.rs` (`project_cpu_percent`), `commands/projects.rs`
(`set_project_description`), `src-tauri/src/sysstat.rs` (new). Test:
`src/__tests__/PillRunningIndicator.test.ts`.*
🧪 Tested: 🤖 automated ✅ (suite green; #11 CPU% core helpers only) · 🖐️ manual ❌ (runtime QA pending)

9. ✅ **Running-task indicator on pills.** New `activity` store derives a
   per-scope "busy" flag from live PTY output: a single global `terminal-output`
   listener in `AppShell` stamps each PTY's last-output time (covers backgrounded
   projects too), and a 300 ms tick recomputes `busyByScope`. Busy pills show the
   three-dot `OrbitSpinner` tinted green (`.pill-running-spinner`).
   - *Test (e.g.):* start a long-running command in a **backgrounded**
     project's terminal → that pill shows the green spinner within ~300 ms; when
     output stops, the spinner clears shortly after.
   - [x] 🤖 Automated test — `PillRunningIndicator.test.ts`
   - [ ] 🖐️ Manual test

10. ✅ **Right-click → change description.** Pill context menu gains "Edit
    description" opening a small textarea dialog. Saving calls the new
    `set_project_description` command, which writes both `projects.json` (the
    pill list) and the project's `project.json`, then mirrors the cleaned value
    into the store.
    - *Test (e.g.):* right-click a pill → "Edit description", save new
      text → both `projects.json` and that project's `project.json` are updated
      on disk and the hover popup shows the new description.
    - [x] 🤖 Automated test — `projects_commands.rs::set_project_description_writes_both_projects_json_and_project_json`
    - [ ] 🖐️ Manual test

11. ✅ **Hover → per-project CPU %.** Hover popup now shows live CPU%, polled
    every 1.5 s while open. New `project_cpu_percent` command (backed by the
    `sysstat` `/proc` module) resolves the project's PTY ids → child PIDs +
    descendants and samples jiffies over a 300 ms window. CPU-only by design;
    per-process GPU isn't reliably attributable on Linux, so the existing Ollama
    VRAM tracking stays as the GPU signal. No-op (returns 0) off Linux.
    - *Test (e.g.):* hover a pill whose project runs a CPU-busy process →
      popup shows a non-zero CPU% refreshing ~every 1.5 s; an idle project reads
      ~0%; on non-Linux it returns 0 without erroring.
    - [x] 🤖 Automated test — *partial:* `sysstat.rs` unit tests (clk_tck, descendant_pids self-inclusion/empty, sum_jiffies live+dead pid); live % readout is manual
    - [ ] 🖐️ Manual test

12. ✅ **Suppress default webview reload/inspect on right-click.** The
    `.bottom-bar` container now `preventDefault`s `contextmenu`, so a right-click
    anywhere on the bar surfaces only our pill menu, never Reload/Inspect.
    - *Test (e.g.):* right-click empty space on the bottom bar and on a
      pill → only the custom menu appears; the default webview Reload/Inspect
      context menu never shows.
    - [x] 🤖 Automated test — `BottomBarContextMenu.test.tsx`
    - [ ] 🖐️ Manual test

---

## Group D.5 — Branding ✅ Done · 🧪 Untested
*Files: `src/assets/logo.svg` (new), `src/components/layout/HeaderBar.tsx`, `src-tauri/icons/*`.*
🧪 Tested: 🤖 automated — N/A (purely visual) · 🖐️ manual ❌ (icons/header not visually verified in a live build)

25. ✅ **Redraw the Eldrun logo in SVG.** Recreated the logo as a clean,
    symmetric vector (`logo.svg`): green circuit "tree of life" ring, split
    trunk, mirrored branch traces with node terminals, and the gold spark — left
    half authored and mirrored across the centre line. Header now imports the SVG
    (`logo.png` removed). OS app icons (`32x32`, `128x128`, `128x128@2x`,
    `icon.ico`, `icon.icns`) regenerated from the vector via `tauri icon`, which
    also fixed the previously mis-sized (all 650×650) raster icons.
    - *Test (e.g.):* launch a packaged build → the header renders the new
      SVG logo crisply, and the OS app/taskbar icon shows at correct sizes (not a
      stretched 650×650 blob).
    - [ ] 🤖 Automated test — *N/A: purely visual; manual only*
    - [ ] 🖐️ Manual test

---

## Group D.6 — Drag & Drop Reordering ✅ Done · 🧪 Untested
*Files: `src/stores/tabs.ts` (already has a `reorder(from, to)` action),
`src/components/layout/CenterPanel.tsx` (tab bar — no drag handlers yet);
`src/stores/projects.ts` (projects carry a `position` field and are sorted by
it, but there is no reorder/persist action), `BottomBar.tsx`/`ProjectPill.tsx`,
backend `save_projects`.*
🧪 Tested: 🤖 automated ✅ (suite green) · 🖐️ manual ❌ (runtime QA pending)

26. ✅ **Drag-and-drop tab reordering.** Tabs in `TabBar.tsx` are now `draggable`
    with HTML5 drag handlers that call `useTabsStore.reorder(from, to)` on drop.
    Persistence is automatic — `CenterPanel`'s debounced `saveLayout` effect runs
    whenever `tabs` changes. Drag feedback via `.tab.dragging` / `.tab.drag-over`.
    - *Test (e.g.):* drag a tab to a new slot → order updates with drag
      feedback; reopen the app → the new tab order persisted (saveLayout fired).
    - [x] 🤖 Automated test — `TabReorder.test.ts`
    - [ ] 🖐️ Manual test

27. ✅ **Drag-and-drop project ordering.** Pills in `ProjectPill.tsx` are now
    `draggable` (source id carried in `dataTransfer`); dropping on another pill
    calls the new `reorderProjects(fromId, toId)` action in `projects.ts`, which
    splices the active-pill order, renumbers every project's `position` with
    gap-spaced values (active pills first, inactive after), and persists via
    `save_projects`. Drag feedback via `.project-pill.drag-over`.
    - *Test (e.g.):* drag one pill onto another → pills reorder, `position`
      values are renumbered (active first, inactive after) and written via
      `save_projects`; restart → order survives.
    - [x] 🤖 Automated test — `ProjectReorder.test.ts`
    - [ ] 🖐️ Manual test

---

## Group D.7 — Right Panel: Hidden Files Section ✅ Done · 🧪 Untested
*Files: `src/components/files/FileTree.tsx` (the `separateScaffold` split at
~426-480 and the "scaffold" `file-tree-section-divider`), `fileUtils.ts`
(`visibleEntries`, `STANDARD_PROJECT_FILES`), `src/styles/themes.css`.*
🧪 Tested: 🤖 automated ✅ (`HiddenFilesSection.test.ts` green) · 🖐️ manual ❌ (runtime QA pending)

29. ✅ **Collapsible hidden-files section under scaffold.** Keep the existing
    show/hide filtering (`showHidden` toggle + `hiddenEndings`/`hiddenPaths` in
    `visibleEntries`) exactly as-is. **Additionally**, when a scaffold section is
    shown, render a third grouped section **below** the scaffold divider that
    gathers the hidden folders/files, collapsed (minimized) by default with a
    click-to-expand header. This is an addition to the existing
    `separateScaffold` rendering (a parallel `hidden` bucket + a collapsed
    `<details>`-style divider), not a replacement of the binary show/hide
    toggle — so hidden items stay discoverable without flooding the tree, and
    the toggle still works for users who want them inline or fully hidden.
    - *Test (e.g.):* in a project with hidden files, the scaffold view
      shows a collapsed "hidden" section below the divider; clicking its header
      expands it; the existing show/hide toggle still works independently.
    - [x] 🤖 Automated test — `HiddenFilesSection.test.ts`
    - [ ] 🖐️ Manual test

---

## Group D.8 — Right Panel: Persist Script-Run Animation ✅ Done · 🧪 Untested
*Files: `src/components/files/FileTree.tsx` (`runningScripts` state + the
`script-finished` listener at ~136, `runShellScript`, `.file-run-spinner`),
`src/components/layout/RightPanel.tsx` (renders `<FileTree>` only `{open && …}`).
Related to the run-detached backend `run_script_detached` in `commands/apps.rs`.*
🧪 Tested: 🤖 automated ✅ (`ScriptRunState.test.ts` green) · 🖐️ manual ❌ (runtime QA pending)

34. ✅ **Keep the `.sh` run animation alive when the right panel hides.** Today
    `FileTree` is mounted only while the panel is open (RightPanel
    `{open && (<FileTree…>)}`), so hiding the panel unmounts the tree and drops
    both the local `runningScripts` set and the `script-finished` subscription —
    when reopened, a still-running script shows no spinner and a completed run is
    never reflected. Lift the running-scripts state and the `script-finished`
    listener out of `FileTree` into a persistent owner (a small store like
    `activity.ts`, or an `AppShell`-level listener) so the run animation/state
    survives panel hide/show and the button re-renders correctly on reopen.
    - *Test (e.g.):* run a long `.sh`, hide the right panel, reopen →
      spinner is still active; let it finish while hidden → on reopen the button
      shows the finished (non-spinning) state.
    - [x] 🤖 Automated test — `ScriptRunState.test.ts`
    - [ ] 🖐️ Manual test

---

## Group D.9 — Center Panel: Free Tab Arrangement / Grid View ✅ Done · 🧪 Untested
*Files: `src/stores/tabs.ts` (`gridByScope` + `grid` mirror + `toggleGrid`),
`src/components/layout/CenterPanel.tsx` (pane-wrapper render + grid layout),
`src/components/terminal/TerminalView.tsx` (`visible`/`focused` props),
`src/components/tabs/TabBar.tsx` (grid-toggle button), `src/styles/themes.css`
(`.center-pane`, `.center-panel.grid-mode`, `.tab-grid-btn`). Test:
`src/__tests__/GridView.test.ts`.*
🧪 Tested: 🤖 automated ✅ (`GridView.test.ts` green) · 🖐️ manual ❌ (runtime QA pending)

35. ✅ **Free arrangement of tabs / grid view.** Added a per-scope grid mode to
    the tabs store (`gridByScope` + `toggleGrid`, restored by `setScope`). A
    grid-toggle button in the tab bar (enabled once a scope has ≥2 tabs) flips
    the current project between the single-active-tab view and a grid that lays
    every pane of that scope out at once (columns = `ceil(sqrt(n))`, equal
    rows). `CenterPanel` now wraps each tab in a `.center-pane`: in single mode
    panes stack absolutely with only the active one shown; in grid mode the
    current scope's panes become CSS-grid items. `TerminalView`'s old `active`
    prop was split into `visible` (drives display + an xterm `fit()`/`pty_resize`
    on show, with the container `ResizeObserver` handling cell-geometry changes)
    and `focused` (keyboard focus + accent outline). All scopes stay mounted so
    PTYs are never killed; clicking a pane in grid mode focuses its tab.
    - *Test (e.g.):* with ≥2 tabs, click the grid toggle → all panes show
      at once in a `ceil(sqrt(n))`-column grid; output keeps streaming (PTYs
      alive); clicking a pane focuses its tab; toggling back returns to single view.
    - [x] 🤖 Automated test — `GridView.test.ts`
    - [ ] 🖐️ Manual test

---

## Group D.10 — Project Model, Import & Publishing ✅ Done · 🧪 Untested
*Files: `src-tauri/src/commands/projects.rs` (`normalize_git_type`,
`ImportProjectRequest.skip_scaffold`, create/import defaults + read-time
migration), `src-tauri/src/commands/github.rs` (new `github_publish`),
`lib.rs`/`commands/mod.rs` (registration), `BottomBar.tsx` (push-target select +
skip-scaffold checkbox), `ProjectPill.tsx` (Publish window + menu),
`src/stores/projects.ts` (`publishProject`), `src/types/index.ts`,
`themes.css` (`.skip-scaffold-row`). Tests: `projects_commands.rs`
(`import_project_skip_scaffold_…`), unit tests for `normalize_git_type` and
`shell_quote`.*
🧪 Tested: 🤖 automated ✅ (suite green; #22 publish = shell_quote only) · 🖐️ manual ❌ (`github_publish` runtime QA pending)

20. ✅ **No-scaffold option for import.** `ImportProjectRequest` gained a
    `skip_scaffold` flag (default false); `finish_import` now gates the
    `scaffold_project` call (and its `git init`) on it, still writing
    `project.json` so the project registers. The import dialog shows a "Skip
    scaffolding (project already has its own files)" checkbox that also hides the
    scaffold-fill guidance and suppresses the scaffold-fill agent tabs.
    - *Test (e.g.):* import an existing repo with "Skip scaffolding"
      checked → no `AGENTS.md`/`CLAUDE.md`/etc. added and no `git init`, but
      `project.json` is written so it registers (cf. `import_project_skip_scaffold_…`).
    - [x] 🤖 Automated test — `projects_commands.rs::import_project_skip_scaffold_does_not_add_missing_scaffold_files`
    - [ ] 🖐️ Manual test

21. ✅ **Rename public/private → local/remote (push-target axis).** `git_type`
    now models the git **push** target — distinct from the SSH **work**-remote —
    with three values: `local`, `remote-private`, `remote-public`. New projects
    default to `local`. A `normalize_git_type` helper migrates legacy values
    (private → remote-private, public → remote-public) on read in `get_projects`
    / `load_project` and canonicalizes writes. The dialog's "Git push target"
    select offers the three options.
    - *Test (e.g.):* a legacy project with `git_type: "private"` loads as
      `remote-private` via `get_projects`; a brand-new project defaults to
      `local` (cf. the `normalize_git_type` unit test).
    - [x] 🤖 Automated test — `commands/projects.rs` normalize_git_type unit tests
    - [ ] 🖐️ Manual test

22. ✅ **"Make repo public" publish flow.** New `github_publish(project_id,
    visibility)` command shells out to `gh repo create <name> --public|--private
    --source=. --remote=origin --push`. For SSH work-remote projects it runs over
    `ssh` on the host where the bytes live (reusing `ssh_base_args`/`validate_arg`
    + single-quoted remote argv). On success it records `git_type =
    remote-<visibility>` in both `projects.json` and `project.json`. Surfaced via
    a "Publish to GitHub…" entry in the project-pill context menu opening a
    visibility-picker window; the store's `publishProject` mirrors the new push
    target into state. Requires `gh` installed + authenticated. **Runtime QA
    pending** (agents can't launch Eldrun).
    - *Test (e.g.):* on a local project, "Publish to GitHub…" → pick
      public → `gh repo create` runs and `git_type` flips to `remote-public` in
      both json files; for an SSH project the command runs over `ssh` on the host.
    - [x] 🤖 Automated test — *partial:* `commands/github.rs` shell_quote unit tests (argv escaping only; full gh/ssh publish flow is manual)
    - [ ] 🖐️ Manual test

*This is an organizational plan. Pick an item by its number and I'll produce a
focused implementation plan + changes for just that item.*
