import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import {
  snapshotFrame,
  physToClient,
  clientToPhys,
  desktopCursor,
  type PhysPoint,
  type WindowFrame,
} from "../../lib/coords";
import { bindDragRelease, dragPlatform } from "../../lib/dragPlatform";
import {
  DETACHED_DRAG_END,
  DETACHED_DRAG_MOVE,
  DETACHED_DRAG_START,
  DETACHED_PANES,
  DETACHED_PANES_REQUEST,
  detachedDropPreviewEvent,
  type DetachedDragEnd,
  type DetachedDragMove,
  type DetachedDragStart,
  type DetachedDropPreview,
  type DetachedPanes,
  type DetachedPanesRequest,
  type PaneRect,
} from "../../stores/detached";
import { TerminalView } from "../terminal/TerminalView";
import { FileBrowser } from "../files/FileBrowser";
import { EmbedPane } from "../embed/EmbedPane";
import { FileViewerPane } from "../embed/FileViewerPane";
import { WindowControls } from "../header/WindowControls";
import { DragGhost, SplitPreviewOverlay } from "./CenterPanel";
import { TabDropPlaceholder } from "../tabs/TabDropPlaceholder";
import { pickEdge } from "../tabs/dragGeometry";
import { useDragStore } from "../../stores/drag";
import { useTabLandStore } from "../../stores/tabLand";
import { useSettingsStore } from "../../stores/settings";
import {
  DEFAULT_MIN_SUBWINDOW_PX,
  allGroups,
  findGroup,
  type DropEdge,
  type GroupNode,
  type LayoutNode,
  type SplitNode,
  type TabEntry,
} from "../../stores/tabs";

/** Pixel coordinates of a group body, relative to the detached center panel. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Props {
  scope: string;
  /** The detached popout's identity (the main store's detached record id). Used
   *  for the cross-window drag protocol — NOT the inner group ids. */
  popoutId: string;
  /** The popout's content layout. A single group, or a split tree once the user
   *  splits panes inside the popout (multi-pane popouts). */
  tree: LayoutNode;
  /** All of the popout's tab payloads (across every group in the tree). */
  tabs: TabEntry[];
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  /** Reorder a bar's tabs (a tab dragged + dropped back onto its own bar). The
   *  main store resolves WHICH group from the key set. */
  onReorder: (tabKeys: string[]) => void;
  /** Split `key` into a new pane at `edge` of `targetGroupId`, inside the popout
   *  (a tab dragged onto a group BODY's edge). */
  onSplit: (key: string, targetGroupId: string, edge: DropEdge) => void;
  /** Resize the divider between children `dividerIndex`/`dividerIndex+1` of
   *  `splitId` inside the popout (a split divider drag). */
  onResize: (splitId: string, dividerIndex: number, fraction: number) => void;
  /** Merge `key` into `targetGroupId` (at `index`, else append) — a tab dragged
   *  onto ANOTHER group's bar (or body center) inside a split popout. */
  onMove: (key: string, targetGroupId: string, index?: number) => void;
}

/**
 * #42 / multi-pane: the detached window's center surface. A stripped CenterPanel
 * that renders the popout's layout TREE — each group as a tab bar + pane layer,
 * splits as flex rows/columns — with no project switcher, right panel, or
 * project-switch effects. Terminals run ATTACH-ONLY (the PTY is owned by the main
 * window's pane), so they never spawn or kill a PTY. Each group keeps every tab
 * mounted; only the active one shows.
 */
export function DetachedCenterPanel({
  scope,
  popoutId,
  tree,
  tabs,
  onActivate,
  onClose,
  onReorder,
  onSplit,
  onResize,
  onMove,
}: Props) {
  // One bar element per group, so a per-tab drag can hit-test the bar it's over.
  const barRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // One body element per group, for resolving an edge-split drop target.
  const bodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // The panel element, the coordinate origin for the split-preview overlay.
  const panelRef = useRef<HTMLDivElement>(null);
  // Measured group-body rects (panel-relative px) feeding the split-preview
  // overlay, which must paint ABOVE the per-group panes (opaque terminals) — so,
  // like the main window, it lives at the panel level rather than in a body.
  const [groupRects, setGroupRects] = useState<Record<string, Rect>>({});
  // Minimum subwindow size (px) a divider drag may shrink a pane to, per axis.
  const minWidth = useSettingsStore((s) => s.settings?.min_subwindow_width) ?? DEFAULT_MIN_SUBWINDOW_PX;
  const minHeight = useSettingsStore((s) => s.settings?.min_subwindow_height) ?? DEFAULT_MIN_SUBWINDOW_PX;
  // #42 (main → detached): true while a tab dragged out of the MAIN window hovers
  // over THIS popout, so we paint a drop-target highlight. The main window streams
  // the toggle on our label-namespaced channel and commits the dock itself (it
  // owns the layout); we only render the cue. See `detachedDropPreviewEvent`.
  const [dropActive, setDropActive] = useState(false);
  // Within-bar reorder visuals, driven by THIS popout's own drag store (a
  // separate JS heap from the main window). While a tab is dragged, the dragged
  // tab collapses and a gap slides open at the live drop slot.
  const dragKey = useDragStore((s) => (s.drag ? s.drag.key : null));
  const reorderGroupId = useDragStore((s) => (s.drag ? s.drag.reorderGroup : null));
  const reorderIndex = useDragStore((s) => (s.drag ? s.drag.reorderIndex : null));
  // Label of the dragged tab, shown in the drop placeholder so the target bar
  // previews WHICH tab will land there — mirrors the main-window `TabBar`.
  const dragLabel = useDragStore((s) => (s.drag ? s.drag.label : ""));
  // One-shot "landing" flourish, driven by THIS popout's own tabLand store (a
  // separate JS heap from the main window). A tab merged/split/moved into a bar
  // inside the popout plays the same drop-in as the main window. `markLanded` is
  // fired from `handleLocalTabRelease` on the same cross-group rules `commitDrop`
  // uses (never on a same-group reorder).
  const landedKey = useTabLandStore((s) => s.landed?.key ?? null);
  const landedNonce = useTabLandStore((s) => s.landed?.nonce ?? 0);
  const clearLanded = useTabLandStore((s) => s.clear);
  const byKey = new Map(tabs.map((t) => [t.key, t] as const));

  // ── Pane-region measurement (for the split-preview overlay) ───────────────
  // Recompute every group body's rect (relative to the panel) so the overlay can
  // paint the half/whole a split drop would carve out. Mirrors CenterPanel.measure.
  const measure = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const base = panel.getBoundingClientRect();
    const next: Record<string, Rect> = {};
    for (const [id, el] of bodyRefs.current) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      next[id] = { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
    }
    setGroupRects((prev) => {
      const keys = Object.keys(next);
      if (keys.length === Object.keys(prev).length) {
        let same = true;
        for (const k of keys) {
          const a = next[k];
          const b = prev[k];
          if (!b || a.left !== b.left || a.top !== b.top || a.width !== b.width || a.height !== b.height) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return next;
    });
  }, []);

  // Re-measure when the popout's tree changes (split added/removed/resized).
  useLayoutEffect(() => {
    measure();
  }, [measure, tree]);

  // Re-measure on panel/body resize and OS-window resize (WebKitGTK sometimes
  // misses the latter via ResizeObserver — DetachedApp bridges it to 'resize').
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(panel);
    for (const el of bodyRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [measure, tree]);
  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  // A split divider drag inside the popout. Mirrors CenterPanel's SplitView: the
  // new fraction is the pointer position within the split container, clamped so
  // neither side of the dragged pair shrinks below the min subwindow size. The
  // resize streams back to the main window via `onResize` (a "resize" edit), so
  // the host's `detachedGroupsByScope` record stays the source of truth.
  const onDividerPointerDown =
    (node: SplitNode, dividerIndex: number) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const container = (e.currentTarget as HTMLElement).parentElement;
      if (!container) return;
      const captureEl = e.target as HTMLElement;
      captureEl.setPointerCapture?.(e.pointerId);
      const onMove = (ev: PointerEvent) => {
        const rect = container.getBoundingClientRect();
        const isRow = node.dir === "row";
        const total = isRow ? rect.width : rect.height;
        if (total <= 0) return;
        const pos = isRow ? ev.clientX - rect.left : ev.clientY - rect.top;
        const wholeFraction = Math.min(Math.max(pos / total, 0), 1);
        let before = 0;
        for (let i = 0; i < dividerIndex; i++) before += node.sizes[i];
        const pair = node.sizes[dividerIndex] + node.sizes[dividerIndex + 1];
        const leftSize = wholeFraction - before;
        const minPx = isRow ? minWidth : minHeight;
        const minFrac = Math.min(minPx / total, pair / 2);
        const clamped = Math.min(Math.max(leftSize, minFrac), pair - minFrac);
        onResize(node.id, dividerIndex, clamped);
      };
      const onUp = (ev: PointerEvent) => {
        captureEl.releasePointerCapture?.(ev.pointerId);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };

  // #42: a tab/file dragged out of the MAIN window over this popout. We (1) answer
  // the host's panes request with our per-pane client geometry, so the host
  // hit-tests the cursor SYNCHRONOUSLY (no release race), and (2) render the
  // per-pane split/merge preview for the target the host streams back — via a
  // synthetic local drag so the SAME SplitPreviewOverlay + ghost light up as an
  // in-popout drag. The dock itself is the host's store mutation + re-seed.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    const win = getCurrentWindow();
    const label = win.label;
    let active = false;
    // Our window frame (physical px), used to map the streamed physical cursor into
    // our own client px for the ghost position; snapshotted lazily on the first
    // hover (the popout doesn't move/rescale mid-gesture).
    let frame: WindowFrame | null = null;
    const refreshFrame = async () => {
      try {
        frame = await snapshotFrame(win);
      } catch {
        frame = null;
      }
    };
    const reg = (p: Promise<() => void>) =>
      p.then((fn) => (cancelled ? fn() : unlisteners.push(fn))).catch(() => {});

    // Render the host-resolved target as our split-preview, and follow the ghost.
    const apply = (p: DetachedDropPreview) => {
      if (p.cursorPhysX != null && p.cursorPhysY != null && frame) {
        // physical desktop px → our own client px (via innerPhys/scale, the only
        // DPI-correct conversion); valid even though the cursor is outside us.
        const c = physToClient(frame, { x: p.cursorPhysX, y: p.cursorPhysY });
        useDragStore.getState().move(c.x, c.y);
      }
      const t = p.target;
      useDragStore.getState().setTarget(
        t
          ? { overGroup: t.groupId, edge: t.edge, reorderGroup: null, reorderIndex: null }
          : { overGroup: null, edge: null, reorderGroup: null, reorderIndex: null },
      );
    };

    // (1) Report our pane geometry (client px) when the host asks at drag start.
    reg(
      listen<DetachedPanesRequest>(DETACHED_PANES_REQUEST, (ev) => {
        if (ev.payload.label !== label) return;
        const panes: PaneRect[] = [];
        for (const [gid, bar] of barRefs.current) {
          const body = bodyRefs.current.get(gid);
          if (!body) continue;
          const br = bar.getBoundingClientRect();
          const bo = body.getBoundingClientRect();
          panes.push({
            groupId: gid,
            bar: { left: br.left, top: br.top, right: br.right, bottom: br.bottom },
            body: { left: bo.left, top: bo.top, right: bo.right, bottom: bo.bottom },
          });
        }
        void emit(DETACHED_PANES, { label, panes } satisfies DetachedPanes);
      }),
    );

    // (2) Render the preview for the streamed target.
    reg(
      listen<DetachedDropPreview>(detachedDropPreviewEvent(label), (ev) => {
        const p = ev.payload;
        if (!p.active) {
          if (active) {
            active = false;
            useDragStore.getState().end();
          }
          setDropActive(false);
          return;
        }
        setDropActive(true);
        if (!active) {
          active = true;
          useDragStore.getState().start({
            key: "",
            fromGroup: "",
            label: p.label ?? "",
            pointerX: 0,
            pointerY: 0,
            previewNode: null,
            previewW: 0,
            previewH: 0,
          });
          void refreshFrame().then(() => apply(p));
          return;
        }
        apply(p);
      }),
    );

    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
      if (active) useDragStore.getState().end();
    };
    // Mount once: the listeners key off our (stable) window label.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve the within-popout drop target under a popout-client point and write
  // it to this popout's drag store: a tab BAR → within-bar reorder slot; a group
  // BODY → edge split of that group. Mirrors CenterPanel.resolveTarget, but scans
  // this popout's own per-group bar/body refs (it may have several once split).
  const resolveLocalTarget = (clientX: number, clientY: number) => {
    const setTarget = useDragStore.getState().setTarget;
    const clear = () =>
      setTarget({ overGroup: null, edge: null, reorderGroup: null, reorderIndex: null });
    const inside = (r: DOMRect) =>
      clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;

    for (const [gid, bar] of barRefs.current) {
      const br = bar.getBoundingClientRect();
      if (!inside(br)) continue;
      const tabEls = Array.from(bar.querySelectorAll<HTMLElement>(".tab"));
      let slot = tabEls.length;
      for (let i = 0; i < tabEls.length; i++) {
        const r = tabEls[i].getBoundingClientRect();
        if (clientX < r.left + r.width / 2) {
          slot = i;
          break;
        }
      }
      setTarget({ overGroup: null, edge: null, reorderGroup: gid, reorderIndex: slot });
      return;
    }
    for (const [gid, body] of bodyRefs.current) {
      const r = body.getBoundingClientRect();
      if (!inside(r)) continue;
      const edge = pickEdge(
        { left: r.left, top: r.top, width: r.width, height: r.height },
        clientX,
        clientY,
      );
      setTarget({ overGroup: gid, edge, reorderGroup: null, reorderIndex: null });
      return;
    }
    clear();
  };

  // A per-tab drag released over THIS popout: commit the LAST resolved target
  // (set by resolveLocalTarget during the drag) — a bar slot reorders, a body
  // edge splits. Returns true if the release was over this popout at all (so the
  // host must NOT also dock it into the main window).
  const handleLocalTabRelease = (
    tabKey: string,
    clientX: number,
    clientY: number,
  ): boolean => {
    const overPopout =
      clientX >= 0 &&
      clientY >= 0 &&
      clientX <= window.innerWidth &&
      clientY <= window.innerHeight;
    if (!overPopout) return false;
    const drag = useDragStore.getState().drag;
    if (!drag) return true;
    // Body edge → split this group inside the popout. A non-center edge splits
    // off a new pane; "center" over a DIFFERENT group merges into it (over the
    // source group it's a no-op, matching the main window's commitDrop). Both
    // land the tab in a new bar, so play the drop-in landing (as commitDrop does).
    if (drag.overGroup && drag.edge) {
      if (drag.edge !== "center") {
        onSplit(tabKey, drag.overGroup, drag.edge);
        useTabLandStore.getState().markLanded(tabKey);
      } else if (drag.overGroup !== drag.fromGroup) {
        onMove(tabKey, drag.overGroup);
        useTabLandStore.getState().markLanded(tabKey);
      }
      return true;
    }
    // Bar slot → reorder within the same group, or merge into another group's bar.
    if (drag.reorderGroup && drag.reorderIndex != null) {
      if (drag.reorderGroup === drag.fromGroup) {
        const group = findGroup(tree, drag.reorderGroup);
        if (group) {
          const cur = group.tabKeys;
          const from = cur.indexOf(tabKey);
          if (from >= 0) {
            let to = drag.reorderIndex;
            if (from < to) to -= 1; // account for the source's own removal.
            if (to !== from) {
              const next = [...cur];
              next.splice(from, 1);
              next.splice(to, 0, tabKey);
              onReorder(next);
            }
          }
        }
      } else {
        // Dropped onto another group's bar → move the tab there at the slot.
        // The slot indexes the target's tabs (which don't contain the key), so
        // it needs no source-removal adjustment. A cross-group move lands the
        // tab in a new bar → play the drop-in landing (as commitDrop does).
        onMove(tabKey, drag.reorderGroup, drag.reorderIndex);
        useTabLandStore.getState().markLanded(tabKey);
      }
    }
    return true;
  };

  // #42: drag-to-dock. We stream the gesture's OS-LEVEL CURSOR position (PHYSICAL
  // desktop px — the canonical cross-window space, see lib/coords) to the main
  // window, which maps it into its own client space and renders the dock preview /
  // docks on release. We do NOT rely on DOM pointer events crossing into the main
  // window: on WebKitGTK (esp. Wayland) DOM pointermove/up don't cross the OS
  // window boundary, and DOM `screenX/Y` units diverge across engines under DPI
  // scaling. Instead we POLL `cursorPosition()` (already physical, cross-engine):
  // (a) emit it verbatim for the main window, and (b) on Linux only — see
  // `followWindowOnDockDrag` — use it to move our OWN window so it follows the
  // cursor (on Win/mac `setPosition` under a held button can drop pointer capture).
  // Release is centralized through `bindDragRelease`, which applies the
  // engine-correct cancel-vs-commit policy; END carries the last polled cursor.
  const beginDockDrag = (args: {
    pointerId: number;
    clientX?: number;
    clientY?: number;
    captureEl: HTMLElement | null;
    label: string;
    moveWindow: boolean;
    // The source group of a per-tab drag (for local ghost/reorder visuals).
    sourceGroup?: GroupNode;
    tabKey?: string;
  }) => {
    const { pointerId, captureEl, label: dragLabel, moveWindow, tabKey, sourceGroup } = args;
    // Per-tab drags pass `captureEl: null` (no stable element under the pointer);
    // on engines that need capture to deliver the terminal event, fall back to a
    // stable element (the panel root, else document.body). Without this, dragging a
    // SINGLE tab out of a popout never receives its release on Win/mac and never
    // docks. WebKitGTK keeps the implicit grab, so it needs no capture at all.
    const capEl =
      captureEl ??
      (dragPlatform.needsPointerCapture ? (panelRef.current ?? document.body) : null);
    // Capture whenever a real element is present (preserves the old unconditional
    // Linux capture for whole-window/group/titlebar drags); the `capEl` fallback
    // ADDS capture only on engines that need it (Win/mac) for the per-tab case.
    if (capEl) {
      try {
        capEl.setPointerCapture(pointerId);
      } catch {
        /* capture is best-effort; the OS-cursor poll does not depend on it */
      }
    }

    const win = getCurrentWindow();
    // `last` tracks the physical desktop cursor (the canonical cross-window space).
    let last: PhysPoint = { x: 0, y: 0 };
    let done = false;
    let grab: { x: number; y: number } | null = null;
    let moving = false;
    // Our own window frame (physical px), for mapping the physical cursor back into
    // our client px for the local per-tab hit-test. Snapshotted up front.
    let popoutFrame: WindowFrame | null = null;
    let pollId: number | null = null;
    let unbindRelease: (() => void) | null = null;

    // Per-tab drags show a local ghost immediately (no frame needed): clone the
    // dragged pane and seed the popout's own drag store synchronously on press.
    if (tabKey != null) {
      const pane =
        Array.from(
          document.querySelectorAll<HTMLElement>(
            `.center-pane[data-tab-key="${CSS.escape(tabKey)}"]`,
          ),
        ).find((el) => el.getBoundingClientRect().width > 0) ?? null;
      let previewNode: HTMLElement | null = null;
      let previewW = 0;
      let previewH = 0;
      if (pane) {
        const r = pane.getBoundingClientRect();
        previewW = r.width;
        previewH = r.height;
        previewNode = pane.cloneNode(true) as HTMLElement;
        previewNode.style.position = "static";
        previewNode.style.left = "";
        previewNode.style.top = "";
        previewNode.style.display = "flex";
        previewNode.style.width = `${previewW}px`;
        previewNode.style.height = `${previewH}px`;
      }
      useDragStore.getState().start({
        key: tabKey,
        fromGroup: sourceGroup?.id ?? popoutId,
        label: dragLabel,
        pointerX: args.clientX ?? 0,
        pointerY: args.clientY ?? 0,
        previewNode,
        previewW,
        previewH,
      });
    }

    const startPoll = () => {
      pollId = window.setInterval(() => {
        void cursorPosition()
          .then((p) => {
            if (done) return;
            last = { x: p.x, y: p.y };
            void emit(DETACHED_DRAG_MOVE, {
              cursorPhysX: p.x,
              cursorPhysY: p.y,
            } satisfies DetachedDragMove);
            // Linux-only cosmetic window-follow (Win/mac: the main window already
            // paints the preview + ghost; setPosition would fight the OS).
            if (moveWindow && dragPlatform.followWindowOnDockDrag && grab && !moving) {
              moving = true;
              void win
                .setPosition(
                  new PhysicalPosition(
                    Math.round(p.x - grab.x),
                    Math.round(p.y - grab.y),
                  ),
                )
                .catch(() => {})
                .finally(() => {
                  moving = false;
                });
            }
            if (tabKey != null && sourceGroup && popoutFrame) {
              // physical desktop px → our own client px (innerPhys/scale), the only
              // DPI-correct conversion — never outerPosition.
              const c = physToClient(popoutFrame, { x: p.x, y: p.y });
              const overPopout =
                c.x >= 0 && c.y >= 0 && c.x <= window.innerWidth && c.y <= window.innerHeight;
              if (overPopout) {
                useDragStore.getState().move(c.x, c.y);
                resolveLocalTarget(c.x, c.y);
              } else if (
                useDragStore.getState().drag?.reorderGroup ||
                useDragStore.getState().drag?.overGroup
              ) {
                useDragStore.getState().setTarget({
                  overGroup: null,
                  edge: null,
                  reorderGroup: null,
                  reorderIndex: null,
                });
              }
            }
          })
          .catch(() => {});
      }, 16);
    };

    // Snapshot our frame, seed the gesture's initial physical cursor, emit START,
    // THEN start the poll — so a MOVE never reaches the main window before START
    // (the main's MOVE/END handlers guard on the in-flight detached drag).
    void snapshotFrame(win)
      .then(async (f) => {
        if (done) return;
        popoutFrame = f;
        // Seed: for a per-tab drag, derive from the press's client coords (exact
        // origin of the gesture); otherwise read the OS cursor (physical).
        const seed: PhysPoint =
          tabKey != null && args.clientX != null && args.clientY != null
            ? clientToPhys(f, { x: args.clientX, y: args.clientY })
            : await desktopCursor().catch(() => ({ x: f.innerPhys.x, y: f.innerPhys.y }));
        if (done) return;
        last = seed;
        if (moveWindow) {
          // Grab offset = cursor − window origin, both physical, so the window
          // tracks the cursor without jumping. Computed for BOTH window-follow
          // modes: on Linux the poll uses it per-tick to follow the cursor; on
          // Win/mac (`!followWindowOnDockDrag`) the poll skips the follow, but
          // `finish` uses this same offset for ONE final `setPosition` so a
          // free-space release lands the popout where it was dropped instead of
          // leaving it frozen at its start position (the Windows regression).
          try {
            const cur = await cursorPosition();
            grab = { x: cur.x - f.outerPhys.x, y: cur.y - f.outerPhys.y };
          } catch {
            grab = null;
          }
        }
        void emit(DETACHED_DRAG_START, {
          scope,
          // Cross-window protocol identifies the popout RECORD, not the inner group.
          groupId: popoutId,
          label: dragLabel,
          cursorPhysX: seed.x,
          cursorPhysY: seed.y,
          tabKey,
        } satisfies DetachedDragStart);
        startPoll();
      })
      .catch(() => {});

    const finish = (cancelled: boolean, shift = false) => {
      if (done) return;
      done = true;
      if (pollId != null) window.clearInterval(pollId);
      unbindRelease?.();
      try {
        capEl?.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      if (tabKey != null) useDragStore.getState().end();
      // Win/mac whole-window free-space release: the per-tick window-follow is
      // disabled there (`!followWindowOnDockDrag`), so the popout never moved
      // during the gesture and the main window's END no-ops on a free-space
      // (inMain=false) drop — leaving the popout frozen at its origin. Move it
      // ONCE here to where it was dropped, using the same grab offset the Linux
      // follow uses. Skipped on cancel (Escape leaves it put). Harmless vs a
      // dock-back: if released over the main window, attach_subwindow destroys
      // this window an instant later, so a stray setPosition has no effect.
      if (!cancelled && moveWindow && !dragPlatform.followWindowOnDockDrag && grab) {
        void win
          .setPosition(
            new PhysicalPosition(
              Math.round(last.x - grab.x),
              Math.round(last.y - grab.y),
            ),
          )
          .catch(() => {});
      }
      void emit(DETACHED_DRAG_END, {
        cancelled,
        cursorPhysX: last.x,
        cursorPhysY: last.y,
        shift,
      } satisfies DetachedDragEnd);
    };
    const release = (shift = false) => {
      if (tabKey != null && sourceGroup && popoutFrame) {
        const c = physToClient(popoutFrame, last);
        const handledLocally = handleLocalTabRelease(tabKey, c.x, c.y);
        finish(handledLocally, shift);
        return;
      }
      finish(false, shift);
    };
    // bindDragRelease applies the engine-correct policy (WebKitGTK: pointercancel
    // commits; Win/mac: pointercancel aborts) + a blur backstop. Bound synchronously
    // so the terminal event is captured from the start of the gesture.
    unbindRelease = bindDragRelease({
      onCommit: (shift) => release(shift),
      onAbort: () => finish(true),
    });
  };

  // #42: grab a group's empty bar area to move/dock the WHOLE popout window.
  const onGroupBarPointerDown = (e: React.PointerEvent, group: GroupNode) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".tab, .detached-titlebar-controls, button")) return;
    e.preventDefault();
    const activeLabel =
      group.tabKeys
        .map((k) => byKey.get(k))
        .find((t) => t?.key === group.activeKey)?.label ?? "Subwindow";
    beginDockDrag({
      pointerId: e.pointerId,
      captureEl: e.currentTarget as HTMLElement,
      label: activeLabel,
      moveWindow: true,
    });
  };

  // #42: grab the popout's outer title bar to move/dock the WHOLE window. Mirrors
  // the group-bar handle, but anchored to the always-full-width title strip so it
  // works the same whether or not the content is split. The window controls carry
  // `no-drag`, so a click on min/max/close never starts a drag.
  const onTitlebarPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".detached-titlebar-controls, button, .no-drag")) return;
    e.preventDefault();
    const first = allGroups(tree)[0];
    const activeLabel =
      (first ? tabs.find((t) => t.key === first.activeKey)?.label : undefined) ?? "Subwindow";
    beginDockDrag({
      pointerId: e.pointerId,
      captureEl: e.currentTarget as HTMLElement,
      label: activeLabel,
      moveWindow: true,
    });
  };

  // #42: dragging a SINGLE tab out of `group`. Activate on press, then once the
  // pointer crosses a threshold start a per-tab dock drag. The threshold uses DOM
  // `clientX/Y` (reliable in-window CSS px on every engine); cross-window position
  // is poll-driven inside beginDockDrag. The press's client coords seed the gesture.
  const onTabPointerDown = (e: React.PointerEvent, group: GroupNode, tab: TabEntry) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onActivate(tab.key);
    const startX = e.clientX;
    const startY = e.clientY;
    let armed = false;
    const onMove = (ev: PointerEvent) => {
      if (armed) return;
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      armed = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      beginDockDrag({
        pointerId: ev.pointerId,
        clientX: ev.clientX,
        clientY: ev.clientY,
        captureEl: null,
        sourceGroup: group,
        tabKey: tab.key,
        label: tab.label,
        moveWindow: false,
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Render one group: its tab bar + a pane layer holding every tab (active shown).
  // For a single-group popout this is the whole content; inside a split each group
  // renders into its flex cell. The min/max/close window controls live in the
  // popout's dedicated outer title bar (not here), so they stay pinned top-right
  // regardless of how the content is split.
  const renderGroup = (group: GroupNode) => {
    const orderedTabs = group.tabKeys
      .map((k) => byKey.get(k))
      .filter((t): t is TabEntry => t != null);
    // This bar is the live drop target of an in-flight drag: light up the whole
    // bar and render a placeholder slot at the insertion point — identical to the
    // main-window `TabBar` (shared `.drop-target` wash + `TabDropPlaceholder`),
    // replacing the old fixed-margin gap so the merge/reorder preview matches.
    const localReorder = reorderGroupId === group.id ? reorderIndex : null;
    const isDropTarget = localReorder != null;
    const dropPlaceholder = <TabDropPlaceholder label={dragLabel} />;
    return (
      <div className="subwindow focused">
        <div
          ref={(el) => {
            if (el) barRefs.current.set(group.id, el);
            else barRefs.current.delete(group.id);
          }}
          className={`tab-bar detached-drag-handle${isDropTarget ? " drop-target" : ""}`}
          data-group-id={group.id}
          onPointerDown={(e) => onGroupBarPointerDown(e, group)}
        >
          {/* Empty bar that's a drop target: the placeholder is the only slot. */}
          {isDropTarget && orderedTabs.length === 0 && (
            <Fragment key="drop-marker">{dropPlaceholder}</Fragment>
          )}
          {orderedTabs.map((tab, index) => {
            const isActive = tab.key === group.activeKey;
            const isDragging = dragKey === tab.key;
            // The placeholder slot previewing where the dragged tab will land —
            // shown immediately before the tab at the resolved insertion index.
            const showMarkerBefore = isDropTarget && localReorder === index;
            // A tab freshly dropped into this bar plays the drop-in landing once.
            const landing = !isDragging && landedKey === tab.key;
            return (
              <Fragment key={tab.key}>
                {showMarkerBefore && dropPlaceholder}
                <div
                  className={`tab ${isActive ? "active" : ""}${isDragging ? " dragging" : ""}${landing ? " landing" : ""}`}
                  onPointerDown={(e) => onTabPointerDown(e, group, tab)}
                  // Clear the landing once it finishes so the class doesn't linger
                  // (guard on currentTarget so a child's animationend never clears
                  // it early). Mirrors the main-window `TabBar`.
                  onAnimationEnd={
                    landing
                      ? (e) => {
                          if (e.target === e.currentTarget) clearLanded(landedNonce);
                        }
                      : undefined
                  }
                >
                  <span className="tab-label">{tab.label}</span>
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(tab.key);
                    }}
                    title="Close tab"
                  >
                    ×
                  </button>
                </div>
              </Fragment>
            );
          })}
          {/* Insertion at the end of the bar (slot === tab count). */}
          {isDropTarget && localReorder === orderedTabs.length && orderedTabs.length > 0 && (
            <Fragment key="drop-marker-end">{dropPlaceholder}</Fragment>
          )}
        </div>
        <div
          className="subwindow-body"
          ref={(el) => {
            if (el) bodyRefs.current.set(group.id, el);
            else bodyRefs.current.delete(group.id);
          }}
        >
          <div className="pane-layer">
            {orderedTabs.map((tab) => {
              const visible = tab.key === group.activeKey;
              const style: React.CSSProperties = visible
                ? { display: "flex", left: 0, top: 0, right: 0, bottom: 0 }
                : { display: "none" };
              return (
                <div key={tab.key} className="center-pane" data-tab-key={tab.key} style={style}>
                  {tab.kind === "files" ? (
                    <FileBrowser
                      projectDir={tab.cwd}
                      projectId={scope === "root" ? null : scope}
                      active={visible}
                    />
                  ) : tab.kind === "embed" ? (
                    tab.viewer ? (
                      <FileViewerPane
                        viewer={tab.viewer}
                        path={tab.embedPath ?? ""}
                        projectId={scope === "root" ? null : scope}
                        tabKey={tab.key}
                        visible={visible}
                      />
                    ) : (
                      <EmbedPane
                        path={tab.embedPath ?? ""}
                        exec={tab.embedExec}
                        projectId={scope === "root" ? null : scope}
                        visible={visible}
                      />
                    )
                  ) : (
                    <TerminalView
                      id={`${scope}:${tab.key}`}
                      cmd={tab.cmd}
                      args={tab.args ?? []}
                      env={tab.env ?? {}}
                      cwd={tab.cwd}
                      localOnly={tab.kind === "local_agent"}
                      zoomable={tab.kind === "agent" || tab.kind === "local_agent"}
                      visible={visible}
                      focused={visible}
                      attachOnly
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  // Recursively render the popout's layout tree. Splits become flex rows/columns
  // sized by their fractions; groups render their bar + panes.
  const renderNode = (node: LayoutNode): React.ReactNode => {
    if (node.type === "group") {
      return renderGroup(node);
    }
    return (
      <div
        className={`split split-${node.dir}`}
        style={{
          display: "flex",
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          flexDirection: node.dir === "row" ? "row" : "column",
        }}
      >
        {node.children.map((child, i) => (
          <Fragment key={child.id}>
            <div
              className="split-child"
              style={{
                flex: `${node.sizes[i] ?? 1 / node.children.length} 1 0`,
                display: "flex",
                minWidth: 0,
                minHeight: 0,
              }}
            >
              {renderNode(child)}
            </div>
            {i < node.children.length - 1 && (
              <div
                className={`split-divider split-divider-${node.dir}`}
                onPointerDown={onDividerPointerDown(node, i)}
              />
            )}
          </Fragment>
        ))}
      </div>
    );
  };

  return (
    <div className="detached-center center-panel">
      {/* #42: the popout's own title bar — a full-width strip ABOVE the tab layout
          that always hosts the min/max/close controls top-right. They used to live
          in the root group's tab bar, which slid left (with the root group) once
          the popout was split; an outer frame keeps them pinned. The empty strip
          is a drag handle for moving / docking the whole window. */}
      <div className="detached-titlebar detached-drag-handle" onPointerDown={onTitlebarPointerDown}>
        <div className="detached-titlebar-controls no-drag">
          <WindowControls />
        </div>
      </div>
      {/* The layout tree (below the title bar) is the positioning context for the
          absolutely-inset split/subwindow nodes and the split-preview overlay. */}
      <div ref={panelRef} className="detached-body">
        {renderNode(tree)}
        {/* Split preview: the translucent half/whole a split drop would carve out,
            drawn above the per-group panes (mirrors the main window). */}
        <SplitPreviewOverlay groupRects={groupRects} />
      </div>
      {dropActive && <div className="detached-drop-target" />}
      <DragGhost />
    </div>
  );
}
