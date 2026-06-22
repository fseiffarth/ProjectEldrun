import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { InternalViewer } from "../lib/viewers/fileUtils";
import { useLinkRoutingStore } from "./linkRouting";

export type TabKind = "agent" | "local_agent" | "shell" | "files" | "embed";

export const FILES_TAB_CMD = "__eldrun_files__";

/**
 * Synthetic group id for the empty-state placeholder subwindow (rendered by
 * CenterPanel when a scope has no layout yet). It is NOT a real group in the
 * store — a drop onto it creates the first tab (addTab builds the root group).
 */
export const EMPTY_GROUP_ID = "__empty__";

/**
 * Persisted per-tab view state for the in-app file viewers, so reopening a file —
 * or restarting Eldrun — restores the reader where they left it instead of
 * jumping back to the top/default zoom. All fields optional; each viewer fills
 * the ones it has: scroll offset (text + PDF), zoom `scale` (PDF + image), and
 * pan `offsetX/offsetY` (image). Travels with the embed tab in project.json.
 */
export interface ViewerState {
  scrollTop?: number;
  scrollLeft?: number;
  scale?: number;
  offsetX?: number;
  offsetY?: number;
}

/**
 * Fallback minimum subwindow (split pane) size in px a divider drag may shrink a
 * pane to, per axis, when `settings.min_subwindow_width/height` is unset. Mirrors
 * the Rust schema note on those fields (schema/settings.rs).
 */
export const DEFAULT_MIN_SUBWINDOW_PX = 120;

export interface TabEntry {
  key: string; // globally-unique within a scope; doubles as PTY id suffix
  // The scope (project id or "root") that owns this tab. Set at addTab /
  // loadFromLayout time so the project→tab binding is EXPLICIT rather than
  // positional. writeScope drops any tab whose scope differs from the map key it
  // is being written under, making a cross-project leak structurally impossible
  // (see #55). Optional for back-compat with tabs built directly in tests.
  scope?: string;
  label: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  initialInput?: string;
  cwd: string;
  kind: TabKind;
  // For agents that support a deterministic session id (currently Claude, via
  // `--session-id <uuid>`), the UUID Eldrun minted and launched the agent with.
  // Surfaced on tab hover and intended to later drive session resume.
  sessionId?: string;
  // For "embed" tabs (a file dragged from the FileTree onto a tab bar): the
  // absolute path of the embedded file and the resolved executable that opens
  // it. Phase 1 opens the file externally; Phase 2 will reparent the app's
  // window into the tab. External-app embeds are NOT persisted (they would
  // relaunch the app on restart) — only in-app `viewer` embeds are restored.
  embedPath?: string;
  embedExec?: string;
  // When set, the embed tab renders the file in-app with a built-in viewer
  // (pdf/image/markdown/text/tex) instead of opening it externally — independent
  // of any external default app. These embeds re-render from `embedPath` on
  // relaunch (see isRestorableEmbedTab). See FileViewerPane.
  viewer?: InternalViewer;
  // For in-app `viewer` embeds: the reader's last scroll/zoom/pan, so reopening
  // the file (or restarting) restores the position instead of jumping to the top
  // (see ViewerState). Written by the viewer panes, persisted in project.json.
  viewerState?: ViewerState;
}

export type SplitDir = "row" | "column";
// "row"    = children laid out left-to-right, vertical dividers
// "column" = children stacked top-to-bottom, horizontal dividers

export interface SplitNode {
  type: "split";
  id: string;
  dir: SplitDir;
  children: LayoutNode[]; // length >= 2
  sizes: number[]; // fractions in (0,1), sum ~= 1, length === children.length
}

export interface GroupNode {
  type: "group";
  id: string;
  tabKeys: string[]; // order shown in this subwindow's tab bar
  activeKey: string | null; // active tab within this group
}

export type LayoutNode = SplitNode | GroupNode;

/**
 * #42: a detached popout window's last-known OS geometry, in physical pixels.
 * Streamed back from the window and persisted so a popout reopens where the user
 * left it after a restart.
 */
export interface WindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * #42: a tab group that has been popped out of the in-window layout tree into
 * its own detached OS window. The group's tab PAYLOADS stay in `tabsByScope`
 * (so PTYs never unmount and #55 scope-binding still holds) — only its
 * arrangement leaves `layoutByScope` and lives here. `label` is the Tauri window
 * label the backend keyed the detached `WebviewWindow` / `TrackedWindow` under,
 * used to close it on dock-back. v1 detaches exactly one `GroupNode` (not an
 * arbitrary split subtree), keeping the re-attach merge math simple.
 */
export interface DetachedGroup {
  id: string; // the detached group node's id
  subtree: GroupNode;
  label: string; // backend window/registry label
  // Last-known OS geometry of the popout, streamed back by the window. Persisted
  // (via the saved tree) so the popout reopens at the same place/size on restart.
  bounds?: WindowBounds;
}

/**
 * The edit shape a detached window streams back. Defined here (not imported from
 * `detached.ts`) so `tabs.ts` stays free of a circular import; `detached.ts`'s
 * `DetachedEdit` is structurally identical.
 */
export type DetachedEditPayload =
  | { kind: "activate"; key: string }
  | { kind: "rename"; key: string; label: string }
  | { kind: "close"; key: string }
  | { kind: "reorder"; tabKeys: string[] };

export type DropEdge = "left" | "right" | "top" | "bottom" | "center";

/** Flat tab shape as persisted in project.json's `tab_layout`. */
export interface SavedTabEntry {
  key: string;
  label: string;
  cmd: string;
  cwd: string;
  kind?: TabKind;
  type?: string;
  env?: Record<string, string>;
  sessionId?: string;
  // For restorable in-app "embed" tabs (a file dragged from the FileTree onto a
  // tab bar that renders via a built-in `viewer`): the absolute file path and
  // the viewer to re-render it with on restart. Only `viewer` embeds are
  // persisted; external-app embeds are dropped (see isRestorableEmbedTab).
  embedPath?: string;
  embedExec?: string;
  viewer?: InternalViewer;
  // Persisted reader position (scroll/zoom/pan) for in-app viewer embeds.
  viewerState?: ViewerState;
}

/** Serialized layout tree as persisted in project.json's `tab_groups`. */
export type SavedLayoutTree =
  | { type: "split"; dir: SplitDir; children: SavedLayoutTree[]; sizes: number[] }
  | {
      type: "group";
      tabKeys: string[];
      activeKey: string | null;
      // #42: when true, this group was popped out into its own OS window. It is
      // persisted as a normal docked group (so the tabs survive even if respawn
      // is disabled) but tagged so restore can re-open it as a floating popout
      // at `bounds` instead of docking it. See withDetachedDocked / loadFromLayout.
      detached?: boolean;
      bounds?: WindowBounds;
    };

/**
 * Persist-ready snapshot of a scope's tabs + layout for a project switch,
 * produced by `snapshotScopeForSwitch`. `tabs` are the scope-owned, restorable
 * tab payloads (in tree order); `tabGroups` is the pruned, detached-docked
 * serialized layout tree; `activeTabIndex` indexes the active tab within `tabs`.
 */
export interface ScopeSwitchSnapshot {
  tabs: TabEntry[];
  tabGroups: SavedLayoutTree | null;
  activeTabIndex: number;
}

interface TabsStore {
  scope: string;

  // source of truth for tab payloads
  tabsByScope: Record<string, TabEntry[]>;
  // arrangement; root is always present once a scope has >=1 tab
  layoutByScope: Record<string, LayoutNode | null>;
  // which group is focused (its active tab is the "globally active" one)
  focusedGroupByScope: Record<string, string | null>;
  // #42: per-scope groups that have been popped out into detached OS windows.
  // Their tab payloads still live in `tabsByScope[scope]`; only their layout
  // node has left `layoutByScope[scope]`.
  detachedGroupsByScope: Record<string, DetachedGroup[]>;
  // #42: per-scope groups that were detached when the scope was last saved and
  // must be re-opened as floating popouts once the scope's layout is live and its
  // panes (PTYs) have mounted. Populated by loadFromLayout, drained by
  // consumePendingRespawn (driven from CenterPanel after the panes render).
  pendingRespawnByScope: Record<string, RespawnTarget[]>;

  // flat mirrors of the CURRENT scope (kept for ergonomic consumers / tests)
  tabs: TabEntry[];
  layout: LayoutNode | null;
  focusedGroupId: string | null;
  activeKey: string | null; // = active tab of the focused group

  // #62: app-internal fullscreen — when set, CenterPanel renders only this
  // group's body full-bleed (panes stay mounted; this just repositions). Cleared
  // on Escape, when the group vanishes, or by toggling the same group again.
  fullscreenGroupId: string | null;
  toggleFullscreen: (groupId: string | null) => void;

  setScope: (scope: string) => void;

  // focus / activation
  focusGroup: (groupId: string) => void;
  setActive: (key: string) => void; // activate tab + focus its group
  setGroupActive: (groupId: string, key: string) => void;

  // tab lifecycle
  addTab: (tab: Omit<TabEntry, "key">) => TabEntry; // into focused group
  ensureTab: (
    tab: Omit<TabEntry, "key">,
    matches: (tab: TabEntry) => boolean,
  ) => TabEntry;
  renameTab: (key: string, label: string) => void;
  removeTab: (key: string) => void; // drop; collapse empty groups/splits
  closeGroup: (groupId: string) => void; // close a whole subwindow; siblings resize
  // Close EVERY tab/subwindow in a scope (defaults to the current scope),
  // leaving it empty (null layout → the +-placeholder). Each pane unmounts, so
  // its PTY dies. Non-current scopes are cleared in memory only; persist
  // explicitly at the call site if the scope isn't the active project.
  closeAllTabs: (scope?: string) => void;
  updateTabEnv: (key: string, env: Record<string, string>) => void;
  // Merge a patch into an embed tab's persisted viewer position (scroll/zoom/
  // pan). The viewer panes call this as the reader scrolls/zooms; the debounced
  // saveLayout effect then flushes it to project.json (see ViewerState).
  setViewerState: (key: string, patch: ViewerState) => void;

  // arrangement
  reorderInGroup: (groupId: string, from: number, to: number) => void;
  moveTab: (key: string, targetGroupId: string, index?: number) => void;
  splitWithTab: (key: string, targetGroupId: string, edge: DropEdge) => void;
  // Create a brand-new tab in a fresh group split off the target at `edge`
  // (or, for "center", added into the target group). Used by file drops from the
  // right panel to spawn a new subwindow holding the file directly. Returns the
  // created tab, or null if the target group no longer exists.
  splitWithNewTab: (
    tab: Omit<TabEntry, "key">,
    targetGroupId: string,
    edge: DropEdge,
  ) => TabEntry | null;
  resizeSplit: (splitId: string, dividerIndex: number, fraction: number) => void;

  // #42: detach / re-attach a subwindow (group) to/from its own OS window.
  // `detachGroup` removes the group from the in-window tree, records it in
  // `detachedGroupsByScope`, and (unless `skipBackend`) spawns the detached
  // OS window via the `detach_subwindow` command. Refuses to detach the lone
  // group (can't empty the in-window layout) UNLESS `allowLastGroup` is set —
  // used by the restart respawn path, where a popout may be the only group left
  // (its in-window siblings held only non-restorable tabs) yet must still re-open
  // as its own window, leaving the main center empty. Returns the detached
  // group's label, or null if refused / not found.
  detachGroup: (
    groupId: string,
    opts?: { skipBackend?: boolean; bounds?: WindowBounds; allowLastGroup?: boolean },
  ) => string | null;
  // `attachGroup` pops the detached entry, regenerates its ids, re-injects it
  // (adjacent to `targetGroupId`/`edge`, or as root if the tree is empty), and
  // (unless `skipBackend`) closes the detached OS window via `attach_subwindow`.
  attachGroup: (
    detachedId: string,
    opts?: { targetGroupId?: string; edge?: DropEdge; skipBackend?: boolean },
  ) => void;
  // #42: apply an edit streamed back from a detached window to the main store's
  // record of that detached group (its subtree node + tab payloads). Keeps the
  // main window — the single persistence owner — in sync with the detached one.
  applyDetachedEdit: (
    scope: string,
    groupId: string,
    edit: DetachedEditPayload,
  ) => void;
  // #42: dock-back for a group whose scope is NOT active. We re-inject the
  // detached subtree into that scope's STORED layout (`layoutByScope[scope]`,
  // not the live `layout`) so its tabs remain referenced by a layout node and
  // persist normally, then drop the detached record. The detached OS window is
  // closed via `attach_subwindow`. Used by the host's cross-scope
  // `DETACHED_DOCK` path; the active-scope path goes through `attachGroup`.
  dropDetachedGroup: (scope: string, groupId: string) => void;
  // #42: WM-close of a popout closes its tabs for good instead of docking them
  // back: kills each tab's PTY (the popout's panes are NOT mounted in the main
  // window and the detached viewer is attach-only, so nothing else tears them
  // down), drops their payloads from `tabsByScope`, and drops the detached
  // record. It does NOT re-inject the subtree into any layout, so the tabs are
  // gone — persist the scope afterwards (persistScope) so disk agrees and they
  // don't restore on next launch. Closes the OS window via `attach_subwindow`.
  closeDetachedGroup: (scope: string, groupId: string) => void;
  // #42: record a popout's latest OS geometry (streamed back from the window) so
  // it persists and the popout reopens where the user left it after a restart.
  setDetachedBounds: (scope: string, groupId: string, bounds: WindowBounds) => void;
  // #42: return and clear the scope's pending respawn targets (groups that were
  // detached at save time). Caller re-opens each via detachGroup once its pane
  // has mounted. Returns [] when there is nothing to respawn.
  consumePendingRespawn: (scope: string) => RespawnTarget[];

  // Struct #3 / Eff #13: produce the persist-ready snapshot of a scope's tabs +
  // layout for a project switch, WITHOUT the caller reaching into the store's
  // internal maps + tree helpers. Encapsulates the #55 ownership filter, the
  // restorable filter, the detached-group re-dock, and the prune-to-kept-keys —
  // the logic projects.ts used to inline by importing serializeTree /
  // pruneSavedTree / withDetachedDocked / allGroups / findGroup and grabbing
  // `getState()` directly. Pure read (no mutation); single tree walk for the
  // active-key resolution.
  snapshotScopeForSwitch: (scope: string) => ScopeSwitchSnapshot;

  // persistence
  loadFromLayout: (
    layout: SavedTabEntry[],
    defaultCwd: string,
    targetScope?: string,
    groups?: SavedLayoutTree,
  ) => void;
  // Persist an explicit scope's tabs+layout (incl. its detached groups) to its
  // project.json. `saveLayout` is the current-scope convenience over this; the
  // detached-close host path uses it to write a parked (non-active) scope, which
  // CenterPanel's current-scope save would otherwise never touch.
  persistScope: (scope: string, localFile: string) => Promise<void>;
  saveLayout: (localFile: string) => Promise<void>;
}

let _keyCounter = 0;
function nextKey(prefix: string) {
  return `${prefix}-${++_keyCounter}`;
}

let _nodeCounter = 0;
function nextGroupId() {
  return `g-${++_nodeCounter}`;
}
function nextSplitId() {
  return `s-${++_nodeCounter}`;
}

// ── Pure tree helpers ───────────────────────────────────────────────────────

/** Find a group node by id anywhere in the tree. */
export function findGroup(node: LayoutNode | null, id: string): GroupNode | null {
  if (!node) return null;
  if (node.type === "group") return node.id === id ? node : null;
  for (const child of node.children) {
    const found = findGroup(child, id);
    if (found) return found;
  }
  return null;
}

/** Find the group that currently holds `key` (and the key's index in it). */
export function findGroupOfTab(
  node: LayoutNode | null,
  key: string,
): { group: GroupNode; index: number } | null {
  if (!node) return null;
  if (node.type === "group") {
    const index = node.tabKeys.indexOf(key);
    return index >= 0 ? { group: node, index } : null;
  }
  for (const child of node.children) {
    const found = findGroupOfTab(child, key);
    if (found) return found;
  }
  return null;
}

/** All group nodes in document order. */
export function allGroups(node: LayoutNode | null): GroupNode[] {
  if (!node) return [];
  if (node.type === "group") return [node];
  return node.children.flatMap(allGroups);
}

/** Flat list of all tab keys, in stable left-to-right tree order. */
function orderedTabKeys(node: LayoutNode | null): string[] {
  return allGroups(node).flatMap((g) => g.tabKeys);
}

export type NavDirection = "left" | "right" | "up" | "down";

/** The split axis a direction navigates along ("row" = horizontal). */
function axisOf(dir: NavDirection): SplitDir {
  return dir === "left" || dir === "right" ? "row" : "column";
}

/**
 * Build the path of nodes from the root down to (and including) the group `id`.
 * Returns null if the group isn't in the tree.
 */
function pathToGroup(node: LayoutNode, id: string): LayoutNode[] | null {
  if (node.type === "group") return node.id === id ? [node] : null;
  for (const child of node.children) {
    const sub = pathToGroup(child, id);
    if (sub) return [node, ...sub];
  }
  return null;
}

/** The first group reached by descending `node` (depth-first, left-to-right). */
function firstGroup(node: LayoutNode): GroupNode {
  let cur = node;
  while (cur.type === "split") cur = cur.children[0];
  return cur;
}

/**
 * #62: the id of the subwindow (group) lying in `dir` from `fromGroupId`, by
 * walking the layout TREE (not pixel geometry) — find the nearest ancestor split
 * whose axis matches `dir`, then step to the adjacent child on that side and
 * descend to its first group. Returns null at an edge (no neighbour that way).
 * Pure: takes the tree, returns an id or null.
 */
export function neighborGroup(
  layout: LayoutNode | null,
  fromGroupId: string,
  dir: NavDirection,
): string | null {
  if (!layout) return null;
  const path = pathToGroup(layout, fromGroupId);
  if (!path) return null;
  const wantAxis = axisOf(dir);
  const towardNext = dir === "right" || dir === "down";
  // Walk up from the group: at each split ancestor on the matching axis, try to
  // step to the adjacent child in the requested direction.
  for (let i = path.length - 2; i >= 0; i--) {
    const split = path[i];
    if (split.type !== "split" || split.dir !== wantAxis) continue;
    const childIdx = split.children.indexOf(path[i + 1]);
    const nextIdx = towardNext ? childIdx + 1 : childIdx - 1;
    if (nextIdx >= 0 && nextIdx < split.children.length) {
      return firstGroup(split.children[nextIdx]).id;
    }
  }
  return null;
}

/**
 * Collapse a tree bottom-up:
 *  - a split with a single remaining child is replaced by that child;
 *  - empty groups inside a split are dropped (a lone empty root group is kept
 *    so an empty scope still has a root container, but callers may pass null).
 * Returns the new (possibly null) root.
 */
function collapse(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.type === "group") {
    return node;
  }
  // Recurse, drop emptied groups / null children.
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const c = collapse(child);
    if (!c) return;
    if (c.type === "group" && c.tabKeys.length === 0) return; // drop empty group
    children.push(c);
    sizes.push(node.sizes[i] ?? 1);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  // Renormalize sizes to sum to 1.
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return {
    ...node,
    children,
    sizes: sizes.map((s) => s / total),
  };
}

/**
 * Eff #5: prune-to-keys + collapse in a SINGLE bottom-up pass, also collecting
 * every surviving group into `groupsOut` (in document order) so `writeScope`
 * doesn't re-walk the tree to refind its focus / active / fullscreen groups.
 * Replaces the former `pruneLayoutToKeys` → `collapse` → repeated
 * `findGroup`/`allGroups` walks (4–5 traversals per mutation, one pass now).
 *
 * Behaviour matches running prune-to-keys then collapse: a group keeps only keys
 * in `keep` (its active repicked to the first survivor if it was dropped), empty
 * groups are dropped inside splits, single-child splits unwrap to their child,
 * and sibling sizes renormalize. `groupsOut` only ever receives groups that
 * survive into the returned tree.
 */
function pruneCollapseCollect(
  node: LayoutNode | null,
  keep: Set<string>,
  groupsOut: GroupNode[],
): LayoutNode | null {
  if (!node) return null;
  if (node.type === "group") {
    const tabKeys = node.tabKeys.filter((k) => keep.has(k));
    const activeKey =
      node.activeKey && tabKeys.includes(node.activeKey)
        ? node.activeKey
        : (tabKeys[0] ?? null);
    const next: GroupNode = { ...node, tabKeys, activeKey };
    groupsOut.push(next);
    return next;
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    // Collect each child's descendants into a scratch list first; only merge it
    // into groupsOut once we know the child survives (isn't an emptied group or
    // a fully-collapsed split) so groupsOut never lists a dropped group.
    const scratch: GroupNode[] = [];
    const c = pruneCollapseCollect(child, keep, scratch);
    if (!c) return;
    if (c.type === "group" && c.tabKeys.length === 0) return; // drop empty group
    children.push(c);
    sizes.push(node.sizes[i] ?? 1);
    for (const g of scratch) groupsOut.push(g);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children, sizes: sizes.map((s) => s / total) };
}

/**
 * Insert `newGroup` adjacent to the group `targetId` in the given direction.
 * `before` controls whether the new group goes before (left/top) or after
 * (right/bottom) the target. The target's slot is split 50/50 with the new
 * group. Returns the new root.
 */
function insertAdjacent(
  root: LayoutNode,
  targetId: string,
  newGroup: GroupNode,
  dir: SplitDir,
  before: boolean,
): LayoutNode {
  // Root itself is the target → wrap into a split.
  if (root.type === "group" && root.id === targetId) {
    return makeSplit(dir, before ? [newGroup, root] : [root, newGroup]);
  }

  function recurse(node: LayoutNode): LayoutNode {
    if (node.type === "group") return node;

    // Is the target a direct group child of this split?
    const childIdx = node.children.findIndex(
      (c) => c.type === "group" && c.id === targetId,
    );
    if (childIdx >= 0) {
      if (node.dir === dir) {
        // Same axis: insert the new group beside the target, splitting the
        // target's size slot 50/50.
        const children = [...node.children];
        const sizes = [...node.sizes];
        const targetSize = sizes[childIdx];
        const half = targetSize / 2;
        const insertAt = before ? childIdx : childIdx + 1;
        children.splice(insertAt, 0, newGroup);
        sizes.splice(childIdx, 1, half, half); // replace target slot with two halves
        // After splice the order of the two halves matches children order at
        // childIdx / childIdx+1; ensure the half list aligns with insertion.
        // We replaced 1 size with [half, half]; if `before`, the new group is
        // the first half — already correct since both halves are equal.
        return { ...node, children, sizes };
      }
      // Different axis: wrap just the target child in a nested split.
      const children = [...node.children];
      const target = children[childIdx] as GroupNode;
      children[childIdx] = makeSplit(
        dir,
        before ? [newGroup, target] : [target, newGroup],
      );
      return { ...node, children };
    }

    // Recurse into split children.
    return { ...node, children: node.children.map(recurse) };
  }

  return recurse(root);
}

function makeSplit(dir: SplitDir, children: LayoutNode[]): SplitNode {
  const n = children.length;
  return {
    type: "split",
    id: nextSplitId(),
    dir,
    children,
    sizes: children.map(() => 1 / n),
  };
}

/** Apply a resize to the divider between child i and i+1 of `splitId`. */
function applyResize(
  node: LayoutNode,
  splitId: string,
  dividerIndex: number,
  fraction: number,
): LayoutNode {
  if (node.type === "group") return node;
  if (node.id === splitId) {
    if (dividerIndex < 0 || dividerIndex >= node.children.length - 1) {
      return node;
    }
    const sizes = [...node.sizes];
    const pair = sizes[dividerIndex] + sizes[dividerIndex + 1];
    const min = 0.05;
    const left = Math.min(Math.max(fraction, min), pair - min);
    sizes[dividerIndex] = left;
    sizes[dividerIndex + 1] = pair - left;
    return { ...node, sizes };
  }
  return { ...node, children: node.children.map((c) => applyResize(c, splitId, dividerIndex, fraction)) };
}

/** Deep-clone a layout tree, regenerating all group/split ids. */
function regenIds(node: LayoutNode): LayoutNode {
  if (node.type === "group") {
    return { ...node, id: nextGroupId() };
  }
  return {
    ...node,
    id: nextSplitId(),
    children: node.children.map(regenIds),
  };
}

// ── Scope persistence helpers ───────────────────────────────────────────────

/** Persist a scope's tabs+layout+focus into the per-scope maps, mirroring the
 *  flat shortcuts when the scope is the current one. */
function writeScope(
  s: TabsStore,
  scope: string,
  tabs: TabEntry[],
  layout: LayoutNode | null,
  focusedGroupId: string | null,
): Partial<TabsStore> {
  // ── #55 invariant enforcement ───────────────────────────────────────────────
  // 1. Stamp/repair the owning scope on every tab and DROP any tab that already
  //    carries a different scope (a stray cross-project payload). This makes the
  //    project→tab binding explicit, so a leaked tab can never be written under
  //    the wrong scope.
  const ownedTabs = tabs
    .filter((t) => t.scope == null || t.scope === scope)
    .map((t) => (t.scope === scope ? t : { ...t, scope }));
  const ownedKeys = new Set(ownedTabs.map((t) => t.key));
  tabs = ownedTabs;

  // 2. Prune orphan layout keys AND collapse emptied groups/splits in one pass,
  //    collecting the surviving groups so the focus/active/fullscreen resolution
  //    below is index lookups against that list rather than fresh tree walks
  //    (Eff #5). `groups` is in document order, matching `allGroups`.
  const groups: GroupNode[] = [];
  let collapsed = pruneCollapseCollect(layout, ownedKeys, groups);
  // A lone empty root group means the scope has no tabs → drop to null so an
  // emptied scope has no layout (matches an uninitialized scope).
  if (collapsed && collapsed.type === "group" && collapsed.tabKeys.length === 0) {
    collapsed = null;
    groups.length = 0;
  }
  const byId = new Map(groups.map((g) => [g.id, g] as const));
  // If the focused group vanished (collapsed away), refocus the first group.
  let focus = focusedGroupId;
  if (!focus || !byId.has(focus)) {
    focus = groups[0]?.id ?? null;
  }
  const activeKey = focus ? (byId.get(focus)?.activeKey ?? null) : null;
  const isCurrent = s.scope === scope;
  // If the fullscreened group collapsed away (e.g. its subwindow was closed),
  // exit fullscreen so CenterPanel doesn't try to render a vanished group.
  const fullscreenGroupId =
    isCurrent && s.fullscreenGroupId && !byId.has(s.fullscreenGroupId)
      ? null
      : s.fullscreenGroupId;
  return {
    tabsByScope: { ...s.tabsByScope, [scope]: tabs },
    layoutByScope: { ...s.layoutByScope, [scope]: collapsed },
    focusedGroupByScope: { ...s.focusedGroupByScope, [scope]: focus },
    ...(isCurrent
      ? { tabs, layout: collapsed, focusedGroupId: focus, activeKey, fullscreenGroupId }
      : {}),
  };
}

/** Convenience accessor for the current scope's mutable state. */
function currentScopeState(s: TabsStore) {
  return {
    tabs: s.tabsByScope[s.scope] ?? [],
    layout: s.layoutByScope[s.scope] ?? null,
    focusedGroupId: s.focusedGroupByScope[s.scope] ?? null,
  };
}

// ── Tree (de)serialization ──────────────────────────────────────────────────

export function serializeTree(node: LayoutNode | null): SavedLayoutTree | null {
  if (!node) return null;
  if (node.type === "group") {
    return { type: "group", tabKeys: [...node.tabKeys], activeKey: node.activeKey };
  }
  return {
    type: "split",
    dir: node.dir,
    sizes: [...node.sizes],
    children: node.children
      .map(serializeTree)
      .filter((c): c is SavedLayoutTree => c != null),
  };
}

/** #42: a group restored from the saved tree that was tagged `detached`. */
export interface RespawnTarget {
  id: string; // the FRESH group id minted during deserialize
  bounds?: WindowBounds;
}

/**
 * Rebuild a layout tree from a serialized tree, remapping saved tab keys to the
 * freshly-minted keys. Drops keys not in `keyMap`. Returns null if nothing left.
 *
 * #42: when a group node is tagged `detached`, its freshly-minted id (+ bounds)
 * is pushed onto `detachedOut` so the caller can re-open it as a floating popout
 * after the layout is live (loadFromLayout). The node is still built into the
 * tree (docked) so its tabs mount and spawn their PTYs before the re-detach.
 */
function deserializeTree(
  saved: SavedLayoutTree,
  keyMap: Map<string, string>,
  detachedOut?: RespawnTarget[],
): LayoutNode | null {
  if (saved.type === "group") {
    const tabKeys = saved.tabKeys
      .map((k) => keyMap.get(k))
      .filter((k): k is string => k != null);
    if (tabKeys.length === 0) return null;
    const activeKey =
      (saved.activeKey != null ? keyMap.get(saved.activeKey) : null) ??
      tabKeys[0] ??
      null;
    const id = nextGroupId();
    if (saved.detached && detachedOut) {
      detachedOut.push({ id, bounds: saved.bounds });
    }
    return { type: "group", id, tabKeys, activeKey };
  }
  const children = saved.children
    .map((c) => deserializeTree(c, keyMap, detachedOut))
    .filter((c): c is LayoutNode => c != null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  // Align sizes to surviving children where possible, else even split.
  let sizes: number[];
  if (saved.sizes.length === children.length) {
    const total = saved.sizes.reduce((a, b) => a + b, 0) || 1;
    sizes = saved.sizes.map((x) => x / total);
  } else {
    sizes = children.map(() => 1 / children.length);
  }
  return { type: "split", id: nextSplitId(), dir: saved.dir, children, sizes };
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useTabsStore = create<TabsStore>((set, get) => ({
  scope: "root",
  tabsByScope: {},
  layoutByScope: {},
  focusedGroupByScope: {},
  detachedGroupsByScope: {},
  pendingRespawnByScope: {},
  tabs: [],
  layout: null,
  focusedGroupId: null,
  activeKey: null,
  fullscreenGroupId: null,

  toggleFullscreen: (groupId) => {
    set((s) => ({
      fullscreenGroupId: s.fullscreenGroupId === groupId ? null : groupId,
    }));
  },

  setScope: (scope) => {
    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const layout = s.layoutByScope[scope] ?? null;
      let focus = s.focusedGroupByScope[scope] ?? null;
      if (!focus || !findGroup(layout, focus)) {
        focus = allGroups(layout)[0]?.id ?? null;
      }
      const activeKey = focus
        ? (findGroup(layout, focus)?.activeKey ?? null)
        : null;
      // Fullscreen is scope-local (its group id belongs to the old scope's tree);
      // drop it on a scope change so a switch never leaves a stale group fullscreen.
      const fullscreenGroupId =
        s.fullscreenGroupId && findGroup(layout, s.fullscreenGroupId)
          ? s.fullscreenGroupId
          : null;
      return { scope, tabs, layout, focusedGroupId: focus, activeKey, fullscreenGroupId };
    });
  },

  focusGroup: (groupId) => {
    set((s) => {
      const { tabs, layout } = currentScopeState(s);
      if (!findGroup(layout, groupId)) return {};
      return writeScope(s, s.scope, tabs, layout, groupId);
    });
  },

  setActive: (key) => {
    set((s) => {
      const { tabs, layout } = currentScopeState(s);
      const found = findGroupOfTab(layout, key);
      if (!found || !layout) return {};
      // Set the active tab within its group and focus that group.
      const next = mapGroup(layout, found.group.id, (g) => ({
        ...g,
        activeKey: key,
      }));
      return writeScope(s, s.scope, tabs, next, found.group.id);
    });
  },

  setGroupActive: (groupId, key) => {
    set((s) => {
      const { tabs, layout } = currentScopeState(s);
      const group = findGroup(layout, groupId);
      if (!group || !group.tabKeys.includes(key) || !layout) return {};
      const next = mapGroup(layout, groupId, (g) => ({ ...g, activeKey: key }));
      return writeScope(s, s.scope, tabs, next, groupId);
    });
  },

  addTab: (tab) => {
    const key = nextKey(tab.kind);
    // Spread first so a stray `key` on the payload can't shadow the minted one.
    const entry: TabEntry = { ...tab, key };
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const nextTabs = [...tabs, entry];

      // No layout yet → create a root group containing this tab.
      if (!layout) {
        const root: GroupNode = {
          type: "group",
          id: nextGroupId(),
          tabKeys: [key],
          activeKey: key,
        };
        return writeScope(s, s.scope, nextTabs, root, root.id);
      }

      // Add into the focused group (fall back to the first group).
      const target =
        (focusedGroupId && findGroup(layout, focusedGroupId)) ||
        allGroups(layout)[0];
      const next = mapGroup(layout, target.id, (g) => ({
        ...g,
        tabKeys: [...g.tabKeys, key],
        activeKey: key,
      }));
      return writeScope(s, s.scope, nextTabs, next, target.id);
    });
    return entry;
  },

  ensureTab: (tab, matches) => {
    const existing = get().tabs.find(matches);
    if (existing) {
      get().setActive(existing.key);
      return existing;
    }
    return get().addTab(tab);
  },

  renameTab: (key, label) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const nextTabs = tabs.map((t) =>
        t.key === key ? { ...t, label: nextLabel } : t,
      );
      return writeScope(s, s.scope, nextTabs, layout, focusedGroupId);
    });
  },

  removeTab: (key) => {
    // Discard any session-only link routes that pointed FROM this tab (#50).
    useLinkRoutingStore.getState().purgeForTab(key);
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const nextTabs = tabs.filter((t) => t.key !== key);
      if (!layout) return writeScope(s, s.scope, nextTabs, null, focusedGroupId);

      const found = findGroupOfTab(layout, key);
      if (!found) {
        return writeScope(s, s.scope, nextTabs, layout, focusedGroupId);
      }
      // Drop the key from its group, repick that group's active tab.
      const next = mapGroup(layout, found.group.id, (g) => {
        const tabKeys = g.tabKeys.filter((k) => k !== key);
        const activeKey =
          g.activeKey === key
            ? (tabKeys[Math.min(found.index, tabKeys.length - 1)] ?? null)
            : g.activeKey;
        return { ...g, tabKeys, activeKey };
      });
      // collapse() in writeScope drops the emptied group + lone splits.
      return writeScope(s, s.scope, nextTabs, next, focusedGroupId);
    });
  },

  closeGroup: (groupId) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      if (!layout) return {};
      const group = findGroup(layout, groupId);
      if (!group) return {};
      // Drop the whole group's tabs from the flat payload list, then empty the
      // group node. collapse() in writeScope removes the emptied group and
      // renormalizes sibling sizes; the removed tabs' PTYs die as the flat pane
      // layer stops rendering their keys (TerminalView unmount → pty_kill).
      const removing = new Set(group.tabKeys);
      // Discard any session-only link routes from the closing tabs (#50).
      const purge = useLinkRoutingStore.getState().purgeForTab;
      group.tabKeys.forEach((k) => purge(k));
      const nextTabs = tabs.filter((t) => !removing.has(t.key));
      const next = mapGroup(layout, groupId, (g) => ({
        ...g,
        tabKeys: [],
        activeKey: null,
      }));
      return writeScope(s, s.scope, nextTabs, next, focusedGroupId);
    });
  },

  closeAllTabs: (scope) => {
    set((s) => {
      const target = scope ?? s.scope;
      const tabs = s.tabsByScope[target] ?? [];
      if (tabs.length === 0) return {};
      // Discard any session-only link routes from the closing tabs (#50).
      const purge = useLinkRoutingStore.getState().purgeForTab;
      tabs.forEach((t) => purge(t.key));
      // Empty the scope entirely: no tabs, no layout. writeScope mirrors the
      // flat shortcuts when target is current; the flat pane layer then unmounts
      // every pane for this scope, killing its PTYs (same path as closeGroup).
      return writeScope(s, target, [], null, null);
    });
  },

  updateTabEnv: (key, env) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const nextTabs = tabs.map((t) => (t.key === key ? { ...t, env } : t));
      return writeScope(s, s.scope, nextTabs, layout, focusedGroupId);
    });
  },

  setViewerState: (key, patch) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const tab = tabs.find((t) => t.key === key);
      if (!tab) return {};
      const merged = { ...tab.viewerState, ...patch };
      // No-op if nothing actually changed, so a redundant write doesn't churn
      // the tabs array (which would re-fire the saveLayout debounce for nothing).
      const cur = tab.viewerState ?? {};
      if (
        cur.scrollTop === merged.scrollTop &&
        cur.scrollLeft === merged.scrollLeft &&
        cur.scale === merged.scale &&
        cur.offsetX === merged.offsetX &&
        cur.offsetY === merged.offsetY
      ) {
        return {};
      }
      const nextTabs = tabs.map((t) =>
        t.key === key ? { ...t, viewerState: merged } : t,
      );
      return writeScope(s, s.scope, nextTabs, layout, focusedGroupId);
    });
  },

  reorderInGroup: (groupId, from, to) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const group = findGroup(layout, groupId);
      if (!group || !layout) return {};
      if (
        from < 0 ||
        from >= group.tabKeys.length ||
        to < 0 ||
        to >= group.tabKeys.length
      ) {
        return {};
      }
      const next = mapGroup(layout, groupId, (g) => {
        const tabKeys = [...g.tabKeys];
        const [moved] = tabKeys.splice(from, 1);
        tabKeys.splice(to, 0, moved);
        return { ...g, tabKeys };
      });
      return writeScope(s, s.scope, tabs, next, focusedGroupId);
    });
  },

  moveTab: (key, targetGroupId, index) => {
    set((s) => {
      const { tabs, layout } = currentScopeState(s);
      if (!layout) return {};
      const source = findGroupOfTab(layout, key);
      const target = findGroup(layout, targetGroupId);
      if (!source || !target) return {};

      // Same group → treat as a reorder to `index`.
      if (source.group.id === targetGroupId) {
        const to =
          index == null
            ? source.group.tabKeys.length - 1
            : Math.min(index, source.group.tabKeys.length - 1);
        const next = mapGroup(layout, targetGroupId, (g) => {
          const tabKeys = [...g.tabKeys];
          const [moved] = tabKeys.splice(source.index, 1);
          tabKeys.splice(to, 0, moved);
          return { ...g, tabKeys, activeKey: key };
        });
        return writeScope(s, s.scope, tabs, next, targetGroupId);
      }

      // Remove from source, then insert into target.
      let next: LayoutNode = mapGroup(layout, source.group.id, (g) => {
        const tabKeys = g.tabKeys.filter((k) => k !== key);
        const activeKey =
          g.activeKey === key ? (tabKeys[0] ?? null) : g.activeKey;
        return { ...g, tabKeys, activeKey };
      });
      next = mapGroup(next, targetGroupId, (g) => {
        const tabKeys = [...g.tabKeys];
        const at = index == null ? tabKeys.length : Math.min(index, tabKeys.length);
        tabKeys.splice(at, 0, key);
        return { ...g, tabKeys, activeKey: key };
      });
      // Source may have emptied → collapse handles it; focus the target.
      return writeScope(s, s.scope, tabs, next, targetGroupId);
    });
  },

  splitWithTab: (key, targetGroupId, edge) => {
    if (edge === "center") {
      get().moveTab(key, targetGroupId);
      return;
    }
    set((s) => {
      const { tabs, layout } = currentScopeState(s);
      if (!layout) return {};
      const source = findGroupOfTab(layout, key);
      const target = findGroup(layout, targetGroupId);
      if (!source || !target) return {};

      // A no-op split: dragging a group's only tab onto its own edge would
      // remove then re-add it; skip if it's the lone tab of the target group.
      if (source.group.id === targetGroupId && source.group.tabKeys.length === 1) {
        return {};
      }

      // 1. Remove from source.
      const removed = mapGroup(layout, source.group.id, (g) => {
        const tabKeys = g.tabKeys.filter((k) => k !== key);
        const activeKey =
          g.activeKey === key ? (tabKeys[0] ?? null) : g.activeKey;
        return { ...g, tabKeys, activeKey };
      });
      // Collapse so an emptied source group disappears before we inject.
      const cleaned = collapse(removed);
      if (!cleaned) return {};

      // The target group survives collapse (it still has tabs); re-find it.
      const stillThere = findGroup(cleaned, targetGroupId);
      if (!stillThere) return {};

      // 2. Build the new group and inject adjacent to the target.
      const newGroup: GroupNode = {
        type: "group",
        id: nextGroupId(),
        tabKeys: [key],
        activeKey: key,
      };
      const dir: SplitDir =
        edge === "left" || edge === "right" ? "row" : "column";
      const before = edge === "left" || edge === "top";
      const next = insertAdjacent(cleaned, targetGroupId, newGroup, dir, before);

      // Focus the freshly-split-off group.
      return writeScope(s, s.scope, tabs, next, newGroup.id);
    });
  },

  splitWithNewTab: (tab, targetGroupId, edge) => {
    const key = nextKey(tab.kind);
    // Spread first so a stray `key` on the payload can't shadow the minted one.
    const entry: TabEntry = { ...tab, key };
    let created = false;
    set((s) => {
      const { tabs, layout } = currentScopeState(s);
      if (!layout || !findGroup(layout, targetGroupId)) return {};
      const nextTabs = [...tabs, entry];

      // Center → add into the existing target group (no split), mirroring a
      // drop on its tab bar.
      if (edge === "center") {
        const next = mapGroup(layout, targetGroupId, (g) => ({
          ...g,
          tabKeys: [...g.tabKeys, key],
          activeKey: key,
        }));
        created = true;
        return writeScope(s, s.scope, nextTabs, next, targetGroupId);
      }

      // Edge → build a new group holding the tab and inject it adjacent to the
      // target, leaving the target's own tabs untouched.
      const newGroup: GroupNode = {
        type: "group",
        id: nextGroupId(),
        tabKeys: [key],
        activeKey: key,
      };
      const dir: SplitDir = edge === "left" || edge === "right" ? "row" : "column";
      const before = edge === "left" || edge === "top";
      const next = insertAdjacent(layout, targetGroupId, newGroup, dir, before);
      created = true;
      return writeScope(s, s.scope, nextTabs, next, newGroup.id);
    });
    return created ? entry : null;
  },

  resizeSplit: (splitId, dividerIndex, fraction) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      if (!layout) return {};
      const next = applyResize(layout, splitId, dividerIndex, fraction);
      return writeScope(s, s.scope, tabs, next, focusedGroupId);
    });
  },

  detachGroup: (groupId, opts) => {
    const scope = get().scope;
    const layout = get().layoutByScope[scope] ?? null;
    const group = findGroup(layout, groupId);
    if (!group) return null;
    // Refuse to detach the only group: the in-window layout must keep a body —
    // except on restart respawn (`allowLastGroup`), where the popout legitimately
    // becomes the scope's only window and the main center is left empty.
    if (!opts?.allowLastGroup && allGroups(layout).length <= 1) return null;

    const label = `detached-${scope}-${groupId}`;
    // Snapshot the group's subtree (it is a single GroupNode in v1).
    const subtree: GroupNode = {
      type: "group",
      id: group.id,
      tabKeys: [...group.tabKeys],
      activeKey: group.activeKey,
    };

    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      const focus = s.focusedGroupByScope[scope] ?? null;
      // Empty the detached group's node, then collapse via writeScope WITHOUT
      // dropping its tab payloads (they stay in tabsByScope — the detached
      // window renders them). Mirrors closeGroup's node-empty step, but keeps
      // the payloads (closeGroup drops them).
      const emptied = layout
        ? mapGroup(layout, groupId, (g) => ({ ...g, tabKeys: [], activeKey: null }))
        : null;
      // Re-pick focus off the detached group onto a surviving one.
      const nextFocus = focus === groupId ? null : focus;
      const base = writeScope(s, scope, tabs, emptied, nextFocus);
      const existing = s.detachedGroupsByScope[scope] ?? [];
      return {
        ...base,
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: [...existing, { id: groupId, subtree, label, bounds: opts?.bounds }],
        },
      };
    });

    if (!opts?.skipBackend) {
      // Spawn the detached OS window. The store mutation + IPC live in one
      // action so they can't drift. Best-effort: a backend failure leaves the
      // group recorded as detached (the user can dock it back). `bounds` (when
      // restoring a popout on restart) reopens it at its prior place/size.
      const b = opts?.bounds;
      invoke("detach_subwindow", {
        projectId: scope,
        groupId,
        x: b?.x ?? null,
        y: b?.y ?? null,
        width: b?.w ?? null,
        height: b?.h ?? null,
      }).catch(() => {});
    }
    return label;
  },

  attachGroup: (detachedId, opts) => {
    const scope = get().scope;
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === detachedId);
    if (!entry) return;

    set((s) => {
      const tabs = s.tabsByScope[scope] ?? [];
      let layout = s.layoutByScope[scope] ?? null;
      // Regenerate the subtree's ids so a docked-then-redetached group never
      // collides with a live node id.
      const fresh = regenIds(entry.subtree) as GroupNode;
      if (!layout) {
        // The in-window tree emptied while detached → install as the root.
        layout = fresh;
      } else {
        const target =
          (opts?.targetGroupId && findGroup(layout, opts.targetGroupId)) ||
          allGroups(layout)[0];
        if (!target) {
          layout = fresh;
        } else {
          const edge = opts?.edge ?? "right";
          if (edge === "center") {
            // Merge the detached tabs into the target group.
            layout = mapGroup(layout, target.id, (g) => ({
              ...g,
              tabKeys: [...g.tabKeys, ...fresh.tabKeys],
              activeKey: fresh.activeKey ?? g.activeKey,
            }));
          } else {
            const dir: SplitDir =
              edge === "left" || edge === "right" ? "row" : "column";
            const before = edge === "left" || edge === "top";
            layout = insertAdjacent(layout, target.id, fresh, dir, before);
          }
        }
      }
      const remaining = entries.filter((d) => d.id !== detachedId);
      const base = writeScope(s, scope, tabs, layout, fresh.id);
      return {
        ...base,
        detachedGroupsByScope: {
          ...s.detachedGroupsByScope,
          [scope]: remaining,
        },
      };
    });

    if (!opts?.skipBackend) {
      invoke("attach_subwindow", { registryId: entry.label }).catch(() => {});
    }
  },

  applyDetachedEdit: (scope, groupId, edit) => {
    set((s) => {
      const entries = s.detachedGroupsByScope[scope] ?? [];
      const idx = entries.findIndex((d) => d.id === groupId);
      if (idx < 0) return {};
      const entry = entries[idx];
      const sub = entry.subtree;
      let nextSub: GroupNode = sub;
      let nextTabs = s.tabsByScope[scope] ?? null;
      switch (edit.kind) {
        case "activate":
          if (sub.tabKeys.includes(edit.key)) {
            nextSub = { ...sub, activeKey: edit.key };
          }
          break;
        case "rename": {
          const label = edit.label.trim();
          if (label && nextTabs) {
            nextTabs = nextTabs.map((t) =>
              t.key === edit.key ? { ...t, label } : t,
            );
          }
          break;
        }
        case "close": {
          const tabKeys = sub.tabKeys.filter((k) => k !== edit.key);
          const activeKey =
            sub.activeKey === edit.key ? (tabKeys[0] ?? null) : sub.activeKey;
          nextSub = { ...sub, tabKeys, activeKey };
          // Drop the closed tab's payload (its pane in the detached window
          // unmounted; the PTY is killed there by the spawning pane's lifetime).
          if (nextTabs) nextTabs = nextTabs.filter((t) => t.key !== edit.key);
          break;
        }
        case "reorder": {
          const owned = new Set(sub.tabKeys);
          const tabKeys = edit.tabKeys.filter((k) => owned.has(k));
          if (tabKeys.length === sub.tabKeys.length) {
            nextSub = { ...sub, tabKeys };
          }
          break;
        }
      }
      const nextEntries = [...entries];
      // If the detached group emptied, remove it entirely.
      if (nextSub.tabKeys.length === 0) {
        nextEntries.splice(idx, 1);
      } else {
        nextEntries[idx] = { ...entry, subtree: nextSub };
      }
      const patch: Partial<TabsStore> = {
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: nextEntries },
      };
      if (nextTabs && nextTabs !== s.tabsByScope[scope]) {
        patch.tabsByScope = { ...s.tabsByScope, [scope]: nextTabs };
        if (s.scope === scope) patch.tabs = nextTabs;
      }
      return patch;
    });
  },

  dropDetachedGroup: (scope, groupId) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === groupId);
    if (!entry) return;

    set((s) => {
      const remaining = (s.detachedGroupsByScope[scope] ?? []).filter(
        (d) => d.id !== groupId,
      );
      // Re-inject the subtree into the inactive scope's STORED layout so its
      // tabs are referenced by a layout node (and thus persist) on next save.
      const fresh = regenIds(entry.subtree) as GroupNode;
      const stored = s.layoutByScope[scope] ?? null;
      let nextLayout: LayoutNode;
      if (!stored) {
        nextLayout = fresh;
      } else {
        const target = allGroups(stored)[0];
        nextLayout = target
          ? insertAdjacent(stored, target.id, fresh, "row", false)
          : fresh;
      }
      return {
        layoutByScope: { ...s.layoutByScope, [scope]: nextLayout },
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: remaining },
      };
    });

    // Close the detached OS window + drop the parkable override / registry entry.
    invoke("attach_subwindow", { registryId: entry.label }).catch(() => {});
  },

  closeDetachedGroup: (scope, groupId) => {
    const entries = get().detachedGroupsByScope[scope] ?? [];
    const entry = entries.find((d) => d.id === groupId);
    if (!entry) return;

    const keys = entry.subtree.tabKeys;
    const byKey = new Map((get().tabsByScope[scope] ?? []).map((t) => [t.key, t] as const));
    // Tear down each tab BEFORE the store mutation: discard its session-only
    // link routes (#50) and kill its PTY. Files/embed tabs have no PTY; terminal
    // tabs (shell/agent/local_agent) do, and since the popout's pane isn't
    // mounted in the main window (it left the layout on detach) and the detached
    // viewer is attach-only, nothing else would ever kill it — do it explicitly.
    const purge = useLinkRoutingStore.getState().purgeForTab;
    for (const key of keys) {
      purge(key);
      const tab = byKey.get(key);
      if (tab && tab.kind !== "files" && tab.kind !== "embed") {
        invoke("pty_kill", { id: `${scope}:${key}` }).catch(() => {});
      }
    }

    set((s) => {
      const remaining = (s.detachedGroupsByScope[scope] ?? []).filter(
        (d) => d.id !== groupId,
      );
      const removing = new Set(keys);
      const nextTabs = (s.tabsByScope[scope] ?? []).filter((t) => !removing.has(t.key));
      const patch: Partial<TabsStore> = {
        detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: remaining },
        tabsByScope: { ...s.tabsByScope, [scope]: nextTabs },
      };
      // Mirror the flat tab list when this scope is the active one.
      if (s.scope === scope) patch.tabs = nextTabs;
      return patch;
    });

    // Close the detached OS window (best-effort; the window also self-destroys).
    invoke("attach_subwindow", { registryId: entry.label }).catch(() => {});
  },

  setDetachedBounds: (scope, groupId, bounds) => {
    set((s) => {
      const entries = s.detachedGroupsByScope[scope];
      if (!entries) return {};
      let changed = false;
      const next = entries.map((d) => {
        if (d.id !== groupId) return d;
        if (
          d.bounds &&
          d.bounds.x === bounds.x &&
          d.bounds.y === bounds.y &&
          d.bounds.w === bounds.w &&
          d.bounds.h === bounds.h
        ) {
          return d;
        }
        changed = true;
        return { ...d, bounds };
      });
      if (!changed) return {};
      return { detachedGroupsByScope: { ...s.detachedGroupsByScope, [scope]: next } };
    });
  },

  consumePendingRespawn: (scope) => {
    const pending = get().pendingRespawnByScope[scope] ?? [];
    if (pending.length === 0) return [];
    set((s) => {
      const rest = { ...s.pendingRespawnByScope };
      delete rest[scope];
      return { pendingRespawnByScope: rest };
    });
    return pending;
  },

  snapshotScopeForSwitch: (scope) => {
    const s = get();
    const layout = s.layoutByScope[scope] ?? null;
    // Resolve the active tab key in one walk: prefer the focused group's active
    // key, falling back to the first group's (Eff #13 — projects.ts previously
    // ran findGroup + allGroups separately for this).
    const focus = s.focusedGroupByScope[scope] ?? null;
    const groups = allGroups(layout);
    const focusedGroup = focus ? groups.find((g) => g.id === focus) : undefined;
    const activeKey = focusedGroup?.activeKey ?? groups[0]?.activeKey ?? null;
    // #55 + restorable filter: keep only scope-owned, restorable tabs.
    const tabs = (s.tabsByScope[scope] ?? []).filter(
      (t) => (t.scope == null || t.scope === scope) && isRestorableTab(t),
    );
    const keepKeys = new Set(tabs.map((t) => t.key));
    const activeTabIndex = Math.max(
      0,
      tabs.findIndex((t) => t.key === activeKey),
    );
    // #42: re-dock detached groups into the persisted tree (detach is
    // session-only; a restart restores them docked), merge BEFORE pruning so
    // dropped tabs prune out consistently.
    const detached = s.detachedGroupsByScope[scope];
    const merged = withDetachedDocked(serializeTree(layout), detached);
    const tabGroups = pruneSavedTree(merged, keepKeys);
    return { tabs, tabGroups, activeTabIndex };
  },

  loadFromLayout: (layout, defaultCwd, targetScope, groups) => {
    // Map saved keys → fresh keys. Saved keys are only unique within the
    // session that wrote them — two projects can persist the same key. Keys
    // double as PTY ids, so always mint a fresh one on restore.
    const keyMap = new Map<string, string>();
    const tabs: TabEntry[] = layout.map((t) => {
      const kind =
        t.kind ??
        cmdToKind(t.cmd || (t.type === "files" ? FILES_TAB_CMD : ""));
      // Agent tabs always start in the current project dir so stale saved cwds
      // don't put the agent in the wrong directory after a project move/rename.
      const isAgent = kind === "agent" || kind === "local_agent";
      const freshKey = nextKey(kind);
      keyMap.set(t.key, freshKey);
      // Resumable agent tabs (Claude with a sessionId) respawn with their
      // resume flag so the prior conversation comes back; everyone else starts
      // fresh with no args.
      const tabShape = { kind, cmd: t.cmd, sessionId: t.sessionId };
      const args =
        isResumableAgentTab(tabShape) && t.sessionId
          ? RESUMABLE_AGENTS[t.cmd](t.sessionId)
          : [];
      return {
        key: freshKey,
        label: t.label,
        cmd: t.cmd,
        args,
        env: t.env ?? {},
        cwd: isAgent && defaultCwd ? defaultCwd : t.cwd || defaultCwd,
        kind,
        sessionId: t.sessionId,
        // Restored file embed tabs (kind === "embed") carry their durable path
        // and how to open it so the pane rebuilds exactly.
        embedPath: t.embedPath,
        embedExec: t.embedExec,
        viewer: t.viewer,
        viewerState: t.viewerState,
      };
    });

    // Build the layout tree. With `groups` provided, rebuild from the saved
    // tree; otherwise (legacy) put all tabs in a single root group. Groups tagged
    // `detached` are collected here (with their fresh ids) so the caller can
    // re-open them as floating popouts once their panes have mounted.
    let root: LayoutNode | null = null;
    const respawn: RespawnTarget[] = [];
    if (groups) {
      root = deserializeTree(groups, keyMap, respawn);
    }
    if (!root && tabs.length > 0) {
      root = {
        type: "group",
        id: nextGroupId(),
        tabKeys: tabs.map((t) => t.key),
        activeKey: tabs[0]?.key ?? null,
      };
    }
    // Any tab not placed by the saved tree (e.g. tree out of sync) → append to
    // the first group so no tab is orphaned.
    if (root) {
      const placed = new Set(orderedTabKeys(root));
      const missing = tabs.filter((t) => !placed.has(t.key)).map((t) => t.key);
      if (missing.length > 0) {
        const first = allGroups(root)[0];
        if (first) {
          root = mapGroup(root, first.id, (g) => ({
            ...g,
            tabKeys: [...g.tabKeys, ...missing],
            activeKey: g.activeKey ?? missing[0],
          }));
        }
      }
    }
    root = collapse(root);
    const focus = allGroups(root)[0]?.id ?? null;

    // Only respawn targets still present in the (possibly pruned/healed) tree:
    // a detached group whose tabs were all dropped on restore won't exist.
    const liveIds = new Set(allGroups(root).map((g) => g.id));
    const pending = respawn.filter((r) => liveIds.has(r.id));

    set((s) => {
      // Use the explicitly requested scope when provided; this prevents a race
      // where a stale async resolve would write into whatever scope happens to
      // be current at the time the set() callback runs.
      const scope = targetScope ?? s.scope;
      const base = writeScope(s, scope, tabs, root, focus);
      return {
        ...base,
        pendingRespawnByScope:
          pending.length > 0
            ? { ...s.pendingRespawnByScope, [scope]: pending }
            : s.pendingRespawnByScope,
      };
    });
  },

  persistScope: async (scope, localFile) => {
    const layout = get().layoutByScope[scope] ?? null;
    const scopeTabs = get().tabsByScope[scope] ?? [];
    // Order the flat tab union by the tree's stable left-to-right order so the
    // persisted `tabs` array and `groups` tree agree.
    const keyOrder = orderedTabKeys(layout);
    const byKey = new Map(scopeTabs.map((t) => [t.key, t] as const));
    const ordered = keyOrder
      .map((k) => byKey.get(k))
      .filter((t): t is TabEntry => t != null);
    // Include any tabs missing from the tree at the end (defensive).
    for (const t of scopeTabs) {
      if (!keyOrder.includes(t.key)) ordered.push(t);
    }
    // Shell/files tabs, resumable agent tabs (Claude with a sessionId), and
    // in-app file-viewer embeds are persisted; other agent/embed tabs (including
    // external-app embeds) are dropped here and the saved tree is pruned to
    // match. See isRestorableTab. Defense-in-depth (#55): also drop any tab not
    // owned by this scope so a foreign tab can never be written into this
    // project's file — `localFile` belongs to `scope`'s project.
    const restorable = ordered.filter(
      (t) => (t.scope == null || t.scope === scope) && isRestorableTab(t),
    );
    const keep = new Set(restorable.map((t) => t.key));
    // Persist the session UUIDs of every open tab that has one (currently
    // Claude agents). Resumable agent tabs also carry their sessionId in
    // `tabLayout`; this separate array keeps UUIDs durable redundantly.
    const sessions = ordered
      .filter((t) => t.sessionId)
      .map((t) => ({ sessionId: t.sessionId, cmd: t.cmd, label: t.label }));
    try {
      const tabLayout = restorable.map((t) => ({
        key: t.key,
        label: t.label,
        cmd: t.cmd,
        cwd: t.cwd,
        kind: t.kind,
        env: t.env ?? {},
        sessionId: t.sessionId,
        embedPath: t.embedPath,
        embedExec: t.embedExec,
        viewer: t.viewer,
        viewerState: t.viewerState,
      }));
      // #42: re-dock detached groups into the persisted tree so disk reflects a
      // restart-as-docked layout (their tabs are already in the flat list above
      // via get().tabs). Prune AFTER merging so dropped (non-restorable) tabs in
      // a detached group are pruned consistently.
      const detached = get().detachedGroupsByScope[scope];
      const merged = withDetachedDocked(serializeTree(layout), detached);
      const groups = pruneSavedTree(merged, keep);
      await invoke("save_tab_layout", {
        localFile,
        tabs: tabLayout,
        groups,
        sessions,
      });
    } catch {
      // tab layout is non-critical
    }
  },

  saveLayout: async (localFile) => {
    await get().persistScope(get().scope, localFile);
  },
}));

/** Replace the group `groupId` via `fn`, returning a new tree (structural). */
function mapGroup(
  node: LayoutNode,
  groupId: string,
  fn: (g: GroupNode) => GroupNode,
): LayoutNode {
  if (node.type === "group") {
    return node.id === groupId ? fn(node) : node;
  }
  return {
    ...node,
    children: node.children.map((c) => mapGroup(c, groupId, fn)),
  };
}

export function cmdToKind(cmd: string): TabKind {
  if (cmd === FILES_TAB_CMD) return "files";
  if (cmd === "claude" || cmd === "codex" || cmd === "gemini" || cmd === "vibe")
    return "agent";
  return "shell";
}

/**
 * Whether a tab KIND alone survives a restart. Shell/files tabs are restorable
 * by kind; agent / local-agent and embed tabs are not, because the kind alone
 * carries no session to resume. Prefer the tab-level `isRestorableTab` at call
 * sites that have the full tab — a resumable agent tab (Claude with a sessionId)
 * IS restorable even though its kind is not. This kind-only check stays for the
 * places that only have a `TabKind`.
 *
 * Embed tabs are not restorable by kind alone — only in-app `viewer` embeds
 * survive (external-app embeds would relaunch on startup), so restorability for
 * them is decided at the tab level (see isRestorableEmbedTab / isRestorableTab),
 * not here.
 */
export function isRestorableKind(kind: TabKind): boolean {
  return kind === "shell" || kind === "files";
}

/**
 * Agents whose prior session can be resumed, mapping `cmd` → the launch args to
 * relaunch with that session. Claude (`--resume <id>`) and Codex (`codex resume`,
 * args injected by the backend) are wired; Gemini/Vibe stay excluded until their
 * resume path is confirmed (39d).
 */
export const RESUMABLE_AGENTS: Record<string, (id: string) => string[]> = {
  // Claude: `--resume <launch-id>`; the backend upgrades the id to the live one
  // after `/clear`.
  claude: (id) => ["--resume", id],
  // Codex mints its own session id, so the tab's `sessionId` is only the
  // ELDRUN_TAB_UID key (not a Codex id) → no frontend resume args. The backend
  // reads the hook-recorded live id and injects `codex resume <live-id>` at spawn
  // (terminal::resolve_codex_session).
  codex: () => [],
};

/**
 * Whether a tab is a resumable agent: an agent/local-agent tab that minted a
 * session id AND whose `cmd` is in `RESUMABLE_AGENTS`. Such tabs survive a
 * restart (their conversation is resumed); other agent tabs are still dropped.
 */
export function isResumableAgentTab(
  tab: { kind: TabKind; cmd: string; sessionId?: string },
): boolean {
  return (
    (tab.kind === "agent" || tab.kind === "local_agent") &&
    !!tab.sessionId &&
    tab.cmd in RESUMABLE_AGENTS
  );
}

/**
 * Whether a tab is a restorable embed: a file dragged from the FileTree onto a
 * tab bar that renders IN-APP via a built-in `viewer` (pdf/image/markdown/text).
 * These re-render the file from its durable `embedPath` on restart with no side
 * effects. Embed tabs that instead open an EXTERNAL app (`embedExec`, no
 * `viewer`) are NOT restorable — re-creating one would relaunch the external app
 * at startup — so they are dropped like other live-process tabs.
 */
export function isRestorableEmbedTab(
  tab: { kind: TabKind; viewer?: TabEntry["viewer"] },
): boolean {
  return tab.kind === "embed" && !!tab.viewer;
}

/**
 * Tab-level restorability (supersedes bare `isRestorableKind` at call sites that
 * have the full tab): a tab survives a restart if its kind is restorable, it is
 * a resumable agent tab, or it is an in-app file-viewer embed.
 */
export function isRestorableTab(
  tab: {
    kind: TabKind;
    cmd: string;
    sessionId?: string;
    viewer?: TabEntry["viewer"];
  },
): boolean {
  return (
    isRestorableKind(tab.kind) ||
    isResumableAgentTab(tab) ||
    isRestorableEmbedTab(tab)
  );
}

/**
 * Drop every tab key not in `keep` from a serialized layout tree, collapsing
 * groups/splits that empty out. Returns null when nothing survives. Used when
 * persisting so the on-disk tree never references tabs we won't restore.
 */
export function pruneSavedTree(
  tree: SavedLayoutTree | null,
  keep: Set<string>,
): SavedLayoutTree | null {
  if (!tree) return null;
  if (tree.type === "group") {
    const tabKeys = tree.tabKeys.filter((k) => keep.has(k));
    if (tabKeys.length === 0) return null;
    const activeKey =
      tree.activeKey && tabKeys.includes(tree.activeKey)
        ? tree.activeKey
        : tabKeys[0];
    // #42: carry the detached tag + bounds through pruning. withDetachedDocked
    // sets these so restore re-opens the group as a floating popout; dropping
    // them here would persist the group as a plain docked node and the popout
    // would restore inside the main panel instead.
    return {
      type: "group",
      tabKeys,
      activeKey,
      ...(tree.detached ? { detached: true, bounds: tree.bounds } : {}),
    };
  }
  const kept = tree.children
    .map((c, i) => ({ child: pruneSavedTree(c, keep), size: tree.sizes[i] ?? 1 }))
    .filter((e): e is { child: SavedLayoutTree; size: number } => e.child != null);
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].child;
  const total = kept.reduce((a, e) => a + e.size, 0) || 1;
  return {
    type: "split",
    dir: tree.dir,
    children: kept.map((e) => e.child),
    sizes: kept.map((e) => e.size / total),
  };
}

export function isLocalAgentKind(kind: TabKind): kind is "local_agent" {
  return kind === "local_agent";
}

/**
 * #42: build the saved layout tree that should be PERSISTED for a scope that has
 * detached groups. Each detached group's serialized subtree is appended to the
 * in-window tree as a sibling (row split) — so `project.json` always reflects "if
 * you restarted now, this group would dock here" and the tabs survive even if
 * respawn is unavailable — but its root group is TAGGED `detached: true` (with its
 * last-known `bounds`). On restore, a tagged group is re-opened as a floating
 * popout at `bounds` rather than docked (see loadFromLayout). With no detached
 * groups it returns the in-window tree unchanged.
 *
 * Pure: takes the serialized in-window tree + the scope's detached groups,
 * returns a serialized tree. Pruning to `keep` is the caller's job.
 */
export function withDetachedDocked(
  inWindow: SavedLayoutTree | null,
  detached: DetachedGroup[] | undefined,
): SavedLayoutTree | null {
  const docked: SavedLayoutTree[] = [];
  for (const d of detached ?? []) {
    const t = serializeTree(d.subtree);
    if (!t) continue;
    // v1 detaches a single GroupNode, so the serialized subtree is a group; tag
    // it so restore knows to respawn the popout instead of docking it.
    docked.push(t.type === "group" ? { ...t, detached: true, bounds: d.bounds } : t);
  }
  if (docked.length === 0) return inWindow;
  const all = inWindow ? [inWindow, ...docked] : docked;
  if (all.length === 1) return all[0];
  return {
    type: "split",
    dir: "row",
    children: all,
    sizes: all.map(() => 1 / all.length),
  };
}

/** #42: the tab keys held by a scope's detached groups (for owned-keys unions). */
export function detachedTabKeys(detached: DetachedGroup[] | undefined): string[] {
  return (detached ?? []).flatMap((d) => d.subtree.tabKeys);
}

// Re-export the id regeneration helper so consumers / tests that build trees
// manually can mint ids consistently.
export { regenIds as _regenLayoutIds };

/**
 * #42: is the PTY `id` (`<scope>:<tabKey>`) currently owned by a DETACHED group?
 *
 * The main window's `TerminalView` is NOT attach-only, so on unmount it kills its
 * PTY. But detaching a group unmounts that pane in the main window — and we must
 * NOT kill the PTY then, because the detached window's attach-only viewer has
 * just attached to it (killing it leaves the popped-out terminal a dead black
 * pane). `detachGroup` records the group in `detachedGroupsByScope` *before* the
 * unmount commit, so this read sees the detached state at kill time.
 */
export function isDetachedPtyId(id: string): boolean {
  const idx = id.indexOf(":");
  if (idx < 0) return false;
  const scope = id.slice(0, idx);
  const tabKey = id.slice(idx + 1);
  const groups = useTabsStore.getState().detachedGroupsByScope[scope] ?? [];
  return groups.some((g) => g.subtree.tabKeys.includes(tabKey));
}

// ── Fine-grained per-group selectors (Eff #3/#4/#7 + Struct #3) ───────────────
// These let a TabBar / pane subscribe to JUST its own group instead of the whole
// `layout` + `tabs` slices, which forced a re-render on any tab change anywhere
// and rebuilt a Map of every tab per render. writeScope rebuilds the layout
// immutably along the changed path only (mapGroup), so an unchanged group node
// keeps its reference identity — meaning these selectors return the SAME value
// across an unrelated group's mutation and React bails out of the re-render.
// Modelled on stores/drag.ts's coarse-selector discipline.

/**
 * The current scope's `GroupNode` for `groupId`, or null if it isn't in the live
 * layout. Reference-stable while this group is unchanged, so a subscriber only
 * re-renders when THIS group's node (its tabKeys / activeKey) actually changes.
 */
export function useGroup(groupId: string): GroupNode | null {
  return useTabsStore((s) => findGroup(s.layout, groupId));
}

/**
 * The full tab payloads held by `groupId`, in group order. Subscribes with a
 * shallow array comparison so the bar re-renders only when this group's resolved
 * payloads change — not when another group's tabs (or the `tabsByScope` array
 * identity) churn. Returns [] when the group is absent.
 */
export function useGroupTabs(groupId: string): TabEntry[] {
  return useTabsStore(
    useShallow((s) => {
      const group = findGroup(s.layout, groupId);
      if (!group) return EMPTY_TABS;
      const byKey = new Map(s.tabs.map((t) => [t.key, t] as const));
      return group.tabKeys
        .map((k) => byKey.get(k))
        .filter((t): t is TabEntry => t != null);
    }),
  );
}

// Shared empty sentinel so the no-group path returns a stable reference (an
// inline `[]` would be a fresh array each call and defeat the shallow bail-out).
const EMPTY_TABS: TabEntry[] = [];
