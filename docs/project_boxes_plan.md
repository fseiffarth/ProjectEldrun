# Project Boxes / Meta-Project Grouping — Implementation Plan (TODO Group A: #13 + #41)

Status: planning artifact for the 4-stage dev team. This document is the contract
for the CODE agent. Read the **Cut Line** section first — it states exactly what to
build this pass and what is an explicit follow-on.

---

## 0. Context discovered during exploration

Key facts that shape this plan (verified against the current tree):

- **Pills use native HTML5 DnD, not the pointer-based gesture.** `ProjectPill.tsx`
  reorders via `draggable` + `onDragStart`/`onDragOver`/`onDrop` with a custom
  MIME type `application/x-eldrun-project` carrying the project id
  (`PILL_DRAG_TYPE`). The "HTML5 DnD is broken on WebKitGTK" memory note applies to
  the **tab** drag system (`stores/drag.ts`, pointer-based), NOT to pills — pill DnD
  already works in the running app via native DnD. **Therefore: reuse the existing
  native pill DnD for "drop pill into box"; do NOT introduce the pointer system for
  pills, and do NOT rewrite pill reorder to pointer.**
- **Persistence model.** `projects.json` (`~/.local/share/eldrun/projects.json`) is
  `Vec<ProjectEntry>` where `ProjectEntry` = `{id,name,status,position,local_file}` +
  `#[serde(flatten)] extra: HashMap<String,Value>`. The frontend mirror
  (`types/index.ts` `ProjectEntry`) has the same named fields + `[key: string]: unknown`.
  Extra keys like `directory`, `git_type`, `description`, `remote` already ride in
  `extra` and surface on the TS object directly. **A new flattened key on the entry is
  the lowest-friction, fully back-compatible way to add grouping.**
- **Saving.** Frontend writes the whole list via `invoke("save_projects", { projects })`
  (`save_projects` in `commands/projects.rs`). `reorderProjects` already does
  read-modify-write of the in-memory list + `save_projects`. Box membership changes
  follow the identical pattern.
- **Scopes.** `stores/tabs.ts` keys tabs by an arbitrary scope string
  (`tabsByScope`, `setScope`). Root uses scope `"root"`, projects use the project id.
  A box can simply be **its own scope** (e.g. the box id) — no new tab machinery
  needed for box-rooted agent tabs.
- **Box folder precedent.** `scaffold_project(&dir)` + `fs::create_dir_all` show the
  established folder-creation idiom. `paths::root_work_dir()` =
  `~/eldrun/root`, `paths::projects_root()` = `~/eldrun/projects`. A box folder slots
  in as `~/eldrun/boxes/<sanitized-name>/` via a new `paths::boxes_root()`.
- **Switcher rendering.** `ProjectSwitcher.tsx` renders `activeProjects` (status !=
  inactive, sorted by position) as a flat `.map` of `<ProjectPill>`. Grouping is a
  pure presentation change over this list plus a new box-chip element.
- **Search.** `results` (memoized) filters inactive projects by name/dir;
  `activateSearchResult` calls `setActive`. Boxes are added as extra result rows.

---

## 1. Phasing and the Cut Line

#41 is genuinely large and spans schema, switcher UI, the file-tree multi-root, the
runtime spawn path, and a relation graph. We phase it so Phase 1 ships #13 in full and
the lowest-risk, highest-leverage #41 groundwork lands in the same pass, while the
heaviest, highest-risk pieces are clearly deferred.

### Phases

- **Phase 1 — #13 foundation (MUST SHIP THIS PASS).**
  Box data model (schema field + a `boxes.json` store), box CRUD (create/rename/
  delete), assign/unassign a project to a box via the existing native pill DnD, and
  grouped pill rendering in the switcher with a box chip + visual distinction.
  Automated tests (vitest + cargo). This is the self-contained, testable unit.

- **Phase 2 — #41 schema groundwork + box folder + opt-in box activation (SHIP THIS
  PASS).**
  Extend the box model with workspace metadata (`folder`, `relations`) — *stored, not
  yet fully surfaced*. Add the `~/eldrun/boxes/<name>/` folder creation (idempotent,
  on box open). Add boxes to the project search results with a distinct look, and make
  "open box" activate a **box scope**: a terminal/agent tab rooted in the box folder.
  Box activation is opt-in (members stay independently searchable/activatable). This
  is mostly additive and low-risk because the box scope reuses the existing scope/tab
  machinery.

- **Phase 3 — DEFERRED (explicit follow-on, do NOT implement this pass): merged
  multi-root file tree.** Right-panel `FileTree.tsx`/`RightPanel.tsx` rendering a box
  as N top-level member roots populated from each member's stored `project.json`
  state. Highest UI risk (touches the most-tested, most-load-bearing panel) and large.

- **Phase 4 — DEFERRED (explicit follow-on): agent-hint seeding + relation-graph
  surfacing.** Seed box agent tabs with pointers to each member's
  CLAUDE.md/AGENTS.md/GEMINI.md and the relation edges; surface relations in the box
  view; tie dirty-source → dependent highlighting into git markers. Relation
  *auto-detection* (scan pyproject/requirements/imports) is a stretch goal even within
  Phase 4.

### Recommended cut line for the CODE agent

**Implement Phase 1 fully + Phase 2.** Defer Phase 3 and Phase 4.

Justification:
- Phase 1 is the named #13 deliverable and is independently shippable/testable.
- Phase 2 is mostly additive: it lands the #41 schema (so we don't re-migrate
  `boxes.json` later), the box folder, and box activation by **reusing the existing
  scope system** — no new tab/runtime subsystem, so the risk is low and it is testable
  without a live app (folder creation + scope-id derivation are unit-testable; box
  search results are vitest-testable).
- Phase 3 (multi-root file tree) is deferred because it rewrites the most heavily
  tested panel (`FileTreeNav`, `HiddenFilesSection`, `GitStatusColors`, etc.) and
  carries real regression risk for a single pass; it deserves its own plan/review/code
  cycle.
- Phase 4 (relation graph + agent hints) depends on Phase 3's box view existing to be
  meaningfully surfaced and is the most speculative; the *schema* for relations lands
  in Phase 2 so the model is forward-stable.

If time is tight within the pass, the safe partial-ship boundary is **"Phase 1 only"**
— it is the must-ship unit. Phase 2 should only be trimmed from the back (drop box
activation/scope, keep schema + folder) rather than left half-done.

---

## 2. Data model (concrete)

### 2.1 Where boxes are persisted

**New file: `~/.local/share/eldrun/boxes.json`**, a `Vec<Box>`. Rationale:

- Keeps `projects.json` byte-compatible for Python rollback (the memory note: unknown
  fields preserved so Python can still read it). A brand-new sibling file is invisible
  to old readers and cannot corrupt the existing list.
- Box identity/metadata (folder, relations, member order) is box-owned, not
  project-owned; a separate file matches that ownership and avoids duplicating box
  metadata across member entries.

**Membership back-reference on the project entry (flattened `extra` key):** add
`box_id: Option<String>` carried in `ProjectEntry.extra` (key `"box_id"`). This makes
"which box is this pill in?" a direct read on the project the switcher already has in
memory, and round-trips through the existing `extra` flatten with zero schema churn on
`projects.json`'s typed fields. The authoritative member list also lives on the box
(`member_ids`); `box_id` on the entry is the denormalized inverse kept in sync by the
same store action. (If the two ever disagree, the box's `member_ids` wins on load.)

### 2.2 Rust — new `src-tauri/src/schema/boxes.rs`

```rust
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A directed relation between two members of a box ("a change in `source` may
/// influence `target`"). Manual declaration is the baseline; auto-detection is a
/// deferred stretch goal (Phase 4).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoxRelation {
    /// Source project id (the one whose change ripples outward).
    pub source: String,
    /// Dependent project id (affected by a change in `source`).
    pub target: String,
    /// Optional relation kind/label, e.g. "python-lib".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Optional path/package hint, e.g. the local-path dep or package name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// One entry in `~/.local/share/eldrun/boxes.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Box {
    pub id: String,
    pub name: String,
    /// Ordered project ids that are members of this box. Authoritative.
    #[serde(default)]
    pub member_ids: Vec<String>,
    /// Ordering position among boxes/pills in the switcher (gap-spaced like
    /// project positions).
    #[serde(default)]
    pub position: i64,
    // ── #41 workspace metadata (Phase 2: stored; Phase 3/4: surfaced) ──
    /// Absolute path to the box folder under `~/eldrun/boxes/<name>/`. Filled in
    /// lazily on first box open (Phase 2). Absent for grouping-only boxes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Directed inter-project relations among members (Phase 2: stored;
    /// Phase 4: surfaced + auto-detected).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relations: Vec<BoxRelation>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

pub type BoxesList = Vec<Box>;
```

Register in `schema/mod.rs`: `pub mod boxes;` + `pub use boxes::{Box, BoxRelation, BoxesList};`.

Note: `Box` collides with `std::boxed::Box` in scope. Use the module path
`schema::boxes::Box` at call sites, or alias as `use crate::schema::boxes::Box as
ProjectBox;` in `commands/boxes.rs`. **Recommendation: name the struct `ProjectBox`**
to avoid the collision entirely while keeping the file `boxes.rs` and JSON file
`boxes.json`. (The plan uses `ProjectBox` from here on.)

### 2.3 TypeScript — `src/types/index.ts`

Keep names in serde-sync with the Rust structs (snake_case fields, no rename
attributes, matching `boxes.json`):

```ts
export interface BoxRelation {
  source: string;
  target: string;
  kind?: string;
  hint?: string;
}

export interface ProjectBox {
  id: string;
  name: string;
  member_ids: string[];
  position: number;
  folder?: string;        // #41 Phase 2
  relations?: BoxRelation[]; // #41 Phase 2 (stored), Phase 4 (surfaced)
}
```

And extend `ProjectEntry` with the denormalized back-reference (already legal via the
index signature, but declare it for type-safety):

```ts
export interface ProjectEntry {
  // ...existing...
  box_id?: string;   // denormalized inverse of ProjectBox.member_ids
}
```

Add a helper alongside `resolveProjectDirectory`:

```ts
export function boxFolderName(name: string): string { /* same sanitize as backend */ }
```

### 2.4 Migration / back-compat

- **No migration of `projects.json` is required.** Old entries simply have no
  `box_id` (→ `undefined`/`None`), meaning "ungrouped" — exactly the legacy behavior.
- **Missing `boxes.json`** → treat as `[]` (mirror `get_projects`'s
  `if !path.exists() { return Ok(vec![]) }`).
- **`#[serde(default)]`** on `member_ids`, `position`, `relations` makes older/partial
  box records (and hand-edited files) deserialize cleanly.
- **Reconciliation on load:** drop `member_ids` referencing unknown project ids, and
  recompute each project's `box_id` from the boxes' `member_ids` so a stale `box_id`
  never wins. This belongs in a small pure helper for unit testing (see tests).

---

## 3. Files to touch (dependency order)

### Phase 1 (#13)

1. **`src-tauri/src/schema/boxes.rs`** (new) — `ProjectBox`, `BoxRelation`,
   `BoxesList` as above.
2. **`src-tauri/src/schema/mod.rs`** — register the module + re-exports.
3. **`src-tauri/src/paths.rs`** — add `pub fn boxes_root() -> PathBuf { home_dir().join("eldrun").join("boxes") }` (+ a unit test mirroring `projects_root`/`root_work_dir`).
4. **`src-tauri/src/commands/boxes.rs`** (new) — Tauri commands (see §4):
   `get_boxes`, `save_boxes`, `create_box`, `rename_box`, `delete_box`,
   `set_box_members`. Plus a private `reconcile(boxes, project_ids)` helper and a
   `sanitize_name` reuse (re-export `projects::sanitize_name` or move it to a shared
   util — prefer reusing `commands::projects::sanitize_name` via `pub(crate)`).
5. **`src-tauri/src/commands/mod.rs`** — `pub mod boxes;`.
6. **`src-tauri/src/lib.rs`** — register the new commands in `generate_handler!`.
7. **`src/types/index.ts`** — `ProjectBox`, `BoxRelation`, `box_id`, `boxFolderName`.
8. **`src/stores/boxes.ts`** (new) — Zustand store mirroring `stores/projects.ts`
   conventions: `boxes`, `load()`, `createBox(name)`, `renameBox(id,name)`,
   `deleteBox(id)`, `assignToBox(projectId, boxId|null)`, `reorderBoxes(...)` (optional
   in P1). `assignToBox` updates the box `member_ids`, sets/clears the project's
   `box_id` in the projects store, and persists both (`save_boxes` + `save_projects`).
9. **`src/components/layout/ProjectSwitcher.tsx`** — grouped rendering: compute
   `boxesById` + bucket `activeProjects` by `box_id`; render a `<BoxChip>` (collapsible)
   wrapping its members' pills, ungrouped pills inline as today. Add a "New box" entry
   to an existing right-click affordance on the switcher (see §6 risk: the switcher
   currently `preventDefault`s contextmenu — add a dedicated control rather than fight
   it). Wire box DnD drop targets.
10. **`src/components/projects/ProjectPill.tsx`** — on `onDragStart`, the pill id is
    already in `dataTransfer` under `PILL_DRAG_TYPE`; no change needed for the *source*.
    Add an optional `boxId` prop so a pill knows its bucket (for unassign DnD out of a
    box). No pointer DnD.
11. **`src/components/projects/BoxChip.tsx`** (new) — the box container element: shows
    box icon/badge + name + member count, accepts pill drops (native DnD, reuse
    `PILL_DRAG_TYPE`), context menu for rename/delete, click to collapse/expand (P1)
    and later "open box" (P2).
12. **`src/styles/themes.css`** — `.project-box-chip`, `.project-box-chip.drag-over`,
    `.project-box-badge`, `.project-box-member-count`, distinct from `.project-pill`.

### Phase 2 (#41 groundwork)

13. **`src-tauri/src/commands/boxes.rs`** — add `ensure_box_folder(box_id)` (creates
    `boxes_root()/<sanitized-name>/`, idempotent, writes the resolved `folder` back into
    `boxes.json`), and `set_box_relations(box_id, relations)` (stores only). Return the
    folder path.
14. **`src/stores/boxes.ts`** — `openBox(boxId)`: ensure folder, then set a **box
    scope** in the tabs store (scope id e.g. `box:<id>`), seed a default shell/agent tab
    rooted in the box folder. Also a `box`-aware `activateBoxSearchResult`.
15. **`src/components/layout/ProjectSwitcher.tsx`** — add boxes to `results`
    (search), with a distinct `.project-search-row.is-box` look; `activateSearchResult`
    branches on box vs project. Members remain independently searchable (opt-in merge).
16. **`src/components/projects/BoxChip.tsx`** — "Open box" action calls
    `openBox`. Visual distinction in the chip header.
17. **`src/styles/themes.css`** — `.project-search-row.is-box` styling.

No Phase 3/4 file changes this pass. (Listed for the follow-on: `FileTree.tsx`,
`RightPanel.tsx`, `services/project_runtime.rs`, agent-hint builder.)

---

## 4. Tauri commands

All in `src-tauri/src/commands/boxes.rs`, registered in `lib.rs` `generate_handler!`
right after the `commands::projects::*` block. They follow the existing
`Result<T, String>` + `storage::read_json`/`write_json` idioms.

Phase 1:

| Command | Args | Returns | Notes |
|---|---|---|---|
| `get_boxes` | — | `Result<BoxesList, String>` | `[]` if file absent; runs `reconcile` against `get_projects` ids in-memory (no surprise write). |
| `save_boxes` | `boxes: BoxesList` | `Result<(), String>` | whole-list write, mirrors `save_projects`. |
| `create_box` | `name: String` | `Result<ProjectBox, String>` | mint uuid (reuse `projects::uuid_v4` via `pub(crate)`), gap-spaced `position`, empty members, append + persist. |
| `rename_box` | `box_id: String, name: String` | `Result<ProjectBox, String>` | rename only; folder rename is **not** done here (folder is derived lazily and a rename after a folder exists is a deferred concern — document it). |
| `delete_box` | `box_id: String` | `Result<(), String>` | remove from list; clearing each member's `box_id` is done frontend-side via `save_projects` (or add an optional sweep here). Does **not** delete the box folder (side-effect safety; see §6). |
| `set_box_members` | `box_id: String, member_ids: Vec<String>` | `Result<ProjectBox, String>` | authoritative membership write. |

Phase 2:

| Command | Args | Returns | Notes |
|---|---|---|---|
| `ensure_box_folder` | `box_id: String` | `Result<String, String>` | `create_dir_all(boxes_root()/sanitize(name))`, persist `folder` into the box, return abs path. Idempotent. |
| `set_box_relations` | `box_id: String, relations: Vec<BoxRelation>` | `Result<ProjectBox, String>` | store only (no surfacing this pass). |

`uuid_v4` and `sanitize_name` currently live in `commands/projects.rs`. Make them
`pub(crate)` (smallest change) and call them from `boxes.rs`, or lift to a shared
`commands/util.rs`. Prefer `pub(crate)` reuse to keep the diff minimal.

---

## 5. Automated tests (satisfies the 🤖 box)

### Frontend — vitest under `src/__tests__/`

- **`BoxAssignment.test.ts`** (Phase 1, store-level, mirrors `ProjectReorder.test.ts`
  with mocked `invoke`):
  - `assignToBox sets box_id on the project, adds it to the box member_ids, and persists via save_boxes + save_projects` — asserts both invoke calls fire with the updated payloads.
  - `assignToBox(null) removes the project from its box and clears box_id`.
  - `deleteBox clears box_id on all former members`.
  - `createBox appends a gap-spaced box and persists`.
  - `renameBox updates the name in store and persists`.
- **`BoxRendering.test.tsx`** (Phase 1, component-level, mirrors
  `ProjectSwitcherContextMenu.test.tsx`):
  - `groups member pills under their BoxChip and renders ungrouped pills inline` — seed projects with/without `box_id` + a box; assert a `.project-box-chip` containing the member pill and a member-count badge, and the ungrouped pill outside any chip.
  - `dropping a pill onto a BoxChip calls assignToBox(projectId, boxId)` — fire a native `drop` with `dataTransfer` carrying `PILL_DRAG_TYPE`; assert the store action.
- **`BoxSearch.test.tsx`** (Phase 2): `box results appear in the search popover with the is-box class and picking one calls openBox` (assert `ensure_box_folder`/scope side via mocked store action).

### Backend — cargo tests in `commands/boxes.rs` (`#[cfg(test)] mod tests`)

- `reconcile_drops_unknown_member_ids` — a box referencing a deleted project id loses it.
- `reconcile_recomputes_box_id_inverse` — given boxes + projects, the derived `box_id` map matches `member_ids` and a stale `box_id` is overridden.
- `create_box_assigns_gap_spaced_position` — first box 10, second 20 (mirrors `next_position`).
- `box_json_roundtrips_with_defaults` — a `ProjectBox` with only `{id,name}` deserializes (member_ids/relations default) and re-serializes without the empty `relations`/`folder` keys (serde skip).
- `boxes_root_path_is_under_eldrun` in `paths.rs` tests — `boxes_root()` ends in `boxes` and its parent is `eldrun` (mirror `root_work_dir` tests).
- Phase 2: `ensure_box_folder_is_idempotent` — calling twice yields the same path and the dir exists (use `tempfile`/override of home as the existing tests do, or test the pure name-derivation if home isn't injectable — check `paths` test seam; the existing `paths` tests inject env via `home_dir_for`, so test the derivation function directly).

Verification commands (must pass; ignore the pre-existing unrelated
`FileViewerPane.tsx` `fileName` errors):
- `npx tsc --noEmit`
- `cargo test --manifest-path src-tauri/Cargo.toml`

---

## 6. Risks & open questions

1. **DnD reuse vs. new gesture (RESOLVED — reuse native).** Pills already use native
   HTML5 DnD with `PILL_DRAG_TYPE`; it works in WebKitGTK for pills today. "Drop pill
   into box" is the same mechanism: `BoxChip` becomes a drop target reading
   `PILL_DRAG_TYPE`. **Do not** port pills to the pointer system, and **do not** assume
   the tab-system WebKitGTK quirk applies here. Open sub-question: dragging a pill *out*
   of a box to the ungrouped area needs an ungrouped drop zone — handle by making the
   ungrouped pill strip a drop target that calls `assignToBox(id, null)`.

2. **Switcher contextmenu is globally suppressed.** `.project-switcher`
   `onContextMenu={(e) => e.preventDefault()}` (and a test asserts it). Adding "New box"
   via right-click on empty bar space would fight that invariant and break
   `ProjectSwitcherContextMenu.test.tsx`. **Decision: add an explicit "New box" control**
   (a small button near `+`, or a "New Box" item in the existing `+` add-menu) rather
   than a bar-level context menu. Box rename/delete live on the `BoxChip`'s own context
   menu (stop-propagation like `ProjectPill`'s menu, which already coexists with the
   suppression).

3. **Back-compat of state files.** New `boxes.json` is invisible to old/Python readers
   (good). `box_id` rides in `extra` and is dropped harmlessly by readers that ignore
   it. The only correctness risk is `box_id`/`member_ids` divergence — mitigated by the
   `reconcile` helper (member_ids authoritative) covered by unit tests. Confirm
   `save_projects` round-trips the new `box_id` extra key (it will, via `flatten`).

4. **Box-folder side effects.** Creating `~/eldrun/boxes/<name>/` is a filesystem
   mutation. Mitigations: (a) create **lazily on first box open (Phase 2)**, never on
   mere grouping (Phase 1 creates nothing on disk); (b) idempotent `create_dir_all`;
   (c) **never delete** the folder on `delete_box` (avoid destroying user data placed in
   a box folder) — document this and consider a future explicit "delete box folder"
   action. Open question: **box rename after a folder exists** — the folder name is
   derived from the box name, so a rename would orphan the old folder. Phase 1/2
   decision: rename updates only the box record; the folder is *resolved once and stored
   in `folder`*, so after first open the stored `folder` path is authoritative and a
   later rename does not move it (documented limitation; a "rename + move folder" is a
   Phase 4 nicety).

5. **Name collisions for the box folder.** Two boxes named "Paper" → same sanitized
   folder. Resolve by suffixing the box id (or a counter) when `boxes_root()/<name>`
   already belongs to a different box; store the chosen path in `folder`. Cover with the
   idempotency test.

6. **Scope id namespace for box activation (Phase 2).** Box scope must not collide with
   project ids (both are uuids) or `"root"`. Use a prefixed scope key (e.g.
   `box:<id>`) so the existing per-scope tab maps stay disjoint. Confirm nothing in
   `tabs.ts` assumes scope == project id (it does not — scope is an opaque string).

7. **Visual distinction (#41).** Box must never be mistaken for a project in the chip,
   the pills, and the search row. Phase 1/2 delivers chip badge + member count + search
   `is-box` class; the right-panel multi-root header is Phase 3 (deferred).

---

## 7. Critical files for implementation

- `src-tauri/src/schema/boxes.rs` (new) — the `ProjectBox`/`BoxRelation` model.
- `src-tauri/src/commands/boxes.rs` (new) — box CRUD + folder/relations commands + reconcile/tests.
- `src/stores/boxes.ts` (new) — box store, `assignToBox`/`openBox`, persistence wiring.
- `src/components/layout/ProjectSwitcher.tsx` — grouped rendering + box search results.
- `src/components/projects/BoxChip.tsx` (new) — box container UI + native-DnD drop target.
