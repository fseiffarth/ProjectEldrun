import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export type TabKind = "agent" | "local_agent" | "shell" | "files" | "embed";

export const FILES_TAB_CMD = "__eldrun_files__";

/**
 * Synthetic group id for the empty-state placeholder subwindow (rendered by
 * CenterPanel when a scope has no layout yet). It is NOT a real group in the
 * store — a drop onto it creates the first tab (addTab builds the root group).
 */
export const EMPTY_GROUP_ID = "__empty__";

export interface TabEntry {
  key: string; // globally-unique within a scope; doubles as PTY id suffix
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
  // (pdf/image/markdown/text) instead of opening it externally — independent of
  // any external default app. These embeds re-render from `embedPath` on
  // relaunch (see isRestorableEmbedTab). See FileViewerPane.
  viewer?: "pdf" | "image" | "markdown" | "text";
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
  viewer?: "pdf" | "image" | "markdown" | "text";
}

/** Serialized layout tree as persisted in project.json's `tab_groups`. */
export type SavedLayoutTree =
  | { type: "split"; dir: SplitDir; children: SavedLayoutTree[]; sizes: number[] }
  | { type: "group"; tabKeys: string[]; activeKey: string | null };

interface TabsStore {
  scope: string;

  // source of truth for tab payloads
  tabsByScope: Record<string, TabEntry[]>;
  // arrangement; root is always present once a scope has >=1 tab
  layoutByScope: Record<string, LayoutNode | null>;
  // which group is focused (its active tab is the "globally active" one)
  focusedGroupByScope: Record<string, string | null>;

  // flat mirrors of the CURRENT scope (kept for ergonomic consumers / tests)
  tabs: TabEntry[];
  layout: LayoutNode | null;
  focusedGroupId: string | null;
  activeKey: string | null; // = active tab of the focused group

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
  updateTabEnv: (key: string, env: Record<string, string>) => void;

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

  // persistence
  loadFromLayout: (
    layout: SavedTabEntry[],
    defaultCwd: string,
    targetScope?: string,
    groups?: SavedLayoutTree,
  ) => void;
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
  let collapsed = collapse(layout);
  // A lone empty root group means the scope has no tabs → drop to null so an
  // emptied scope has no layout (matches an uninitialized scope).
  if (collapsed && collapsed.type === "group" && collapsed.tabKeys.length === 0) {
    collapsed = null;
  }
  // If the focused group vanished (collapsed away), refocus the first group.
  let focus = focusedGroupId;
  if (!focus || !findGroup(collapsed, focus)) {
    focus = allGroups(collapsed)[0]?.id ?? null;
  }
  const activeKey = focus
    ? (findGroup(collapsed, focus)?.activeKey ?? null)
    : null;
  const isCurrent = s.scope === scope;
  return {
    tabsByScope: { ...s.tabsByScope, [scope]: tabs },
    layoutByScope: { ...s.layoutByScope, [scope]: collapsed },
    focusedGroupByScope: { ...s.focusedGroupByScope, [scope]: focus },
    ...(isCurrent
      ? { tabs, layout: collapsed, focusedGroupId: focus, activeKey }
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

/**
 * Rebuild a layout tree from a serialized tree, remapping saved tab keys to the
 * freshly-minted keys. Drops keys not in `keyMap`. Returns null if nothing left.
 */
function deserializeTree(
  saved: SavedLayoutTree,
  keyMap: Map<string, string>,
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
    return { type: "group", id: nextGroupId(), tabKeys, activeKey };
  }
  const children = saved.children
    .map((c) => deserializeTree(c, keyMap))
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
  tabs: [],
  layout: null,
  focusedGroupId: null,
  activeKey: null,

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
      return { scope, tabs, layout, focusedGroupId: focus, activeKey };
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
      const nextTabs = tabs.filter((t) => !removing.has(t.key));
      const next = mapGroup(layout, groupId, (g) => ({
        ...g,
        tabKeys: [],
        activeKey: null,
      }));
      return writeScope(s, s.scope, nextTabs, next, focusedGroupId);
    });
  },

  updateTabEnv: (key, env) => {
    set((s) => {
      const { tabs, layout, focusedGroupId } = currentScopeState(s);
      const nextTabs = tabs.map((t) => (t.key === key ? { ...t, env } : t));
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
      };
    });

    // Build the layout tree. With `groups` provided, rebuild from the saved
    // tree; otherwise (legacy) put all tabs in a single root group.
    let root: LayoutNode | null = null;
    if (groups) {
      root = deserializeTree(groups, keyMap);
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

    set((s) => {
      // Use the explicitly requested scope when provided; this prevents a race
      // where a stale async resolve would write into whatever scope happens to
      // be current at the time the set() callback runs.
      const scope = targetScope ?? s.scope;
      return writeScope(s, scope, tabs, root, focus);
    });
  },

  saveLayout: async (localFile) => {
    const { layout } = get();
    // Order the flat tab union by the tree's stable left-to-right order so the
    // persisted `tabs` array and `groups` tree agree.
    const keyOrder = orderedTabKeys(layout);
    const byKey = new Map(get().tabs.map((t) => [t.key, t] as const));
    const ordered = keyOrder
      .map((k) => byKey.get(k))
      .filter((t): t is TabEntry => t != null);
    // Include any tabs missing from the tree at the end (defensive).
    for (const t of get().tabs) {
      if (!keyOrder.includes(t.key)) ordered.push(t);
    }
    // Shell/files tabs, resumable agent tabs (Claude with a sessionId), and
    // in-app file-viewer embeds are persisted; other agent/embed tabs (including
    // external-app embeds) are dropped here and the saved tree is pruned to
    // match. See isRestorableTab.
    const restorable = ordered.filter((t) => isRestorableTab(t));
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
      }));
      const groups = pruneSavedTree(serializeTree(layout), keep);
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
    return { type: "group", tabKeys, activeKey };
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

// Re-export the id regeneration helper so consumers / tests that build trees
// manually can mint ids consistently.
export { regenIds as _regenLayoutIds };
