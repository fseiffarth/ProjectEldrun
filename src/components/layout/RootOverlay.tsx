import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useProjectsStore } from "../../stores/projects";
import { useActivityStore } from "../../stores/activity";
import { useCalendarStore } from "../../stores/calendar";
import {
  ROOT_SCOPE,
  allGroups,
  isPtyTabKind,
  useTabsStore,
  type TabEntry,
} from "../../stores/tabs";
import { notifyCalendarWrite } from "../../lib/calendarWriteHook";
import type { CalendarEvent, CalendarTask } from "../../types";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { CustomAgentDialog } from "../tabs/CustomAgentDialog";
import { NewTabMenu } from "../tabs/NewTabMenu";
import { TabPane } from "../tabs/TabPane";
import { StarIcon } from "./StarIcon";

/** What the backend's `root-mcp-changed` event carries (`services::root_mcp::Change`). */
type RootMcpChange =
  | { kind: "event"; op: "upsert" | "delete"; row: CalendarEvent }
  | { kind: "task"; op: "upsert" | "delete"; row: CalendarTask };

interface RootMcpStatus {
  running: boolean;
  tools: string[];
}

const NO_TABS: TabEntry[] = [];

/**
 * The root scope's tabs in the order its layout holds them. A root layout can
 * be split (it was an ordinary scope for years); the overlay is ONE subwindow,
 * so the groups are read left to right into a single strip. Tabs living in a
 * popout are left out — their panes are in that window.
 */
function useRootTabs(): TabEntry[] {
  const tabs = useTabsStore((s) => s.tabsByScope[ROOT_SCOPE] ?? NO_TABS);
  const layout = useTabsStore((s) => s.layoutByScope[ROOT_SCOPE] ?? null);
  return useMemo(() => {
    const byKey = new Map(tabs.map((tab) => [tab.key, tab]));
    return allGroups(layout)
      .flatMap((g) => g.tabKeys)
      .map((key) => byKey.get(key))
      .filter((tab): tab is TabEntry => !!tab);
  }, [tabs, layout]);
}

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
      void notifyCalendarWrite(payload).catch(() => {});
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  return open ? <RootOverlay /> : null;
}

function RootOverlay() {
  const t = useT();
  const tabs = useRootTabs();
  const storedKey = useRootOverlayStore((s) => s.activeKey);
  const setActiveKey = useRootOverlayStore((s) => s.setActiveKey);
  const close = useRootOverlayStore((s) => s.close);
  const rootDir = useProjectsStore((s) => s.rootDir) ?? "";
  const busyByTab = useActivityStore((s) => s.busyByTab);
  const attentionByTab = useActivityStore((s) => s.attentionByTab);
  const clearAttention = useActivityStore((s) => s.clearAttention);
  const scopeActiveKey = useTabsStore((s) => {
    const layout = s.layoutByScope[ROOT_SCOPE] ?? null;
    const focused = s.focusedGroupByScope[ROOT_SCOPE];
    const groups = allGroups(layout);
    return (groups.find((g) => g.id === focused) ?? groups[0])?.activeKey ?? null;
  });
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [manageAgents, setManageAgents] = useState(false);
  const [status, setStatus] = useState<RootMcpStatus | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  // The shown tab: the overlay's own pick while it still exists, else the tab
  // the scope itself had active, else the first.
  const activeKey =
    (storedKey && tabs.some((tab) => tab.key === storedKey) ? storedKey : null) ??
    (scopeActiveKey && tabs.some((tab) => tab.key === scopeActiveKey) ? scopeActiveKey : null) ??
    tabs[0]?.key ??
    null;

  useEffect(() => {
    invoke<RootMcpStatus>("root_mcp_status").then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape inside a pane is the pane's (an agent TUI's cancel key); the
      // toggle chord closes from there. A menu of ours closes first.
      if (paneRef.current && e.target instanceof Node && paneRef.current.contains(e.target)) return;
      if (addMenu || manageAgents) return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, addMenu, manageAgents]);

  const addTab = useCallback(
    (spec: Omit<TabEntry, "key">) => {
      const tab = useTabsStore.getState().addTabToScope(ROOT_SCOPE, spec);
      setActiveKey(tab.key);
    },
    [setActiveKey],
  );

  const agentsWithTools = status?.running ? t("rootConsole.rightsOn") : t("rootConsole.rightsOff");

  return (
    <div
      className="modal-backdrop root-overlay-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="root-overlay subwindow focused"
        role="dialog"
        aria-modal="true"
        aria-label={t("rootConsole.title")}
      >
        <div className="tab-bar root-overlay-bar">
          <div className="root-overlay-mark" title={t("rootConsole.title")}>
            <StarIcon />
          </div>
          <div className="tab-strip">
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
                  className={`tab ${isActive ? "active" : ""}${stateClass}`}
                  onMouseDown={() => {
                    if (isActive) clearAttention(ptyId);
                    else setActiveKey(tab.key);
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
          <div className="tab-new-wrap">
            <button
              className="tab-new-btn"
              title={t("detachedTabs.newTab")}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setAddMenu((cur) => (cur ? null : { x: r.left, y: r.bottom + 4 }));
              }}
            >
              +
            </button>
          </div>
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
          <div className="subwindow-pane-region" ref={paneRef}>
            {tabs.length === 0 ? (
              <div className="center-placeholder" style={{ height: "100%" }}>
                <div className="center-placeholder-card">
                  <div className="center-placeholder-title">{t("rootConsole.emptyTitle")}</div>
                  <div className="center-placeholder-hint">{t("rootConsole.emptyHint")}</div>
                </div>
              </div>
            ) : (
              <div className="pane-layer">
                {tabs.map((tab) => {
                  const visible = tab.key === activeKey;
                  return (
                    <div
                      key={tab.key}
                      className="center-pane"
                      data-tab-key={tab.key}
                      style={
                        visible
                          ? { display: "flex", left: 0, top: 0, right: 0, bottom: 0 }
                          : { display: "none" }
                      }
                    >
                      {/* Attach-only, like a popout's panes: the PTY belongs to
                          the root tab's own pane in CenterPanel's keep-alive
                          layer, so closing the overlay ends nothing. */}
                      <TabPane
                        tab={tab}
                        scope={ROOT_SCOPE}
                        visible={visible}
                        focused={visible && !addMenu}
                        attachOnly
                        filesProjectDir={tab.cwd || rootDir}
                        terminalCwd={tab.cwd || rootDir}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
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
