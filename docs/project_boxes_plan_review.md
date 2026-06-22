# Plan Review — Project Boxes / Meta-Project Grouping (TODO Group A: #13 + #41)

Reviewer: PLAN-REVIEW agent. Reviews `docs/project_boxes_plan.md` against the live
tree. Verdict at the bottom.

Verification baseline (confirmed in-tree, so the plan rests on solid ground):
- Pills DO use native HTML5 DnD with `PILL_DRAG_TYPE = "application/x-eldrun-project"`
  (`src/components/projects/ProjectPill.tsx:20,395,399-419`). The tab pointer system
  lives in `src/stores/drag.ts` and carries no `PILL_DRAG_TYPE` — confirming the plan's
  claim that the WebKitGTK HTML5-DnD quirk applies to tabs, not pills. Reuse is safe.
- The switcher globally suppresses contextmenu: `.project-switcher`
  `onContextMenu={(e) => e.preventDefault()}` (`ProjectSwitcher.tsx:291`), asserted by
  `src/__tests__/ProjectSwitcherContextMenu.test.tsx`.
- Persistence: `ProjectEntry` has `#[serde(flatten)] extra: HashMap<String, Value>`
  (`schema/projects.rs:17`) and the TS mirror has `[key: string]: unknown`
  (`types/index.ts:51`); `directory`/`git_type`/`remote` already ride in `extra`
  (`commands/projects.rs:847-869`). A flattened `box_id` is consistent and back-compatible.
- `get_projects` returns `Ok(vec![])` when the file is absent (`commands/projects.rs:21-23`);
  `save_projects` is a whole-list write (`:57-60`). `reorderProjects` is read-modify-write +
  `save_projects` (`stores/projects.ts:224-259`). The box store mirroring this is sound.
- `sanitize_name` is already `pub(crate)` (`commands/projects.rs:890`) — reuse is a no-op,
  not a visibility change.
- `paths.rs` exposes `home_dir()`, `projects_root()`, `root_work_dir()` and an injectable
  `home_dir_for(OsKind, env)` test seam; storage `state_dir()`, `read_json`/`write_json`
  (which `create_dir_all` the parent) are all as described.
- `generate_handler!` is a flat comma-list grouped by comment headers
  (`lib.rs:190-303`); adding a `// Project boxes` block after the projects block fits.

---

## Findings

### [BLOCKER] B1 — `uuid_v4` is private, not `pub(crate)`; the "reuse via pub(crate)" claim is wrong for it.
Plan §3.4 and §4 say "mint uuid (reuse `projects::uuid_v4` via `pub(crate)`)" and treat
`uuid_v4` and `sanitize_name` symmetrically. But in the tree:
- `sanitize_name` is already `pub(crate)` (`commands/projects.rs:890`) — fine.
- `uuid_v4` is a bare private `fn uuid_v4()` (`commands/projects.rs:1066`), NOT `pub(crate)`.
Calling it from `commands/boxes.rs` will not compile until its visibility is raised.
Also note `uuid_v4()` is time-based (nanos): two boxes created in the same process within
the same nanosecond tick would collide. For boxes minted back-to-back in a loop/test this
is a real (if rare) risk that project ids mostly dodge because creation is user-paced.
**Fix:** explicitly raise `uuid_v4` to `pub(crate)` as a named step in the file list (don't
bury it under "reuse"). Recommend the code agent add a uniqueness guard (e.g. re-mint if the
new id already exists in the boxes list) or document that box creation is user-paced. The
backend tests that create two boxes (`create_box_assigns_gap_spaced_position`) should create
them via the command path, not by hand-calling `uuid_v4` twice in a tight loop, or they may
flake.

### [BLOCKER] B2 — `get_boxes` "runs reconcile against get_projects ids" double-reads and risks divergence; the reconcile contract is under-specified.
Plan §2.4 and §4 say `get_boxes` reconciles against project ids "in-memory (no surprise
write)" but also that "the box's `member_ids` wins on load" and recomputes each project's
`box_id`. Two concrete problems:
1. `box_id` lives in `projects.json`, which `get_boxes` does not own or write. If `get_boxes`
   only returns boxes, it cannot "recompute each project's `box_id`" — that recompute must
   happen frontend-side after BOTH `get_boxes` and `get_projects` resolve, or in a dedicated
   step. The plan conflates a pure Rust `reconcile(boxes, project_ids) -> boxes` (drops dead
   member ids) with a cross-file `box_id` rewrite. Only the former is a pure unit-testable
   helper; the latter is store-level glue.
2. The "member_ids wins, stale box_id overridden" rule needs a definite home. Nothing today
   calls `get_boxes`; the box store's `load()` must (a) call `get_boxes`, (b) read the already
   loaded `projects`, (c) derive `box_id` per project from `member_ids`, (d) and decide whether
   to persist the corrected `box_id` back (a write on load — which the plan elsewhere says to
   avoid). 
**Fix:** Split the contract explicitly: a pure `reconcile_member_ids(boxes, &project_ids) ->
boxes` in Rust (the one the cargo tests target), and a separate frontend `load()` that derives
`box_id` from `member_ids` into in-memory state WITHOUT writing on load (write only on the next
mutating action). State this division in §2.4 and §4 so the code agent doesn't try to mutate
`projects.json` inside `get_boxes`. The named test `reconcile_recomputes_box_id_inverse` should
test the pure id-map derivation, not a file write.

### [SHOULD-FIX] S1 — `delete_box` leaves `box_id` dangling unless the frontend sweep is mandatory, not "optional".
§4's `delete_box` row says clearing members' `box_id` is "done frontend-side via `save_projects`
(or add an optional sweep here)." If the frontend store action forgets the sweep, deleted-box
members keep a `box_id` pointing at a now-nonexistent box. The reconcile rule (member_ids wins)
saves rendering — an orphan `box_id` with no matching box bucket should render ungrouped — but
only if the bucketing code treats "box_id present but no such box" as ungrouped. 
**Fix:** Make the member `box_id` clear a REQUIRED step of `deleteBox` in the store (not
optional), AND make the switcher bucketing fall back to ungrouped when `boxesById[box_id]` is
missing. Add a vitest assertion: `deleteBox clears box_id on all former members` (already named
in §5 — good; make it load-bearing, i.e. assert the `save_projects` payload too) and a render
test that an orphaned `box_id` renders inline.

### [SHOULD-FIX] S2 — Box rename vs. stored `folder` is a genuine inconsistency the plan accepts but the search/grouping UI will expose.
§6.4 decides rename updates only the box record; once `folder` is resolved it is authoritative
and a later rename does not move it. That is defensible, but note a second-order effect the plan
doesn't: name-derived folder collision resolution (§6.5) suffixes the id only when the folder is
first created. If a box is renamed to collide with another box's name BEFORE either has a folder,
both will derive the same `boxes_root()/<name>` on first open, and the collision check must
compare against folders already claimed by OTHER boxes in `boxes.json`, not just on-disk
existence (an unopened box has no dir yet but may have a reserved name). 
**Fix:** Make `ensure_box_folder` resolve collisions against the set of `folder` values already
stored in `boxes.json` (reserved-but-maybe-not-yet-created), in addition to on-disk existence.
The idempotency test should cover "two boxes, same name, second open gets a suffixed path."

### [SHOULD-FIX] S3 — Nesting a BoxChip with its members' pills inside the horizontal `.project-pills-scroll` strip needs a layout/DnD story the plan doesn't give.
`ProjectSwitcher.tsx:347-358` renders pills as a flat `.map` inside a single
`.project-pills-scroll` flex row that also drives edge-fade + wheel-to-horizontal-scroll
(`:211-245`) keyed on `activeProjects.length`. Dropping a collapsible `<BoxChip>` wrapper into
that row changes its flex children and DOM shape. Two risks: (a) the overflow/wheel effect keys
on `activeProjects.length`, which won't change when membership moves between a box and ungrouped,
so the edge-fade may go stale after a regroup; (b) a pill INSIDE a BoxChip is still `draggable`
with `PILL_DRAG_TYPE`, and the BoxChip is also a drop target for the same type — `onDrop`
handlers can both fire / bubble, so the BoxChip drop and an inner-pill reorder drop can race
without `stopPropagation` discipline.
**Fix:** Add to the plan: (1) the overflow effect dependency must include box membership (e.g.
key on a serialized bucket signature, not just `activeProjects.length`); (2) specify
`stopPropagation` on the BoxChip's `onDrop`/`onDragOver` and define precedence (drop on chip
background = assign-to-box; drop on an inner pill = reorder within), mirroring how
`ProjectPill`'s context menu already coexists with the bar-level suppression via
`stopPropagation`. The `BoxRendering.test.tsx` "dropping a pill onto a BoxChip" case should
assert the inner reorder is NOT also triggered.

### [SHOULD-FIX] S4 — Ungrouped drop zone for "drag a pill out of a box" is named as an open sub-question but not assigned to a file/step.
§6.1 correctly identifies that dragging a pill out of a box needs an ungrouped drop target
calling `assignToBox(id, null)`, but the Phase-1 file list (§3) never assigns this to a concrete
element. As written, a code agent could ship box assignment with no way to un-assign via DnD
(only via delete or context menu).
**Fix:** Add a concrete step: make the ungrouped pill strip (or a dedicated "ungrouped" drop
region) a `PILL_DRAG_TYPE` drop target in `ProjectSwitcher.tsx` that calls
`assignToBox(fromId, null)`. Add the corresponding vitest case.

### [SHOULD-FIX] S5 — `Box` vs `ProjectBox` naming is left half-resolved in the schema snippet.
§2.2 ships a Rust snippet declaring `pub struct Box`, then a Note recommends renaming to
`ProjectBox` and says "the plan uses `ProjectBox` from here on." The re-export line in the same
section still says `pub use boxes::{Box, BoxRelation, BoxesList};`. A code agent copying the
snippet verbatim gets `Box` (shadowing `std::boxed::Box` inside `boxes.rs`, which is usable but
error-prone) and a re-export that won't match the renamed struct.
**Fix:** Make the snippet and the re-export both use `ProjectBox` (and `BoxesList = Vec<ProjectBox>`)
so there is exactly one name. Keep file `boxes.rs` / json `boxes.json`. This also keeps the TS
`ProjectBox` interface (§2.3) in serde-sync.

### [NIT] N1 — `BoxRelation`/`Box` deriving only `Serialize/Deserialize` is fine, but tests need `PartialEq`.
The named cargo tests (`reconcile_drops_unknown_member_ids`, `box_json_roundtrips_with_defaults`)
will want to assert equality on `ProjectBox`/`BoxRelation`. The struct derives in §2.2 omit
`PartialEq`. **Fix:** add `PartialEq` (and `Default` if `box_json_roundtrips_with_defaults` builds
a partial value) to the derives, matching the assert-heavy test style elsewhere.

### [NIT] N2 — `box_json_roundtrips_with_defaults` over-claims serde skip on `folder`.
§5 says a `{id,name}`-only box "re-serializes without the empty `relations`/`folder` keys."
`relations` has `skip_serializing_if = "Vec::is_empty"` (will skip) and `folder` has
`skip_serializing_if = "Option::is_none"` (will skip) — correct — but `member_ids` has only
`#[serde(default)]` with NO skip, so an empty `member_ids: []` WILL serialize. The test assertion
should expect `member_ids: []` present, `folder`/`relations` absent. **Fix:** adjust the test
expectation, or add `skip_serializing_if = "Vec::is_empty"` to `member_ids` too (and decide
which — persisting `[]` is arguably clearer).

### [NIT] N3 — Search-result `ProjectEntry`-typed `activateSearchResult` signature change not flagged.
§3 Phase 2 says `activateSearchResult` "branches on box vs project," but today its signature is
`(project: ProjectEntry)` (`ProjectSwitcher.tsx:247`) and `results` is `ProjectEntry[]`. Mixing
boxes in means a discriminated union for results and a signature change. Minor, but the plan
should name it so the code agent doesn't try to cram a box into a `ProjectEntry`. **Fix:** note
the union type for search rows (`{kind:'project',...}|{kind:'box',...}`) in §3 Phase 2.

---

## Scope / cut-line assessment

The Phase 1 + Phase 2 cut is coherent and the "Phase 1 only" fallback is a real, shippable
boundary — good. Phase 3 (multi-root file tree) is correctly deferred: it touches the most
heavily tested panel (`FileTreeNav`, `HiddenFilesSection`, `GitStatusColors`,
`GitignoreVisible`, etc. all exist under `src/__tests__/`) and is the largest regression
surface. No objection to the phasing itself.

One scope caution: Phase 2's "box activation = box scope + seed a shell/agent tab rooted in the
box folder" (§3.14 `openBox`) is described as low-risk "reuse the scope system," but it actually
reaches into `useTabsStore.setScope` + `addTab` and the `switch_project_runtime` /
`project-runtime-switched` machinery that is currently keyed on project id ↔ `"root"`
(`stores/projects.ts:343-378`, which maps `payload.projectId ?? "root"`). A `box:<id>` scope is
disjoint for the in-memory tab maps (confirmed: scope is an opaque string), BUT box scopes are
NOT persisted/restored by `switch_project_runtime` (which only knows projects + root), so a box's
tabs will silently vanish on project switch / restart. That's acceptable for a Phase-2 "stored,
not fully surfaced" cut, but the plan should state it as a known limitation rather than implying
box activation behaves like a project. If `openBox` is the part trimmed under time pressure
(§1 already allows trimming box activation from the back), nothing else in Phase 2 depends on it.

---

## Verdict

**Approve with fixes.** The plan is well-grounded — its core factual claims about pill DnD,
contextmenu suppression, `extra`-flatten persistence, back-compat, and command conventions all
check out against the tree. No claim is fatally wrong. But two blockers (a private `uuid_v4`
that won't compile as described, and a conflated `get_boxes`/reconcile/`box_id`-rewrite contract
that crosses two state files) must be resolved before coding, plus several should-fixes that
close real gaps (un-assign DnD target, delete sweep, BoxChip drop precedence, folder-collision
reservation).

### Punch-list for the CODE agent (in order)
1. (B1) Raise `commands::projects::uuid_v4` to `pub(crate)` as an explicit step; add a
   uniqueness guard or ensure box-creating tests go through the command path, not raw double-mint.
2. (B2) Split the reconcile contract: pure Rust `reconcile_member_ids(boxes, &project_ids)`
   (drops dead ids; the cargo test target) vs. frontend `load()` deriving `box_id` from
   `member_ids` in-memory with NO write-on-load. `get_boxes` must not touch `projects.json`.
3. (S5) Use `ProjectBox` consistently in the schema snippet AND the `pub use` re-export;
   `BoxesList = Vec<ProjectBox>`.
4. (S1) Make `deleteBox`'s member-`box_id` clear REQUIRED, and make switcher bucketing treat a
   `box_id` with no matching box as ungrouped.
5. (S3) Box membership must drive the overflow/edge-fade effect dependency (not just
   `activeProjects.length`); give BoxChip drop/dragover `stopPropagation` with defined precedence
   over inner-pill reorder.
6. (S4) Add a concrete ungrouped drop target calling `assignToBox(id, null)` + its vitest case.
7. (S2) `ensure_box_folder` resolves name collisions against stored `folder` values in
   `boxes.json` (reserved), not only on-disk existence.
8. (N1) Add `PartialEq` (+ `Default` where needed) to `ProjectBox`/`BoxRelation` derives.
9. (N2) Fix `box_json_roundtrips_with_defaults` expectation (`member_ids: []` serializes unless
   you add `skip_serializing_if`).
10. (N3) Type search rows as a project|box union; note `activateSearchResult` signature change.
11. (scope) Document that `box:<id>` scopes are not persisted/restored by
   `switch_project_runtime` — box tabs are session-only this pass.
