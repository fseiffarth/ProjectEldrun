/**
 * #42: detached-subwindow message passing + pure reducers.
 *
 * Two WebViews (main + detached) are separate JS heaps and CANNOT share a
 * Zustand store, so the main window streams the detached group's tab payloads +
 * subtree to the detached window over Tauri events, and the detached window
 * streams edits back. The MAIN window remains the single owner of project.json
 * writes — the detached window never persists.
 *
 * This module holds the pure, unit-testable bits: the `?detached=` URL parser
 * and the seed/edit payload builders + appliers. The wiring (listeners) lives in
 * `DetachedApp` / the main shell.
 */
import { emit, listen } from "@tauri-apps/api/event";
import {
  useTabsStore,
  type GroupNode,
  type TabEntry,
  type WindowBounds,
} from "./tabs";
import { useProjectsStore } from "./projects";

/** Parsed `?detached=<scope>:<groupId>` query. */
export interface DetachedParam {
  scope: string;
  groupId: string;
}

/**
 * Parse the `?detached=` query that selects the DetachedApp render branch.
 * Returns null when absent (→ render the normal AppShell). The value is
 * `<scope>:<groupId>`; a group id can itself contain a hyphen (e.g. `g-3`) but
 * never a colon, so we split on the FIRST colon only.
 */
export function parseDetachedParam(search: string): DetachedParam | null {
  const params = new URLSearchParams(search);
  const raw = params.get("detached");
  if (!raw) return null;
  const idx = raw.indexOf(":");
  if (idx < 0) return null;
  const scope = raw.slice(0, idx);
  const groupId = raw.slice(idx + 1);
  if (!scope || !groupId) return null;
  return { scope, groupId };
}

/**
 * Tauri event names. The SEED is namespaced by the detached window's label so a
 * targeted emit only re-seeds that one window. Edits/dock-back flow back on
 * single GLOBAL channels carrying their identity (`scope`/`groupId`/`label`),
 * because the main window doesn't statically know every detached label to
 * subscribe per-window.
 */
export const detachedSeedEvent = (label: string) => `detached-seed-${label}`;
/** The detached window emits this (with its label) to ask the main for a seed. */
export const DETACHED_REQUEST_SEED = "detached-request-seed";
/** Detached → main: a tab edit (activate/rename/close/reorder). */
export const DETACHED_EDIT = "detached-edit";
/** Detached → main: request to dock this group back into the main window. */
export const DETACHED_DOCK = "detached-dock";
/**
 * Detached → main: the popout's OS window was closed (WM/title-bar close). Unlike
 * DETACHED_DOCK, this CLOSES the group's tabs for good — they are not docked back
 * and do not restore on next launch. The ⤓ dock button still uses DETACHED_DOCK.
 */
export const DETACHED_CLOSE = "detached-close";
/** Detached → main: the popout's OS geometry changed (persisted for respawn). */
export const DETACHED_BOUNDS = "detached-bounds";
/**
 * #42: cross-window drag-to-dock. The detached window owns the pointer capture,
 * so it streams the gesture to the main window, which renders the dock preview
 * and docks the group on release. START opens the preview, MOVE updates it (with
 * the pointer's SCREEN coords, mapped to the main window's client space), and END
 * commits (or cancels). One popout drags at a time, so MOVE/END carry no id.
 */
export const DETACHED_DRAG_START = "detached-drag-start";
export const DETACHED_DRAG_MOVE = "detached-drag-move";
export const DETACHED_DRAG_END = "detached-drag-end";

/** Detached → main: begin a drag-to-dock of this whole popout. */
export interface DetachedDragStart {
  scope: string;
  groupId: string;
  label: string;
  screenX: number;
  screenY: number;
}
/** Detached → main: the dragged pointer moved (screen CSS px). */
export interface DetachedDragMove {
  screenX: number;
  screenY: number;
}
/** Detached → main: the drag ended; `cancelled` skips docking. */
export interface DetachedDragEnd {
  cancelled: boolean;
}

/** The seed the main window ships to a freshly-opened detached window. */
export interface DetachedSeed {
  scope: string;
  groupId: string;
  tabs: TabEntry[];
  subtree: GroupNode;
}

/** Build a seed payload from a detached group's tabs + subtree. Pure. */
export function buildSeed(
  scope: string,
  groupId: string,
  allScopeTabs: TabEntry[],
  subtree: GroupNode,
): DetachedSeed {
  const keys = new Set(subtree.tabKeys);
  // Ship only the group's own tabs (the detached window renders just this group).
  const tabs = allScopeTabs.filter((t) => keys.has(t.key));
  return { scope, groupId, tabs, subtree };
}

/**
 * Edits the detached window streams back to the main window. Last-writer-wins;
 * one group, so conflicts are rare.
 */
export type DetachedEdit =
  | { kind: "activate"; key: string }
  | { kind: "rename"; key: string; label: string }
  | { kind: "close"; key: string }
  | { kind: "reorder"; tabKeys: string[] };

/** Envelope for a detached→main edit (identity + the edit itself). */
export interface DetachedEditEnvelope {
  scope: string;
  groupId: string;
  edit: DetachedEdit;
}

/** Envelope for a detached→main dock-back request. */
export interface DetachedDockEnvelope {
  scope: string;
  groupId: string;
}

/** Envelope for a detached→main geometry update. */
export interface DetachedBoundsEnvelope {
  scope: string;
  groupId: string;
  bounds: WindowBounds;
}

/** Identity the detached window sends when requesting its seed. */
export interface DetachedSeedRequest {
  label: string;
  scope: string;
  groupId: string;
}

/**
 * Apply a `DetachedEdit` to a detached group's subtree, returning the new
 * subtree. Pure — used by the main window to keep its `detachedGroupsByScope`
 * entry in sync (and to recompute what the detached window should render). The
 * tab PAYLOAD updates (rename label) are applied to `tabs` separately by the
 * caller; this only updates the group node (tabKeys/activeKey).
 */
export function applyEditToSubtree(
  subtree: GroupNode,
  edit: DetachedEdit,
): GroupNode {
  switch (edit.kind) {
    case "activate":
      return subtree.tabKeys.includes(edit.key)
        ? { ...subtree, activeKey: edit.key }
        : subtree;
    case "close": {
      const tabKeys = subtree.tabKeys.filter((k) => k !== edit.key);
      const activeKey =
        subtree.activeKey === edit.key ? (tabKeys[0] ?? null) : subtree.activeKey;
      return { ...subtree, tabKeys, activeKey };
    }
    case "reorder": {
      // Keep only keys the group actually owns, preserving the requested order.
      const owned = new Set(subtree.tabKeys);
      const tabKeys = edit.tabKeys.filter((k) => owned.has(k));
      if (tabKeys.length !== subtree.tabKeys.length) return subtree;
      const activeKey =
        subtree.activeKey && tabKeys.includes(subtree.activeKey)
          ? subtree.activeKey
          : (tabKeys[0] ?? null);
      return { ...subtree, tabKeys, activeKey };
    }
    case "rename":
      // Label lives on the tab payload, not the group node — no node change.
      return subtree;
  }
}

/** Apply a `rename` edit to a tab payload list. Pure. */
export function applyRenameToTabs(
  tabs: TabEntry[],
  key: string,
  label: string,
): TabEntry[] {
  const next = label.trim();
  if (!next) return tabs;
  return tabs.map((t) => (t.key === key ? { ...t, label: next } : t));
}

/**
 * MAIN window: wire the host side of the detached-subwindow protocol. Responds
 * to a detached window's seed request by shipping its group's tabs+subtree,
 * applies edits streamed back into `detachedGroupsByScope`, and docks a group
 * back on request (closing its OS window). Register once at app startup; returns
 * a combined unlisten. The detached window never calls this — it is inert.
 */
export async function listenDetachedHost(): Promise<() => void> {
  const unSeed = await listen<DetachedSeedRequest>(DETACHED_REQUEST_SEED, (ev) => {
    const { label, scope, groupId } = ev.payload;
    const store = useTabsStore.getState();
    const entry = (store.detachedGroupsByScope[scope] ?? []).find(
      (d) => d.id === groupId,
    );
    if (!entry) return;
    const seed = buildSeed(scope, groupId, store.tabsByScope[scope] ?? [], entry.subtree);
    void emit(detachedSeedEvent(label), seed);
  });

  const unEdit = await listen<DetachedEditEnvelope>(DETACHED_EDIT, (ev) => {
    const { scope, groupId, edit } = ev.payload;
    useTabsStore.getState().applyDetachedEdit(scope, groupId, edit);
  });

  const unBounds = await listen<DetachedBoundsEnvelope>(DETACHED_BOUNDS, (ev) => {
    const { scope, groupId, bounds } = ev.payload;
    useTabsStore.getState().setDetachedBounds(scope, groupId, bounds);
  });

  const unDock = await listen<DetachedDockEnvelope>(DETACHED_DOCK, (ev) => {
    const { scope, groupId } = ev.payload;
    // `attachGroup` operates on the ACTIVE scope's live layout, so it can only
    // re-inject a group whose scope is currently active. When the detached
    // group's scope is the active one, dock it back into the live layout. When
    // it isn't (e.g. the WM closed a parked/hidden detached window of an
    // inactive project), `dropDetachedGroup` re-injects the subtree into that
    // scope's STORED layout (so its tabs still persist) and closes the OS
    // window — instead of stranding the group. Both paths close the OS window
    // via `attach_subwindow`.
    const store = useTabsStore.getState();
    if (store.scope === scope) {
      store.attachGroup(groupId);
    } else {
      store.dropDetachedGroup(scope, groupId);
    }
  });

  const unClose = await listen<DetachedDockEnvelope>(DETACHED_CLOSE, (ev) => {
    const { scope, groupId } = ev.payload;
    const store = useTabsStore.getState();
    // Closing the popout closes ITS tabs for good (no dock-back, no restore).
    store.closeDetachedGroup(scope, groupId);
    // Persist so the dropped tabs don't come back on next launch. For the active
    // scope CenterPanel's debounced save also covers this, but a parked
    // (inactive) scope has nothing else to write its project.json — persist it
    // explicitly. Root has no project.json, so there's nothing to persist.
    const localFile = useProjectsStore
      .getState()
      .projects.find((p) => p.id === scope)?.local_file;
    if (localFile) void store.persistScope(scope, localFile);
  });

  return () => {
    unSeed();
    unEdit();
    unBounds();
    unDock();
    unClose();
  };
}
