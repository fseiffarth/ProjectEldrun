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
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  useTabsStore,
  orderedTabKeys,
  findGroupOfTab,
  mapGroup,
  removeKeyFromTree,
  splitSubtree,
  applyResize,
  moveKeyInTree,
  allGroups,
  type DropEdge,
  type LayoutNode,
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
 * and do not restore on next launch.
 */
export const DETACHED_CLOSE = "detached-close";
/** Detached → main: the popout's OS geometry changed (persisted for respawn). */
export const DETACHED_BOUNDS = "detached-bounds";
/**
 * #42: cross-window drag-to-dock. The detached window streams the gesture to the
 * main window, which renders the dock preview and docks the group on release.
 * START opens the preview, MOVE updates it, and END commits (or cancels). One
 * popout drags at a time, so MOVE/END carry no id.
 *
 * The streamed coords are OS-level desktop CURSOR coords in PHYSICAL desktop px
 * (the canonical cross-window space — see `lib/coords`), polled from
 * `cursorPosition()` — NOT DOM pointer-event coords. DOM `screenX/Y` units diverge
 * across engines under DPI scaling, and on WebKitGTK (esp. Wayland) DOM
 * pointermove/up don't cross the OS window boundary, so the DOM stream would die at
 * the popout's edge. Polling the OS cursor keeps MOVE flowing over the main window
 * in a single DPI-correct frame, and END carries the last polled cursor position so
 * the drop resolves where the cursor really is. The receiver converts physical →
 * its-own-client px at the leaf (`physToClient`), the only DPI-correct place.
 */
export const DETACHED_DRAG_START = "detached-drag-start";
export const DETACHED_DRAG_MOVE = "detached-drag-move";
export const DETACHED_DRAG_END = "detached-drag-end";

/**
 * #42: main → detached drop preview. The mirror image of the DETACHED_DRAG_*
 * stream: while a tab dragged OUT of the main window hovers over a popout, the
 * main window streams `active:true` on the popout's label-namespaced channel so
 * it highlights itself as a drop target; `active:false` (cursor left, released
 * elsewhere, or drag cancelled) clears it. The dock itself is a main-side store
 * mutation (`dockTabIntoDetached`) + re-seed — the popout only renders the
 * highlight, never owns the layout. Namespaced per label (like the seed) so the
 * main targets exactly the one popout under the cursor.
 */
export const detachedDropPreviewEvent = (label: string) =>
  `detached-drop-preview-${label}`;
/**
 * Main → detached: drive THIS popout's drop preview while a tab/file dragged out
 * of the main window hovers it. The host resolves WHICH pane the cursor is over
 * (synchronously, from the popout's reported geometry — see DETACHED_PANES) and
 * streams the resolved `target` here; the popout renders the per-pane split/merge
 * preview for it (no release race — the host already holds the target on release).
 * `active:false` clears the preview. `label` is the dragged item's name (ghost).
 */
export interface DetachedDropPreview {
  active: boolean;
  target?: { groupId: string; edge: DropEdge } | null;
  // OS cursor in PHYSICAL desktop px (see lib/coords) so the popout can position
  // its own drag ghost while the main-window item hovers (the main's ghost lives in
  // the main window and isn't visible over the popout). Cosmetic — the target
  // drives the drop.
  cursorPhysX?: number;
  cursorPhysY?: number;
  label?: string;
}

/**
 * Host → detached: ask a popout to report its per-pane geometry so the host can
 * hit-test the cursor against it. Sent once when a drag starts (the popout's tree
 * is fixed until the drop). Namespaced by label so only the addressed popout
 * replies. The popout answers on DETACHED_PANES.
 */
export const DETACHED_PANES_REQUEST = "detached-panes-request";
export interface DetachedPanesRequest {
  label: string;
}
/**
 * Detached → host: this popout's panes in CLIENT px (its own getBoundingClientRect
 * space). The host converts the physical cursor into THIS popout's client px via
 * its `innerPosition`/scale (`physToClient` — never `outerPosition`, so an
 * invisible frame/shadow can't skew it) before hit-testing against these: over a
 * bar → merge into that group; over a body → edge-split (pickEdge). One channel
 * carrying the label, so the host needs a single listener.
 */
export const DETACHED_PANES = "detached-panes";
export interface PaneRect {
  groupId: string;
  bar: { left: number; top: number; right: number; bottom: number };
  body: { left: number; top: number; right: number; bottom: number };
}
export interface DetachedPanes {
  label: string;
  panes: PaneRect[];
}

/**
 * Detached → main: begin a drag-to-dock. Without `tabKey` it drags the WHOLE
 * popout (the tab-bar handle); with `tabKey` it drags that single tab, which the
 * host docks on its own via `attachDetachedTab`.
 */
export interface DetachedDragStart {
  scope: string;
  groupId: string;
  label: string;
  cursorPhysX: number;
  cursorPhysY: number;
  tabKey?: string;
}
/** Detached → main: the OS cursor moved (physical desktop px — see lib/coords). */
export interface DetachedDragMove {
  cursorPhysX: number;
  cursorPhysY: number;
}
/**
 * Detached → main: the drag ended; `cancelled` skips docking. `cursorPhysX/Y` carry
 * the LAST OS-level cursor position (physical desktop px — see lib/coords), so the
 * main window resolves the drop against where the cursor actually is — not the
 * stale DOM coordinates of the release event, which on WebKitGTK fire inside the
 * popout even when the cursor is released over the main window. Absent only on a
 * cancel.
 */
export interface DetachedDragEnd {
  cancelled: boolean;
  cursorPhysX?: number;
  cursorPhysY?: number;
  /**
   * Shift held at release → keep the popout floating as its own window instead of
   * docking it back into the main window (mirrors the main-window tab rule where
   * Shift always means "new window"). For a drag that originates in a popout, the
   * popout already IS a separate window, so "always new window" = don't dock.
   */
  shift?: boolean;
}

/** The seed the main window ships to a freshly-opened detached window. */
export interface DetachedSeed {
  scope: string;
  groupId: string;
  tabs: TabEntry[];
  subtree: LayoutNode;
  /**
   * Set only when this seed is the result of a tab being docked INTO the popout
   * from another window (a cross-window merge): the docked tab's key, so the
   * popout plays the same drop-in landing flourish it would for an in-popout
   * merge. Absent on a plain (re)seed, so a refresh never re-animates.
   */
  landedKey?: string;
}

/** Build a seed payload from a detached popout's tabs + subtree. Pure. The
 *  subtree may be a split (multi-pane popout), so collect keys across the tree. */
export function buildSeed(
  scope: string,
  groupId: string,
  allScopeTabs: TabEntry[],
  subtree: LayoutNode,
): DetachedSeed {
  const keys = new Set(orderedTabKeys(subtree));
  // Ship only the popout's own tabs (it renders just this subtree).
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
  | { kind: "reorder"; tabKeys: string[] }
  // Multi-pane popouts: split `key` into a new pane at `edge` of `targetGroupId`.
  | { kind: "split"; key: string; targetGroupId: string; edge: DropEdge }
  // Multi-pane popouts: resize the divider between children i and i+1 of a split.
  | { kind: "resize"; splitId: string; dividerIndex: number; fraction: number }
  // Multi-pane popouts: merge `key` into `targetGroupId` (at `index`, else append).
  | { kind: "move"; key: string; targetGroupId: string; index?: number };

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
  subtree: LayoutNode,
  edit: DetachedEdit,
): LayoutNode | null {
  switch (edit.kind) {
    case "activate": {
      const g = findGroupOfTab(subtree, edit.key);
      return g
        ? mapGroup(subtree, g.group.id, (grp) => ({ ...grp, activeKey: edit.key }))
        : subtree;
    }
    case "close":
      // Returns null if the popout emptied (caller closes the window).
      return removeKeyFromTree(subtree, edit.key);
    case "reorder": {
      // Find the group whose tab set the reordered list permutes, then reapply.
      const want = new Set(edit.tabKeys);
      const g = allGroups(subtree).find(
        (grp) =>
          grp.tabKeys.length === edit.tabKeys.length &&
          grp.tabKeys.every((k) => want.has(k)),
      );
      if (!g) return subtree;
      return mapGroup(subtree, g.id, (grp) => {
        const activeKey =
          grp.activeKey && edit.tabKeys.includes(grp.activeKey)
            ? grp.activeKey
            : (edit.tabKeys[0] ?? null);
        return { ...grp, tabKeys: edit.tabKeys, activeKey };
      });
    }
    case "split": {
      // Optimistic local split; null (invalid) leaves the popout unchanged.
      return splitSubtree(subtree, edit.key, edit.targetGroupId, edit.edge) ?? subtree;
    }
    case "resize":
      // Optimistic local divider resize (mirrors the main window's resizeSplit).
      return applyResize(subtree, edit.splitId, edit.dividerIndex, edit.fraction);
    case "move":
      // Optimistic local cross-group merge; null (invalid) leaves it unchanged.
      return moveKeyInTree(subtree, edit.key, edit.targetGroupId, edit.index) ?? subtree;
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

/**
 * App-quit teardown for every open popout. Called from the MAIN window's
 * `onCloseRequested` before it destroys itself: a detached `WebviewWindow` lives
 * in the same process but is NOT a child of the main window, so closing the main
 * window alone strands the popouts on screen. For each scope that has detached
 * groups we (1) persist that scope so its `detached: true` flag + latest streamed
 * bounds reach project.json, then (2) `destroy()` each popout's OS window.
 *
 * We use `destroy()`, not `close()`, precisely to BYPASS the popout's own
 * `onCloseRequested` (which emits DETACHED_CLOSE → drops the group's tabs for
 * good). On a full-app quit the popouts must SURVIVE and re-open at their saved
 * bounds on next launch (via the docked→re-detach respawn path), exactly like the
 * main window's docked tabs — only an explicit per-popout WM close discards them.
 * Best-effort throughout: a failure here must never block the app from quitting.
 */
export async function shutdownDetachedWindows(): Promise<void> {
  const store = useTabsStore.getState();
  const projects = useProjectsStore.getState().projects;
  for (const [scope, entries] of Object.entries(store.detachedGroupsByScope)) {
    if (!entries || entries.length === 0) continue;
    // Persist the detached set + bounds durably. Root has no project.json, so its
    // popouts can't be restored — they just close.
    const localFile = projects.find((p) => p.id === scope)?.local_file;
    if (localFile) {
      await store.persistScope(scope, localFile).catch(() => {});
    }
    for (const entry of entries) {
      try {
        const win = await WebviewWindow.getByLabel(entry.label);
        await win?.destroy();
      } catch {
        /* best-effort: keep tearing down the rest */
      }
    }
  }
}
