import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withHpcConfirm } from "../../lib/hpcGuard";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import {
  arcColor,
  flattenRows,
  formatBytes,
  layoutRings,
  ringPath,
  sharePercent,
  squarify,
  OTHERS_COLOR,
  type DuDevice,
  type DuNode,
  type DuProgress,
  type DuScan,
} from "../../lib/diskUsage";
import { FILES_TAB_CMD, useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { OrbitSpinner } from "../common/OrbitSpinner";

interface Props {
  /** Owning project, or `null` in the root scope. */
  projectId: string | null;
  /** The project's directory — the "This project" scan shortcut. */
  projectCwd: string;
  /**
   * This pane's tab, so starting a scan can retitle the tab after the folder it is
   * measuring — several Disk Usage tabs can be open at once, and "Disk Usage" three
   * times over tells the user nothing. Omitted in a detached pop-out, which runs on
   * a streamed copy of the tab payloads with no rename channel back to the main
   * window; the pane then simply keeps its label.
   */
  tabKey?: string;
  visible: boolean;
}

type Chart = "rings" | "treemap";

/** Rings drawn outside the centre disc. Past this the slices are hairlines. */
const RING_DEPTH = 6;
/** Row height of the treeview, in px. Must match `.du-row` in themes.css. */
const ROW_H = 22;
/** Rows rendered beyond the viewport on each side, to hide scroll tearing. */
const OVERSCAN = 8;

// ── Small pure helpers (the interesting maths lives in lib/diskUsage.ts) ───────

function findNode(node: DuNode, path: string): DuNode | null {
  if (node.path === path) return node;
  for (const child of node.children) {
    const hit = findNode(child, path);
    if (hit) return hit;
  }
  return null;
}

/** The chain from the scan root down to `path`, for the zoom breadcrumb. */
function trail(root: DuNode, path: string): DuNode[] {
  if (root.path === path) return [root];
  for (const child of root.children) {
    const rest = trail(child, path);
    if (rest.length) return [root, ...rest];
  }
  return [];
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

// ── Pane ──────────────────────────────────────────────────────────────────────

export function DiskUsagePane({ projectId, projectCwd, tabKey, visible }: Props) {
  const [devices, setDevices] = useState<DuDevice[]>([]);
  const [scan, setScan] = useState<DuScan | null>(null);
  const [progress, setProgress] = useState<DuProgress | null>(null);
  const [scanningRoot, setScanningRoot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [chart, setChart] = useState<Chart>("rings");
  const [zoomPath, setZoomPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [hover, setHover] = useState<{ node: DuNode | null; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ node: DuNode; x: number; y: number } | null>(null);

  /** Id of the scan in flight, so its progress events can be told from a stale one. */
  const scanIdRef = useRef<string | null>(null);

  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const sshState = useRemoteStatusStore((s) => (projectId ? s.byProject[projectId]?.ssh : undefined));
  const addTab = useTabsStore((s) => s.addTab);
  const renameTab = useTabsStore((s) => s.renameTab);

  const isRemoteProject = !!project?.remote;
  const hostConnected = isRemoteProject && sshState === "connected";
  /** A remote project's tree lives on the host; its local `directory` is state. */
  const projectScanRoot = isRemoteProject ? (project?.remote?.remote_path ?? "") : projectCwd;

  // ── Devices + progress wiring ───────────────────────────────────────────────

  useEffect(() => {
    if (!visible || devices.length) return;
    void invoke<DuDevice[]>("disk_usage_devices")
      .then(setDevices)
      .catch((e) => setError(String(e)));
  }, [visible, devices.length]);

  useEffect(() => {
    const unlisten = listen<DuProgress>("disk-scan-progress", (ev) => {
      if (ev.payload.scan_id !== scanIdRef.current) return; // another pane's scan
      if (ev.payload.phase !== "done") setProgress(ev.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const startScan = useCallback(
    async (root: string, onHost: boolean, label: string) => {
      // Retitle the tab after what it is measuring, so several open Disk Usage tabs
      // stay tellable apart. Done HERE, at scan start, and not on completion:
      // `renameTab` writes to the *current* scope, and panes stay mounted across
      // project switches — so a long scan finishing after the user has moved on
      // would retitle a tab in whatever project they switched to. Starting a scan is
      // a click inside a visible pane, so at this instant the pane's scope IS the
      // active scope.
      if (tabKey) renameTab(tabKey, `Disk: ${label}`);

      const scanId = `${projectId ?? "root"}-${crypto.randomUUID()}`;
      scanIdRef.current = scanId;
      setScanningRoot(root);
      setProgress(null);
      setError(null);
      setScan(null);
      try {
        // On a host tagged HPC the backend refuses this until the user confirms
        // *this* scan: it stats every file under the root, and on a cluster that
        // root is normally on the parallel filesystem, where that is a metadata
        // storm against a shared server (`lib/hpcGuard.ts`). Untagged hosts and
        // local roots never see the dialog — the refusal never happens for them.
        const result = await withHpcConfirm((confirmed) =>
          invoke<DuScan>("disk_usage_scan", {
            scanId,
            root,
            projectId: onHost ? projectId : null,
            confirmed,
          }),
        );
        // A scan the user cancelled and replaced must not overwrite the new one.
        if (scanIdRef.current !== scanId) return;
        setScan(result);
        setZoomPath(null);
        setExpanded(new Set([result.root.path]));
      } catch (e) {
        if (scanIdRef.current === scanId) setError(String(e));
      } finally {
        if (scanIdRef.current === scanId) {
          scanIdRef.current = null;
          setScanningRoot(null);
        }
      }
    },
    [projectId, renameTab, tabKey],
  );

  function cancelScan() {
    const id = scanIdRef.current;
    if (id) void invoke("disk_usage_cancel", { scanId: id }).catch(() => {});
  }

  async function pickFolder() {
    const picked = await open({ directory: true, multiple: false, title: "Scan a folder" });
    if (typeof picked === "string") {
      void startScan(picked, false, picked.slice(picked.lastIndexOf("/") + 1) || picked);
    }
  }

  function backToHome() {
    setScan(null);
    setError(null);
    setHover(null);
  }

  // ── Derived view state ──────────────────────────────────────────────────────

  const chartRoot = useMemo(() => {
    if (!scan) return null;
    return (zoomPath && findNode(scan.root, zoomPath)) || scan.root;
  }, [scan, zoomPath]);

  const crumbs = useMemo(
    () => (scan && chartRoot ? trail(scan.root, chartRoot.path) : []),
    [scan, chartRoot],
  );

  const rows = useMemo(() => (scan ? flattenRows(scan.root, expanded) : []), [scan, expanded]);

  function toggleExpand(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /** Zoom the chart into a directory, and open the path to it in the treeview. */
  function zoomTo(node: DuNode) {
    if (!node.is_dir || !scan) return;
    setZoomPath(node.path);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const crumb of trail(scan.root, node.path)) next.add(crumb.path);
      return next;
    });
  }

  // ── Row actions ─────────────────────────────────────────────────────────────

  function openExternally(node: DuNode) {
    setMenu(null);
    void invoke("open_file", { path: node.path, projectId }).catch((e) => setError(String(e)));
  }

  function revealInFiles(node: DuNode) {
    setMenu(null);
    addTab({
      label: node.is_dir ? node.name : "Files",
      cmd: FILES_TAB_CMD,
      cwd: node.is_dir ? node.path : parentDir(node.path),
      kind: "files",
    });
  }

  function copyPath(node: DuNode) {
    setMenu(null);
    navigator.clipboard?.writeText(node.path).catch(() => {});
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (scanningRoot !== null) {
    return (
      <div className="du-root du-centered">
        <OrbitSpinner />
        <div className="du-scanning-title">Scanning {scanningRoot}</div>
        <div className="du-scanning-stats">
          {progress
            ? `${progress.dirs.toLocaleString()} folders · ${progress.files.toLocaleString()} files · ${formatBytes(progress.bytes)}`
            : "Starting…"}
        </div>
        <div className="du-scanning-path">{progress?.path ?? ""}</div>
        <button className="du-btn" onClick={cancelScan}>
          Cancel
        </button>
      </div>
    );
  }

  if (!scan) {
    return (
      <div className="du-root du-home">
        <h2 className="du-home-title">Disk Usage Analyzer</h2>
        {error && <div className="du-error">{error}</div>}

        <div className="du-targets">
          {devices.map((dev) => (
            <button
              key={dev.path}
              className="du-target"
              onClick={() => void startScan(dev.path, false, dev.label)}
            >
              <span className="du-target-label">{dev.label}</span>
              <span className="du-target-path">{dev.path}</span>
              {dev.total_bytes != null && dev.free_bytes != null && (
                <>
                  <span className="du-capacity">
                    <span
                      className="du-capacity-fill"
                      style={{
                        width: `${sharePercent(dev.total_bytes - dev.free_bytes, dev.total_bytes)}%`,
                      }}
                    />
                  </span>
                  <span className="du-target-caption">
                    {formatBytes(dev.total_bytes - dev.free_bytes)} of {formatBytes(dev.total_bytes)}{" "}
                    used
                  </span>
                </>
              )}
            </button>
          ))}

          {projectId && projectScanRoot && (
            <button
              className="du-target"
              disabled={isRemoteProject && !hostConnected}
              onClick={() =>
                void startScan(projectScanRoot, isRemoteProject, project?.name ?? "project")
              }
            >
              <span className="du-target-label">This project</span>
              <span className="du-target-path">{projectScanRoot}</span>
              <span className="du-target-caption">
                {!isRemoteProject
                  ? "Local"
                  : hostConnected
                    ? `On ${project?.remote?.host}`
                    : "Connect the project to scan its host"}
              </span>
            </button>
          )}

          <button className="du-target" onClick={() => void pickFolder()}>
            <span className="du-target-label">Scan a folder…</span>
            <span className="du-target-caption">Pick any folder on this machine</span>
          </button>
        </div>
      </div>
    );
  }

  const total = scan.root.size;

  return (
    <div className="du-root" onMouseDown={() => setMenu(null)}>
      <div className="du-toolbar">
        <button className="du-btn" onClick={backToHome} title="Scan something else">
          ‹ Scans
        </button>
        <div className="du-crumbs">
          {crumbs.map((crumb, i) => (
            <span key={crumb.path}>
              {i > 0 && <span className="du-crumb-sep">/</span>}
              <button
                className="du-crumb"
                disabled={i === crumbs.length - 1}
                onClick={() => setZoomPath(i === 0 ? null : crumb.path)}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>
        <span className="du-total">{formatBytes(chartRoot?.size ?? total)}</span>
        <span className="du-stats">
          {scan.dirs.toLocaleString()} folders · {scan.files.toLocaleString()} files
          {scan.errors > 0 && ` · ${scan.errors.toLocaleString()} unreadable`}
          {scan.cancelled && " · cancelled (partial)"}
        </span>
        <span className="du-chart-toggle">
          <button
            className={chart === "rings" ? "du-btn active" : "du-btn"}
            onClick={() => setChart("rings")}
            title="Rings"
          >
            ◍
          </button>
          <button
            className={chart === "treemap" ? "du-btn active" : "du-btn"}
            onClick={() => setChart("treemap")}
            title="Treemap"
          >
            ▦
          </button>
        </span>
      </div>

      <div className="du-body">
        <TreeView
          rows={rows}
          expanded={expanded}
          onToggle={toggleExpand}
          onZoom={zoomTo}
          onMenu={(node, x, y) => setMenu({ node, x, y })}
        />
        <div className="du-chart">
          {chartRoot && chart === "rings" ? (
            <Rings
              root={chartRoot}
              onZoom={zoomTo}
              onUp={() =>
                setZoomPath(crumbs.length > 1 ? (crumbs[crumbs.length - 2].path ?? null) : null)
              }
              canGoUp={crumbs.length > 1}
              onHover={setHover}
              onMenu={(node, x, y) => setMenu({ node, x, y })}
            />
          ) : chartRoot ? (
            <Treemap
              root={chartRoot}
              onZoom={zoomTo}
              onHover={setHover}
              onMenu={(node, x, y) => setMenu({ node, x, y })}
            />
          ) : null}
        </div>
      </div>

      {hover?.node &&
        createPortal(
          <div
            className="activity-tooltip du-tooltip"
            style={{
              position: "fixed",
              left: hover.x,
              top: hover.y - 8,
              transform: "translate(-50%, -100%)",
              pointerEvents: "none",
              zIndex: 10000,
            }}
          >
            <strong>{hover.node.name}</strong>
            <br />
            {formatBytes(hover.node.size)}
            {chartRoot && chartRoot.size > 0 && (
              <> · {sharePercent(hover.node.size, chartRoot.size).toFixed(1)}%</>
            )}
          </div>,
          document.body,
        )}

      {menu &&
        createPortal(
          <div
            className="context-menu du-context-menu"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button onClick={() => openExternally(menu.node)}>Open</button>
            <button onClick={() => revealInFiles(menu.node)}>Reveal in Files tab</button>
            <button onClick={() => copyPath(menu.node)}>Copy path</button>
          </div>,
          document.body,
        )}
    </div>
  );
}

// ── Treeview ──────────────────────────────────────────────────────────────────

interface TreeViewProps {
  rows: ReturnType<typeof flattenRows>;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onZoom: (node: DuNode) => void;
  onMenu: (node: DuNode, x: number, y: number) => void;
}

/**
 * Windowed size treeview. A whole-home scan yields far more rows than the DOM
 * should hold, so only the visible slice is rendered inside a full-height spacer.
 */
function TreeView({ rows, expanded, onToggle, onZoom, onMenu }: TreeViewProps) {
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const slice = rows.slice(first, last);

  return (
    <div className="du-tree" ref={ref} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: rows.length * ROW_H, position: "relative" }}>
        <div style={{ position: "absolute", top: first * ROW_H, left: 0, right: 0 }}>
          {slice.map(({ node, depth, parentSize, expandable }) => (
            <div
              key={node.path}
              className={`du-row ${node.is_dir ? "dir" : "file"}`}
              style={{ height: ROW_H, paddingLeft: 6 + depth * 13 }}
              onClick={() => (expandable ? onToggle(node.path) : undefined)}
              onDoubleClick={() => onZoom(node)}
              onContextMenu={(e) => {
                e.preventDefault();
                onMenu(node, e.clientX, e.clientY);
              }}
            >
              <span className="du-row-caret">
                {expandable ? (expanded.has(node.path) ? "▾" : "▸") : ""}
              </span>
              <span className="du-row-name" title={node.path}>
                {node.name}
              </span>
              <span className="du-row-bar">
                <span
                  className="du-row-bar-fill"
                  style={{ width: `${sharePercent(node.size, parentSize)}%` }}
                />
              </span>
              <span className="du-row-size">{formatBytes(node.size)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Charts ────────────────────────────────────────────────────────────────────

/** Measure a chart container, re-measuring when it is revealed (a hidden pane is 0×0). */
function useChartSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

interface ChartProps {
  root: DuNode;
  onZoom: (node: DuNode) => void;
  onHover: (h: { node: DuNode | null; x: number; y: number } | null) => void;
  onMenu: (node: DuNode, x: number, y: number) => void;
}

function Rings({
  root,
  onZoom,
  onUp,
  canGoUp,
  onHover,
  onMenu,
}: ChartProps & { onUp: () => void; canGoUp: boolean }) {
  const [ref, { w, h }] = useChartSize();
  const arcs = useMemo(() => layoutRings(root, RING_DEPTH), [root]);

  const side = Math.min(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const outer = Math.max(0, side / 2 - 10);
  const centre = outer * 0.24;
  const ringW = (outer - centre) / RING_DEPTH;

  return (
    <div className="du-svg-wrap" ref={ref}>
      {side > 40 && (
        <svg width={w} height={h} role="img" aria-label={`Disk usage of ${root.name}`}>
          {arcs.map((arc) => {
            const r0 = centre + (arc.depth - 1) * ringW;
            const node = arc.node;
            return (
              <path
                key={arc.key}
                className="du-arc"
                d={ringPath(cx, cy, r0, r0 + ringW, arc.a0, arc.a1)}
                fill={node ? arcColor(arc.colorIndex, arc.depth) : OTHERS_COLOR}
                onClick={() => node && onZoom(node)}
                onMouseMove={(e) => onHover({ node, x: e.clientX, y: e.clientY })}
                onMouseLeave={() => onHover(null)}
                onContextMenu={(e) => {
                  if (!node) return;
                  e.preventDefault();
                  onMenu(node, e.clientX, e.clientY);
                }}
              />
            );
          })}
          <circle
            className={canGoUp ? "du-centre up" : "du-centre"}
            cx={cx}
            cy={cy}
            r={centre}
            onClick={() => canGoUp && onUp()}
          />
          <text className="du-centre-name" x={cx} y={cy - 3} textAnchor="middle">
            {root.name}
          </text>
          <text className="du-centre-size" x={cx} y={cy + 12} textAnchor="middle">
            {formatBytes(root.size)}
          </text>
        </svg>
      )}
    </div>
  );
}

function Treemap({ root, onZoom, onHover, onMenu }: ChartProps) {
  const [ref, { w, h }] = useChartSize();
  const cells = useMemo(
    () => squarify(root, { x: 0, y: 0, w: Math.max(0, w - 2), h: Math.max(0, h - 2) }),
    [root, w, h],
  );

  return (
    <div className="du-svg-wrap" ref={ref}>
      {w > 20 && h > 20 && (
        <svg width={w} height={h} role="img" aria-label={`Disk usage of ${root.name}`}>
          {cells.map((cell) => {
            const node = cell.node;
            const label = cell.w > 56 && cell.h > 24;
            return (
              <g key={cell.key}>
                <rect
                  className="du-cell"
                  x={cell.x + 1}
                  y={cell.y + 1}
                  width={cell.w}
                  height={cell.h}
                  fill={node ? arcColor(cell.colorIndex, 1) : OTHERS_COLOR}
                  onClick={() => node && onZoom(node)}
                  onMouseMove={(e) => onHover({ node, x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => onHover(null)}
                  onContextMenu={(e) => {
                    if (!node) return;
                    e.preventDefault();
                    onMenu(node, e.clientX, e.clientY);
                  }}
                />
                {label && (
                  <text className="du-cell-label" x={cell.x + 7} y={cell.y + 16}>
                    {node ? node.name : `${root.hidden_children} more`}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
