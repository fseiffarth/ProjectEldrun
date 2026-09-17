import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useProjectsStore } from "../../stores/projects";
import { useActivityStore } from "../../stores/activity";
import { useCalendarStore } from "../../stores/calendar";
import { useMailStore } from "../../stores/mail";
import { useTodoStore } from "../../stores/todo";
import { useSettingsStore } from "../../stores/settings";
import {
  DEFAULT_MIN_SUBWINDOW_PX,
  EMPTY_GROUP_ID,
  ROOT_SCOPE,
  allGroups,
  dividerFraction,
  findGroupOfTab,
  isPtyTabKind,
  useTabsStore,
  type DropEdge,
  type LayoutNode,
  type TabEntry,
} from "../../stores/tabs";
import { notifyCalendarWrite } from "../../lib/calendarWriteHook";
import { bindDragRelease, dragPlatform } from "../../lib/dragPlatform";
import type { CalendarEvent, CalendarTask } from "../../types";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { CustomAgentDialog } from "../tabs/CustomAgentDialog";
import { NewTabMenu } from "../tabs/NewTabMenu";
import { TabPane } from "../tabs/TabPane";
import { pickEdge, previewInset } from "../tabs/dragGeometry";
import { dragPreviewLayout } from "../tabs/dragPreview";
import { StarIcon } from "./StarIcon";

/** What the backend's `root-mcp-changed` event carries (`services::root_mcp::Change`). */
type RootMcpChange = (
  | { kind: "event"; op: "upsert" | "delete"; row: CalendarEvent }
  | { kind: "task"; op: "upsert" | "delete"; row: CalendarTask }
) & {
  /** Board-only fields changed (a move's column/rank): merge, push nothing. */
  local?: boolean;
};

/** What `root-mcp-open` carries (`services::root_mcp::OverlayOpen`). */
interface RootMcpOpen {
  overlay: "mail" | "calendar" | "todo";
  /** `todo_open` with a card: the board opens on it. */
  task_id?: string;
}

interface RootMcpStatus {
  running: boolean;
  tools: string[];
}

/** A rect relative to the overlay's pane region. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A tab drag inside the console. Local state rather than `stores/drag`: that
 * store's `drag !== null` puts `CenterPanel` into drag mode, and the panel
 * under this modal is not what the tab is being dropped on.
 */
interface OverlayDrag {
  key: string;
  fromGroup: string;
  label: string;
  x: number;
  y: number;
  /** A strip slot: move into that group at `reorderIndex`. */
  reorderGroup: string | null;
  reorderIndex: number | null;
  /** Client x of the insertion marker for a strip slot. */
  markerX: number | null;
  /** A body: split off at `edge` (center = move into the group). */
  overGroup: string | null;
  edge: DropEdge | null;
}

/** Pixels a press must travel before it is a drag rather than a click. */
const DRAG_THRESHOLD_PX = 5;

const NO_TABS: TabEntry[] = [];

/**
 * The **root console** (see `stores/rootOverlay` for why it is an overlay): one
 * floating subwindow over whatever project is open, holding the root scope's
 * tabs. Its chrome is a subwindow's own — `.subwindow` / `.tab-bar` /
 * `.tab-strip` / `.tab` — so it reads as the thing it replaced, lifted off the
 * page.
 *
 * Two jobs live in the always-mounted host rather than the dialog, because both
 * must run while it is closed: the **persist** of the root scope (`CenterPanel`
 * saves the *active* scope only, and root no longer becomes active), and the
 * **`root-mcp-changed`** listener — a root agent that adds a calendar entry
 * through Eldrun's MCP tools wrote `calendar.json` behind the window's back, so
 * the row is merged into the store here and announced through the same hook a
 * dialog edit uses, which is what carries it to CalDAV.
 */
export function RootOverlayHost() {
  const open = useRootOverlayStore((s) => s.open);
  const rootTabs = useTabsStore((s) => s.tabsByScope[ROOT_SCOPE]);
  const rootLayout = useTabsStore((s) => s.layoutByScope[ROOT_SCOPE]);
  const activeScope = useTabsStore((s) => s.scope);

  useEffect(() => {
    // Absent key = never hydrated: a save now would erase the layout on disk.
    // While root IS the active scope, CenterPanel's own save covers it.
    if (rootTabs === undefined || activeScope === ROOT_SCOPE) return;
    const timer = window.setTimeout(() => {
      useTabsStore.getState().persistScope(ROOT_SCOPE, "").catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [rootTabs, rootLayout, activeScope]);

  useEffect(() => {
    const unlisten = listen<RootMcpChange>("root-mcp-changed", ({ payload }) => {
      const upsert = <T extends { id: string }>(rows: T[], row: T) =>
        rows.some((r) => r.id === row.id)
          ? rows.map((r) => (r.id === row.id ? row : r))
          : [...rows, row];
      useCalendarStore.setState((s) => {
        if (payload.kind === "event") {
          return payload.op === "delete"
            ? { events: s.events.filter((e) => e.id !== payload.row.id) }
            : { events: upsert(s.events, payload.row) };
        }
        return payload.op === "delete"
          ? { tasks: s.tasks.filter((task) => task.id !== payload.row.id) }
          : { tasks: upsert(s.tasks, payload.row) };
      });
      // A root agent's first board move is what seeds the columns (a read
      // never does), so a card naming a column the store has not seen means the
      // board just came into existence — re-read, as `moveTasks` does.
      if (payload.kind === "task" && payload.op === "upsert" && payload.row.column) {
        const { taskColumns, reload } = useCalendarStore.getState();
        if (!taskColumns.some((c) => c.id === payload.row.column)) void reload().catch(() => {});
      }
      if (payload.local) return;
      void notifyCalendarWrite(payload).catch(() => {});
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    // A root agent's `*_open` tool. The backend already checked the overlay's
    // settings gate, so this only has to show it — and get out of its way: the
    // console is a modal mounted after the other three, so it would sit on top.
    const unlisten = listen<RootMcpOpen>("root-mcp-open", ({ payload }) => {
      useRootOverlayStore.getState().close();
      if (payload.overlay === "mail") useMailStore.getState().openOverlay();
      else if (payload.overlay === "calendar") useCalendarStore.getState().openOverlay();
      else if (payload.task_id) useTodoStore.getState().openCard(payload.task_id);
      else useTodoStore.getState().openOverlay();
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  return open ? <RootOverlay /> : null;
}

/**
 * The console itself. The root scope's layout is rendered as it is stored —
 * split into subwindows when it is split — and a tab dragged onto another
 * subwindow's strip moves there, onto a body's edge splits it off, exactly as
 * in a project's center panel. All of it writes the ROOT scope through the
 * store's `…InScope` actions, never the project on screen.
 *
 * Panes are a flat layer positioned over each group body's measured rect (the
 * `CenterPanel` arrangement), so a tab moving between subwindows repositions
 * its view instead of remounting it. They are attach-only views: the PTYs
 * belong to `CenterPanel`'s keep-alive layer, so closing the console ends
 * nothing.
 *
 * With a single subwindow its strip sits in the console's own title bar; once
 * the layout is split every subwindow carries its own bar.
 */
function RootOverlay() {
  const t = useT();
  const tabs = useTabsStore((s) => s.tabsByScope[ROOT_SCOPE] ?? NO_TABS);
  const layout = useTabsStore((s) => s.layoutByScope[ROOT_SCOPE] ?? null);
  const storedFocus = useTabsStore((s) => s.focusedGroupByScope[ROOT_SCOPE] ?? null);
  const close = useRootOverlayStore((s) => s.close);
  const rootDir = useProjectsStore((s) => s.rootDir) ?? "";
  const [addMenu, setAddMenu] = useState<{ x: number; y: number; groupId: string | null } | null>(
    null,
  );
  const [manageAgents, setManageAgents] = useState(false);
  const [status, setStatus] = useState<RootMcpStatus | null>(null);
  const [drag, setDrag] = useState<OverlayDrag | null>(null);
  const [groupRects, setGroupRects] = useState<Record<string, Rect>>({});
  const regionRef = useRef<HTMLDivElement>(null);
  const bodyRefs = useRef(new Map<string, HTMLDivElement>());
  const stripRefs = useRef(new Map<string, HTMLDivElement>());

  const split = allGroups(layout).length > 1;
  // While a subwindow's lone tab is dragged, its subwindow is pruned from the
  // RENDERED tree so the siblings reflow at once (render-only, like CenterPanel).
  const dragKey = drag?.key ?? null;
  const dragFrom = drag?.fromGroup ?? null;
  const dragging = drag != null;
  const renderLayout = useMemo(
    () => dragPreviewLayout(layout, dragKey ? "tab" : null, dragKey, dragFrom, false),
    [layout, dragKey, dragFrom],
  );
  const groups = useMemo(() => allGroups(renderLayout), [renderLayout]);
  const focusedGroup =
    (storedFocus && groups.some((g) => g.id === storedFocus) ? storedFocus : null) ??
    groups[0]?.id ??
    null;
  // The single-subwindow strip in the title bar stands for the one group.
  const soleGroupId = split ? null : (allGroups(layout)[0]?.id ?? EMPTY_GROUP_ID);

  useEffect(() => {
    invoke<RootMcpStatus>("root_mcp_status").then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape inside a pane is the pane's (an agent TUI's cancel key); the
      // toggle chord closes from there. A menu or a drag of ours goes first.
      if (regionRef.current && e.target instanceof Node && regionRef.current.contains(e.target)) return;
      if (addMenu || manageAgents || dragging) return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, addMenu, manageAgents, dragging]);

  // ── Measurement ─────────────────────────────────────────────────────────
  const measure = useCallback(() => {
    const region = regionRef.current;
    if (!region) return;
    const base = region.getBoundingClientRect();
    const next: Record<string, Rect> = {};
    for (const [id, el] of bodyRefs.current) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      next[id] = { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
    }
    setGroupRects((prev) => {
      const keys = Object.keys(next);
      const same =
        keys.length === Object.keys(prev).length &&
        keys.every((k) => {
          const a = next[k];
          const b = prev[k];
          return !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
        });
      return same ? prev : next;
    });
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, renderLayout]);

  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(region);
    for (const el of bodyRefs.current.values()) ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, renderLayout]);

  const registerBody = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) bodyRefs.current.set(id, el);
      else bodyRefs.current.delete(id);
    },
    [],
  );
  const registerStrip = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) stripRefs.current.set(id, el);
      else stripRefs.current.delete(id);
    },
    [],
  );

  // ── Tab drag ────────────────────────────────────────────────────────────
  /** What a release at client (x, y) would do. Measured rects, never
   *  `elementFromPoint` — the panes are opaque and WebKitGTK's is unreliable. */
  const resolveTarget = useCallback(
    (x: number, y: number) => {
      for (const [gid, strip] of stripRefs.current) {
        if (!strip.isConnected) continue;
        const r = strip.getBoundingClientRect();
        // The whole bar height counts, so a drop just under the tabs still lands.
        const bar = strip.closest(".tab-bar")?.getBoundingClientRect() ?? r;
        if (x < r.left || x > r.right || y < bar.top || y > bar.bottom) continue;
        const tabEls = Array.from(strip.querySelectorAll<HTMLElement>(".tab"));
        let slot = tabEls.length;
        let markerX = tabEls.length ? tabEls[tabEls.length - 1].getBoundingClientRect().right : r.left;
        for (let i = 0; i < tabEls.length; i++) {
          const tr = tabEls[i].getBoundingClientRect();
          if (x < tr.left + tr.width / 2) {
            slot = i;
            markerX = tr.left;
            break;
          }
        }
        return {
          reorderGroup: gid,
          reorderIndex: slot,
          markerX,
          overGroup: null,
          edge: null,
        };
      }
      const region = regionRef.current;
      if (region) {
        const base = region.getBoundingClientRect();
        const px = x - base.left;
        const py = y - base.top;
        for (const [gid, r] of Object.entries(groupRects)) {
          if (px >= r.left && px <= r.left + r.width && py >= r.top && py <= r.top + r.height) {
            return {
              reorderGroup: null,
              reorderIndex: null,
              markerX: null,
              overGroup: gid,
              edge: pickEdge(r, px, py),
            };
          }
        }
      }
      return { reorderGroup: null, reorderIndex: null, markerX: null, overGroup: null, edge: null };
    },
    [groupRects],
  );
  const resolveRef = useRef(resolveTarget);
  resolveRef.current = resolveTarget;

  const startTabDrag = useCallback((e: React.PointerEvent, tab: TabEntry, groupId: string) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".tab-close")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;
    let latest: OverlayDrag | null = null;
    const captureEl = document.documentElement;
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
        active = true;
      }
      latest = {
        key: tab.key,
        fromGroup: groupId,
        label: tab.label,
        x: ev.clientX,
        y: ev.clientY,
        ...resolveRef.current(ev.clientX, ev.clientY),
      };
      setDrag(latest);
    };
    const teardown = () => {
      window.removeEventListener("pointermove", onMove);
      if (dragPlatform.needsPointerCapture) {
        try {
          captureEl.releasePointerCapture(e.pointerId);
        } catch {
          /* capture already gone */
        }
      }
      setDrag(null);
    };
    // Bound synchronously inside pointerdown: WebKitGTK only delivers the
    // terminal event to listeners that existed before the gesture began.
    bindDragRelease({
      onCommit: () => {
        teardown();
        if (active && latest) commitOverlayDrop(latest);
      },
      onAbort: teardown,
    });
    window.addEventListener("pointermove", onMove);
    if (dragPlatform.needsPointerCapture) {
      try {
        captureEl.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer is not active any more */
      }
    }
  }, []);

  const openAddMenu = (anchor: DOMRect, groupId: string | null) =>
    setAddMenu((cur) => (cur ? null : { x: anchor.left, y: anchor.bottom + 4, groupId }));

  const addTab = useCallback(
    (spec: Omit<TabEntry, "key">) => {
      const store = useTabsStore.getState();
      // A tab added from a subwindow's own "+" lands in that subwindow.
      if (addMenu?.groupId && addMenu.groupId !== EMPTY_GROUP_ID) {
        store.focusGroupInScope(ROOT_SCOPE, addMenu.groupId);
      }
      store.addTabToScope(ROOT_SCOPE, spec);
    },
    [addMenu],
  );

  const agentsWithTools = status?.running ? t("rootConsole.rightsOn") : t("rootConsole.rightsOff");
  const groupOfKey = useMemo(() => {
    const map = new Map<string, { groupId: string; active: boolean }>();
    for (const g of groups) {
      for (const k of g.tabKeys) map.set(k, { groupId: g.id, active: g.activeKey === k });
    }
    return map;
  }, [groups]);
  const tabByKey = useMemo(() => new Map(tabs.map((tab) => [tab.key, tab])), [tabs]);

  const stripFor = (groupId: string, tabKeys: string[], activeKey: string | null) => (
    <>
      <GroupStrip
        groupId={groupId}
        tabs={tabKeys.map((k) => tabByKey.get(k)).filter((tab): tab is TabEntry => !!tab)}
        activeKey={activeKey}
        draggingKey={drag?.key ?? null}
        stripRef={registerStrip(groupId)}
        onTabPointerDown={startTabDrag}
      />
      <div className="tab-new-wrap">
        <button
          className="tab-new-btn"
          title={t("detachedTabs.newTab")}
          onClick={(e) => openAddMenu(e.currentTarget.getBoundingClientRect(), groupId)}
        >
          +
        </button>
      </div>
    </>
  );

  const sole = soleGroupId ? (allGroups(layout)[0] ?? null) : null;
  const previewRect =
    drag?.overGroup && drag.edge ? groupRects[drag.overGroup] : undefined;

  return (
    <div
      className="modal-backdrop root-overlay-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className={`root-overlay subwindow focused${drag ? " dragging" : ""}${split ? " split-layout" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("rootConsole.title")}
      >
        <div className="tab-bar root-overlay-bar">
          <div className="root-overlay-mark" title={t("rootConsole.title")}>
            <StarIcon />
          </div>
          {soleGroupId && stripFor(soleGroupId, sole?.tabKeys ?? [], sole?.activeKey ?? null)}
          <div className="tab-controls root-overlay-controls">
            <span
              className={`root-overlay-rights${status?.running ? " on" : ""}`}
              title={`${agentsWithTools}${
                status?.running ? `\n${status.tools.join(", ")}` : ""
              }\n${t("rootConsole.noPhone")}`}
            >
              {t("rootConsole.rightsBadge")}
            </span>
            <UntestedTag />
            <button className="subwindow-hide" title={t("common.close")} onClick={close}>
              ×
            </button>
          </div>
        </div>
        <div className="subwindow-body">
          <div className="subwindow-pane-region root-overlay-region" ref={regionRef}>
            {tabs.length === 0 || !renderLayout ? (
              <div className="center-placeholder" style={{ height: "100%" }}>
                <div className="center-placeholder-card">
                  <div className="center-placeholder-title">{t("rootConsole.emptyTitle")}</div>
                  <div className="center-placeholder-hint">{t("rootConsole.emptyHint")}</div>
                </div>
              </div>
            ) : (
              <>
                <div className="root-overlay-layout">
                  <OverlayTree
                    node={renderLayout}
                    split={split}
                    focusedGroup={focusedGroup}
                    registerBody={registerBody}
                    onResized={measure}
                    stripFor={stripFor}
                  />
                </div>
                <div className="pane-layer">
                  {tabs.map((tab) => {
                    const place = groupOfKey.get(tab.key);
                    const visible = !!place?.active;
                    const rect = place ? groupRects[place.groupId] : undefined;
                    const style: React.CSSProperties = !visible
                      ? { display: "none" }
                      : rect
                        ? { display: "flex", left: rect.left, top: rect.top, width: rect.width, height: rect.height }
                        : { display: "flex", left: 0, top: 0, right: 0, bottom: 0 };
                    return (
                      <div
                        key={tab.key}
                        className="center-pane"
                        data-tab-key={tab.key}
                        style={style}
                        onMouseDownCapture={() => {
                          if (place && place.groupId !== focusedGroup) {
                            useTabsStore.getState().focusGroupInScope(ROOT_SCOPE, place.groupId);
                          }
                        }}
                      >
                        {/* Attach-only, like a popout's panes: the PTY belongs to
                            the root tab's own pane in CenterPanel's keep-alive
                            layer, so closing the overlay ends nothing. */}
                        <TabPane
                          tab={tab}
                          scope={ROOT_SCOPE}
                          visible={visible}
                          focused={visible && place?.groupId === focusedGroup && !addMenu && !drag}
                          attachOnly
                          filesProjectDir={tab.cwd || rootDir}
                          terminalCwd={tab.cwd || rootDir}
                        />
                      </div>
                    );
                  })}
                </div>
                {previewRect && drag?.edge && <SplitPreview rect={previewRect} edge={drag.edge} />}
              </>
            )}
          </div>
        </div>
      </div>
      {drag &&
        createPortal(
          <>
            <div className="tab-drag-ghost" style={{ left: drag.x, top: drag.y }}>
              <div className="tab-drag-ghost-label">{drag.label}</div>
            </div>
            {drag.markerX != null && drag.reorderGroup && (
              <StripMarker x={drag.markerX} strip={stripRefs.current.get(drag.reorderGroup)} />
            )}
          </>,
          document.body,
        )}
      {addMenu && (
        <NewTabMenu
          scope={ROOT_SCOPE}
          projectCwd={rootDir}
          projectName=""
          anchor={addMenu}
          onPick={addTab}
          onClose={() => setAddMenu(null)}
          onManageAgents={() => setManageAgents(true)}
        />
      )}
      {manageAgents && <CustomAgentDialog onClose={() => setManageAgents(false)} />}
    </div>
  );
}

/**
 * Apply a finished console drag to the ROOT scope — `tabs/commitDrop`'s rules,
 * addressed to a named scope: a strip slot reorders (same subwindow) or moves
 * the tab over; a body edge splits it off; a body's centre moves it in.
 */
function commitOverlayDrop(d: Pick<OverlayDrag, "key" | "fromGroup" | "reorderGroup" | "reorderIndex" | "overGroup" | "edge">) {
  const store = useTabsStore.getState();
  if (d.reorderGroup && d.reorderIndex != null) {
    const found = findGroupOfTab(store.layoutByScope[ROOT_SCOPE] ?? null, d.key);
    if (!found) return;
    if (found.group.id === d.reorderGroup) {
      // The slot counts the dragged tab still in place; the move is addressed
      // without it.
      const to = found.index < d.reorderIndex ? d.reorderIndex - 1 : d.reorderIndex;
      if (to !== found.index && to >= 0) store.moveTabInScope(ROOT_SCOPE, d.key, d.reorderGroup, to);
    } else {
      store.moveTabInScope(ROOT_SCOPE, d.key, d.reorderGroup, d.reorderIndex);
    }
    return;
  }
  if (!d.overGroup || !d.edge) return;
  if (d.edge === "center") {
    if (d.overGroup !== d.fromGroup) store.moveTabInScope(ROOT_SCOPE, d.key, d.overGroup);
    return;
  }
  store.splitWithTabInScope(ROOT_SCOPE, d.key, d.overGroup, d.edge);
}

function GroupStrip({
  groupId,
  tabs,
  activeKey,
  draggingKey,
  stripRef,
  onTabPointerDown,
}: {
  groupId: string;
  tabs: TabEntry[];
  activeKey: string | null;
  draggingKey: string | null;
  stripRef: (el: HTMLDivElement | null) => void;
  onTabPointerDown: (e: React.PointerEvent, tab: TabEntry, groupId: string) => void;
}) {
  const t = useT();
  const busyByTab = useActivityStore((s) => s.busyByTab);
  const attentionByTab = useActivityStore((s) => s.attentionByTab);
  const clearAttention = useActivityStore((s) => s.clearAttention);
  return (
    <div className="tab-strip" ref={stripRef}>
      {tabs.map((tab) => {
        const isActive = tab.key === activeKey;
        const ptyId = `${ROOT_SCOPE}:${tab.key}`;
        const isAgent = tab.kind === "agent" || tab.kind === "local_agent";
        // The strip's own status rules (TabBar / the popout strip).
        const working = isPtyTabKind(tab.kind) && !isActive && !!busyByTab[ptyId];
        const rawAttn = isAgent ? (attentionByTab[ptyId] ?? null) : null;
        const attn = !isActive || rawAttn === "decision" ? rawAttn : null;
        const stateClass = working
          ? " working"
          : attn === "decision"
            ? " needs-decision"
            : attn === "done"
              ? " finished"
              : "";
        return (
          <div
            key={tab.key}
            className={`tab ${isActive ? "active" : ""}${stateClass}${
              draggingKey === tab.key ? " dragging" : ""
            }`}
            onPointerDown={(e) => onTabPointerDown(e, tab, groupId)}
            onMouseDown={() => {
              if (isActive) clearAttention(ptyId);
              if (groupId === EMPTY_GROUP_ID) return;
              useTabsStore.getState().setGroupActiveInScope(ROOT_SCOPE, groupId, tab.key);
            }}
          >
            <span className="tab-label">{tab.label}</span>
            <button
              className="tab-close"
              title={t("detachedTabs.closeTab")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                useTabsStore.getState().removeTabInScope(ROOT_SCOPE, tab.key);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

interface TreeProps {
  node: LayoutNode;
  split: boolean;
  focusedGroup: string | null;
  registerBody: (id: string) => (el: HTMLDivElement | null) => void;
  onResized: () => void;
  stripFor: (groupId: string, tabKeys: string[], activeKey: string | null) => React.ReactNode;
}

function OverlayTree(props: TreeProps) {
  const { node } = props;
  if (node.type === "split") return <OverlaySplit {...props} node={node} />;
  // Unsplit, the strip lives in the console's title bar; the group is its body.
  if (!props.split) {
    return <div className="subwindow-pane-slot" ref={props.registerBody(node.id)} />;
  }
  return (
    <div
      className={`subwindow root-overlay-group${props.focusedGroup === node.id ? " focused" : ""}`}
      onMouseDownCapture={() => {
        if (props.focusedGroup !== node.id) useTabsStore.getState().focusGroupInScope(ROOT_SCOPE, node.id);
      }}
    >
      <div className="tab-bar">{props.stripFor(node.id, node.tabKeys, node.activeKey)}</div>
      <div className="subwindow-body">
        <div className="subwindow-pane-region">
          <div className="subwindow-pane-slot" ref={props.registerBody(node.id)} />
        </div>
      </div>
    </div>
  );
}

/** A split of the root layout: `CenterPanel`'s SplitView, addressed to root. */
function OverlaySplit(props: TreeProps & { node: Extract<LayoutNode, { type: "split" }> }) {
  const { node } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const childRefs = useRef(new Map<number, HTMLDivElement>());
  const minWidth = useSettingsStore((s) => s.settings?.min_subwindow_width) ?? DEFAULT_MIN_SUBWINDOW_PX;
  const minHeight = useSettingsStore((s) => s.settings?.min_subwindow_height) ?? DEFAULT_MIN_SUBWINDOW_PX;

  const startDivider = (dividerIndex: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const isRow = node.dir === "row";
    let fraction: number | null = null;
    let raf: number | null = null;
    const onMove = (ev: PointerEvent) => {
      const total = isRow ? rect.width : rect.height;
      if (total <= 0) return;
      const pos = isRow ? ev.clientX - rect.left : ev.clientY - rect.top;
      fraction = dividerFraction(node, dividerIndex, pos, total, isRow ? minWidth : minHeight);
      const pair = node.sizes[dividerIndex] + node.sizes[dividerIndex + 1];
      const a = childRefs.current.get(dividerIndex);
      const b = childRefs.current.get(dividerIndex + 1);
      if (a) a.style.flex = `${fraction} 1 0`;
      if (b) b.style.flex = `${pair - fraction} 1 0`;
      if (raf == null) {
        raf = requestAnimationFrame(() => {
          raf = null;
          props.onResized();
        });
      }
    };
    const teardown = () => {
      window.removeEventListener("pointermove", onMove);
      if (raf != null) cancelAnimationFrame(raf);
    };
    bindDragRelease({
      onCommit: () => {
        teardown();
        if (fraction != null) {
          useTabsStore.getState().resizeSplitInScope(ROOT_SCOPE, node.id, dividerIndex, fraction);
        }
        props.onResized();
      },
      onAbort: () => {
        teardown();
        for (const [i, el] of childRefs.current) {
          if (node.sizes[i] != null) el.style.flex = `${node.sizes[i]} 1 0`;
        }
        props.onResized();
      },
    });
    window.addEventListener("pointermove", onMove);
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
            ref={(el) => {
              if (el) childRefs.current.set(i, el);
              else childRefs.current.delete(i);
            }}
            style={{ flex: `${node.sizes[i] ?? 1} 1 0` }}
          >
            <OverlayTree {...props} node={child} />
          </div>
          {i < node.children.length - 1 && (
            <div
              className={`split-divider split-divider-${node.dir}`}
              onPointerDown={startDivider(i)}
              onDoubleClick={() => {
                const a = node.children[i];
                const b = node.children[i + 1];
                if (a.type === "group" && b.type === "group") {
                  useTabsStore.getState().mergeGroupsInScope(ROOT_SCOPE, a.id, b.id);
                }
              }}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

function SplitPreview({ rect, edge }: { rect: Rect; edge: DropEdge }) {
  const ins = previewInset(edge);
  return (
    <div
      className="split-preview"
      style={{
        left: rect.left + ins.left * rect.width,
        top: rect.top + ins.top * rect.height,
        width: rect.width * (1 - ins.left - ins.right),
        height: rect.height * (1 - ins.top - ins.bottom),
      }}
    />
  );
}

/** Where a strip drop lands: a thin accent line at the slot. */
function StripMarker({ x, strip }: { x: number; strip: HTMLDivElement | undefined }) {
  const r = strip?.getBoundingClientRect();
  if (!r) return null;
  return <div className="root-overlay-strip-marker" style={{ left: x - 1, top: r.top + 2, height: r.height - 4 }} />;
}
