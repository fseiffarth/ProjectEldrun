import { useEffect, useRef, useState } from "react";
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
import { DragGhost } from "./CenterPanel";
import { pickEdge } from "../tabs/dragGeometry";
import { useDragStore } from "../../stores/drag";
import { findGroup, type DropEdge, type GroupNode, type LayoutNode, type TabEntry } from "../../stores/tabs";

// Fixed width of the gap that opens within the bar to receive a reordered tab.
// Mirrors TabBar's constant so the popout's within-bar reorder looks identical.
const REORDER_GAP = 80;

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
}: Props) {
  // One bar element per group, so a per-tab drag can hit-test the bar it's over.
  const barRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // One body element per group, for resolving an edge-split drop target.
  const bodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());
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
  const byKey = new Map(tabs.map((t) => [t.key, t] as const));

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
    // Body edge → split this group inside the popout (non-center only).
    if (drag.overGroup && drag.edge && drag.edge !== "center") {
      onSplit(tabKey, drag.overGroup, drag.edge);
      return true;
    }
    // Bar slot → reorder the target group's tabs.
    if (drag.reorderGroup && drag.reorderIndex != null) {
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
  // renders into its flex cell. `isRoot` puts the window controls on the first bar.
  const renderGroup = (group: GroupNode, isRoot: boolean) => {
    const orderedTabs = group.tabKeys
      .map((k) => byKey.get(k))
      .filter((t): t is TabEntry => t != null);
    const localReorder = reorderGroupId === group.id ? reorderIndex : null;
    return (
      <div className="subwindow focused">
        <div
          ref={(el) => {
            if (el) barRefs.current.set(group.id, el);
            else barRefs.current.delete(group.id);
          }}
          className="tab-bar detached-drag-handle"
          data-group-id={group.id}
          onPointerDown={(e) => onGroupBarPointerDown(e, group)}
        >
          {orderedTabs.map((tab, index) => {
            const isActive = tab.key === group.activeKey;
            const isDragging = dragKey === tab.key;
            const isLast = index === orderedTabs.length - 1;
            const style: React.CSSProperties = {};
            if (!isDragging && localReorder != null) {
              if (localReorder === index) style.marginLeft = REORDER_GAP;
              if (isLast && localReorder === orderedTabs.length) style.marginRight = REORDER_GAP;
            }
            return (
              <div
                key={tab.key}
                className={`tab ${isActive ? "active" : ""}${isDragging ? " dragging" : ""}`}
                style={style}
                onPointerDown={(e) => onTabPointerDown(e, group, tab)}
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
          {isRoot && (
            <div className="detached-titlebar-controls no-drag">
              <WindowControls />
            </div>
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
  // sized by their fractions; groups render their bar + panes. `isRoot` flags the
  // first group reached so only it hosts the window controls.
  let rootClaimed = false;
  const renderNode = (node: LayoutNode): React.ReactNode => {
    if (node.type === "group") {
      const isRoot = !rootClaimed;
      rootClaimed = true;
      return renderGroup(node, isRoot);
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
          <div
            key={child.id}
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
        ))}
      </div>
    );
  };

  return (
    <div className="detached-center center-panel">
      {renderNode(tree)}
      {dropActive && <div className="detached-drop-target" />}
      <DragGhost />
    </div>
  );
}
