import { useMemo, useState } from "react";
import { ProjectFilesView } from "../files/ProjectFilesView";
import { useFileSource } from "../files/ProjectFilesPane";
import { openProjectFilesTab } from "../files/ProjectFilesTab";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, orderedTabKeys, isPtyTabKind, type TabEntry } from "../../stores/tabs";
import { useActivityStore, type AttentionKind } from "../../stores/activity";
import { resolveProjectDirectory } from "../../types";

interface Props {
  open: boolean;
  pinned?: boolean;
  /** Which edge the panel docks against; drives the mirrored slide/border/resize
   *  layout via the `.left` class. Defaults to "right". */
  side?: "left" | "right";
  /** Current panel width in px (driven by the left-border resize drag). */
  width?: number;
  /** True while a resize drag is in progress — suppresses width/transform
   *  transitions so the panel tracks the cursor instead of lagging behind. */
  resizing?: boolean;
  onResizeStart?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onResizeMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onResizeEnd?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onTogglePin?: () => void;
  onToggleSide?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

/** A hidden subwindow's tab is invisible to the tab bar, so it can't paint its
 *  own glow — this is the same working/needs-decision/finished precedence
 *  `TabBar` uses for the live tab glow, applied here to a hidden group's tab
 *  chips (and rolled up for the group's row) so a hidden pane doesn't go dark
 *  just because it's parked. */
function hiddenTabStatus(
  kind: TabEntry["kind"] | undefined,
  ptyId: string,
  busyByTab: Record<string, boolean>,
  attentionByTab: Record<string, AttentionKind>,
): "working" | "needs-decision" | "finished" | null {
  if (!kind) return null;
  if (isPtyTabKind(kind) && busyByTab[ptyId]) return "working";
  if (kind === "agent" || kind === "local_agent") {
    const attn = attentionByTab[ptyId];
    if (attn === "decision") return "needs-decision";
    if (attn === "done") return "finished";
  }
  return null;
}

/** Roll several tab statuses up into one, most urgent first — a decision still
 *  waiting on the user outranks a tab merely working, which outranks one that's
 *  just finished unseen. Mirrors `attentionByScope`'s decision-over-done
 *  precedence, extended with `working` for the row-level dot. */
function rollUpStatus(
  statuses: Array<"working" | "needs-decision" | "finished" | null>,
): "working" | "needs-decision" | "finished" | null {
  if (statuses.includes("needs-decision")) return "needs-decision";
  if (statuses.includes("working")) return "working";
  if (statuses.includes("finished")) return "finished";
  return null;
}

/**
 * The file-tree overlay panel. Its file *viewer* — the view switcher, git bar +
 * history, search, apps, orange list, type tags, source switch and settings — is
 * the shared `ProjectFilesView`, the same component the Files (Project) tab
 * renders, so the two can never drift. This host owns only what is panel-specific:
 * the active-project identity it forwards, the browsed-folder in the projects
 * store, and the three window-chrome fragments (pin, resize border, the "Hidden
 * subwindows" list) it injects as slots — none of which a tab has.
 */
export function RightPanel({
  open,
  pinned,
  side = "right",
  width,
  resizing,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onTogglePin,
  onToggleSide,
  onMouseEnter,
  onMouseLeave,
}: Props) {
  const { projects, activeId } = useProjectsStore();
  const rightPanelFolderByProject = useProjectsStore((s) => s.rightPanelFolderByProject);
  const setRightPanelFolder = useProjectsStore((s) => s.setRightPanelFolder);

  const activeProject = projects.find((p) => p.id === activeId) ?? null;
  const projectDir = resolveProjectDirectory(activeProject);
  // SSH-sync Phase 1: which side of a remote project the files view shows — the
  // host (remote, SFTP-listed, with the sync overlay) or the local mirror.
  const [fileSource, setFileSource] = useFileSource(activeId, !!activeProject?.remote);
  const rightPanelFolder = activeId ? rightPanelFolderByProject[activeId] ?? "" : "";

  // When a box scope is open, the shared view shows a multi-root file view. It
  // derives that from the current tab scope, which the panel forwards.
  const scope = useTabsStore((s) => s.scope);
  // Subwindows the user has hidden in the current scope, surfaced as an
  // auto-pinned section above the toolbar. Their tabs still live in
  // `tabsByScope[scope]` (PTYs mounted, hidden), so the chips resolve labels
  // from there. `unhideGroup`/`closeHiddenGroup` restore or discard them.
  const hiddenGroups = useTabsStore((s) => s.hiddenGroupsByScope[s.scope]);
  const scopeTabs = useTabsStore((s) => s.tabsByScope[s.scope]);
  // Same working/decision/finished glow the tab bar draws for a live tab — a
  // hidden subwindow's tabs are still running underneath the pane, so they keep
  // reporting status even while parked.
  const busyByTab = useActivityStore((s) => s.busyByTab);
  const attentionByTab = useActivityStore((s) => s.attentionByTab);
  // One status per hidden group's tab, rolled up per group and overall, so the
  // Hidden section still says "something's running in there" without needing
  // the group unhidden and its tab bar drawn.
  const hiddenStatus = useMemo(() => {
    const rows = (hiddenGroups ?? []).map((h) => {
      const tabStatuses = orderedTabKeys(h.subtree).map((k) =>
        hiddenTabStatus(
          scopeTabs?.find((t) => t.key === k)?.kind,
          `${scope}:${k}`,
          busyByTab,
          attentionByTab,
        ),
      );
      return { id: h.id, status: rollUpStatus(tabStatuses), tabStatuses };
    });
    return { rows, overall: rollUpStatus(rows.map((r) => r.status)) };
  }, [hiddenGroups, scopeTabs, scope, busyByTab, attentionByTab]);
  const unhideGroup = useTabsStore((s) => s.unhideGroup);
  const closeHiddenGroup = useTabsStore((s) => s.closeHiddenGroup);
  const [hiddenCollapsed, setHiddenCollapsed] = useState(false);

  // Drag the left border to resize the panel; width persists in settings.
  // Pointer capture (set in onResizeStart) keeps the drag alive once the cursor
  // leaves this thin strip.
  const resizeHandle = onResizeStart ? (
    <div
      className="right-panel-resize"
      onPointerDown={onResizeStart}
      onPointerMove={onResizeMove}
      onPointerUp={onResizeEnd}
      title="Drag to resize panel"
      aria-hidden
    />
  ) : null;

  // The panel header's left-edge chrome: a side-flip toggle and the pin. Both ride
  // the single `pin` slot ProjectFilesView exposes (a tab passes neither), so no
  // extra slot is threaded through the shared viewer.
  const chrome =
    onTogglePin || onToggleSide ? (
      <>
        {onToggleSide && (
          <button
            className="right-panel-pin right-panel-flip"
            onClick={onToggleSide}
            title={side === "left" ? "Move panel to the right edge" : "Move panel to the left edge"}
            aria-label={side === "left" ? "Move panel to the right edge" : "Move panel to the left edge"}
          >
            ⇄
          </button>
        )}
        {onTogglePin && (
          <button
            className={`right-panel-pin${pinned ? " pinned" : ""}`}
            aria-pressed={pinned}
            onClick={onTogglePin}
            title={pinned ? "Unpin panel (allow auto-hide)" : "Pin panel open"}
          >
            📌
          </button>
        )}
      </>
    ) : null;

  const hidden =
    hiddenGroups && hiddenGroups.length > 0 ? (
      <div className="hidden-subwindows">
        <button
          type="button"
          className="hidden-sw-header"
          onClick={() => setHiddenCollapsed((c) => !c)}
          title={hiddenCollapsed ? "Show hidden subwindows" : "Collapse"}
        >
          <span className="hidden-sw-caret">{hiddenCollapsed ? "▸" : "▾"}</span>
          Hidden ({hiddenGroups.length})
          {hiddenStatus.overall && (
            <span
              className={`hidden-sw-status-dot ${hiddenStatus.overall}`}
              title={
                hiddenStatus.overall === "needs-decision"
                  ? "A hidden subwindow is waiting on you"
                  : hiddenStatus.overall === "working"
                    ? "A hidden subwindow is working"
                    : "A hidden subwindow finished, unseen"
              }
            />
          )}
        </button>
        {!hiddenCollapsed && (
          <div className="hidden-sw-list">
            {hiddenGroups.map((h, hi) => {
              const keys = orderedTabKeys(h.subtree);
              const { status: rowStatus, tabStatuses } = hiddenStatus.rows[hi];
              return (
                <div key={h.id} className="hidden-sw-row">
                  <span className={`hidden-sw-icon${rowStatus ? ` ${rowStatus}` : ""}`}>⊞</span>
                  <div className="hidden-sw-chips">
                    {keys.map((k, ki) => {
                      const label = scopeTabs?.find((t) => t.key === k)?.label ?? k;
                      const status = tabStatuses[ki];
                      return (
                        <button
                          key={k}
                          type="button"
                          className={`hidden-sw-chip${status ? ` ${status}` : ""}`}
                          title={`Restore focused on “${label}”`}
                          onClick={() => unhideGroup(h.id, { activeKey: k })}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="hidden-sw-btn"
                    title="Restore subwindow"
                    onClick={() => unhideGroup(h.id)}
                  >
                    ↩
                  </button>
                  <button
                    type="button"
                    className="hidden-sw-btn hidden-sw-close"
                    title="Close subwindow (discard its tabs)"
                    onClick={() => closeHiddenGroup(h.id)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    ) : null;

  return (
    <ProjectFilesView
      scope={scope}
      projectId={activeId ?? null}
      project={activeProject}
      projectDir={projectDir}
      folder={rightPanelFolder}
      onFolderChange={(folder) => {
        if (activeId) setRightPanelFolder(activeId, folder);
      }}
      source={fileSource}
      setSource={setFileSource}
      // A closed panel runs no probes and keeps no tree mounted (and so no
      // fs-watch).
      active={open}
      mountTree={open}
      // Right-click → "Open in a new tab": the same file view, on that folder,
      // as a Files (Project) tab in this project's scope.
      onOpenFolderTab={(rel) => openProjectFilesTab(projectDir, rel)}
      containerClassName={`right-panel${side === "left" ? " left" : ""} ${open ? "open" : ""}${resizing ? " resizing" : ""}`}
      containerStyle={width ? { width } : undefined}
      containerProps={{ onMouseEnter, onMouseLeave }}
      resizeHandle={resizeHandle}
      pin={chrome}
      hidden={hidden}
    />
  );
}
