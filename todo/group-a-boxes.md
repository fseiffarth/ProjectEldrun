## Group A — Bottom Panel: Meta-Project Grouping (new feature)
*Files: data model (`schema/project.rs`/`projects.rs`, `types/index.ts`), `ProjectSwitcher.tsx`, `ProjectPill.tsx`. No grouping concept exists today.*

13. **Project boxes / meta-project management.** Right-click to create a named,
    renamable box (e.g. PaperBox, CodingBox) that groups projects, with
    drag-and-drop of pills into boxes. Requires a new grouping field in the
    project/entry schema plus drag-drop UI and grouped rendering. Largest bottom-
    panel item.
    > **Phase 1 (#13) DONE (🤖 covered).** Box model (`schema/boxes.rs`
    > `ProjectBox`/`BoxRelation`, `boxes.json`) + box CRUD commands
    > (`commands/boxes.rs`: get/save/create/rename/delete/set_box_members) +
    > native-DnD pill-into-box + ungrouped-drop-zone + grouped pill rendering with
    > a distinct `.project-box-chip` (badge + member count) +
    > `stores/boxes.ts`/`BoxChip.tsx`. `box_id` rides in `ProjectEntry.extra`;
    > member_ids authoritative, `box_id` derived in-memory on load (no write).

41. **Project box containers (merge of two or more projects).** Building on #13,
    let a box be opened as a single *merged* workspace that spans its member
    projects rather than just a pill grouping. Specifics:
    - **Merged file view in the right panel.** Extend the right-panel file tree
      (`FileTree.tsx`/`RightPanel.tsx`) to render a box as a multi-root view —
      each member project listed as a top-level node, populated from that
      project's **stored state** (its `project.json` tree layout / file metadata)
      rather than re-walking only one root. Reuse the existing per-project file
      model so each member keeps its own git markers, hidden-file sections, etc.
    - **A box folder in the eldrun root.** Create a `~/eldrun/boxes/<box-name>/`
      (or similar under the eldrun root) directory per box to host box-scoped
      state and serve as the cwd for the box's terminals/agents.
    - **Agent tabs rooted in the box, hinted to each member.** Start the box's
      agent tabs rooted in the box folder, seeding each agent with hints/pointers
      to every member project's local agent files (`CLAUDE.md`/`AGENTS.md`/
      `GEMINI.md` and paths) so the agent can work across all merged projects
      from one place.
    - **Boxes in the project search (merge is opt-in).** Surface boxes as results
      in the "Search inactive…" box (`ProjectSwitcher.tsx`,
      `activateSearchResult`/`results`) alongside individual projects; picking a
      box result opens the merged box workspace. The merge is **opt-in** — a box's
      member projects stay independently searchable and can each be loaded on
      their own as a normal single project, without activating the box merge.
    - **Visual distinction box vs. single project.** Give boxes a distinct look
      from single projects everywhere they appear — in the search results
      (`project-search-row`), the pills (`ProjectPill.tsx`/`project-switcher`),
      and the right-panel multi-root header — e.g. a box icon/badge, member count,
      and/or a grouped style, so a merged box is never mistaken for a plain
      project. Add the corresponding styles in `themes.css`.
    - **Inter-project relations within a box.** Let a box record directed
      relations between its members — "a change in project A may influence
      project B" — e.g. project B depends on a Python library developed in project
      A, so editing A's library can break/affect B. Model as relation edges in the
      box metadata (source → dependents, with an optional kind/label like
      "python-lib" and an optional path/package hint). Surface them so the
      dependency is visible and actionable: show related members in the box view,
      flag dependents when a source changes (tie into the existing git-status
      markers so a dirty source highlights its dependents), and seed the box's
      agent hints with the relation graph so a cross-project agent knows which
      members a change ripples into. Auto-detection of relations (e.g. scanning
      `pyproject.toml`/`requirements.txt`/imports for local-path deps between
      members) is a stretch goal; manual declaration is the baseline.
    - Schema/model: extends the #13 grouping field with box-as-workspace metadata
      (member list, box folder path, relation edges); touches
      `schema/project.rs`/`projects.rs`, `types/index.ts`, `ProjectSwitcher.tsx`,
      `RightPanel.tsx`/`FileTree.tsx`, and the runtime/spawn path that sets
      agent-tab cwd + env. Scope to be refined when picked.
    > **Phase 2 (#41 groundwork) DONE (🤖 covered):** full box schema stored
    > (`folder`, `relations` via `set_box_relations`), lazy
    > `~/eldrun/boxes/<name>/` creation (`ensure_box_folder`, idempotent +
    > name-collision-safe against reserved `folder`s and on-disk dirs), boxes in
    > the project search (`.project-search-row.is-box`, opt-in — members stay
    > searchable), and opt-in box activation (`openBox` → `box:<id>` scope rooted
    > in the box folder). **Box scopes are session-only this pass** —
    > `switch_project_runtime` does not persist/restore them.
    > **Phase 3 — DONE** (recorded 2026-07-28; the entry said "deferred" long
    > after it shipped): merged multi-root file tree lives in
    > `ProjectFilesPane.tsx:159-230` (`BoxRoot` / `useBoxRoots` /
    > `BoxRootSection`), consumed at `ProjectFilesView.tsx:845` and
    > `RightPanel.tsx:100-102`.
    > **Phase 4 — agent-hint seeding DONE:** `commands/boxes.rs:118-184`
    > (`box_links_block` / `write_box_agent_docs`), `:349`
    > `refresh_box_agent_docs`, registered `lib.rs:711`, called from
    > `src/stores/boxes.ts:165` — the managed CLAUDE/GEMINI/AGENTS link block is
    > regenerated on member change.
    > **Phase 5 — boxes upgrade DONE (2026-08-26, 🤖 covered, untested live):**
    > the "session-only" note above is superseded — `box:<id>` is a first-class
    > persisted scope now (`sessions/box_<id>/terminals.json`, lazy restore +
    > shell seed via `restoreBoxScope`; the spawn gate and `compute_allowed_roots`
    > accept box folder ∪ member roots ∪ remote mirrors, fail-closed on unknown
    > boxes; box tabs pinned `sandbox: false` — v1 trust statement). Membership
    > went **N:M** (per-project `box_id` retired; `addToBox`/`removeFromBox`/
    > `boxProjects`; NO silent one-member dissolve — the box editor's confirmed
    > Dissolve is the only way out). Switcher moved to the **overlay model**
    > (member pills always render, ▣ badge; boxes placed by their own
    > `position`; empty boxes render dimmed). All four box/unbox gestures:
    > pill-menu Boxes group, Ctrl-click multi-select → "Box these…",
    > `BoxEditorDialog` (rename/members/dissolve/trust notice), Alt-drag kept
    > additive. Box folder gains a **member symlink farm** (Unix,
    > `.eldrun-box-links.json` ownership manifest, never clobbers user paths;
    > Eldrun confinement doesn't follow the links). Box "+" menu offers
    > per-member Files/Shell/Claude rows (member-cwd, resume-safe); PDF merge
    > picker is multi-root in a box scope; disconnected remote members gate
    > behind a connect prompt; local box shells get tmux persistence. See
    > `docs/context/project_boxes.md`.
    > **Still deferred:** relation-graph *surfacing* (`set_box_relations` is
    > registered at `lib.rs:712` but has **no frontend caller**; `relations`
    > appears only in `src/types/index.ts:735`), dirty-source→dependent git
    > markers, auto-detection, remote-member mirror fallback in the box file
    > view, box-level sandbox/VM.
    - [x] 🤖 Automated test — `commands/boxes.rs` cargo tests (reconcile drops
      unknown member_ids / recomputes box_id inverse / drop-on-delete, gap-spaced
      position, defaults round-trip, folder-collision suffixing); `paths.rs`
      `boxes_root`; vitest `BoxAssignment` (assign/unassign/move/delete sweep,
      create/rename, derive-on-load no-write), `BoxRendering` (grouped vs inline,
      orphan box_id inline, chip drop ≠ reorder, ungrouped drop), `BoxSearch`
      (is-box row → openBox, members independently searchable). Phase 5 adds:
      cargo `commands::boxes` (box scope ids, allowed-roots table incl. unknown
      box fail-closed, link planner + Unix link-farm suite), `commands::fs`
      (box-scope allowed roots), `services::sandbox` (box never sandboxed);
      vitest `BoxScopePersistence`, rewritten `BoxAssignment`/`BoxRendering`
      (N:M + overlay), `BoxUx` (gestures + editor), `BoxScopeMenus` ("+" menu
      cwds, cross-root paste invoke shape, multi-root merge picker),
      `RightPanelBox` remote gate, `TmuxSessions` box flip.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
    > **Phase 6 — box file-view fixes + per-member line (2026-08-28, 🤖
    > covered, untested live).** Two live-found bugs fixed: (1) cross-project
    > drag-and-drop in the multi-root view moved files *within the source
    > project* to the other project's rel path ("strangely moved" folders) —
    > every `[data-move-rel]` target now carries its tree's identity
    > (`data-move-root`/`data-move-remote`), `lib/fileMove.ts`'s
    > `resolveMoveTarget` routes the drop (cross-root local↔local only; remote
    > either side refuses the target up front), and `move_path` is called with
    > the TARGET root — this also fixes a right-panel drag into another
    > project's Files tab. (2) A remote member had no Remote/Local switch (the
    > "remote-member mirror fallback" deferred above): `BoxRootSection` now
    > shares the project-wide side (`useFileSource`), lists the mirror on
    > Local (browsable while disconnected), and gates only the SFTP side
    > behind the connect prompt. Plus each member root gained its own
    > **Files/Git/Search + ⧉/⚙ + source-switch line** (member-scoped
    > `GitHistory`/`SearchPanel`, per-member `ProjectFilesSettingsDialog`, and
    > the member's own hidden-endings/paths filters now apply in the box view).
    - [x] 🤖 Automated test — vitest `FileMove` (resolveMoveTarget table,
      dest-rel/abs builders, `remoteMemberTreeDir`, source tripwires: every
      `data-move-rel` stamps identity attrs, move commit routes to
      `target.root`, member tree keyed on `treeDir` + `syncSource`); updated
      `SidePanelBox` (Remote side gated + switch stays up while disconnected,
      Local mirror browsable offline); cargo `commands::fs`
      `move_path_moves_a_folder_between_roots`.
    - [ ] 🖐️ Manual test (drag member→member file + folder both directions;
      drag onto a member's breadcrumb; remote member: flip Local/Remote while
      disconnected; per-member Git/Search/⚙ line)
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
    > **Phase 7 — slice membership controls (2026-08-28, 🤖 covered,
    > untested live).** While a Box slice is selected, the switcher's `+`
    > becomes a filterable list of active non-members and each member pill's
    > `×` removes only that membership. Opening a member keeps the slice in
    > membership mode; an open project removed from the Box stays visible as
    > the existing non-member exception, without a Box badge or `×`. Project
    > creation/import and global deactivation remain unchanged in All projects.
    - [x] 🤖 Automated test — vitest `BoxMembershipControls` (candidate
      eligibility/filter/empty state, repeated in-place adds, member removal,
      open non-member exception, and All-project behavior), plus the existing
      `BoxRendering`/`BoxUx` switcher regressions.
    - [ ] 🖐️ Manual test (select a Box, add several projects without reopening
      `+`, remove both an ordinary and a currently open member, then return to All
      projects and confirm the ordinary create/import/deactivate controls)
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

---
