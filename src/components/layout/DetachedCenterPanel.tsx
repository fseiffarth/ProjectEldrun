import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import {
  DETACHED_DRAG_END,
  DETACHED_DRAG_MOVE,
  DETACHED_DRAG_START,
  type DetachedDragEnd,
  type DetachedDragMove,
  type DetachedDragStart,
} from "../../stores/detached";
import { TerminalView } from "../terminal/TerminalView";
import { FileBrowser } from "../files/FileBrowser";
import { EmbedPane } from "../embed/EmbedPane";
import { FileViewerPane } from "../embed/FileViewerPane";
import { WindowControls } from "../header/WindowControls";
import { DragGhost } from "./CenterPanel";
import { useDragStore } from "../../stores/drag";
import type { GroupNode, TabEntry } from "../../stores/tabs";

// Fixed width of the gap that opens within the bar to receive a reordered tab.
// Mirrors TabBar's constant so the popout's within-bar reorder looks identical.
const REORDER_GAP = 80;

interface Props {
  scope: string;
  /** The single group this detached window renders. */
  group: GroupNode;
  /** The group's tab payloads (already filtered to this group). */
  tabs: TabEntry[];
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  /** Reorder this group's tabs (a tab dragged + dropped back onto its own bar). */
  onReorder: (tabKeys: string[]) => void;
}

/**
 * #42: the detached window's single-group center surface. A stripped CenterPanel
 * that renders ONLY this one group's tab bar + pane layer — no project switcher,
 * no right panel, no LayoutTree, and crucially no project-switch effects. Its
 * terminals run ATTACH-ONLY (the PTY is owned by the main window's pane), so they
 * never spawn or kill a PTY. The pane layer keeps every tab mounted; only the
 * active one is shown.
 */
export function DetachedCenterPanel({
  scope,
  group,
  tabs,
  onActivate,
  onClose,
  onReorder,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  // Within-bar reorder visuals, driven by THIS popout's own drag store (a
  // separate JS heap from the main window). While a tab is dragged, the dragged
  // tab collapses and a gap slides open at the live drop slot — mirroring the
  // main window's TabBar (#42 drag parity).
  const dragKey = useDragStore((s) => (s.drag ? s.drag.key : null));
  const reorderIndex = useDragStore((s) =>
    s.drag && s.drag.reorderGroup === group.id ? s.drag.reorderIndex : null,
  );
  const byKey = new Map(tabs.map((t) => [t.key, t] as const));
  const orderedTabs = group.tabKeys
    .map((k) => byKey.get(k))
    .filter((t): t is TabEntry => t != null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () =>
      setRect({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // #42: grab the popout's top frame (the empty tab-bar area) to move/dock the
  // WHOLE group. The popout follows the cursor and, while the cursor is over the
  // main window, the main window shows the same split/merge drop preview as an
  // in-window tab drag and docks the group on release (`beginDockDrag` with
  // moveWindow). Released anywhere else, the popout simply stays where it was
  // dragged. We drive the move ourselves (no `startDragging`), so we trade away
  // KWin's native edge-snap/maximize-on-drag for cross-window docking. Dragging a
  // single TAB (not the bar) is handled per-tab by `onTabPointerDown`.
  const onTabBarPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Only the empty bar area is a drag handle — not the tabs or the controls.
    if (target.closest(".tab, .detached-titlebar-controls, button")) return;
    e.preventDefault();
    // The whole popout follows the cursor and docks the WHOLE group.
    beginDockDrag({
      pointerId: e.pointerId,
      screenX: e.screenX,
      screenY: e.screenY,
      captureEl: e.currentTarget as HTMLElement,
      label:
        orderedTabs.find((t) => t.key === group.activeKey)?.label ?? "Subwindow",
      moveWindow: true,
    });
  };

  // #42: dragging a SINGLE tab. Activate on press, then once the pointer crosses
  // a small threshold start a per-tab dock drag (mirrors the main window's
  // TabBar): the cursor streams to the main window, which previews + docks just
  // this tab on release over it. Released back over THIS popout's own tab bar it
  // reorders locally; released over the popout body it stays put. The popout
  // itself does NOT move (moveWindow:false) — only the dragged tab travels.
  const onTabPointerDown = (e: React.PointerEvent, tab: TabEntry) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // don't also start the whole-group bar drag.
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
        // Client coords seed the local ghost so it appears under the cursor
        // before the async window-origin resolves (the poll corrects it after).
        clientX: ev.clientX,
        clientY: ev.clientY,
        captureEl: null,
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

  // Resolve the within-bar reorder slot under a popout-client point and write it
  // to this popout's drag store, driving the live gap (and clearing it when the
  // cursor is off the bar — e.g. over the body or out over the main window).
  // Mirrors CenterPanel.resolveTarget's tab-bar branch.
  const resolveLocalReorder = (clientX: number, clientY: number) => {
    const setTarget = useDragStore.getState().setTarget;
    const clear = () =>
      setTarget({ overGroup: null, edge: null, reorderGroup: null, reorderIndex: null });
    const bar = barRef.current;
    if (!bar) return clear();
    const br = bar.getBoundingClientRect();
    const overBar =
      clientX >= br.left &&
      clientX <= br.right &&
      clientY >= br.top &&
      clientY <= br.bottom;
    if (!overBar) return clear();
    const tabEls = Array.from(bar.querySelectorAll<HTMLElement>(".tab"));
    let slot = tabEls.length;
    for (let i = 0; i < tabEls.length; i++) {
      const r = tabEls[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) {
        slot = i;
        break;
      }
    }
    setTarget({ overGroup: null, edge: null, reorderGroup: group.id, reorderIndex: slot });
  };

  // If a per-tab drag ends back over THIS popout's own tab bar, reorder locally
  // (client coords are the cursor minus the popout's content origin, both in CSS
  // px). A drop over the body is a no-op. Returns true if the release was over
  // this popout at all (so the host must NOT also dock it into the main window).
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
    const bar = barRef.current;
    if (bar) {
      const br = bar.getBoundingClientRect();
      const overBar =
        clientX >= br.left &&
        clientX <= br.right &&
        clientY >= br.top &&
        clientY <= br.bottom;
      if (overBar) {
        const tabEls = Array.from(bar.querySelectorAll<HTMLElement>(".tab"));
        let idx = tabEls.length;
        for (let i = 0; i < tabEls.length; i++) {
          const r = tabEls[i].getBoundingClientRect();
          if (clientX < r.left + r.width / 2) {
            idx = i;
            break;
          }
        }
        const cur = group.tabKeys;
        const from = cur.indexOf(tabKey);
        if (from >= 0) {
          let to = idx;
          if (from < to) to -= 1; // account for the source's own removal.
          if (to !== from) {
            const next = [...cur];
            next.splice(from, 1);
            next.splice(to, 0, tabKey);
            onReorder(next);
          }
        }
      }
    }
    return true;
  };

  // #42: drag-to-dock. We stream the gesture's OS-LEVEL CURSOR position to the
  // main window, which maps it into its client space, renders the dock preview,
  // and docks the group on release. We do NOT rely on DOM pointer events crossing
  // into the main window: on WebKitGTK (especially Wayland) DOM pointermove/up do
  // not cross the OS window boundary, so the stream would die at the popout's edge
  // and the drop would commit at stale in-popout coords (never docking). Instead
  // we POLL `cursorPosition()` on a timer; that is a desktop-global PHYSICAL
  // position, so we (a) divide by our scale factor to emit logical/CSS px for the
  // main window (which subtracts its logical origin in the same unit) and (b) use
  // the raw physical position to move our OWN window so it follows the cursor like
  // a dragged tab. Release is detected via DOM pointerup/pointercancel (which fire
  // in the popout when released over it; an X11 implicit grab also delivers them
  // when released over the main window). END carries the LAST polled cursor
  // position so the drop resolves where the cursor truly is. Only Escape cancels;
  // pointercancel commits (WebKitGTK fires it in place of pointerup).
  const beginDockDrag = (args: {
    pointerId: number;
    screenX: number;
    screenY: number;
    clientX?: number;
    clientY?: number;
    captureEl: HTMLElement | null;
    label: string;
    moveWindow: boolean;
    tabKey?: string;
  }) => {
    const { pointerId, captureEl, label: dragLabel, moveWindow, tabKey } = args;
    try {
      captureEl?.setPointerCapture(pointerId);
    } catch {
      /* capture is best-effort; the OS-cursor poll does not depend on it */
    }

    const win = getCurrentWindow();
    // Latest OS cursor position in logical/CSS px (updated by the poll). Seeded
    // from the pointerdown's screen coords (WebKitGTK reports these in CSS px).
    let last = { x: args.screenX, y: args.screenY };
    let scale = 1;
    let done = false;
    // Physical offset from the window's top-left to the cursor at grab time, so
    // the window can follow the cursor without jumping (whole-group drag only).
    let grab: { x: number; y: number } | null = null;
    let moving = false; // in-flight guard so 60 Hz polls don't queue setPosition.
    // This popout's content origin in screen CSS px, so a per-tab release can be
    // mapped to client coords for the local-bar hit-test. Resolved async.
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
      groupId: group.id,
      label: dragLabel,
      screenX: last.x,
      screenY: last.y,
      tabKey,
    } satisfies DetachedDragStart);

    // Per-tab drag: drive THIS popout's own drag store so the bar shows the same
    // live feedback as the main window — the dragged tab collapses, a content
    // thumbnail follows the cursor (DragGhost), and a gap opens at the drop slot.
    // The visuals are local to the popout; cross-window docking is still driven by
    // the streamed DETACHED_DRAG_* events above. Clone the active pane for the
    // ghost thumbnail, picking the VISIBLE pane (hidden duplicates measure zero).
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
        fromGroup: group.id,
        label: dragLabel,
        pointerX: args.clientX ?? 0,
        pointerY: args.clientY ?? 0,
        previewNode,
        previewW,
        previewH,
      });
    }

    // Poll the OS cursor (~60 Hz). This is what survives the cursor leaving the
    // popout window — DOM pointermove does not on WebKitGTK.
    const poll = window.setInterval(() => {
      void cursorPosition()
        .then((p) => {
          if (done) return;
          last = { x: p.x / scale, y: p.y / scale };
          void emit(DETACHED_DRAG_MOVE, {
            screenX: last.x,
            screenY: last.y,
          } satisfies DetachedDragMove);
          // Move our own window to follow the cursor (physical px; whole-group
          // drag only). Skip while a previous move is still in flight to avoid an
          // IPC backlog.
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
          // Per-tab drag: update the local ghost + reorder gap. Map the OS cursor
          // to popout-client coords (same `last - origin` as the release
          // hit-test). While the cursor is over the popout, the ghost follows and
          // the gap tracks the bar slot; once it leaves (over the main window) we
          // freeze the ghost and clear the gap — the main window then shows its
          // own preview from the streamed events.
          if (tabKey != null) {
            const cx = last.x - origin.x;
            const cy = last.y - origin.y;
            const overPopout =
              cx >= 0 &&
              cy >= 0 &&
              cx <= window.innerWidth &&
              cy <= window.innerHeight;
            if (overPopout) {
              useDragStore.getState().move(cx, cy);
              resolveLocalReorder(cx, cy);
            } else if (useDragStore.getState().drag?.reorderGroup) {
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

    const finish = (cancelled: boolean) => {
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
      // Clear this popout's local drag visuals (ghost + gap); the actual reorder,
      // if any, is applied by `release` via handleLocalTabRelease.
      if (tabKey != null) useDragStore.getState().end();
      void emit(DETACHED_DRAG_END, {
        cancelled,
        screenX: last.x,
        screenY: last.y,
      } satisfies DetachedDragEnd);
    };
    // A per-tab release over THIS popout reorders locally (or no-ops over the
    // body) and tells the host to cancel its dock; only a release clear of the
    // popout falls through to the main window's dock. The whole-group drag always
    // commits (the host decides via its own in-window check).
    const release = () => {
      if (tabKey != null) {
        const handledLocally = handleLocalTabRelease(
          tabKey,
          last.x - origin.x,
          last.y - origin.y,
        );
        finish(handledLocally);
        return;
      }
      finish(false);
    };
    const onUp = () => release();
    const onCancel = () => release();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") finish(true);
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  };

  return (
    <div className="detached-center center-panel">
      <div className="subwindow focused">
        <div
          ref={barRef}
          className="tab-bar detached-drag-handle"
          data-group-id={group.id}
          onPointerDown={onTabBarPointerDown}
        >
          {orderedTabs.map((tab, index) => {
            const isActive = tab.key === group.activeKey;
            const isDragging = dragKey === tab.key;
            const isLast = index === orderedTabs.length - 1;
            // Open the gap by sliding the neighbouring tab away from the slot; the
            // dragged tab is collapsed (via `.tab.dragging`) so it carries no gap.
            const style: React.CSSProperties = {};
            if (!isDragging && reorderIndex != null) {
              if (reorderIndex === index) style.marginLeft = REORDER_GAP;
              if (isLast && reorderIndex === orderedTabs.length)
                style.marginRight = REORDER_GAP;
            }
            return (
              <div
                key={tab.key}
                className={`tab ${isActive ? "active" : ""}${isDragging ? " dragging" : ""}`}
                style={style}
                onPointerDown={(e) => onTabPointerDown(e, tab)}
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
            );
          })}
          {/* Right-aligned title-bar cluster: native window controls. `no-drag`
              so clicks here never start a window drag. Dock-back is done by
              Ctrl+dragging the tab bar onto the main window (#42). */}
          <div className="detached-titlebar-controls no-drag">
            <WindowControls />
          </div>
        </div>
        <div className="subwindow-body" ref={bodyRef}>
          <div className="pane-layer">
            {orderedTabs.map((tab) => {
              const visible = tab.key === group.activeKey;
              const style: React.CSSProperties = visible
                ? { display: "flex", left: 0, top: 0, width: rect.w, height: rect.h }
                : { display: "none" };
              return (
                <div
                  key={tab.key}
                  className="center-pane"
                  data-tab-key={tab.key}
                  style={style}
                >
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
                      // SAME id as the main window's pane so this re-attaches to
                      // the existing PTY (output is broadcast). attachOnly => no
                      // spawn, no kill-on-unmount.
                      id={`${scope}:${tab.key}`}
                      cmd={tab.cmd}
                      args={tab.args ?? []}
                      env={tab.env ?? {}}
                      cwd={tab.cwd}
                      localOnly={tab.kind === "local_agent"}
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
      {/* Floating ghost following the cursor during a per-tab drag (content
          thumbnail + label), mirroring the main window. */}
      <DragGhost />
    </div>
  );
}
