import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { TerminalView } from "../terminal/TerminalView";
import { FileBrowser } from "../files/FileBrowser";
import { EmbedPane } from "../embed/EmbedPane";
import { FileViewerPane } from "../embed/FileViewerPane";
import { Subwindow } from "../tabs/Subwindow";
import { pickEdge, previewInset } from "../tabs/dragGeometry";
import {
  EMPTY_GROUP_ID,
  FILES_TAB_CMD,
  allGroups,
  cmdToKind,
  isRestorableTab,
  useTabsStore,
  type LayoutNode,
  type SavedLayoutTree,
  type TabKind,
} from "../../stores/tabs";
import { useDragStore } from "../../stores/drag";
import { commitDrop } from "../tabs/commitDrop";
import { useProjectsStore } from "../../stores/projects";
import { resolveProjectDirectory } from "../../types";

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
  const saveLayout = useTabsStore((s) => s.saveLayout);
  const updateTabEnv = useTabsStore((s) => s.updateTabEnv);

  const { projects, activeId } = useProjectsStore();

  // Whether a pointer-drag is active. We subscribe to a boolean (not the drag
  // object, which is replaced on every pointermove) so the panel doesn't
  // re-render — and tear down/re-add its window listeners — each frame. Live
  // drag state is read via useDragStore.getState() inside the handlers.
  const dragging = useDragStore((s) => s.drag != null);

  // Measured pane regions per group id (current scope only). The flat pane
  // layer positions each active pane over its group's body so PTYs never
  // unmount on scope switch / re-tile.
  const [groupRects, setGroupRects] = useState<Record<string, Rect>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const groupBodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const activeProject = projects.find((p) => p.id === activeId);
  const localFile = activeProject?.local_file as string | undefined;
  const projectCwd = resolveProjectDirectory(activeProject);

  useEffect(() => {
    const nextScope = activeId ?? "root";
    setScope(nextScope);

    if (!activeId || !localFile) {
      // Root context: never auto-spawn; leave empty until the user opens a tab.
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
        const raw = proj.tab_layout as LayoutEntry[] | undefined;
        if (!raw || raw.length === 0) return;
        // Keep shell/files tabs, resumable agent tabs (Claude with a sessionId,
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
        if (restorable.length === 0) return;
        // Guard: don't overwrite tabs that switch_project_runtime already loaded.
        if (scopeForLoad in useTabsStore.getState().tabsByScope) return;
        // `tab_groups` carries the saved split/group tree (absent → single group).
        const groups = proj.tab_groups as SavedLayoutTree | undefined;
        loadFromLayout(restorable, projectCwd, scopeForLoad, groups ?? undefined);
      })
      .catch(() => {});
  }, [activeId, projectCwd, localFile, setScope, loadFromLayout]);

  // Re-hydrate local_agent tabs that were saved without VIBE_HOME/VIBE_ACTIVE_MODEL.
  useEffect(() => {
    if (!activeId) return;
    const { tabs: currentTabs } = useTabsStore.getState();
    const needsEnv = currentTabs.filter(
      (t) => t.kind === "local_agent" && Object.keys(t.env ?? {}).length === 0,
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
  }, [activeId, localFile, tabs, layout, saveLayout]);

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

  // Re-measure when the current scope's layout tree changes.
  useLayoutEffect(() => {
    measure();
  }, [measure, layout, scope]);

  // Re-measure on panel resize (split drags resize children without remount).
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(panel);
    for (const el of groupBodyRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [measure, layout, scope]);

  const registerGroupBody = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) groupBodyRefs.current.set(id, el);
      else groupBodyRefs.current.delete(id);
    },
    [],
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
    const setTarget = useDragStore.getState().setTarget;
    const move = useDragStore.getState().move;

    // Insertion slot (0..count) a reorder would drop into, mirroring TabBar's
    // "left half → before, right half → after" rule.
    const computeReorderIndex = (tabBar: Element, x: number): number => {
      const tabEls = tabBar.querySelectorAll(".tab");
      let slot = tabEls.length;
      tabEls.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (slot === tabEls.length && x < r.left + r.width / 2) slot = i;
      });
      return slot;
    };

    const resolve = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      const tabBar = el?.closest(".tab-bar");
      if (tabBar instanceof HTMLElement && tabBar.dataset.groupId) {
        // A tab bar always accepts a drop — for both tab drags and file drags.
        // Files snap to the bar regardless of embed capability: the drop is
        // always meaningful (it opens the file / creates a tab). The prefetched
        // capability only decides embed-vs-external at release time, handled in
        // commitFileDrop.
        setTarget({
          overGroup: null,
          edge: null,
          reorderGroup: tabBar.dataset.groupId,
          reorderIndex: computeReorderIndex(tabBar, x),
        });
        return;
      }
      // Not over a tab bar → fall back to the measured group rects and pick the
      // edge of whichever subwindow body contains the panel-relative point. For
      // file drags this carves out a new subwindow holding the file's embed tab
      // (commitFileDrop handles the overGroup/edge case); a tab-bar drop instead
      // adds the tab into that existing group.
      const panel = panelRef.current;
      if (panel) {
        const base = panel.getBoundingClientRect();
        const px = x - base.left;
        const py = y - base.top;
        for (const [gid, r] of Object.entries(groupRects)) {
          if (px >= r.left && px <= r.left + r.width && py >= r.top && py <= r.top + r.height) {
            setTarget({
              overGroup: gid,
              // The empty-state placeholder isn't a real group to split — a drop
              // anywhere over it just creates the first tab. So always treat it as
              // a whole-area ("center") target, giving a full-pane drop preview.
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
    };

    const onMove = (e: PointerEvent) => {
      resolve(e.clientX, e.clientY);
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
      if (d?.kind === "file") {
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
    // pointermove). Treating cancel as an abort therefore silently swallowed
    // every drop. So a pointercancel commits the drop too — only an explicit
    // Escape (aborted) ends without committing.
    const onCancel = () => {
      if (aborted) { useDragStore.getState().end(); return; }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, groupRects]);

  // ── Render the flat pane layer (all tabs, all scopes; never unmounted) ─────
  const allTabs = Object.entries(tabsByScope).flatMap(([s, scopeTabs]) =>
    scopeTabs.map((tab) => ({ tab, scopeKey: s })),
  );
  // For each current-scope group, which tab key is its active (visible) one.
  const activeKeyOfGroup = new Map<string, string>();
  // Group id holding each visible tab key (current scope only).
  const groupOfKey = new Map<string, string>();
  for (const g of allGroups(layoutByScope[scope] ?? null)) {
    if (g.activeKey) activeKeyOfGroup.set(g.id, g.activeKey);
    for (const k of g.tabKeys) groupOfKey.set(k, g.id);
  }

  return (
    <div
      ref={panelRef}
      className={`center-panel${dragging ? " dragging" : ""}`}
    >
      {/* Subwindow frame layer: the recursive layout tree for the current scope.
          Each group body is an empty measured slot; panes are positioned over
          it by the flat layer below. */}
      {layout ? (
        <LayoutTree
          node={layout}
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
            No tabs open — use + to create one
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
          const visible =
            isCurrentScope &&
            groupId != null &&
            activeKeyOfGroup.get(groupId) === tab.key;
          const rect = groupId ? groupRects[groupId] : undefined;
          const style: React.CSSProperties = visible && rect
            ? {
                display: "flex",
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              }
            : { display: "none" };
          return (
            <div key={`${scopeKey}/${tab.key}`} className="center-pane" style={style}>
              {tab.kind === "files" ? (
                <FileBrowser
                  projectDir={tab.cwd}
                  projectId={scopeKey === "root" ? null : scopeKey}
                  active={visible}
                />
              ) : tab.kind === "embed" ? (
                tab.viewer ? (
                  <FileViewerPane
                    viewer={tab.viewer}
                    path={tab.embedPath ?? ""}
                    projectId={scopeKey === "root" ? null : scopeKey}
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
                  cwd={tab.cwd}
                  localOnly={tab.kind === "local_agent"}
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

      {/* Floating ghost following the pointer during a drag. */}
      <DragGhost />
    </div>
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
 * The dragged tab's label, floating at the pointer. Subscribes to the drag store
 * itself (rather than via CenterPanel props) so the panel doesn't re-render on
 * every pointermove. Rendered into document.body so it isn't clipped.
 */
function DragGhost() {
  const drag = useDragStore((s) => s.drag);
  if (!drag) return null;
  return createPortal(
    <div className="tab-drag-ghost" style={{ left: drag.pointerX, top: drag.pointerY }}>
      {drag.label}
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
      props.resizeSplit(node.id, dividerIndex, Math.min(Math.max(leftSize, 0), pair));
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
