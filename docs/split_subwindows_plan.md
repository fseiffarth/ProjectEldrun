# Split Subwindows — Design Contract

> **Status: implemented** (TODO Group D.11 / #36). All four agents complete;
> `npx tsc --noEmit` clean, `npx vitest run` green (85 tests incl.
> `SplitLayout.test.ts`), `cargo test`/`cargo build` green.
>
> Deviations / notes from the contract as built:
> - **Measured-rect pane positioning:** `CenterPanel` renders each `GroupNode`
>   as an empty *measured* body slot (`.subwindow-pane-slot`) and overlays the
>   active pane from a single flat `.pane-layer` positioned to that slot's
>   measured rect (via a `ResizeObserver` + `useLayoutEffect`). This keeps every
>   PTY across every scope mounted while the tree re-tiles, rather than mounting
>   panes inside the tree.
> - **projects.ts threads `tabGroups`:** project switch serializes the live tree
>   with the store's exported `serializeTree` (shared with `saveLayout`, no
>   duplicate serializer) so the switch snapshot and on-disk `tab_groups` agree.
> - **Old auto-grid removed:** `grid`/`gridByScope`/`toggleGrid`/`setGrid` and the
>   ▦ button are gone; `GridView.test.ts` asserts their removal.
> - **Backend rebuild required** for `tab_groups` persistence to take effect
>   (Rust changes; per CLAUDE.md, agents do not launch Eldrun).

Goal: rework the center panel from "one global tab bar (in the header) + an
auto-grid of bare terminal panes" into a **tiling layout of subwindows**, where:

- Each **subwindow** (a.k.a. *group*) owns a set of tabs and renders **its own
  tab bar** at its top.
- **Dragging a tab** from one subwindow's tab bar and dropping it:
  - onto another subwindow's **tab bar / center** → moves the tab into that group;
  - onto a subwindow's **edge zone** (left / right / top / bottom) → splits that
    direction, creating a **new subwindow** containing the dragged tab.
- Splits are **resizable** via draggable dividers (VS Code editor-group style).
- The global tab bar is **removed from the header**; tabs live entirely in the
  center panel's subwindows.

This is the agreed direction (user chose: *Directional splits* + *Move tab bars
into subwindows*).

---

## Data model (src/stores/tabs.ts)

Tab payloads stay flat per scope (so all PTYs across all scopes keep rendering and
never unmount). A separate **layout tree** describes arrangement.

```ts
export type TabKind = "agent" | "local_agent" | "shell" | "files";

export interface TabEntry {
  key: string;          // globally-unique within a scope; doubles as PTY id suffix
  label: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  initialInput?: string;
  cwd: string;
  kind: TabKind;
}

export type SplitDir = "row" | "column";
// "row"    = children laid out left-to-right, vertical dividers
// "column" = children stacked top-to-bottom, horizontal dividers

export interface SplitNode {
  type: "split";
  id: string;
  dir: SplitDir;
  children: LayoutNode[];   // length >= 2
  sizes: number[];          // fractions in (0,1), sum ~= 1, length === children.length
}

export interface GroupNode {
  type: "group";
  id: string;
  tabKeys: string[];        // order shown in this subwindow's tab bar
  activeKey: string | null; // active tab within this group
}

export type LayoutNode = SplitNode | GroupNode;

export type DropEdge = "left" | "right" | "top" | "bottom" | "center";
```

### Store shape (per scope, mirrored into flat shortcuts for the current scope)

```ts
interface TabsStore {
  scope: string;

  // source of truth for tab payloads
  tabsByScope: Record<string, TabEntry[]>;
  // arrangement; root is always present once a scope has >=1 tab
  layoutByScope: Record<string, LayoutNode>;
  // which group is focused (its active tab is the "globally active" one)
  focusedGroupByScope: Record<string, string | null>;

  // flat mirrors of the CURRENT scope (kept for ergonomic consumers / tests)
  tabs: TabEntry[];
  layout: LayoutNode | null;
  focusedGroupId: string | null;
  activeKey: string | null;   // = active tab of the focused group

  setScope(scope: string): void;

  // focus / activation
  focusGroup(groupId: string): void;
  setActive(key: string): void;                 // activate tab + focus its group
  setGroupActive(groupId: string, key: string): void;

  // tab lifecycle
  addTab(tab: Omit<TabEntry, "key">): TabEntry;  // into focused group (creates root group if none)
  ensureTab(tab: Omit<TabEntry, "key">, matches: (t: TabEntry) => boolean): TabEntry;
  renameTab(key: string, label: string): void;
  removeTab(key: string): void;                  // drop from its group; collapse empty groups/splits
  updateTabEnv(key: string, env: Record<string, string>): void;

  // arrangement
  reorderInGroup(groupId: string, from: number, to: number): void;
  moveTab(key: string, targetGroupId: string, index?: number): void;   // edge === "center"
  splitWithTab(key: string, targetGroupId: string, edge: DropEdge): void; // edge L/R/T/B
  resizeSplit(splitId: string, dividerIndex: number, fraction: number): void;

  // persistence
  loadFromLayout(layout: SavedTabEntry[], defaultCwd: string, targetScope?: string,
                 groups?: SavedLayoutTree): void;
  saveLayout(localFile: string): Promise<void>;
}
```

### Invariants & rules
- A scope with >= 1 tab always has a `layout` whose leaves' `tabKeys` union ==
  that scope's `tabsByScope` keys (no orphan tabs, no dangling keys).
- A `GroupNode` may be empty only transiently; `removeTab` must delete an emptied
  group and **collapse** its parent split: a split with one remaining child is
  replaced by that child (and the root may become a lone `GroupNode`).
- `splitWithTab(key, targetGroupId, edge)`: remove `key` from its source group
  (collapsing if it empties), create a new `GroupNode { tabKeys:[key] }`, and
  insert it adjacent to `targetGroupId` per `edge`:
  - left/right → ensure/inject a `row` split, new group before/after target;
  - top/bottom → ensure/inject a `column` split, new group above/below target;
  - sizes split the target's slot 50/50 with the new group.
  - Edge `center` is equivalent to `moveTab(key, targetGroupId)`.
- New `id`s via a counter helper (e.g. `g-<n>`, `s-<n>`); ids need not survive
  reload (regenerate on load), tab keys are re-minted on load as today.
- `setScope` restores `tabs/layout/focusedGroupId/activeKey` from the per-scope
  maps; an uninitialized scope has `layout = null`, `tabs = []`.

### Backward compatibility
- Old `project.json` has only a flat `tab_layout: TabEntry[]` (no tree).
  `loadFromLayout` with no `groups` arg builds a **single root GroupNode**
  containing all tabs in order (active = first). This preserves existing projects.

---

## Persistence

### Frontend (`saveLayout`)
Send BOTH (so older app builds still read tabs):
- `tabs`: flat `TabEntry[]` (unchanged shape: key,label,cmd,cwd,kind,env) — the
  union of all groups' tabs, in a stable order.
- `groups`: the serialized layout tree (`SavedLayoutTree`) referencing tab keys.

Call: `invoke("save_tab_layout", { localFile, tabs, groups })`.

### Backend (Rust)
- `schema/project.rs`: add `pub tab_groups: Option<serde_json::Value>` to `Project`
  (kept opaque — frontend owns the tree shape; `Value` round-trips safely).
- `commands/projects.rs::save_tab_layout`: accept optional `groups: Option<Value>`
  and thread it to the service.
- `services/terminal_service.rs::save_tab_layout`: write `project.tab_groups`
  (clear to `None` when tabs empty). `load_project` already returns the whole
  project JSON, so the frontend reads `proj.tab_groups` in CenterPanel.
- `schema/session.rs` / `services/project_runtime.rs`: thread `tab_groups`
  through the in-memory terminal session snapshot so a project-switch round-trips
  the tree (mirror how `tab_layout` is handled).
- Because `Project`/`TabEntry` use `#[serde(flatten)] extra`, unknown fields are
  preserved; still add the explicit field for clarity and switch round-tripping.

> Backend changes require the user to rebuild/restart Eldrun (per CLAUDE.md).
> The feature must degrade gracefully if `tab_groups` is absent (→ single group).

---

## UI

### CenterPanel (src/components/layout/CenterPanel.tsx)
- Render the scope's `layout` tree recursively:
  - `SplitNode` → flex container (`row`/`column`) with children sized by `sizes`
    fractions and a **resize divider** between each pair (drag → `resizeSplit`).
  - `GroupNode` → a `<Subwindow>` component.
- Still render **all tabs of all scopes** as `TerminalView`/`FileBrowser` panes so
  PTYs never unmount; only the focused tab *within each visible group* is shown,
  and only the current scope's groups are visible. Off-scope panes stay mounted
  but hidden (keep current `allTabs` cross-scope rendering approach).
- Directional **drop zones**: while a tab drag is in progress (detect via
  `TAB_DRAG_MIME` in `dataTransfer.types`), each subwindow shows L/R/T/B/center
  hit regions; hovering highlights the target zone; drop calls `splitWithTab` or
  `moveTab`.

### Subwindow + per-group TabBar
- Extract a `<Subwindow groupId>` that renders a per-group `<TabBar>` + the group's
  pane area.
- Refactor `src/components/tabs/TabBar.tsx` to take a `groupId` and operate on that
  group (its `tabKeys`, `activeKey`), using `setGroupActive`, `reorderInGroup`,
  `removeTab`, `renameTab`, and the add-tab menu (adds into this group). Drag
  start tags `TAB_DRAG_MIME` with the tab key (not bare index) so cross-group
  moves work; include source group id in the payload.
- Remove `<TabBar>` from `HeaderBar.tsx` (header keeps logo/status/clock/window
  controls only). Keep the header drag selector entries harmless.

### CSS (src/styles/themes.css)
- Subwindow frame, per-group tab bar reuse of existing `.tab*` styles, resize
  dividers (`.split-divider` row/column variants, hover affordance), and edge
  drop-zone overlays (`.drop-zone.left/right/top/bottom/center` highlighted state).
- Remove/repurpose the just-added `.center-drop-overlay` (auto-grid) — superseded.

---

## Out of scope (keep simple)
- Dragging subwindows themselves (only tabs are draggable).
- Persisting exact divider pixel positions beyond `sizes` fractions.
- The old `grid`/`toggleGrid` auto-grid path — replaced by the split model. Remove
  `grid`, `gridByScope`, `toggleGrid`, `setGrid` and the ▦ button, and update/
  replace `GridView.test.ts` accordingly.

---

## Verification (every agent before handing off)
1. `npx tsc --noEmit`
2. `npx vitest run`
3. `cargo test --manifest-path src-tauri/Cargo.toml`
4. Frontend hot-reloads (src/); backend changes need a user rebuild — call this
   out in the handoff, do NOT launch Eldrun.

## Agent pipeline (sequential, shared working tree)
1. **Foundation** — store tree model + all actions + backward-compat load + Rust
   persistence + store unit tests. App-wide tsc may still fail (consumers not yet
   updated); the store and its own tests must pass.
2. **UI** — CenterPanel recursive render, Subwindow + per-group TabBar, remove
   header bar, resize dividers, directional drop zones wired to store, CSS.
   Whole-app `npx tsc --noEmit` and `npx vitest run` must pass.
3. **Verify & polish** — edge cases (close last tab in last group, empty scope,
   project switch round-trip), final tsc/vitest/cargo, update docs/TODO + memory.
</content>
</invoke>
