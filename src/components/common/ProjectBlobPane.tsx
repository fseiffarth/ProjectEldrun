import { useCallback, useEffect, useMemo, useRef } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import type { ProjectBox, ProjectEntry } from "../../types";

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

/**
 * The "Projects" tab body: a navigable 3D cloud of every project and box. Drag
 * to orbit, scroll to zoom (dolly), click a node to jump to that project / open
 * that box. Inactive projects render dimmed so the at-a-glance status is clear.
 *
 * Rendered with CSS 3D transforms (no WebGL dependency). The orbit/zoom state
 * lives in refs and is written straight to the DOM in a rAF loop so a slow spin
 * and a 60fps drag never thrash React; the static node list renders once.
 */
export function ProjectBlobPane() {
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);
  const setActive = useProjectsStore((s) => s.setActive);
  const boxes = useBoxesStore((s) => s.boxes);
  const openBox = useBoxesStore((s) => s.openBox);

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
      if (scene) {
        scene.style.transform = `translateZ(${dolly.current}px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      }
      // Counter-rotate each node by the inverse scene rotation → net identity, so
      // the card billboards toward the viewer while its translate3d still rides
      // the sphere (parent rotation positions it).
      const billboard = `rotateY(${-ry}deg) rotateX(${-rx}deg)`;
      for (const el of nodeEls.current.values()) {
        const base = el.dataset.base;
        if (base) el.style.transform = `${base} ${billboard}`;
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

  const onNodeClick = useCallback(
    (node: BlobNode) => {
      if (node.kind === "project") void setActive(node.project.id);
      else void openBox(node.box.id);
    },
    [setActive, openBox],
  );

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
      <div className="blob-hint">Drag to orbit · scroll to zoom · click to open</div>
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
                data-base={base}
                style={{ transform: base }}
                className={
                  `blob-node blob-node-${node.kind} blob-status-${status}` +
                  (isActive ? " blob-node-active" : "")
                }
                title={isProject ? `${label} · ${status}` : `Box · ${label} (${memberCount})`}
                onClick={(e) => {
                  e.stopPropagation();
                  onNodeClick(node);
                }}
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
    </div>
  );
}
