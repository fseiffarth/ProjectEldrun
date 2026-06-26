import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import {
  DETACHED_DRAG_END,
  DETACHED_DRAG_MOVE,
  DETACHED_DRAG_START,
  detachedDropPreviewEvent,
  type DetachedDragEnd,
  type DetachedDragMove,
  type DetachedDragStart,
  type DetachedDropPreview,
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

  // #42: listen for the main window's drop-target highlight toggle (a tab being
  // dragged out of the main window over this popout). Keyed by THIS window's
  // label so only the popout under the cursor lights up.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const label = getCurrentWindow().label;
    listen<DetachedDropPreview>(detachedDropPreviewEvent(label), (ev) => {
      setDropActive(ev.payload.active);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
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

  // #42: drag-to-dock. We stream the gesture's OS-LEVEL CURSOR position to the
  // main window, which maps it into its client space, renders the dock preview,
  // and docks on release. We do NOT rely on DOM pointer events crossing into the
  // main window: on WebKitGTK (especially Wayland) DOM pointermove/up do not cross
  // the OS window boundary, so the stream would die at the popout's edge and the
  // drop would commit at stale coords. Instead we POLL `cursorPosition()`; that is
  // a desktop-global PHYSICAL position, so we (a) divide by our scale factor to
  // emit logical/CSS px for the main window and (b) use the raw physical position
  // to move our OWN window so it follows the cursor. Release is via DOM
  // pointerup/pointercancel; END carries the LAST polled cursor position. Only
  // Escape cancels; pointercancel commits (WebKitGTK fires it for pointerup).
  const beginDockDrag = (args: {
    pointerId: number;
    screenX: number;
    screenY: number;
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
    try {
      captureEl?.setPointerCapture(pointerId);
    } catch {
      /* capture is best-effort; the OS-cursor poll does not depend on it */
    }

    const win = getCurrentWindow();
    let last = { x: args.screenX, y: args.screenY };
    let scale = 1;
    let done = false;
    let grab: { x: number; y: number } | null = null;
    let moving = false;
    let origin = { x: 0, y: 0 };

    void win
      .scaleFactor()
      .then(async (s) => {
        scale = s || 1;
        if (tabKey != null) {
          const ip = await win.innerPosition();
          const lg = ip.toLogical(scale);
          origin = { x: lg.x, y: lg.y };
        }
      })
      .catch(() => {});
    if (moveWindow) {
      void Promise.all([win.outerPosition(), cursorPosition()])
        .then(([pos, cur]) => {
          grab = { x: cur.x - pos.x, y: cur.y - pos.y };
        })
        .catch(() => {});
    }

    void emit(DETACHED_DRAG_START, {
      scope,
      // Cross-window protocol identifies the popout RECORD, not the inner group.
      groupId: popoutId,
      label: dragLabel,
      screenX: last.x,
      screenY: last.y,
      tabKey,
    } satisfies DetachedDragStart);

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

    const poll = window.setInterval(() => {
      void cursorPosition()
        .then((p) => {
          if (done) return;
          last = { x: p.x / scale, y: p.y / scale };
          void emit(DETACHED_DRAG_MOVE, {
            screenX: last.x,
            screenY: last.y,
          } satisfies DetachedDragMove);
          if (moveWindow && grab && !moving) {
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
          if (tabKey != null && sourceGroup) {
            const cx = last.x - origin.x;
            const cy = last.y - origin.y;
            const overPopout =
              cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;
            if (overPopout) {
              useDragStore.getState().move(cx, cy);
              resolveLocalTarget(cx, cy);
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

    const finish = (cancelled: boolean, shift = false) => {
      if (done) return;
      done = true;
      window.clearInterval(poll);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      try {
        captureEl?.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      if (tabKey != null) useDragStore.getState().end();
      void emit(DETACHED_DRAG_END, {
        cancelled,
        screenX: last.x,
        screenY: last.y,
        shift,
      } satisfies DetachedDragEnd);
    };
    const release = (shift = false) => {
      if (tabKey != null && sourceGroup) {
        const handledLocally = handleLocalTabRelease(
          tabKey,
          last.x - origin.x,
          last.y - origin.y,
        );
        finish(handledLocally, shift);
        return;
      }
      finish(false, shift);
    };
    const onUp = (ev: PointerEvent) => release(ev.shiftKey);
    const onCancel = (ev: PointerEvent) => release(ev.shiftKey);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") finish(true);
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
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
      screenX: e.screenX,
      screenY: e.screenY,
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
      screenX: e.screenX,
      screenY: e.screenY,
      captureEl: e.currentTarget as HTMLElement,
      label: activeLabel,
      moveWindow: true,
    });
  };

  // #42: dragging a SINGLE tab out of `group`. Activate on press, then once the
  // pointer crosses a threshold start a per-tab dock drag.
  const onTabPointerDown = (e: React.PointerEvent, group: GroupNode, tab: TabEntry) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onActivate(tab.key);
    const startX = e.screenX;
    const startY = e.screenY;
    let armed = false;
    const onMove = (ev: PointerEvent) => {
      if (armed) return;
      if (Math.hypot(ev.screenX - startX, ev.screenY - startY) < 5) return;
      armed = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      beginDockDrag({
        pointerId: ev.pointerId,
        screenX: ev.screenX,
        screenY: ev.screenY,
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
