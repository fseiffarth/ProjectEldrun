import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  onDockBack: () => void;
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
  onDockBack,
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

  // #42: grab the popout's top frame (the empty tab-bar area) to move the window.
  // A PLAIN drag hands off to the window manager via `startDragging` so KWin's
  // native behaviour — edge-snap, maximize, and cross-monitor moves — all work.
  // A CTRL+drag instead streams a cross-window drag-to-dock to the main window
  // (`startDockDrag`): release over a main-window subwindow to dock this popout
  // back in. We pick the mode at pointerdown because once `startDragging` hands
  // the pointer to the WM we get no further DOM events to detect "Ctrl at drop".
  const onTabBarPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Only the empty bar area is a drag handle — not the tabs or the controls.
    if (target.closest(".tab, .detached-titlebar-controls, button")) return;
    e.preventDefault();
    if (e.ctrlKey) {
      startDockDrag(e);
    } else {
      void getCurrentWindow().startDragging();
    }
  };

  // #42: Ctrl+drag-to-dock. The left button stays down, so X11's implicit
  // pointer grab keeps delivering pointermove to THIS webview even while the
  // cursor is over the main window — letting us stream the gesture's SCREEN
  // coords to the main window, which maps them into its client space, renders
  // the dock preview, and docks the group on release. We never move our own OS
  // window during this gesture (no `startDragging`). Pointer events are captured
  // to the handle and mirrored on `window`; pointercancel commits (WebKitGTK
  // fires it in place of pointerup mid-gesture), only Escape cancels.
  const startDockDrag = (e: React.PointerEvent) => {
    const handle = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      /* capture is best-effort; the implicit grab still routes events */
    }
    const activeLabel =
      orderedTabs.find((t) => t.key === group.activeKey)?.label ?? "Subwindow";
    void emit(DETACHED_DRAG_START, {
      scope,
      groupId: group.id,
      label: activeLabel,
      screenX: e.screenX,
      screenY: e.screenY,
    } satisfies DetachedDragStart);

    let done = false;
    const finish = (cancelled: boolean) => {
      if (done) return;
      done = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      void emit(DETACHED_DRAG_END, { cancelled } satisfies DetachedDragEnd);
    };
    const onMove = (ev: PointerEvent) => {
      void emit(DETACHED_DRAG_MOVE, {
        screenX: ev.screenX,
        screenY: ev.screenY,
      } satisfies DetachedDragMove);
    };
    const onUp = () => finish(false);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") finish(true);
    };
    window.addEventListener("pointermove", onMove);
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
          {/* Right-aligned title-bar cluster: dock-back + native window
              controls. `no-drag` so clicks here never start a window drag. */}
          <div className="detached-titlebar-controls no-drag">
            <button
              className="subwindow-dock"
              title="Dock back into main window"
              onClick={(e) => {
                e.stopPropagation();
                onDockBack();
              }}
            >
              ⤓
            </button>
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
