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
    > **DEFERRED (explicit follow-on, NOT this pass):** Phase 3 merged multi-root
    > file tree (`RightPanel.tsx`/`FileTree.tsx`); Phase 4 agent-hint seeding +
    > relation-graph surfacing (dirty-source→dependent git markers,
    > auto-detection). Schema groundwork for both is in place.
    - [x] 🤖 Automated test — `commands/boxes.rs` cargo tests (reconcile drops
      unknown member_ids / recomputes box_id inverse / drop-on-delete, gap-spaced
      position, defaults round-trip, folder-collision suffixing); `paths.rs`
      `boxes_root`; vitest `BoxAssignment` (assign/unassign/move/delete sweep,
      create/rename, derive-on-load no-write), `BoxRendering` (grouped vs inline,
      orphan box_id inline, chip drop ≠ reorder, ungrouped drop), `BoxSearch`
      (is-box row → openBox, members independently searchable). Covers Phase 1 +
      Phase 2 groundwork; Phase 3/4 deferred.
    - [ ] 🖐️ Manual test

---
