import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  DETACHED_DRAG_END,
  DETACHED_DRAG_MOVE,
  DETACHED_DRAG_START,
  buildSeed,
  detachedSeedEvent,
  type DetachedDragEnd,
  type DetachedDragMove,
  type DetachedDragStart,
} from "../../stores/detached";
import { TerminalView } from "../terminal/TerminalView";
import { FileBrowser } from "../files/FileBrowser";
import { EmbedPane } from "../embed/EmbedPane";
import { FileViewerPane } from "../embed/FileViewerPane";
import { ProjectBlobPane } from "../common/ProjectBlobPane";
import { NetworkTrafficPane } from "../monitoring/NetworkTrafficPane";
import { CalendarPane } from "../calendar/CalendarPane";
import { Subwindow } from "../tabs/Subwindow";
import { pickEdge, previewInset } from "../tabs/dragGeometry";
import { dragPreviewLayout } from "../tabs/dragPreview";
import {
  BLOB_TAB_CMD,
  DEFAULT_MIN_SUBWINDOW_PX,
  EMPTY_GROUP_ID,
  FILES_TAB_CMD,
  allGroups,
  cmdToKind,
  effectiveTabLocation,
  isRestorableTab,
  isPtyTabKind,
  localTabCwd,
  useTabsStore,
  type LayoutNode,
  type SavedLayoutTree,
  type TabKind,
} from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useDragStore } from "../../stores/drag";
import { useSubwindowNavStore } from "../../stores/subwindowNav";
import { useWindowMoveStore } from "../../stores/windowMove";
import { useDetachAnimStore } from "../../stores/detachAnim";
import { useTabLandStore } from "../../stores/tabLand";
import { commitDrop } from "../tabs/commitDrop";
import { snapshotFrame, physToClient, type WindowFrame } from "../../lib/coords";
import { dragPlatform } from "../../lib/dragPlatform";
import { useProjectsStore } from "../../stores/projects";
import { useConnectDialogStore } from "../../stores/connectDialog";
import { RemotePaneHold } from "../projects/RemotePaneHold";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { resolveLocalMirror, resolveProjectDirectory } from "../../types";

/** Pixel coordinates of a group's pane region, relative to the center panel. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function CenterPanel() {
  const tabsByScope = useTabsStore((s) => s.tabsByScope);
  const scope = useTabsStore((s) => s.scope);
  const layout = useTabsStore((s) => s.layout);
  const layoutByScope = useTabsStore((s) => s.layoutByScope);
  const setScope = useTabsStore((s) => s.setScope);
  const loadFromLayout = useTabsStore((s) => s.loadFromLayout);
  const resizeSplit = useTabsStore((s) => s.resizeSplit);
  const tabs = useTabsStore((s) => s.tabs);
  // #42: the current scope's detached popouts. Subscribed here so the debounced
  // save below re-fires when a popout is moved/resized (setDetachedBounds swaps
  // this array's identity) — otherwise bounds drags wouldn't reach project.json
  // until the next tab/layout change or app quit.
  const detachedGroups = useTabsStore((s) => s.detachedGroupsByScope[s.scope]);
  const saveLayout = useTabsStore((s) => s.saveLayout);
  const updateTabEnv = useTabsStore((s) => s.updateTabEnv);
  // #42: popouts to re-open for the current scope (restored docked, then detached).
  const pendingRespawn = useTabsStore((s) => s.pendingRespawnByScope[s.scope]);
  const consumePendingRespawn = useTabsStore((s) => s.consumePendingRespawn);
  const detachGroup = useTabsStore((s) => s.detachGroup);
  // #62: app-internal fullscreen. When set, only this group's pane is shown,
  // sized to the whole panel — panes stay MOUNTED (we reposition, never unmount,
  // so PTYs survive). The frame layer (tab bars/splits) keeps rendering beneath.
  const fullscreenGroupId = useTabsStore((s) => s.fullscreenGroupId);
  // True while the whole window is being moved by a native title-bar drag
  // (Windows). Drives `.center-panel.moving`, which hides the heavy pane layer so
  // WebView2 can keep the frame aligned with the cursor during the OS move loop.
  const windowMoving = useWindowMoveStore((s) => s.moving);

  const { projects, activeId } = useProjectsStore();

  // Whether a pointer-drag is active. We subscribe to a boolean (not the drag
  // object, which is replaced on every pointermove) so the panel doesn't
  // re-render — and tear down/re-add its window listeners — each frame. Live
  // drag state is read via useDragStore.getState() inside the handlers.
  const dragging = useDragStore((s) => s.drag != null);
  // The dragged tab's identity (stable for the whole gesture — start() sets it
  // once; the per-frame move/setTarget only swap coords/target). Subscribed as
  // scalars so they don't re-render the panel on every pointermove, only on
  // drag start/end. They drive the live source-subwindow collapse below.
  const dragKind = useDragStore((s) => s.drag?.kind ?? null);
  const dragKey = useDragStore((s) => s.drag?.key ?? null);
  const dragFromGroup = useDragStore((s) => s.drag?.fromGroup ?? null);

  // Measured pane regions per group id (current scope only). The flat pane
  // layer positions each active pane over its group's body so PTYs never
  // unmount on scope switch / re-tile.
  const [groupRects, setGroupRects] = useState<Record<string, Rect>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const groupBodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const activeProject = projects.find((p) => p.id === activeId);
  const localFile = activeProject?.local_file as string | undefined;
  const projectCwd = resolveProjectDirectory(activeProject);

  // Mount-free remote: a remote project starts DISCONNECTED but its LOCAL tabs
  // (local agents / local_agent / local-toggled shells — all running in the
  // mirror via a local PTY) and the file browser (which falls back to the mirror
  // while disconnected) work offline, so the saved tabs are ALWAYS restored. Only
  // genuinely-remote panes (`ssh -tt` shells, remote-toggled agents, the SFTP
  // file tree) would block on the dead pool, so those are held per-pane below
  // until that pane's project reaches "connected" (see the pane render). Keyed
  // by the PANE's own scope — panes stay mounted across scope switches, so
  // holding must not track only the active project's state.
  const remoteSshByProject = useRemoteStatusStore((s) => s.byProject);
  const openConnectDialog = useConnectDialogStore((s) => s.open);

  // The layout to RENDER: normally the store layout, but while dragging a
  // subwindow's lone tab it's that layout with the (about-to-empty) source
  // subwindow pruned — so it collapses live and the siblings reflow to fill,
  // rather than lingering until the drop. Render-only; the store is untouched
  // (an aborted drag restores instantly), and the dragged tab's pane stays
  // mounted in the flat pane layer below (its PTY survives). All measurement and
  // drop-target resolution keys off THIS tree so the previewed layout is what
  // the pointer hit-tests against.
  const renderLayout = useMemo(
    () => dragPreviewLayout(layout, dragKind, dragKey, dragFromGroup, fullscreenGroupId != null),
    [layout, dragKind, dragKey, dragFromGroup, fullscreenGroupId],
  );

  useEffect(() => {
    const nextScope = activeId ?? "root";
    setScope(nextScope);

    if (!activeId || !localFile) {
      // Root context: the 3D project-blob is the default tab. Seed it the first
      // time the root scope is entered this session, but only when projects
      // exist (an empty cloud has nothing to show) and the scope hasn't been
      // initialized yet — so an intentionally-closed/emptied root stays empty
      // and we never clobber existing root tabs.
      if (
        !activeId &&
        useProjectsStore.getState().projects.length > 0 &&
        !("root" in useTabsStore.getState().tabsByScope)
      ) {
        useTabsStore.getState().addTab({
          label: "Projects",
          cmd: BLOB_TAB_CMD,
          cwd: "",
          kind: "projects3d",
        });
      }
      return;
    }

    // Scope was already initialized this session (tabs may be empty by user intent).
    // Trust in-memory state rather than re-reading disk — avoids restoring
    // intentionally-closed tabs, and eliminates a race where load_project reads
    // stale project.json before switch_project_runtime has written the empty layout.
    if (nextScope in useTabsStore.getState().tabsByScope) return;

    // Project context: restore saved tab layout from disk (first visit this session).
    const scopeForLoad = nextScope;
    type LayoutEntry = { key: string; label: string; cmd: string; cwd: string; kind?: TabKind; type?: string; env?: Record<string, string>; sessionId?: string; embedPath?: string; embedExec?: string; viewer?: "pdf" | "image" | "markdown" | "text" };
    invoke<Record<string, unknown>>("load_project", { localFile })
      .then((proj) => {
        const raw = (proj.tab_layout as LayoutEntry[] | undefined) ?? [];
        // Keep shell/files/network tabs, resumable agent tabs (Claude with a sessionId,
        // resumed via --resume), and in-app file-viewer embeds; other agent/embed
        // tabs (including external-app embeds) are dropped. Derive kind from the
        // saved entry or its command. The saved groups tree self-heals
        // (loadFromLayout drops dropped keys).
        const restorable = raw.filter((t) =>
          isRestorableTab({
            kind: t.kind ?? cmdToKind(t.cmd || (t.type === "files" ? FILES_TAB_CMD : "")),
            cmd: t.cmd,
            sessionId: t.sessionId,
            viewer: t.viewer,
          }),
        );
        // Guard: don't overwrite tabs that switch_project_runtime already loaded.
        if (scopeForLoad in useTabsStore.getState().tabsByScope) return;
        // A freshly-visited project with NO restorable tabs stays empty (shows the
        // empty Subwindow with a "+"); we no longer seed a default README.md tab.
        if (restorable.length === 0) return;
        // `tab_groups` carries the saved split/group tree (absent → single group).
        const groups = proj.tab_groups as SavedLayoutTree | undefined;
        loadFromLayout(restorable, projectCwd, scopeForLoad, groups ?? undefined);
      })
      .catch(() => {});
  }, [activeId, projectCwd, localFile, setScope, loadFromLayout]);

  // Re-hydrate vibe local_agent tabs that were saved without VIBE_HOME/
  // VIBE_ACTIVE_MODEL. Only vibe needs this: `ollama launch`/fallback driver tabs
  // (cmd "ollama"/"codex"/…) carry everything in cmd+args and have no env to
  // restore, so they must be skipped — `prepare_local_agent` only knows vibe.
  useEffect(() => {
    if (!activeId) return;
    const { tabs: currentTabs } = useTabsStore.getState();
    const needsEnv = currentTabs.filter(
      (t) =>
        t.kind === "local_agent" &&
        t.cmd === "vibe" &&
        Object.keys(t.env ?? {}).length === 0,
    );
    for (const tab of needsEnv) {
      invoke<{ vibe_home: string; alias: string }>("prepare_local_agent", { model: tab.label })
        .then(({ vibe_home, alias }) => {
          updateTabEnv(tab.key, { VIBE_HOME: vibe_home, VIBE_ACTIVE_MODEL: alias });
        })
        .catch(() => {});
    }
  }, [activeId, updateTabEnv]);

  useEffect(() => {
    if (!activeId || !localFile) return;
    const timer = window.setTimeout(() => {
      saveLayout(localFile).catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeId, localFile, tabs, layout, detachedGroups, saveLayout]);

  // #42: re-open popouts that were detached when this scope was last saved. The
  // groups were restored DOCKED (above) so their panes mount and spawn their
  // PTYs first; this effect — which runs after those child panes have mounted —
  // then re-detaches each, reopening the floating window (which attaches to the
  // now-live PTY). consumePendingRespawn clears the queue so it fires once.
  useEffect(() => {
    if (!pendingRespawn || pendingRespawn.length === 0) return;
    const targets = consumePendingRespawn(scope);
    for (const t of targets) {
      // allowLastGroup: a restored popout may be the scope's only group (its
      // in-window siblings held only non-restorable tabs and were dropped); it
      // must still re-detach into its own window rather than stay docked.
      detachGroup(t.id, { bounds: t.bounds, allowLastGroup: true });
    }
  }, [scope, pendingRespawn, consumePendingRespawn, detachGroup]);

  // ── Pane-region measurement ───────────────────────────────────────────────
  // Recompute every group body's rect (relative to the panel) so the flat pane
  // layer can position each active pane over its subwindow. Runs after layout
  // changes and on resize.
  const measure = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const base = panel.getBoundingClientRect();
    const next: Record<string, Rect> = {};
    for (const [id, el] of groupBodyRefs.current) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      next[id] = {
        left: r.left - base.left,
        top: r.top - base.top,
        width: r.width,
        height: r.height,
      };
    }
    setGroupRects((prev) => {
      // Avoid pointless state churn (which would re-render every pane).
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

  // Re-measure when the rendered layout tree changes — including the live drag
  // collapse/restore, so siblings' reflowed rects are picked up immediately.
  useLayoutEffect(() => {
    measure();
  }, [measure, renderLayout, scope]);

  // Re-measure on panel resize (split drags resize children without remount).
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(panel);
    for (const el of groupBodyRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [measure, renderLayout, scope]);

  // Re-measure on OS-window resize. The ResizeObserver above misses OS-level
  // resizes on older WebKitGTK builds (it fires for split drags but not for the
  // window growing/shrinking), so panes — positioned at a JS-measured pixel
  // width/height — would keep their stale size and the file viewers
  // (markdown/text/PDF, sized off the pane box) never reflow to the new window
  // width. AppShell bridges Tauri's reliable onResized/onScaleChanged into a DOM
  // 'resize' event; listening for it here re-runs the measurement. (The detached
  // window sidesteps this entirely by sizing its single pane with CSS insets.)
  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  const registerGroupBody = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) groupBodyRefs.current.set(id, el);
      else groupBodyRefs.current.delete(id);
    },
    [],
  );

  // Resolve the drop target under a panel point (client coords) and write it to
  // the drag store (driving the live preview). Shared by the in-window pointer
  // drag and the cross-window detached-popout drag (#42), which feeds it pointer
  // coords streamed from the popout. A tab bar → within-bar reorder slot; a
  // subwindow body → edge split of that group.
  const resolveTarget = useCallback(
    (x: number, y: number) => {
      const setTarget = useDragStore.getState().setTarget;
      const computeReorderIndex = (tabBar: Element, px: number): number => {
        const tabEls = tabBar.querySelectorAll(".tab");
        let slot = tabEls.length;
        tabEls.forEach((el, i) => {
          const r = el.getBoundingClientRect();
          if (slot === tabEls.length && px < r.left + r.width / 2) slot = i;
        });
        return slot;
      };
      const el = document.elementFromPoint(x, y);
      const tabBar = el?.closest(".tab-bar");
      if (tabBar instanceof HTMLElement && tabBar.dataset.groupId) {
        setTarget({
          overGroup: null,
          edge: null,
          reorderGroup: tabBar.dataset.groupId,
          reorderIndex: computeReorderIndex(tabBar, x),
        });
        return;
      }
      const panel = panelRef.current;
      if (panel) {
        const base = panel.getBoundingClientRect();
        const px = x - base.left;
        const py = y - base.top;
        for (const [gid, r] of Object.entries(groupRects)) {
          if (px >= r.left && px <= r.left + r.width && py >= r.top && py <= r.top + r.height) {
            setTarget({
              overGroup: gid,
              edge:
                gid === EMPTY_GROUP_ID
                  ? "center"
                  : pickEdge({ left: r.left, top: r.top, width: r.width, height: r.height }, px, py),
              reorderGroup: null,
              reorderIndex: null,
            });
            return;
          }
        }
      }
      setTarget({ overGroup: null, edge: null, reorderGroup: null, reorderIndex: null });
    },
    [groupRects],
  );

  // ── Pointer-drag hit-test + drop authority (panel-wide) ───────────────────
  // While a tab drag is active, window listeners resolve the target under the
  // pointer each move (a tab bar → within-bar reorder slot, or a subwindow body
  // → edge split) and commit on release. CenterPanel is the SINGLE drop
  // authority; TabBar's own pointerup only handles the click case. We avoid
  // setPointerCapture and rely on `.center-panel.dragging` making panes
  // pointer-events:none so elementFromPoint can reach the tab bars / bodies.
  useEffect(() => {
    if (!dragging) return;
    const move = useDragStore.getState().move;

    const onMove = (e: PointerEvent) => {
      const d = useDragStore.getState().drag;
      // Shift during a file drag = "force a new window on release" (see
      // FileTree's commitRelease). Suppress the in-window split/dock preview so
      // the animation stops and it's clear nothing will dock here. Clear once
      // (only when a target is actually set) to avoid per-move store churn;
      // releasing Shift falls back to resolveTarget and the preview returns.
      if (e.shiftKey && d?.kind === "file") {
        if (
          d.overGroup != null ||
          d.edge != null ||
          d.reorderGroup != null ||
          d.reorderIndex != null
        ) {
          useDragStore.getState().setTarget({
            overGroup: null,
            edge: null,
            reorderGroup: null,
            reorderIndex: null,
          });
        }
        move(e.clientX, e.clientY);
        return;
      }
      resolveTarget(e.clientX, e.clientY);
      move(e.clientX, e.clientY);
    };
    // True only when the user explicitly aborts (Escape); a plain pointercancel
    // is NOT an abort on WebKitGTK — see onCancel.
    let aborted = false;
    const finish = () => {
      // File drags are committed AND torn down by FileTree's own pointerup
      // handler (the only listener that reliably sees the release on WebKitGTK).
      // Bail out here without commit or end() so we never race FileTree and tear
      // the drag down before it commits the drop.
      const d = useDragStore.getState().drag;
      // File drags commit via FileTree; detached-popout drags commit via the
      // cross-window END handler (#42). Neither commits here.
      if (d?.kind === "file" || d?.kind === "detached") {
        return;
      }
      // Commit the LAST resolved target (the one the live preview showed) rather
      // than re-resolving at the release coordinate (elementFromPoint there is
      // unreliable on WebKitGTK). The store already holds what every pointermove
      // resolved, so honour it verbatim. NOTE: on WebKitGTK these mid-gesture
      // window listeners receive pointermove but NOT the terminal pointerup, so
      // the actual commit normally comes from TabBar's pointerup handler (bound
      // before pointer capture). These handlers are a redundant path for other
      // platforms; the drag-store end() guard makes a double-commit a no-op.
      commitDrop(useDragStore.getState().drag);
      useDragStore.getState().end();
    };
    const onUp = () => finish();
    const onMouseUp = () => finish();
    // WebKitGTK frequently fires `pointercancel` INSTEAD of `pointerup` to end a
    // mouse drag (its native gesture/selection heuristic claims the stream after
    // pointermove), so on Linux a cancel commits the drop (else every drop is
    // swallowed). On Chromium/WKWebView (Win/mac) a real `pointerup` fires and a
    // `pointercancel` is a genuine capture loss → abort, not commit. The
    // `dragPlatform.cancelCommits` flag encodes exactly this split. An explicit
    // Escape (aborted) always ends without committing.
    const onCancel = () => {
      if (aborted || !dragPlatform.cancelCommits) { useDragStore.getState().end(); return; }
      finish();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        aborted = true;
        useDragStore.getState().end();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [dragging, resolveTarget]);

  // ── Cross-window drag-to-dock (#42) ───────────────────────────────────────
  // A popped-out window dragged back streams its OS cursor (PHYSICAL desktop px —
  // the canonical cross-window space, see lib/coords) to this main window. We map
  // it into OUR client px via our own frame (innerPhys/scale — the only DPI-correct
  // conversion), drive the SAME drop preview as an in-window tab drag (via
  // `resolveTarget` + the drag store), and dock the group on release.
  // `resolveTarget` is read through a ref so this listener — mounted once — always
  // hit-tests against current group rects. Setting the detached drag in the store
  // flips `.center-panel.dragging` on, which makes panes pointer-events:none so
  // elementFromPoint can reach the tab bars/bodies. The popout owns the pointer, so
  // the main window never sees real pointer events during the gesture and the
  // in-window drag effect above stays inert (its handlers also guard `kind ===
  // "detached"`).
  const resolveTargetRef = useRef(resolveTarget);
  resolveTargetRef.current = resolveTarget;
  useEffect(() => {
    const win = getCurrentWindow();
    // Our own window frame (physical px). Streamed physical cursor → our client px
    // via `physToClient` (innerPhys/scale). Snapshotted at each drag start (the
    // main window doesn't move mid-gesture).
    let frame: WindowFrame | null = null;
    const refreshFrame = async () => {
      try {
        frame = await snapshotFrame(win);
      } catch {
        frame = null;
      }
    };
    const toClient = (cursorPhysX: number, cursorPhysY: number) =>
      frame
        ? physToClient(frame, { x: cursorPhysX, y: cursorPhysY })
        : { x: cursorPhysX, y: cursorPhysY };

    const unsubs: Array<() => void> = [];
    let cancelled = false;
    const reg = (p: Promise<() => void>) =>
      p
        .then((fn) => {
          if (cancelled) fn();
          else unsubs.push(fn);
        })
        .catch(() => {});

    reg(
      listen<DetachedDragStart>(DETACHED_DRAG_START, (ev) => {
        const { scope: dScope, groupId, label, cursorPhysX, cursorPhysY, tabKey } = ev.payload;
        // Start the drag synchronously so the high-frequency MOVE poll that
        // follows isn't dropped by its `kind !== "detached"` guard while we await
        // the frame. Seed with the current (stale/identity) frame; refreshFrame()
        // then corrects it and we re-resolve. The main window doesn't move mid-gesture.
        const seed = toClient(cursorPhysX, cursorPhysY);
        useDragStore.getState().startDetachedDrag({
          label,
          pointerX: seed.x,
          pointerY: seed.y,
          detachedScope: dScope,
          detachedGroupId: groupId,
          detachedTabKey: tabKey,
        });
        resolveTargetRef.current(seed.x, seed.y);
        void refreshFrame().then(() => {
          if (useDragStore.getState().drag?.kind !== "detached") return;
          const { x, y } = toClient(cursorPhysX, cursorPhysY);
          useDragStore.getState().move(x, y);
          resolveTargetRef.current(x, y);
        });
      }),
    );

    reg(
      listen<DetachedDragMove>(DETACHED_DRAG_MOVE, (ev) => {
        if (useDragStore.getState().drag?.kind !== "detached") return;
        const { x, y } = toClient(ev.payload.cursorPhysX, ev.payload.cursorPhysY);
        useDragStore.getState().move(x, y);
        resolveTargetRef.current(x, y);
      }),
    );

    reg(
      listen<DetachedDragEnd>(DETACHED_DRAG_END, (ev) => {
        const d = useDragStore.getState().drag;
        if (d?.kind !== "detached") return;
        // Shift held at release → keep the popout floating as its own window
        // instead of docking it back (mirrors the main-window tab rule: Shift
        // always means "new window"). The popout already IS a separate window, so
        // honouring "new window" just means not docking. End the preview and bail.
        if (ev.payload.shift) {
          useDragStore.getState().end();
          return;
        }
        // END carries the LAST OS-cursor position in PHYSICAL desktop px (the DOM
        // release event fires inside the popout on WebKitGTK, so we cannot trust
        // `d.pointerX/Y` here). Re-map it to client coords and re-resolve the drop
        // target so `inMain` and the target reflect where the cursor actually is.
        let px = d.pointerX;
        let py = d.pointerY;
        if (ev.payload.cursorPhysX != null && ev.payload.cursorPhysY != null) {
          const c = toClient(ev.payload.cursorPhysX, ev.payload.cursorPhysY);
          px = c.x;
          py = c.y;
          useDragStore.getState().move(px, py);
          resolveTargetRef.current(px, py);
        }
        // Re-read the drag after the final resolve so over/reorder targets are
        // the ones the cursor ended over.
        const f = useDragStore.getState().drag;
        // Dock only when released over THIS window's content and not cancelled;
        // dropping outside the main window (or Escape) leaves the popout floating.
        const inMain =
          px >= 0 &&
          py >= 0 &&
          px <= window.innerWidth &&
          py <= window.innerHeight;
        if (
          !ev.payload.cancelled &&
          inMain &&
          f?.kind === "detached" &&
          f.detachedGroupId &&
          f.detachedScope &&
          f.detachedTabKey
        ) {
          // Single-tab dock-back: dock just the dragged tab into its OWN scope's
          // layout at the resolved target (a tab bar → merge; a body edge →
          // split; otherwise default placement), then re-seed the popout so it
          // drops the docked tab (or, if that emptied it, the popout has already
          // closed). The resolved targets are the active scope's groups, so they
          // only apply when the popout's scope IS the active one; cross-scope
          // falls through to default placement inside its stored layout.
          const store = useTabsStore.getState();
          const sameScope = store.scope === f.detachedScope;
          const target =
            sameScope && f.reorderGroup
              ? { targetGroupId: f.reorderGroup, edge: "center" as const }
              : sameScope && f.overGroup && f.edge
                ? { targetGroupId: f.overGroup, edge: f.edge }
                : undefined;
          store.attachDetachedTab(
            f.detachedScope,
            f.detachedGroupId,
            f.detachedTabKey,
            target,
          );
          // Docked back into the active scope's layout → play the drop-in
          // landing on the tab as it mounts in its destination bar.
          if (sameScope) useTabLandStore.getState().markLanded(f.detachedTabKey);
          const entry = useTabsStore
            .getState()
            .detachedGroupsByScope[f.detachedScope]?.find(
              (d) => d.id === f.detachedGroupId,
            );
          if (entry) {
            const seed = buildSeed(
              f.detachedScope,
              f.detachedGroupId,
              useTabsStore.getState().tabsByScope[f.detachedScope] ?? [],
              entry.subtree,
            );
            void emit(detachedSeedEvent(entry.label), seed);
          }
          useDragStore.getState().end();
          return;
        }
        // Per-tab FREE-SPACE release (outside both windows): pop the dragged tab
        // into its OWN new popout at the cursor — the popout analog of TabBar's
        // `popToNewWindow`. Bounds use the PHYSICAL cursor (`cursorPhysX/Y`), as
        // Rust `.position()` is physical (the client `px/py` would be wrong under
        // DPI scaling), matching detachTab/popToNewWindow. After splitting we
        // re-seed the SOURCE popout so it drops the tab that just left.
        if (
          !ev.payload.cancelled &&
          !inMain &&
          f?.kind === "detached" &&
          f.detachedScope &&
          f.detachedGroupId &&
          f.detachedTabKey &&
          ev.payload.cursorPhysX != null &&
          ev.payload.cursorPhysY != null
        ) {
          const store = useTabsStore.getState();
          const bounds = {
            x: Math.round(ev.payload.cursorPhysX - 80),
            y: Math.round(ev.payload.cursorPhysY - 8),
            w: 900,
            h: 640,
          };
          const newLabel = store.detachTabToNewWindow(
            f.detachedScope,
            f.detachedGroupId,
            f.detachedTabKey,
            bounds,
          );
          if (newLabel) {
            const src = useTabsStore
              .getState()
              .detachedGroupsByScope[f.detachedScope]?.find(
                (d) => d.id === f.detachedGroupId,
              );
            if (src) {
              const seed = buildSeed(
                f.detachedScope,
                f.detachedGroupId,
                useTabsStore.getState().tabsByScope[f.detachedScope] ?? [],
                src.subtree,
              );
              void emit(detachedSeedEvent(src.label), seed);
            }
          }
          useDragStore.getState().end();
          return;
        }
        if (!ev.payload.cancelled && inMain && f?.kind === "detached" && f.detachedGroupId) {
          const store = useTabsStore.getState();
          // Mirror the button-path branch in `listenDetachedHost` (detached.ts):
          // `attachGroup` re-injects only into the ACTIVE scope's live layout, so
          // it can only dock a group whose scope is currently active. When the
          // popout's scope is NOT the active one, re-inject into that scope's
          // STORED layout via `dropDetachedGroup` instead — otherwise attachGroup
          // silently no-ops and the drop is swallowed.
          if (f.detachedScope && store.scope === f.detachedScope) {
            if (f.reorderGroup) {
              // Released over a tab bar → merge into that group.
              store.attachGroup(f.detachedGroupId, {
                targetGroupId: f.reorderGroup,
                edge: "center",
              });
            } else if (f.overGroup && f.edge) {
              store.attachGroup(f.detachedGroupId, {
                targetGroupId: f.overGroup,
                edge: f.edge,
              });
            } else {
              // Over the panel but no resolved target → default placement.
              store.attachGroup(f.detachedGroupId);
            }
          } else if (f.detachedScope) {
            // Cross-scope drop: re-inject into the popout's stored layout (target
            // edges don't apply to a layout that isn't currently rendered).
            store.dropDetachedGroup(f.detachedScope, f.detachedGroupId);
          }
        }
        useDragStore.getState().end();
      }),
    );

    return () => {
      cancelled = true;
      for (const fn of unsubs) fn();
    };
  }, []);

  // ── Render the flat pane layer (all tabs, all scopes; never unmounted) ─────
  // Memoized so unrelated re-renders (drag flags, group-rect churn) don't rebuild
  // these whole-store maps every frame (Eff #7). The pane layer genuinely needs
  // EVERY scope's tabs (panes stay mounted across switches), so the subscription
  // stays broad — but the rebuild is now keyed to the inputs that change it.
  const allTabs = useMemo(
    () =>
      Object.entries(tabsByScope).flatMap(([s, scopeTabs]) =>
        scopeTabs.map((tab) => ({ tab, scopeKey: s })),
      ),
    [tabsByScope],
  );
  // For each current-scope group: its active (visible) tab key, and the group id
  // holding each visible tab key. Rebuilt only when the current scope's layout
  // tree changes — not on every render.
  const { activeKeyOfGroup, groupOfKey } = useMemo(() => {
    const activeKeyOfGroup = new Map<string, string>();
    const groupOfKey = new Map<string, string>();
    for (const g of allGroups(layoutByScope[scope] ?? null)) {
      if (g.activeKey) activeKeyOfGroup.set(g.id, g.activeKey);
      for (const k of g.tabKeys) groupOfKey.set(k, g.id);
    }
    return { activeKeyOfGroup, groupOfKey };
  }, [layoutByScope, scope]);
  // #62: fullscreen is active only when the stored group actually exists in the
  // current scope (a stale id from another scope is ignored). When active, the
  // fullscreened group's pane is sized to the whole panel and all others hidden.
  const fsActive = fullscreenGroupId != null && groupRects[fullscreenGroupId] != null;
  const panelRect = panelRef.current?.getBoundingClientRect();
  const fullRect: Rect | undefined = panelRect
    ? { left: 0, top: 0, width: panelRect.width, height: panelRect.height }
    : undefined;

  return (
    <div
      ref={panelRef}
      className={`center-panel${dragging ? " dragging" : ""}${fsActive ? " fullscreen" : ""}${windowMoving ? " moving" : ""}`}
    >
      {/* Subwindow frame layer: the recursive layout tree for the current scope.
          Each group body is an empty measured slot; panes are positioned over
          it by the flat layer below. */}
      {renderLayout ? (
        <LayoutTree
          node={renderLayout}
          projectCwd={projectCwd}
          resizeSplit={resizeSplit}
          panelRef={panelRef}
          registerGroupBody={registerGroupBody}
          onResized={measure}
        />
      ) : (
        // No tabs yet: render an empty subwindow so its tab bar's "+" is always
        // available to create the first tab. EMPTY_GROUP_ID isn't a real group
        // (the store has no layout) — the add menu's addTab() creates the root
        // group, which then replaces this placeholder with a real LayoutTree.
        <Subwindow groupId={EMPTY_GROUP_ID} projectCwd={projectCwd}>
          {/* Measured like a real group body so a file dragged from the right
              panel can drop anywhere over the (full-panel) empty placeholder and
              become the first tab — see commitFileDrop's empty-state branch. */}
          <div
            ref={registerGroupBody(EMPTY_GROUP_ID)}
            className="center-placeholder"
            style={{ height: "100%" }}
          >
            <div className="center-placeholder-card">
              <div className="center-placeholder-title">No tabs open</div>
              <div className="center-placeholder-hint">
                Use <span className="center-placeholder-key">+</span> on the tab bar above to open a
                shell or an AI agent.
              </div>
            </div>
          </div>
        </Subwindow>
      )}

      {/* Pane layer: every tab across every scope, kept mounted. A pane is shown
          only when its tab is the active tab of its current-scope group, sized
          to that group's measured body rect. */}
      <div className="pane-layer">
        {allTabs.map(({ tab, scopeKey }) => {
          const isCurrentScope = scopeKey === scope;
          const groupId = isCurrentScope ? groupOfKey.get(tab.key) : undefined;
          // While a group is fullscreen, only that group's active pane shows.
          const visible =
            isCurrentScope &&
            groupId != null &&
            activeKeyOfGroup.get(groupId) === tab.key &&
            (!fsActive || groupId === fullscreenGroupId);
          // The fullscreened group's pane is stretched over the whole panel; all
          // others keep their measured rect (but are hidden by `visible` above).
          const rect =
            fsActive && groupId === fullscreenGroupId
              ? (fullRect ?? (groupId ? groupRects[groupId] : undefined))
              : groupId
                ? groupRects[groupId]
                : undefined;
          const style: React.CSSProperties = visible && rect
            ? {
                display: "flex",
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                // Lift the fullscreened pane above the frame layer (tab bars).
                ...(fsActive && groupId === fullscreenGroupId ? { zIndex: 5 } : {}),
              }
            : { display: "none" };
          // Mount-free remote, per-pane gating. A remote project's LOCAL panes
          // run on the mirror and work offline; only remote-I/O panes must wait
          // for the pool. Keyed by THIS pane's scope (not the active project) so
          // a disconnected remote project switched away from never un-holds.
          const paneProject = projects.find((p) => p.id === scopeKey);
          const paneRemoteProj = !!paneProject?.remote;
          const paneDisconnected =
            paneRemoteProj && remoteSshByProject[scopeKey]?.ssh !== "connected";
          // A terminal pane is "remote" when its effective locality is remote
          // (default shells; agents/shells toggled remote). Held while the pool
          // is down: spawning `ssh -tt` now would block on the dead pool.
          const holdRemoteTerminal =
            paneDisconnected &&
            isPtyTabKind(tab.kind) &&
            effectiveTabLocation(tab) === "remote";
          return (
            <div
              key={`${scopeKey}/${tab.key}`}
              className="center-pane"
              // Lets a tab drag locate this pane's live DOM to clone a content
              // thumbnail into the drag ghost (see DragGhost / startTabDrag).
              data-scope-key={scopeKey}
              data-tab-key={tab.key}
              // Clicking anywhere in a pane focuses its subwindow. The panes sit
              // in this layer ABOVE the .subwindow frame, so Subwindow's own
              // mousedown-capture only sees clicks on its tab bar — the body
              // clicks land here. Capture-phase + no preventDefault so the
              // terminal/viewer still receives the click for focus/selection.
              onMouseDownCapture={() => {
                if (!groupId) return;
                const t = useTabsStore.getState();
                if (t.focusedGroupId !== groupId) t.focusGroup(groupId);
              }}
              style={style}
            >
              {tab.kind === "projects3d" ? (
                <ProjectBlobPane />
              ) : tab.kind === "calendar" ? (
                <CalendarPane visible={visible} />
              ) : tab.kind === "network" ? (
                <NetworkTrafficPane
                  projectId={scopeKey}
                  visible={visible}
                  onConnect={() => openConnectDialog(scopeKey)}
                />
              ) : tab.kind === "files" ? (
                <FileBrowser
                  // While a remote project is disconnected the SFTP tree can't be
                  // listed (it would freeze the main thread), so browse the local
                  // mirror instead — the same synced working copy the local tabs
                  // use. `list_dir` routes the mirror path locally; FileBrowser
                  // re-lists when `projectDir` changes, so it swaps back to the
                  // remote tree automatically once the pool is connected.
                  projectDir={
                    paneDisconnected
                      ? localTabCwd(
                          { kind: "files" },
                          {
                            isRemoteProject: true,
                            projectDirectory: resolveProjectDirectory(paneProject),
                            mirror: resolveLocalMirror(paneProject),
                            fallback: tab.cwd,
                          },
                        )
                      : tab.cwd
                  }
                  projectId={scopeKey === "root" ? null : scopeKey}
                  active={visible}
                />
              ) : tab.kind === "embed" ? (
                tab.viewer ? (
                  <FileViewerPane
                    viewer={tab.viewer}
                    path={tab.embedPath ?? ""}
                    projectId={scopeKey === "root" ? null : scopeKey}
                    tabKey={tab.key}
                    visible={visible}
                  />
                ) : (
                  <EmbedPane
                    path={tab.embedPath ?? ""}
                    exec={tab.embedExec}
                    projectId={scopeKey === "root" ? null : scopeKey}
                    visible={visible}
                  />
                )
              ) : holdRemoteTerminal ? (
                // Remote terminal pane while the pool is down: don't mount
                // TerminalView (it would spawn `ssh -tt` and block on the dead
                // pool). Show a Connect placeholder; when the project connects
                // this pane re-renders, mounts TerminalView, and spawns — a
                // resumable agent resumes via its saved args.
                <RemotePaneHold
                  host={paneProject?.remote?.host ?? ""}
                  onConnect={() => openConnectDialog(scopeKey)}
                />
              ) : (
                <TerminalView
                  // PTY ids must include the scope: tab keys alone can collide
                  // across projects (restored layouts), which would attach two
                  // projects' terminals to the same PTY stream.
                  id={`${scopeKey}:${tab.key}`}
                  cmd={tab.cmd}
                  args={tab.args ?? []}
                  env={tab.env ?? {}}
                  initialInput={tab.initialInput}
                  // SSH-sync Phase 0: a local-on-remote tab runs in the project's
                  // local mirror (state dir), not the remote tree it can't reach.
                  cwd={localTabCwd(tab, {
                    isRemoteProject: !!projects.find((p) => p.id === scopeKey)?.remote,
                    projectDirectory: resolveProjectDirectory(
                      projects.find((p) => p.id === scopeKey),
                    ),
                    mirror: resolveLocalMirror(
                      projects.find((p) => p.id === scopeKey),
                    ),
                    fallback: tab.cwd,
                  })}
                  // SSH-sync Phase 0: agents default LOCAL on a remote project,
                  // shells default REMOTE; the per-tab toggle overrides. local_agent
                  // stays fixed-local (effectiveTabLocation handles it).
                  localOnly={effectiveTabLocation(tab) === "local"}
                  // The owning project's id (null for the root scope), so the
                  // backend spawn detects remoteness explicitly instead of
                  // sniffing the cwd. Harmless for local projects.
                  projectId={scopeKey === "root" ? null : scopeKey}
                  // Run agent tabs in a Docker sandbox when this tab's project
                  // has the sandbox toggle on. Local projects only (a remote
                  // project is ssh-wrapped instead). Derived here, not at tab
                  // creation, so restored agent tabs are covered too.
                  sandbox={
                    tab.kind === "agent" &&
                    scopeKey !== "root" &&
                    (() => {
                      const proj = projects.find((p) => p.id === scopeKey);
                      return !!proj?.sandbox?.enabled && !proj?.remote;
                    })()
                  }
                  // Agent panes are font-zoomable (Ctrl+wheel / Ctrl +/-/0);
                  // plain shells keep the fixed default size.
                  zoomable={tab.kind === "agent" || tab.kind === "local_agent"}
                  visible={visible}
                  focused={visible}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Split preview: darkens the half (or whole, for center) a drop would
          carve out. Rendered here — above the pane layer — because an opaque
          terminal pane (z-index:2) would otherwise paint over it if it lived in
          a subwindow body. Coordinates come from the same measured group rects. */}
      <SplitPreviewOverlay groupRects={groupRects} />

      {/* Focus frame (always) + Shift+↑/↓ subwindow numbering (transient), drawn
          above the pane layer for the same reason as the split preview — the
          opaque panes (z-index:2) would otherwise cover an in-body frame. */}
      <FocusFrameOverlay
        groupRects={groupRects}
        orderedIds={allGroups(layoutByScope[scope] ?? null).map((g) => g.id)}
      />

      {/* Floating ghost following the pointer during a drag. */}
      <DragGhost />

      {/* One-shot send-off when a tab/subwindow is dropped out to its own window. */}
      <DetachFlourish />
    </div>
  );
}

/**
 * The one-shot "fly-out" played when a tab or subwindow is dropped OUT of the
 * main window into its own OS window (see stores/detachAnim). A card appears at
 * the gesture's last in-window position and — via a CSS animation — lifts,
 * scales, and fades while sliding toward the edge the content exited through, so
 * the detach reads as the content being ejected into its own window. Clears
 * itself on `animationend` (matched by nonce, so a fresh fly-out isn't cut off).
 * Portalled to document.body so it isn't clipped by the panel. Honors
 * prefers-reduced-motion via the CSS (the animation collapses to a quick fade).
 */
export function DetachFlourish() {
  const flourish = useDetachAnimStore((s) => s.flourish);
  const clear = useDetachAnimStore((s) => s.clear);
  if (!flourish) return null;
  const { x, y, w, h, label, dx, dy, nonce } = flourish;
  return createPortal(
    <div
      key={nonce}
      className="tab-detach-flourish"
      style={
        {
          left: x,
          top: y,
          width: w,
          height: h,
          "--fly-dx": `${dx}px`,
          "--fly-dy": `${dy}px`,
        } as React.CSSProperties
      }
      onAnimationEnd={() => clear(nonce)}
    >
      <div className="tab-detach-flourish-label">{label}</div>
    </div>,
    document.body,
  );
}

/**
 * The translucent half/whole highlight previewing where a drop lands, drawn in
 * panel coordinates above the pane layer. Subscribes to the drag store with two
 * PRIMITIVE selectors (overGroup + edge) rather than the whole drag object, so
 * move()'s per-frame coord churn — which leaves these two equal — never
 * re-renders it; only setTarget (a changed target) does. Preserves the no-churn
 * design while letting the preview sit in CenterPanel's stacking context.
 */
export function SplitPreviewOverlay({ groupRects }: { groupRects: Record<string, Rect> }) {
  const overGroup = useDragStore((s) => s.drag?.overGroup ?? null);
  const edge = useDragStore((s) => s.drag?.edge ?? null);
  if (!overGroup || !edge) return null;
  const r = groupRects[overGroup];
  if (!r) return null;
  const ins = previewInset(edge);
  const left = r.left + ins.left * r.width;
  const top = r.top + ins.top * r.height;
  const width = r.width * (1 - ins.left - ins.right);
  const height = r.height * (1 - ins.top - ins.bottom);
  return <div className="split-preview" style={{ left, top, width, height }} />;
}

/**
 * The focused-subwindow marker, drawn above the pane layer (see the render site
 * for why). Two roles:
 *  - Always: a light accent frame around the focused subwindow's pane rect.
 *  - While Shift+↑/↓ subwindow-nav is active: the frame follows the previewed
 *    group and every subwindow shows a numbered badge — the committed focus is
 *    0, others numbered in document order (wrapping) so ↑/↓ read as relative
 *    steps. Focus commits (moving the frame's committed home) on Shift release.
 * `pointer-events: none`, panel-relative coords from the same measured rects.
 */
export function FocusFrameOverlay({
  groupRects,
  orderedIds,
}: {
  groupRects: Record<string, Rect>;
  orderedIds: string[];
}) {
  const focusedGroupId = useTabsStore((s) => s.focusedGroupId);
  const navActive = useSubwindowNavStore((s) => s.active);
  const previewGroupId = useSubwindowNavStore((s) => s.previewGroupId);

  const frameId = navActive && previewGroupId ? previewGroupId : focusedGroupId;
  const frameRect = frameId ? groupRects[frameId] : undefined;
  const n = orderedIds.length;
  const f = frameId ? orderedIds.indexOf(frameId) : -1;

  return (
    <>
      {frameRect && (
        <div
          className="focus-frame"
          style={{
            left: frameRect.left,
            top: frameRect.top,
            width: frameRect.width,
            height: frameRect.height,
          }}
        />
      )}
      {navActive &&
        f >= 0 &&
        orderedIds.map((id, p) => {
          const r = groupRects[id];
          if (!r) return null;
          const down = (p - f + n) % n;
          const up = (n - down) % n;
          const label =
            down === 0 ? "0" : down <= up ? `${down}↓` : `${up}↑`;
          return (
            <div
              key={id}
              className="subwindow-number"
              style={{ left: r.left + 6, top: r.top + 6 }}
            >
              {label}
            </div>
          );
        })}
    </>
  );
}

/**
 * The dragged tab floating at the pointer: its label plus, for tab drags, a
 * scaled thumbnail of the tab's live CONTENT (a clone captured at drag start)
 * so it's clear WHAT is moving, not just where it lands. Subscribes to the drag
 * store itself (rather than via CenterPanel props) so the panel doesn't re-render
 * on every pointermove. Rendered into document.body so it isn't clipped.
 */
const GHOST_THUMB_W = 280; // px; the thumbnail's on-screen width.

export function DragGhost() {
  // Eff #14: subscribe to COARSE PRIMITIVE selectors (mirroring
  // SplitPreviewOverlay / stores/drag.ts), not the whole `drag` object. The
  // ghost still re-renders each frame to follow the pointer (pointerX/Y change),
  // but the heavy `previewNode` / its dimensions are read as stable primitives,
  // so the clone-mount effect's deps don't churn and React diffs only the moved
  // position. `active` gates the whole render off when no drag is in flight.
  const active = useDragStore((s) => s.drag != null);
  const pointerX = useDragStore((s) => s.drag?.pointerX ?? 0);
  const pointerY = useDragStore((s) => s.drag?.pointerY ?? 0);
  const label = useDragStore((s) => s.drag?.label ?? "");
  // During a file drag (pointer-based drag-to-tab) the ghost lists the available
  // drop options so the user can see what each release will do.
  const isFileDrag = useDragStore((s) => s.drag?.kind === "file");
  const node = useDragStore((s) => s.drag?.previewNode ?? null);
  const srcW = useDragStore((s) => s.drag?.previewW ?? 0);
  const srcH = useDragStore((s) => s.drag?.previewH ?? 0);
  const thumbRef = useRef<HTMLDivElement>(null);

  // Track Shift live so the options legend can highlight "force new window"
  // while the file drag is in flight (Shift can toggle without a pointer move,
  // which wouldn't otherwise re-render the ghost).
  const [shiftHeld, setShiftHeld] = useState(false);
  useEffect(() => {
    if (!isFileDrag) return;
    const sync = (e: KeyboardEvent) => setShiftHeld(e.shiftKey);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      setShiftHeld(false);
    };
  }, [isFileDrag]);

  // Mount the cloned pane once per drag and scale it to fit GHOST_THUMB_W. Done
  // in an effect (not inline) so the heavy clone isn't re-appended on every
  // pointermove re-render — only the ghost's left/top change then.
  useEffect(() => {
    const holder = thumbRef.current;
    if (!holder || !node || srcW <= 0) return;
    const scale = GHOST_THUMB_W / srcW;
    node.style.transformOrigin = "top left";
    node.style.transform = `scale(${scale})`;
    holder.appendChild(node);
    return () => {
      if (node.parentNode === holder) holder.removeChild(node);
    };
  }, [node, srcW]);

  if (!active) return null;
  const thumbH = node && srcW > 0 ? (srcH * GHOST_THUMB_W) / srcW : 0;
  return createPortal(
    <div className="tab-drag-ghost" style={{ left: pointerX, top: pointerY }}>
      <div className="tab-drag-ghost-label">{label}</div>
      {isFileDrag ? (
        <div className="tab-drag-ghost-opts">
          <div className="tab-drag-ghost-opt">Drop on a folder → move file there</div>
          <div className={`tab-drag-ghost-opt${shiftHeld ? "" : " active"}`}>
            Drop → open in new window / dock into popout
          </div>
          <div className={`tab-drag-ghost-opt${shiftHeld ? " active" : ""}`}>
            ⇧ Shift → force a new window
          </div>
          <div className="tab-drag-ghost-opt">⌃ Ctrl-drag → copy to Signal / browser</div>
        </div>
      ) : null}
      {node ? (
        <div
          className="tab-drag-ghost-thumb"
          ref={thumbRef}
          style={{ width: GHOST_THUMB_W, height: thumbH }}
        />
      ) : null}
    </div>,
    document.body,
  );
}

// ── Recursive layout renderer ────────────────────────────────────────────────

interface TreeProps {
  node: LayoutNode;
  projectCwd: string;
  resizeSplit: (splitId: string, dividerIndex: number, fraction: number) => void;
  panelRef: React.RefObject<HTMLDivElement>;
  registerGroupBody: (id: string) => (el: HTMLDivElement | null) => void;
  onResized: () => void;
}

function LayoutTree(props: TreeProps) {
  const { node } = props;
  if (node.type === "group") {
    return (
      <Subwindow groupId={node.id} projectCwd={props.projectCwd}>
        {/* Empty measured body — panes are overlaid by CenterPanel. */}
        <div className="subwindow-pane-slot" ref={props.registerGroupBody(node.id)} />
      </Subwindow>
    );
  }
  return <SplitView {...props} node={node} />;
}

function SplitView(props: TreeProps & { node: Extract<LayoutNode, { type: "split" }> }) {
  const { node } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  // Minimum subwindow size (px) a divider drag may shrink a pane to, per axis,
  // from global settings (falling back to the built-in default).
  const minWidth = useSettingsStore((s) => s.settings?.min_subwindow_width) ?? DEFAULT_MIN_SUBWINDOW_PX;
  const minHeight = useSettingsStore((s) => s.settings?.min_subwindow_height) ?? DEFAULT_MIN_SUBWINDOW_PX;

  const startDrag = (dividerIndex: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      // The new fraction is the pointer position within the SPAN of the two
      // children adjacent to this divider, measured from the container origin.
      const isRow = node.dir === "row";
      const total = isRow ? rect.width : rect.height;
      if (total <= 0) return;
      const pos = isRow ? ev.clientX - rect.left : ev.clientY - rect.top;
      // Fraction of the whole container up to the pointer.
      const wholeFraction = Math.min(Math.max(pos / total, 0), 1);
      // Sum of sizes before this divider's left child.
      let before = 0;
      for (let i = 0; i < dividerIndex; i++) before += node.sizes[i];
      const pair = node.sizes[dividerIndex] + node.sizes[dividerIndex + 1];
      // Desired size of the left child of the pair = pointer fraction minus the
      // space taken by everything before the pair.
      const leftSize = wholeFraction - before;
      // Enforce the min subwindow size: neither side of the pair may shrink below
      // `minPx` (as a fraction of the container). If the pair is too small to fit
      // both minimums, split it evenly.
      const minPx = isRow ? minWidth : minHeight;
      const minFrac = Math.min(minPx / total, pair / 2);
      const clamped = Math.min(Math.max(leftSize, minFrac), pair - minFrac);
      props.resizeSplit(node.id, dividerIndex, clamped);
      props.onResized();
    };
    const onUp = (ev: PointerEvent) => {
      (e.target as HTMLElement).releasePointerCapture?.(ev.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      props.onResized();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={containerRef}
      className={`split split-${node.dir}`}
      style={{ flexDirection: node.dir === "row" ? "row" : "column" }}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          <div
            className="split-child"
            // flex-basis carries the size fraction; grow/shrink let dividers
            // claim their fixed pixels without distorting the ratio noticeably.
            style={{ flex: `${node.sizes[i] ?? 1} 1 0` }}
          >
            <LayoutTree {...props} node={child} />
          </div>
          {i < node.children.length - 1 && (
            <div
              className={`split-divider split-divider-${node.dir}`}
              onPointerDown={startDrag(i)}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}
