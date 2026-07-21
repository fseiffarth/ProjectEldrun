import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { bindDragRelease, dragPlatform, PLATFORM } from "../../lib/dragPlatform";
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
import { FileDropContext, type FileDropController } from "../files/fileDropContext";
import { fileDropPayloads } from "../tabs/commitFileDrop";
import { TabPane } from "../tabs/TabPane";
import {
  clampFilesWidth,
  DEFAULT_GROUP_FILES_WIDTH,
  SubwindowFilesSidebar,
} from "../files/SubwindowFilesSidebar";
import { useWindowFocused } from "../../hooks/useWindowFocused";
import { TabHoverCard } from "../tabs/TabHoverCard";
import { WindowControls } from "../header/WindowControls";
import { DragGhost, SplitPreviewOverlay } from "./CenterPanel";
import { TabDropPlaceholder } from "../tabs/TabDropPlaceholder";
import { NewTabMenu } from "../tabs/NewTabMenu";
import { CustomAgentDialog } from "../tabs/CustomAgentDialog";
import { pickEdge } from "../tabs/dragGeometry";
import {
  chordMatches,
  resolveChord,
  type ShortcutAction,
  type ShortcutMap,
} from "../../lib/shortcuts";
import { isEditableTarget } from "../../hooks/useKeyboard";
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
  type TabLocation,
} from "../../stores/tabs";
import type { DetachedRemoteInfo } from "../../stores/detached";
import {
  TabSourceBadge,
  TabLocalityBadge,
  LocalityMenu,
  tabLocation,
  type LocalityMenuState,
} from "../tabs/TabLocalityBadges";

/** Pixel coordinates of a group body, relative to the detached center panel. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The horizontally-scrolling tab strip + flanking chevrons — the SAME overflow
 * behaviour as the main window's `TabBar` (click-scroll, continuous hover-scroll,
 * wheel-to-horizontal, chevrons that appear only on overflow). Extracted as its
 * own component so each group's bar in a (possibly multi-pane) popout gets its
 * own strip ref + scroll state, exactly as each main-window `TabBar` instance
 * does. The bar div, its detach-drag handler, and the per-group `barRefs`
 * registration stay in `renderGroup`; this only owns the scroll chrome.
 */
function DetachedTabStrip({
  children,
  revision,
}: {
  children: React.ReactNode;
  /** Changes whenever the group's tab set (or its drop placeholder) changes, so
   *  overflow is re-evaluated — adding/removing tabs alters the strip's
   *  scrollWidth without resizing its own box, which the ResizeObserver misses. */
  revision: string;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = stripRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  // Track overflow so the chevrons toggle with the strip's size/content (mirrors
  // the main-window `TabBar`): Resize catches the strip shrinking, the revision
  // effect below catches scrollWidth changes from adding/removing tabs.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    updateScrollState();
    const onScroll = () => updateScrollState();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => updateScrollState());
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [updateScrollState]);
  useEffect(() => {
    updateScrollState();
  }, [revision, updateScrollState]);

  // Scroll one chevron-press worth (most of the visible width) toward `dir`.
  const scrollStrip = useCallback((dir: number) => {
    const el = stripRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.7), behavior: "smooth" });
  }, []);

  // Continuous scroll while a chevron is hovered: rAF loop nudges the strip each
  // frame until the pointer leaves (mirrors the main window's chevrons).
  const hoverScrollRef = useRef<number | null>(null);
  const stopHoverScroll = useCallback(() => {
    if (hoverScrollRef.current !== null) {
      cancelAnimationFrame(hoverScrollRef.current);
      hoverScrollRef.current = null;
    }
  }, []);
  const startHoverScroll = useCallback((dir: number) => {
    stopHoverScroll();
    const step = () => {
      const el = stripRef.current;
      if (!el) return;
      el.scrollLeft += dir * 6;
      // The chevrons unmount at the edges (canScroll*), so onMouseLeave may never
      // fire — stop once we can't scroll further in `dir` rather than spin forever.
      const atEdge =
        dir < 0
          ? el.scrollLeft <= 0
          : el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      if (atEdge) {
        hoverScrollRef.current = null;
        return;
      }
      hoverScrollRef.current = requestAnimationFrame(step);
    };
    hoverScrollRef.current = requestAnimationFrame(step);
  }, [stopHoverScroll]);
  useEffect(() => stopHoverScroll, [stopHoverScroll]);

  // Translate a vertical wheel into horizontal strip scrolling so the tabs can be
  // panned while hovering anywhere over them, not just via the (hidden) scrollbar.
  const onStripWheel = useCallback((e: React.WheelEvent) => {
    const el = stripRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    if (delta === 0) return;
    el.scrollLeft += delta;
  }, []);

  return (
    <>
      {canScrollLeft && (
        <button
          className="tab-scroll-btn left"
          title="Scroll tabs left"
          // Keep the chevron out of the bar's window-move/dock drag flow.
          onPointerDown={(e) => e.stopPropagation()}
          onMouseEnter={() => startHoverScroll(-1)}
          onMouseLeave={stopHoverScroll}
          onClick={() => scrollStrip(-1)}
        >
          ‹
        </button>
      )}
      <div className="tab-strip" ref={stripRef} onWheel={onStripWheel}>
        {children}
      </div>
      {canScrollRight && (
        <button
          className="tab-scroll-btn right"
          title="Scroll tabs right"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseEnter={() => startHoverScroll(1)}
          onMouseLeave={stopHoverScroll}
          onClick={() => scrollStrip(1)}
        >
          ›
        </button>
      )}
    </>
  );
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
  /** The owning project's remoteness (machines + primary host name), streamed in
   *  the seed. Drives the per-tab locality badge/menu; undefined = local project
   *  (no locality axis, no badge — parity with a local main-window strip). */
  remoteInfo?: DetachedRemoteInfo;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  /** Hide the WHOLE popout into the main window's right-panel "Hidden subwindows"
   *  list (the detached twin of a main-window subwindow's "–" hide). Closes this
   *  OS window; the group is parked with its tabs mounted and restored from there.
   *  Undefined ⇒ no hide affordance. */
  onHideWindow?: () => void;
  /** Multi-host: change where a locatable tab runs (streamed to the main window,
   *  which owns the PTY and respawns the pane on the chosen host). */
  onSetLocation: (key: string, location: TabLocation) => void;
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
  /** Create a new tab in `targetGroupId` — the popout's own "+" menu, or a file
   *  dropped onto a pane inside the popout. The detached window can't mint the
   *  key/own the PTY, so it streams the resolved payload to the main window, which
   *  creates the tab and re-seeds. A side `edge` carves a NEW pane at that edge (a
   *  file dropped on a body edge); omitted/"center" appends to the group. */
  onAddTab: (tab: Omit<TabEntry, "key">, targetGroupId: string, edge?: DropEdge) => void;
  /** Toggle/resize a group's docked file-viewer column (the per-subwindow right
   *  file viewer): applied optimistically popout-side and streamed to the main
   *  window so the flag persists (and survives a dock-back). */
  onFiles: (groupId: string, patch: { open?: boolean; width?: number; folder?: string }) => void;
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
  remoteInfo,
  onActivate,
  onClose,
  onHideWindow,
  onSetLocation,
  onReorder,
  onSplit,
  onResize,
  onMove,
  onAddTab,
  onFiles,
}: Props) {
  // The popout's "+" add-tab menu: which group opened it + where to anchor it.
  const [addMenu, setAddMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  // Tab hover card anchor (the hovered tab's bottom-centre), mirroring the main
  // window's TabBar — the popout has its own tab strip, so it renders its own.
  const [hoverTab, setHoverTab] = useState<{ key: string; x: number; y: number } | null>(null);
  // Multi-host locality menu (shared with TabBar). Machine names + the primary
  // host come from the streamed `remoteInfo`; undefined ⇒ local project, no badge.
  const [localityMenu, setLocalityMenu] = useState<LocalityMenuState | null>(null);
  const isRemote = !!remoteInfo;
  const primaryHost = remoteInfo?.primaryHost;
  const computeHosts = remoteInfo?.computeHosts;
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
  // Whole-subwindow rects (tab bar + pane region, sidebar excluded), used by the
  // focus frame so it wraps the current subwindow's tab header too — mirrors the
  // main window's `groupFrameRects`.
  const [groupFrameRects, setGroupFrameRects] = useState<Record<string, Rect>>({});
  // Minimum subwindow size (px) a divider drag may shrink a pane to, per axis.
  const minWidth = useSettingsStore((s) => s.settings?.min_subwindow_width) ?? DEFAULT_MIN_SUBWINDOW_PX;
  const minHeight = useSettingsStore((s) => s.settings?.min_subwindow_height) ?? DEFAULT_MIN_SUBWINDOW_PX;
  // #42 (main → detached): true while a tab dragged out of the MAIN window hovers
  // over THIS popout, so we paint a drop-target highlight. The main window streams
  // the toggle on our label-namespaced channel and commits the dock itself (it
  // owns the layout); we only render the cue. See `detachedDropPreviewEvent`.
  const [dropActive, setDropActive] = useState(false);
  // #42 (Windows): true while the popout is being moved by a NATIVE title-bar drag.
  // It swaps the heavy pane content (terminal canvases) for a cheap placeholder so
  // WebView2 has a trivial surface to composite during the OS modal move loop and
  // can keep up with the frame — the panes would otherwise visibly lag/swim behind
  // the moving frame. Set on the first `onMoved`, cleared on release (or when the
  // window stops moving), so a plain title-bar click never flashes the placeholder.
  const [windowDragging, setWindowDragging] = useState(false);
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
  // Which group inside this popout is "current". A split popout otherwise
  // rendered every pane as `.focused` with no active-pane marker; mirror the main
  // window, where `focusedGroupId` drives the `.focus-frame` accent outline. The
  // detached window is inert to the main tabs store (separate JS heap, layout
  // streamed via props), so focus is tracked locally here.
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(null);
  // Only paint this popout's active subwindow while the popout itself owns OS
  // focus, so it and the main window never both highlight one at once (#42).
  const windowFocused = useWindowFocused();
  // Keep focus on a group that still exists as the tree changes (split added /
  // removed / docked back); default to the first group.
  useEffect(() => {
    const ids = allGroups(tree).map((g) => g.id);
    setFocusedGroupId((cur) => (cur && ids.includes(cur) ? cur : (ids[0] ?? null)));
  }, [tree]);

  // ── Keyboard shortcuts (parity with the main window) ──────────────────────
  // The popout is a separate JS heap, inert to the tabs store, so the main
  // window's `useKeyboard` (which drives `useTabsStore`) can't run here. Instead
  // we handle the WINDOW-LOCAL chords against THIS popout's own layout + edit
  // protocol, resolving each chord through the SAME `shortcuts.ts` map (incl. the
  // user's overrides) so a rebound key behaves identically in both windows.
  //
  // Only the actions with a popout equivalent are wired: close tab, prev/next/
  // cycle tab, cycle subwindow focus, and F11 OS-fullscreen. The rest are
  // deliberately absent because the popout has no matching concept:
  // app-internal fullscreen, hide/close-subwindow (no such edit), and
  // cycle-project (a popout owns no project switcher). Live values are read
  // through a ref so the window listener binds once and never churns on the
  // per-render identity of the edit callbacks.
  const kbRef = useRef({ tree, focusedGroupId, onActivate, onClose, onFiles });
  kbRef.current = { tree, focusedGroupId, onActivate, onClose, onFiles };
  useEffect(() => {
    const win = getCurrentWindow();
    const onKeyDown = async (e: KeyboardEvent) => {
      // F11 — OS fullscreen (Windows: maximize toggle, matching the main window,
      // since real fullscreen strips the styles native dragging relies on).
      // Handled before the editable-target guard so it works from a terminal too.
      if (e.key === "F11") {
        e.preventDefault();
        if (PLATFORM === "windows") {
          if (await win.isMaximized()) void win.unmaximize();
          else void win.maximize();
        } else {
          const isFs = await win.isFullscreen();
          void win.setFullscreen(!isFs);
        }
        return;
      }
      // Never steal keys from a focused text field / xterm textarea (same rule
      // the main window applies) — otherwise typing in a terminal would trip the
      // nav chords.
      if (isEditableTarget(e.target)) return;

      const overrides = useSettingsStore.getState().settings
        ?.keyboard_shortcuts as ShortcutMap | undefined;
      const is = (action: ShortcutAction) =>
        chordMatches(resolveChord(action, overrides), e);
      const {
        tree: t,
        focusedGroupId: fid,
        onActivate: activate,
        onClose: close,
        onFiles: files,
      } = kbRef.current;
      const focused = (fid && findGroup(t, fid)) || allGroups(t)[0] || null;

      // Toggle the focused subwindow's docked file viewer (streams a files edit
      // back to the main window, same as the ◫ button / resize-edge double-click).
      if (is("toggleSubwindowFiles")) {
        if (focused) {
          e.preventDefault();
          files(focused.id, { open: !focused.filesOpen });
        }
        return;
      }

      // Close the active tab of the focused subwindow. DetachedApp's handleClose
      // closes the whole window when it was the last tab.
      if (is("closeTab")) {
        if (focused?.activeKey) {
          e.preventDefault();
          close(focused.activeKey);
        }
        return;
      }

      // Previous / next / cycle tab within the focused subwindow.
      const prev = is("prevTab");
      if (prev || is("nextTab") || is("cycleTabs")) {
        if (focused && focused.tabKeys.length > 1) {
          e.preventDefault();
          const len = focused.tabKeys.length;
          const cur = focused.activeKey ? focused.tabKeys.indexOf(focused.activeKey) : 0;
          const next = focused.tabKeys[(cur + (prev ? -1 : 1) + len) % len];
          activate(next);
        }
        return;
      }

      // Cycle which subwindow is focused (only meaningful once the popout is
      // split into several panes). A direct move — the popout has a focus frame
      // but not the main window's numbered Shift-preview nav.
      const down = is("subwindowDown");
      if (down || is("subwindowUp")) {
        const ids = allGroups(t).map((g) => g.id);
        if (ids.length >= 2) {
          e.preventDefault();
          const from = fid ? ids.indexOf(fid) : -1;
          const base = from >= 0 ? from : 0;
          setFocusedGroupId(ids[(base + (down ? 1 : -1) + ids.length) % ids.length]);
        }
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // Bind once: live state is read via kbRef; the resolver reads settings live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Pane-region measurement (for the split-preview overlay) ───────────────
  // Recompute every group body's rect (relative to the panel) so the overlay can
  // paint the half/whole a split drop would carve out. Mirrors CenterPanel.measure.
  const measure = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const base = panel.getBoundingClientRect();
    const next: Record<string, Rect> = {};
    const frames: Record<string, Rect> = {};
    for (const [id, el] of bodyRefs.current) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      next[id] = { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
      // The enclosing subwindow box spans the tab header bar + body; clamp the
      // right edge to the pane region's right (`r`, the measured element here)
      // so a docked files sidebar in the same body is excluded from the frame.
      const sub = el.closest(".subwindow");
      if (sub) {
        const sr = sub.getBoundingClientRect();
        frames[id] = {
          left: sr.left - base.left,
          top: sr.top - base.top,
          width: r.right - sr.left,
          height: sr.height,
        };
      }
    }
    const sameRects = (
      a: Record<string, Rect>,
      b: Record<string, Rect>,
    ): boolean => {
      const keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      for (const k of keys) {
        const x = a[k];
        const y = b[k];
        if (!y || x.left !== y.left || x.top !== y.top || x.width !== y.width || x.height !== y.height) {
          return false;
        }
      }
      return true;
    };
    setGroupRects((prev) => (sameRects(next, prev) ? prev : next));
    setGroupFrameRects((prev) => (sameRects(frames, prev) ? prev : frames));
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
  const resolveLocalTarget = useCallback((clientX: number, clientY: number) => {
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
  }, []);

  // #42: a FILE dragged out of the file tree (a Files (Project) tab) onto a pane
  // inside THIS popout. The main window's `commitFileDrop` can't run here (the
  // popout doesn't own the tab store), so commit the resolved target as a
  // detached `add` edit: a bar / pane-centre → append; a body side edge → carve a
  // new pane. Provided to the tree via `FileDropContext`, with `resolveLocalTarget`
  // as its per-move target resolver so the split/merge preview lights up.
  const fileDrop = useMemo<FileDropController>(
    () => ({
      resolveTarget: resolveLocalTarget,
      commit: (d, projectCwd) => {
        const drag = useDragStore.getState().drag;
        if (!drag) return;
        const payloads = fileDropPayloads(d, projectCwd);
        if (payloads.length === 0) return;
        // Body side edge → the first file carves a new pane at that edge; any
        // further files (a multi-selection) append to the target group, since the
        // popout can't reference the pane the main window is about to mint.
        if (drag.overGroup && drag.edge && drag.edge !== "center") {
          onAddTab(payloads[0], drag.overGroup, drag.edge);
          for (const p of payloads.slice(1)) onAddTab(p, drag.overGroup);
          return;
        }
        // A pane centre/body, or a tab bar → append to that group. No pane under
        // the cursor (released over empty space) → nothing (never leak a file out).
        const target = drag.overGroup ?? drag.reorderGroup;
        if (!target) return;
        for (const p of payloads) onAddTab(p, target);
      },
      // No drag involved (a button click): drop the tab into the popout's focused
      // group, else its first group, streamed to the main window via onAddTab.
      openTab: (tab) => {
        const target = focusedGroupId ?? allGroups(tree)[0]?.id;
        if (target) onAddTab(tab, target);
      },
    }),
    [resolveLocalTarget, onAddTab, focusedGroupId, tree],
  );

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
    // ONE pane (inner group) of a multi-pane popout dragged by its bar grip: the
    // host docks just this group (attachDetachedPane) — never the whole popout.
    paneGroupId?: string;
  }) => {
    const { pointerId, captureEl, label: dragLabel, moveWindow, tabKey, sourceGroup, paneGroupId } =
      args;
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
          paneId: paneGroupId,
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
      // Shift ALWAYS means "pop into its own window" (unified with the main-window
      // tab rule), so DON'T commit a within-popout drop under Shift — hand the
      // gesture to the main host UNcancelled and let its unified ladder run the
      // new-window branch (`decideDetachedTabDrop` → `detachTabToNewWindow`). For a
      // lone-tab popout the host refuses (it's already its own window) → a clean
      // no-op, never the previous local-split + Shift-bail hang. Without Shift, a
      // release over THIS popout is still committed locally (reorder/split).
      if (!shift && tabKey != null && sourceGroup && popoutFrame) {
        const c = physToClient(popoutFrame, last);
        const handledLocally = handleLocalTabRelease(tabKey, c.x, c.y);
        finish(handledLocally, shift);
        return;
      }
      // A PANE drag released over its own popout stays put: the window doesn't
      // follow the cursor (moveWindow=false), and the popout usually floats
      // ABOVE the main window — the host's inMain test alone would read a
      // release-in-place as "dock into main". Cancel so the host no-ops.
      if (!shift && paneGroupId != null && popoutFrame) {
        const c = physToClient(popoutFrame, last);
        const overSelf =
          c.x >= 0 && c.y >= 0 && c.x <= window.innerWidth && c.y <= window.innerHeight;
        if (overSelf) {
          finish(true, shift);
          return;
        }
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

  // Grab a group's bar grip → MOVE the whole popout window natively (option B:
  // move-only). This replaces the old streamed move+dock gesture (`beginDockDrag`)
  // whose cross-window protocol is what painted a dock/split preview in the main
  // window while you were merely repositioning a popout. A popout no longer docks
  // back — nor separates a pane — by dragging; those are part of a re-docking
  // redesign still to come. Only the explicit `.tab-drag-grip` starts the move;
  // grabbing empty bar space does not.
  const onGroupBarPointerDown = (e: React.PointerEvent, _group: GroupNode) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target.closest(".tab-drag-grip")) return;
    e.preventDefault();
    beginNativeWindowMove();
  };

  // #42 (Windows): show the cheap move placeholder for the duration of a NATIVE
  // title-bar drag (`startDragging`), so WebView2 isn't repainting the terminal
  // canvases during the OS modal move loop (which it can't do fast enough → the
  // content lags the frame). End detection is deliberately belt-and-suspenders
  // because the native move loop can swallow the terminal `pointerup`:
  //   • show on the FIRST `onMoved` (so a non-drag click never flashes it),
  //   • hide on `pointerup`/`pointercancel` (the normal release, cursor over us),
  //   • hide once the window has stopped moving for a beat (release over ANOTHER
  //     monitor, where our webview never sees the pointerup), and
  //   • a hard timeout so the placeholder can never get stuck on.
  const beginWindowMove = () => {
    const win = getCurrentWindow();
    let idle: ReturnType<typeof setTimeout> | undefined;
    let unMoved: (() => void) | undefined;
    let shown = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (idle) clearTimeout(idle);
      clearTimeout(hardStop);
      unMoved?.();
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (shown) setWindowDragging(false);
    };
    const onMoved = () => {
      if (!shown) {
        shown = true;
        setWindowDragging(true);
      }
      if (idle) clearTimeout(idle);
      idle = setTimeout(finish, 250);
    };
    const hardStop = setTimeout(finish, 10000);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    win
      .onMoved(onMoved)
      .then((fn) => (done ? fn() : (unMoved = fn)))
      .catch(() => {});
  };

  // Move-only, most-native window reposition. Hands the drag straight to the OS
  // (`startDragging`) instead of the streamed poll+setPosition dock gesture
  // (`beginDockDrag`) — so it emits NO cross-window dock protocol and therefore
  // no other window ever paints a dock/split preview for it. This is the whole-
  // subwindow behaviour: a popout's grip and titlebar only REPOSITION the window;
  // re-docking back into another window by dragging is deliberately gone (a
  // separate re-docking design is planned). On Windows the move placeholder keeps
  // the frame aligned during the OS modal move loop (WebView2 can't repaint the
  // terminals fast enough); other engines don't need it.
  const beginNativeWindowMove = () => {
    if (PLATFORM === "windows") beginWindowMove();
    void getCurrentWindow().startDragging().catch(() => {});
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
    // Move the whole popout window natively on every platform (see
    // `beginNativeWindowMove`) — no streamed dock gesture, so dragging the
    // titlebar never makes another window flash a dock/split preview.
    beginNativeWindowMove();
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
    const isFocused = windowFocused && group.id === focusedGroupId;
    return (
      <div
        className={`subwindow${isFocused ? " focused" : ""}`}
        // Clicking anywhere in the group (bar or body) makes it the current one.
        // Capture-phase so it wins before a tab/divider pointerdown stops
        // propagation — mirrors the main window's `Subwindow`.
        onMouseDownCapture={() => {
          if (!isFocused) setFocusedGroupId(group.id);
        }}
      >
        <div
          ref={(el) => {
            if (el) barRefs.current.set(group.id, el);
            else barRefs.current.delete(group.id);
          }}
          className={`tab-bar detached-drag-handle${isDropTarget ? " drop-target" : ""}`}
          data-group-id={group.id}
          onPointerDown={(e) => onGroupBarPointerDown(e, group)}
        >
          {/* Move grip — the sole tab-bar handle for moving/docking this popout
              (the titlebar still moves it too). Always pinned at the far left so
              it stays grabbable however many tabs fill the bar. A plain
              (non-button) element, so its pointerdown bubbles to
              `onGroupBarPointerDown`, which now fires only when the grip is the
              target. */}
          <div
            className="tab-drag-grip"
            title="Drag to move this window"
            aria-hidden="true"
          >
            ⠿
          </div>
          {/* The tabs live in their own horizontally-scrolling strip; chevrons
              flank it and appear only on overflow — the same behaviour as the
              main-window `TabBar`. `revision` re-checks overflow when the tab set
              (or its drop placeholder) changes. */}
          <DetachedTabStrip
            revision={`${orderedTabs.map((t) => t.key).join(",")}|${isDropTarget}|${localReorder}`}
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
                  // Styled hover card (same one the main window's TabBar shows —
                  // this strip is bespoke, so it anchors the shared card itself).
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setHoverTab({ key: tab.key, x: r.left + r.width / 2, y: r.bottom });
                  }}
                  onMouseLeave={() =>
                    setHoverTab((h) => (h?.key === tab.key ? null : h))
                  }
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
                  {/* Local/remote badges — parity with the main-window TabBar,
                      via the shared TabLocalityBadges. The source badge reads THIS
                      window's fileSources store; the locality badge/menu use the
                      streamed host list and route changes through onSetLocation. */}
                  <TabSourceBadge tabKey={tab.key} />
                  {isRemote && (
                    <TabLocalityBadge
                      tab={tab}
                      primaryHost={primaryHost}
                      computeHosts={computeHosts}
                      onOpen={(r, startOnMachines) =>
                        setLocalityMenu({
                          key: tab.key,
                          x: r.left,
                          y: r.bottom + 2,
                          view: startOnMachines ? "machines" : "root",
                        })
                      }
                    />
                  )}
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
          {/* #42: the popout's own "+" — the detached window had no way to add
              tabs. Streams an "add" edit to the main window (which owns tab
              creation + the PTY) via onAddTab. */}
          <div className="tab-new-wrap">
            <button
              className="tab-new-btn"
              title="New tab"
              // The bar's pointerdown starts a window-move/dock drag; keep the
              // button's press out of it (it also excludes buttons, but be explicit).
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setAddMenu((cur) =>
                  cur && cur.groupId === group.id
                    ? null
                    : { groupId: group.id, x: r.left, y: r.bottom + 4 },
                );
              }}
            >
              +
            </button>
          </div>
          </DetachedTabStrip>
          {/* Per-subwindow right file viewer, same ◫ toggle as the main window's
              TabBar. Applied optimistically + streamed to the main window. When
              the viewer is docked below, the control reserves its width (like
              the main window's `.tab-controls`) so it stays pinned above the
              viewer and the strip stops at the pane edge. */}
          <div
            className="tab-controls"
            style={
              group.filesOpen
                ? { width: clampFilesWidth(group.filesWidth ?? DEFAULT_GROUP_FILES_WIDTH) }
                : undefined
            }
          >
            <button
              className={`subwindow-files-toggle${group.filesOpen ? " open" : ""}`}
              title={
                group.filesOpen
                  ? "Close this subwindow's file viewer"
                  : "Open a file viewer in this subwindow"
              }
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onFiles(group.id, { open: !group.filesOpen });
              }}
            >
              ◫
            </button>
            {/* Hide the WHOLE popout into the main window's right-panel Hidden
                list — the detached twin of the main-window bar's "–". Rendered
                per bar (like ◫); for a multi-pane popout every bar's "–" hides
                the whole window as one hidden entry. stopPropagation keeps the
                press off the bar's window-move/dock drag. */}
            {onHideWindow && (
              <button
                className="subwindow-hide"
                title="Hide this window into the right panel (bring it back from there)"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onHideWindow();
                }}
              >
                –
              </button>
            )}
          </div>
        </div>
        <div className="subwindow-body">
          {/* The measured/drop-target body is the PANE REGION, not the whole
              flex row — so edge-split drops and the split preview never target
              the file-viewer column. */}
          <div
            className="subwindow-pane-region"
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
                  {/* The shared per-tab render switch (`components/tabs/TabPane`),
                      the SAME one the main window uses. A popout is attach-only (the
                      main window owns the PTY) and doesn't own the tab store, so it
                      passes no `ownsTabs`/`onConnect`/mirror props — the cwd is just
                      the tab's, since the projects store the mirror-swap needs isn't
                      here. See TabPane for why each prop differs between windows. */}
                  <TabPane
                    tab={tab}
                    scope={scope}
                    visible={visible}
                    attachOnly
                    filesProjectDir={tab.cwd}
                    terminalCwd={tab.cwd}
                  />
                </div>
              );
            })}
          </div>
          </div>
          {/* Per-subwindow right file viewer. The popout has no projects store,
              so the viewer resolves its root from the group's tab cwd (same
              fallback a Files (Project) tab uses here); no open-in-new-tab (a
              popout can't own tabs). Width edits stream back like the toggle. */}
          {group.filesOpen && (
            <SubwindowFilesSidebar
              scope={scope}
              cwd={
                byKey.get(group.activeKey ?? group.tabKeys[0] ?? "")?.cwd ??
                group.tabKeys.map((k) => byKey.get(k)?.cwd).find(Boolean) ??
                ""
              }
              width={group.filesWidth}
              onWidthChange={(w) => onFiles(group.id, { width: w })}
              folder={group.filesFolder}
              onFolderChange={(f) => onFiles(group.id, { folder: f })}
              onHide={() => onFiles(group.id, { open: false })}
            />
          )}
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
                // Double-click merges the two adjacent subwindows (both must be
                // leaf groups). No `merge` edit exists, so replay it as one
                // `move` per source tab into the left/top survivor — the main
                // window applies each via moveKeyInTree (which collapses the
                // emptied source) and streams the result back.
                onDoubleClick={() => {
                  const a = node.children[i];
                  const b = node.children[i + 1];
                  if (a.type === "group" && b.type === "group") {
                    for (const key of b.tabKeys) onMove(key, a.id);
                  }
                }}
              />
            )}
          </Fragment>
        ))}
      </div>
    );
  };

  // Label shown on the move placeholder: the first group's active tab, else a
  // generic fallback. Cheap to compute; only painted while `windowDragging`.
  const firstGroup = allGroups(tree)[0];
  const moveLabel =
    (firstGroup ? tabs.find((t) => t.key === firstGroup.activeKey)?.label : undefined) ??
    "Subwindow";

  return (
    <FileDropContext.Provider value={fileDrop}>
    <div className={`detached-center center-panel${windowDragging ? " moving" : ""}`}>
      {/* #42: the popout's own title bar — a full-width strip ABOVE the tab layout
          that always hosts the min/max/close controls top-right. They used to live
          in the root group's tab bar, which slid left (with the root group) once
          the popout was split; an outer frame keeps them pinned. The empty strip
          is a drag handle for moving / docking the whole window. */}
      <div className="detached-titlebar detached-drag-handle" onPointerDown={onTitlebarPointerDown}>
        {PLATFORM !== "macos" && (
          <div className="detached-titlebar-controls no-drag">
            <WindowControls />
          </div>
        )}
      </div>
      {/* The layout tree (below the title bar) is the positioning context for the
          absolutely-inset split/subwindow nodes and the split-preview overlay. */}
      <div ref={panelRef} className="detached-body">
        {renderNode(tree)}
        {/* Split preview: the translucent half/whole a split drop would carve out,
            drawn above the per-group panes (mirrors the main window). */}
        <SplitPreviewOverlay groupRects={groupRects} />
        {/* Focus frame: the accent outline around the current subwindow (tab bar
            + pane region, sidebar excluded), drawn here (above the opaque panes)
            for the same reason as the split preview — an in-body frame would be
            hidden. Mirrors the main window's `FocusFrameOverlay` (minus Shift+↑/↓
            nav, which isn't wired here). Falls back to the pane rect if the
            whole-subwindow box wasn't measured. */}
        {windowFocused &&
          focusedGroupId &&
          (groupFrameRects[focusedGroupId] ?? groupRects[focusedGroupId]) && (
            <div
              className="focus-frame"
              style={
                groupFrameRects[focusedGroupId] ?? groupRects[focusedGroupId]
              }
            />
          )}
        {/* #42 (Windows): the move placeholder. While shown, `.detached-center.moving`
            hides the heavy pane content so this trivial surface is all WebView2 has to
            composite during the native drag — keeping the content aligned with the
            frame instead of lagging behind it. */}
        {windowDragging && (
          <div className="detached-move-overlay">
            <span>{moveLabel}</span>
          </div>
        )}
      </div>
      {dropActive && <div className="detached-drop-target" />}
      {/* #42: the "+" add-tab menu for the group that opened it. cwd comes from a
          tab already in that group (the popout's project directory). */}
      {addMenu &&
        (() => {
          const g = findGroup(tree, addMenu.groupId);
          if (!g) return null;
          const cwd =
            byKey.get(g.activeKey ?? g.tabKeys[0] ?? "")?.cwd ??
            g.tabKeys.map((k) => byKey.get(k)?.cwd).find(Boolean) ??
            "";
          return (
            <NewTabMenu
              scope={scope}
              projectCwd={cwd}
              // The detached window is inert to the projects store, so there's no
              // project name to auto-name an agent session with — skip it.
              projectName=""
              anchor={{ x: addMenu.x, y: addMenu.y }}
              onPick={(tab) => onAddTab(tab, addMenu.groupId)}
              onClose={() => setAddMenu(null)}
              onManageAgents={() => setAgentDialogOpen(true)}
            />
          );
        })()}
      {agentDialogOpen && (
        <CustomAgentDialog onClose={() => setAgentDialogOpen(false)} />
      )}
      {/* Multi-host locality menu — parity with the main-window TabBar, routed
          through onSetLocation (the main window owns the PTY + respawns it). */}
      {localityMenu && (
        <LocalityMenu
          menu={localityMenu}
          current={tabLocation(byKey.get(localityMenu.key))}
          primaryHost={primaryHost}
          computeHosts={computeHosts}
          onClose={() => setLocalityMenu(null)}
          onChangeView={(view) => setLocalityMenu((m) => (m ? { ...m, view } : m))}
          onChoose={(key, loc) => onSetLocation(key, loc)}
        />
      )}
      {/* Styled tab hover card — parity with the main window's TabBar.
          Suppressed mid-drag (local or streamed-in: both set the drag store)
          and while the "+" menu is open so it never overlaps them. The card
          reads THIS window's stores; the machine names come from the streamed
          `remoteInfo` (the projects store is absent here). */}
      {hoverTab && dragKey === null && !addMenu && (() => {
        const tab = byKey.get(hoverTab.key);
        if (!tab) return null;
        return (
          <TabHoverCard
            tab={tab}
            scope={scope}
            isRemote={isRemote}
            primaryHost={primaryHost}
            computeHosts={computeHosts}
            anchorX={hoverTab.x}
            anchorY={hoverTab.y}
          />
        );
      })()}
      <DragGhost />
    </div>
    </FileDropContext.Provider>
  );
}
