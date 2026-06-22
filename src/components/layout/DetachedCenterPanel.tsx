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
import type { GroupNode, TabEntry } from "../../stores/tabs";

interface Props {
  scope: string;
  /** The single group this detached window renders. */
  group: GroupNode;
  /** The group's tab payloads (already filtered to this group). */
  tabs: TabEntry[];
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
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
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
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

  // #42: grab the popout's top frame (the empty tab-bar area) to move/dock it.
  // A PLAIN drag behaves like dragging a tab: the popout follows the cursor and,
  // while the cursor is over the main window, the main window shows the same
  // split/merge drop preview as an in-window tab drag and docks the group on
  // release (`startDockDrag`). Released anywhere else, the popout simply stays
  // where it was dragged. We drive the move ourselves (no `startDragging`), so we
  // trade away KWin's native edge-snap/maximize-on-drag for cross-window docking.
  const onTabBarPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Only the empty bar area is a drag handle — not the tabs or the controls.
    if (target.closest(".tab, .detached-titlebar-controls, button")) return;
    e.preventDefault();
    startDockDrag(e);
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
  const startDockDrag = (e: React.PointerEvent) => {
    const handle = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      /* capture is best-effort; the OS-cursor poll does not depend on it */
    }
    const activeLabel =
      orderedTabs.find((t) => t.key === group.activeKey)?.label ?? "Subwindow";

    const win = getCurrentWindow();
    // Latest OS cursor position in logical/CSS px (updated by the poll). Seeded
    // from the pointerdown's screen coords (WebKitGTK reports these in CSS px).
    let last = { x: e.screenX, y: e.screenY };
    let scale = 1;
    let done = false;
    // Physical offset from the window's top-left to the cursor at grab time, so
    // the window can follow the cursor without jumping. Resolved async; until
    // then the window simply doesn't move yet.
    let grab: { x: number; y: number } | null = null;
    let moving = false; // in-flight guard so 60 Hz polls don't queue setPosition.

    void win.scaleFactor().then((s) => {
      scale = s || 1;
    }).catch(() => {});
    void Promise.all([win.outerPosition(), cursorPosition()])
      .then(([pos, cur]) => {
        grab = { x: cur.x - pos.x, y: cur.y - pos.y };
      })
      .catch(() => {});

    void emit(DETACHED_DRAG_START, {
      scope,
      groupId: group.id,
      label: activeLabel,
      screenX: last.x,
      screenY: last.y,
    } satisfies DetachedDragStart);

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
          // Move our own window to follow the cursor (physical px). Skip while a
          // previous move is still in flight to avoid an IPC backlog.
          if (grab && !moving) {
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
        handle.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      void emit(DETACHED_DRAG_END, {
        cancelled,
        screenX: last.x,
        screenY: last.y,
      } satisfies DetachedDragEnd);
    };
    const onUp = () => finish(false);
    const onCancel = () => finish(false);
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
          className="tab-bar detached-drag-handle"
          data-group-id={group.id}
          onPointerDown={onTabBarPointerDown}
        >
          {orderedTabs.map((tab) => {
            const isActive = tab.key === group.activeKey;
            return (
              <div
                key={tab.key}
                className={`tab ${isActive ? "active" : ""}`}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  onActivate(tab.key);
                }}
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
                <div key={tab.key} className="center-pane" style={style}>
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
    </div>
  );
}
