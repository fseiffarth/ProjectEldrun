import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import type { ProjectBox, ProjectEntry } from "../../types";
import { ActivityCalendar } from "../projects/ActivityCalendar";

/**
 * A node in the 3D project cloud: either a project (any status — current,
 * active, or inactive) or a box (meta-grouping). Each is placed on a sphere and
 * rendered as a billboarded card that always faces the camera.
 */
type BlobNode =
  | { id: string; kind: "project"; project: ProjectEntry }
  | { id: string; kind: "box"; box: ProjectBox };

/** A unit-sphere coordinate, scaled by the cloud radius at layout time. */
interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Distribute `n` points evenly over a sphere of `radius` using the Fibonacci
 * lattice — deterministic and visually uniform without clustering at the poles.
 */
function fibonacciSphere(n: number, radius: number): Vec3[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: 0, y: 0, z: radius }];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2; // 1 → -1
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out.push({ x: Math.cos(theta) * r * radius, y: y * radius, z: Math.sin(theta) * r * radius });
  }
  return out;
}

const ROT_SENSITIVITY = 0.3; // deg per px dragged
const AUTO_SPIN = 0.06; // deg per frame when idle
const MIN_DOLLY = -360;
const MAX_DOLLY = 520;
const PERSPECTIVE = 1100; // px; the perspective the CSS scene used to delegate
const DBL_CLICK_MS = 260; // window to detect a double-click before the single fires

/** Where the right-click menu is anchored, plus the project it targets. */
interface BlobMenu {
  x: number;
  y: number;
  project: ProjectEntry;
}

/**
 * The "Projects" tab body: a navigable 3D cloud of every project and box. Drag
 * to orbit, scroll to zoom (dolly), click a node to jump to that project / open
 * that box. Inactive projects render dimmed so the at-a-glance status is clear.
 *
 * Rendered without WebGL: the rAF loop rotates each node's sphere point and
 * does the perspective divide itself, then writes a plain 2D transform to the
 * DOM. It deliberately does NOT lean on CSS `perspective`/`preserve-3d` to
 * project the Z — WebKitGTK (Linux) drops nested-3D Z, which flattened the
 * sphere to a disc, while Chromium/WebView2 (Windows) honored it. Keeping the
 * state in refs means a slow spin and a 60fps drag never thrash React; the
 * static node list renders once. Each node is also depth-shaded (front bright,
 * back dim) so the cloud reads as a solid sphere.
 *
 * Project interactions: single-click an inactive project to activate it, double-
 * click any project to open it (make it current), right-click for a menu that
 * can inactivate it. Boxes open on click.
 */
export function ProjectBlobPane() {
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);
  const setActive = useProjectsStore((s) => s.setActive);
  const activateProject = useProjectsStore((s) => s.activateProject);
  const deactivateProject = useProjectsStore((s) => s.deactivateProject);
  const boxes = useBoxesStore((s) => s.boxes);
  const openBox = useBoxesStore((s) => s.openBox);

  const [menu, setMenu] = useState<BlobMenu | null>(null);
  // The node currently hovered, plus where to anchor its info card. Cleared on
  // leave, on an orbit drag, and whenever the context menu opens.
  const [hover, setHover] = useState<{ x: number; y: number; node: BlobNode } | null>(null);
  // Per-project activity history (date → seconds) for the hover card's GitHub-
  // style heatmap, fetched lazily and cached so re-hovering doesn't refetch.
  const [activity, setActivity] = useState<Record<string, Record<string, number>>>({});

  const hoverProjectId = hover?.node.kind === "project" ? hover.node.project.id : null;
  useEffect(() => {
    if (!hoverProjectId || activity[hoverProjectId]) return;
    invoke<Record<string, number>>("get_project_activity", { projectId: hoverProjectId })
      .then((d) => setActivity((m) => ({ ...m, [hoverProjectId]: d })))
      .catch(() => setActivity((m) => ({ ...m, [hoverProjectId]: {} })));
  }, [hoverProjectId, activity]);

  const nodes = useMemo<BlobNode[]>(() => {
    const projectNodes: BlobNode[] = [...projects]
      .sort((a, b) => a.position - b.position)
      .map((project) => ({ id: `p:${project.id}`, kind: "project", project }));
    const boxNodes: BlobNode[] = [...boxes]
      .sort((a, b) => a.position - b.position)
      .map((box) => ({ id: `b:${box.id}`, kind: "box", box }));
    return [...projectNodes, ...boxNodes];
  }, [projects, boxes]);

  // Sphere grows with population so dense clouds don't overlap.
  const radius = useMemo(() => Math.min(520, 200 + nodes.length * 16), [nodes.length]);
  const positions = useMemo(() => fibonacciSphere(nodes.length, radius), [nodes.length, radius]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const nodeEls = useRef<Map<string, HTMLDivElement>>(new Map());
  // The hover card follows its node as the sphere spins, so the rAF loop pins it
  // each frame. It reads the hovered id (not React state, which the once-mounted
  // loop can't see) and writes straight to the card element.
  const hoverCardRef = useRef<HTMLDivElement>(null);
  const hoverIdRef = useRef<string | null>(null);
  // Mirror the layout radius into a ref so the rAF loop (mounted once) can
  // normalize each node's rotated depth without re-binding on population change.
  const radiusRef = useRef(radius);
  radiusRef.current = radius;
  // Mirror the hovered node id (suppressed while the menu is open) for the loop.
  hoverIdRef.current = hover && !menu ? hover.node.id : null;
  // Pending single-click timer, so a double-click can cancel the single action.
  const clickTimer = useRef<number | null>(null);

  // Live orbit/zoom state — held in refs (not React state) so the rAF loop can
  // mutate them without re-rendering. rotY orbits horizontally, rotX vertically.
  const rotX = useRef(-12);
  const rotY = useRef(0);
  const dolly = useRef(0); // translateZ of the whole scene (zoom)
  const dragging = useRef(false);

  const registerNode = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) nodeEls.current.set(id, el);
      else nodeEls.current.delete(id);
    },
    [],
  );

  // rAF loop: apply the scene rotation/zoom and billboard every node so cards
  // stay upright and face the camera regardless of orbit. Auto-spins gently
  // while the user isn't dragging.
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      // Panes stay mounted across scope switches; skip all work (and the spin)
      // while this one is hidden (display:none → no offsetParent).
      if (!viewportRef.current?.offsetParent) {
        raf = requestAnimationFrame(frame);
        return;
      }
      if (!dragging.current) rotY.current += AUTO_SPIN;
      const rx = rotX.current;
      const ry = rotY.current;
      const scene = sceneRef.current;
      // The scene stays untransformed and only anchors the cloud's center. We
      // project every node to 2D ourselves (below) instead of handing the scene
      // a rotate/translateZ and letting the browser project it: this WebKitGTK
      // build doesn't reliably honor nested `preserve-3d`, so each node's Z was
      // dropped and the sphere collapsed to a flat disc (WebView2 honored it, so
      // Windows looked correct).
      if (scene) scene.style.transform = "none";
      // Scene rotation Rx·Ry (matching the original CSS transform order). We
      // rotate each sphere point here and project it with a manual perspective
      // divide so the result is identical on every webview.
      const rxr = (rx * Math.PI) / 180;
      const ryr = (ry * Math.PI) / 180;
      const cx = Math.cos(rxr);
      const sx = Math.sin(rxr);
      const cy = Math.cos(ryr);
      const sy = Math.sin(ryr);
      const radius = radiusRef.current || 1;
      const dz = dolly.current; // zoom, applied as a Z offset before projection
      const hoverId = hoverIdRef.current;
      for (const [id, el] of nodeEls.current.entries()) {
        const x = Number(el.dataset.x) || 0;
        const y = Number(el.dataset.y) || 0;
        const z = Number(el.dataset.z) || 0;
        // Apply Ry then Rx to the sphere point. worldZ grows toward the viewer.
        const x1 = x * cy + z * sy;
        const z1 = -x * sy + z * cy;
        const screenY = y * cx - z1 * sx;
        const worldZ = y * sx + z1 * cx;
        // Perspective divide: nearer nodes (high worldZ) magnify and spread out,
        // farther ones shrink toward the center — the cue that turns a flat ring
        // of cards into a readable sphere. Clamp the denominator so a node never
        // crosses the camera plane and blows up.
        const f = PERSPECTIVE / Math.max(120, PERSPECTIVE - (worldZ + dz));
        const tx = x1 * f;
        const ty = screenY * f;
        // Depth-shade opacity (0 far … 1 near) on top of the size foreshortening;
        // zIndex keeps front cards above back ones.
        const t = Math.max(0, Math.min(1, (worldZ / radius + 1) / 2));
        el.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${f.toFixed(3)})`;
        el.style.opacity = (0.28 + t * 0.72).toFixed(3);
        el.style.zIndex = String(Math.round(worldZ));
        // Pin the hover card just off the node so it tracks the spin. The scene
        // is anchored at the viewport center, so the node's screen point is that
        // center plus its projected offset.
        if (id === hoverId && hoverCardRef.current && viewportRef.current) {
          const vp = viewportRef.current.getBoundingClientRect();
          const card = hoverCardRef.current;
          const cw = card.offsetWidth;
          const ch = card.offsetHeight;
          const px = vp.left + vp.width / 2 + tx + 70 * f + 14;
          const py = vp.top + vp.height / 2 + ty - 14;
          card.style.left = `${Math.min(Math.max(8, px), window.innerWidth - cw - 8)}px`;
          card.style.top = `${Math.min(Math.max(8, py), window.innerHeight - ch - 8)}px`;
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Pointer-drag to orbit. Movement beyond a small threshold marks the gesture a
  // drag (so the pointerup isn't treated as a node click).
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const baseRotX = rotX.current;
    const baseRotY = rotY.current;
    let moved = false;
    dragging.current = true;
    setHover(null);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 4) moved = true;
      rotY.current = baseRotY + dx * ROT_SENSITIVITY;
      // Clamp vertical orbit so the cloud never flips fully upside-down.
      rotX.current = Math.max(-85, Math.min(85, baseRotX - dy * ROT_SENSITIVITY));
    };
    const onUp = (ev: PointerEvent) => {
      dragging.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      (e.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId);
      // Suppress the click that follows a real drag so we don't also activate a
      // node the pointer happened to release over.
      if (moved) {
        const swallow = (c: MouseEvent) => {
          c.stopPropagation();
          c.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    dolly.current = Math.max(MIN_DOLLY, Math.min(MAX_DOLLY, dolly.current - e.deltaY * 0.6));
  }, []);

  // Open = make this project current (switches scope). Used by double-click and
  // the box single-click, and the menu's "Open".
  const openNode = useCallback(
    (node: BlobNode) => {
      if (node.kind === "project") void setActive(node.project.id);
      else void openBox(node.box.id);
    },
    [setActive, openBox],
  );

  const clearClickTimer = useCallback(() => {
    if (clickTimer.current !== null) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
  }, []);

  // Single click: boxes open immediately; an inactive project is activated; an
  // already-active/current project does nothing (open is the double-click). The
  // action is deferred briefly so a following double-click can cancel it.
  const onNodeClick = useCallback(
    (node: BlobNode) => {
      clearClickTimer();
      if (node.kind === "box") {
        openNode(node);
        return;
      }
      const { project } = node;
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = null;
        if (project.status === "inactive") void activateProject(project.id);
      }, DBL_CLICK_MS);
    },
    [openNode, activateProject, clearClickTimer],
  );

  const onNodeDoubleClick = useCallback(
    (node: BlobNode) => {
      clearClickTimer();
      openNode(node);
    },
    [openNode, clearClickTimer],
  );

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: BlobNode) => {
      if (node.kind !== "project") return;
      e.preventDefault();
      e.stopPropagation();
      clearClickTimer();
      setHover(null);
      setMenu({ x: e.clientX, y: e.clientY, project: node.project });
    },
    [clearClickTimer],
  );

  // Dismiss the context menu on any outside pointer (incl. an orbit drag start).
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [menu]);

  // Drop the pending single-click timer if the pane unmounts.
  useEffect(() => () => clearClickTimer(), [clearClickTimer]);

  if (nodes.length === 0) {
    return (
      <div className="blob-viewport blob-empty">
        <div className="blob-empty-card">No projects yet — create one to populate the cloud.</div>
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      className="blob-viewport"
      onPointerDown={onPointerDown}
      onWheel={onWheel}
    >
      <div className="blob-hint">
        Drag to orbit · scroll to zoom · click to activate · double-click to open · right-click for menu
      </div>
      <div className="blob-stage">
        <div ref={sceneRef} className="blob-scene">
          {nodes.map((node, i) => {
            const pos = positions[i] ?? { x: 0, y: 0, z: 0 };
            const base = `translate3d(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px, ${pos.z.toFixed(1)}px)`;
            const isProject = node.kind === "project";
            const status = isProject ? node.project.status : "box";
            const label = isProject ? node.project.name : node.box.name;
            const isActive = isProject && node.project.id === activeId;
            const memberCount = node.kind === "box" ? node.box.member_ids.length : 0;
            return (
              <div
                key={node.id}
                ref={registerNode(node.id)}
                data-x={pos.x.toFixed(1)}
                data-y={pos.y.toFixed(1)}
                data-z={pos.z.toFixed(1)}
                style={{ transform: base }}
                className={
                  `blob-node blob-node-${node.kind} blob-status-${status}` +
                  (isActive ? " blob-node-active" : "")
                }
                onPointerEnter={(e) => setHover({ x: e.clientX, y: e.clientY, node })}
                onPointerLeave={() =>
                  setHover((h) => (h?.node.id === node.id ? null : h))
                }
                onClick={(e) => {
                  e.stopPropagation();
                  onNodeClick(node);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onNodeDoubleClick(node);
                }}
                onContextMenu={(e) => onNodeContextMenu(e, node)}
              >
                <span className="blob-node-icon" aria-hidden>
                  {node.kind === "box" ? "▦" : status === "inactive" ? "○" : "●"}
                </span>
                <span className="blob-node-label">{label}</span>
                {node.kind === "box" && <span className="blob-node-sub">{memberCount}</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right-click menu for a project node. */}
      {menu && createPortal(
        <div
          className="context-menu blob-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              setMenu(null);
              void setActive(menu.project.id);
            }}
          >
            Open
          </button>
          {menu.project.status === "inactive" ? (
            <button
              onClick={() => {
                setMenu(null);
                void activateProject(menu.project.id);
              }}
            >
              Activate
            </button>
          ) : (
            <button
              onClick={() => {
                setMenu(null);
                void deactivateProject(menu.project.id);
              }}
            >
              Inactivate
            </button>
          )}
        </div>,
        document.body,
      )}

      {/* Hover info card: the node's description (or details), anchored near the
          pointer. Suppressed while the context menu is open. */}
      {hover && !menu && createPortal(
        <div
          ref={hoverCardRef}
          className="blob-hover-card"
          style={{
            left: Math.min(hover.x + 16, window.innerWidth - 320),
            top: Math.min(hover.y + 16, window.innerHeight - 200),
          }}
        >
          {hover.node.kind === "project" ? (
            <>
              <div className="blob-hover-title">{hover.node.project.name}</div>
              <div className="blob-hover-meta">{hover.node.project.status}</div>
              <div className="blob-hover-desc">
                {hover.node.project.description?.trim() || "No description yet."}
              </div>
              {hoverProjectId && activity[hoverProjectId] && (
                <div className="blob-hover-activity">
                  <ActivityCalendar data={activity[hoverProjectId]} />
                </div>
              )}
            </>
          ) : (
            <>
              <div className="blob-hover-title">{hover.node.box.name}</div>
              <div className="blob-hover-meta">
                Box · {hover.node.box.member_ids.length} project
                {hover.node.box.member_ids.length === 1 ? "" : "s"}
              </div>
            </>
          )}
          <div className="blob-hover-hint">Double-click to open</div>
        </div>,
        document.body,
      )}
    </div>
  );
}
