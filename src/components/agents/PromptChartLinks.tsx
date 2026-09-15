import { useEffect, useId, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { PromptLink } from "../../stores/agentPrompts";

export interface Line { link: PromptLink; x1: number; y1: number; x2: number; y2: number }

/** How far from the drawn curve, in px, a right-click still hits the edge. */
const HIT_TOLERANCE = 6;
const HIT_SAMPLES = 24;

export interface LinkPreview {
  /** Client coordinates of the port the line starts at and the pointer. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: "related" | "after";
}

function path(x1: number, y1: number, x2: number, y2: number): string {
  const bend = Math.max(24, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * The edge whose drawn curve passes within a few px of a point (overlay
 * coordinates), nearest first. Measured against the same bezier `path` draws,
 * sampled as a polyline — the lines themselves take no pointer, so a press on
 * a card a line happens to cross stays the card's.
 */
export function linkAt(lines: Line[], x: number, y: number, tolerance = HIT_TOLERANCE): PromptLink | null {
  let best: { link: PromptLink; distance: number } | null = null;
  for (const { link, x1, y1, x2, y2 } of lines) {
    const bend = Math.max(24, Math.abs(x2 - x1) / 2);
    const cx1 = x1 + bend;
    const cx2 = x2 - bend;
    let prevX = x1;
    let prevY = y1;
    for (let step = 1; step <= HIT_SAMPLES; step += 1) {
      const t = step / HIT_SAMPLES;
      const u = 1 - t;
      const nextX = u * u * u * x1 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t * t * t * x2;
      const nextY = u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2;
      const distance = segmentDistance(x, y, prevX, prevY, nextX, nextY);
      if (distance <= tolerance && (!best || distance < best.distance)) best = { link, distance };
      prevX = nextX;
      prevY = nextY;
    }
  }
  return best?.link ?? null;
}

/**
 * The link overlay: one bezier per edge, from the source card's right port
 * to the target's left port — the axis is horizontal, so a link leaves in
 * the direction time runs — over rects measured from the registered card
 * nodes. `version` is the caller's way of saying the cards moved without
 * the links changing — a view switch, a drag that ended, a body that
 * scrolled — so the paths are re-measured.
 *
 * Each edge carries a handle at its midpoint (the one part of the overlay
 * that takes the pointer) which opens the edge's editor, and an `after`
 * edge's commands are written beside it, so a `/clear` between two prompts
 * is visible on the chart rather than only inside a card.
 *
 * A right-click on an edge — its handle or anywhere along the line — opens
 * `onMenu`. The line is hit-tested from the chart root rather than given a
 * wide invisible stroke, which would take presses away from the cards and
 * lanes it crosses.
 */
export function PromptChartLinks({
  rootRef,
  cardNodes,
  links,
  selectedId,
  preview,
  version,
  onEdit,
  onMenu,
  editLabel,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  cardNodes: MutableRefObject<Map<string, HTMLElement>>;
  links: PromptLink[];
  selectedId: string | null;
  preview?: LinkPreview | null;
  version: number;
  /** Open the edge's editor at a client point. */
  onEdit?: (link: PromptLink, x: number, y: number) => void;
  /** Open the edge's context menu at a client point. */
  onMenu?: (link: PromptLink, x: number, y: number) => void;
  editLabel?: string;
}) {
  const marker = `prompt-arrow-${useId().replace(/:/g, "")}`;
  const [lines, setLines] = useState<Line[]>([]);
  const latest = useRef({ lines, links, onMenu });
  latest.current = { lines, links, onMenu };
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onContextMenu = (event: MouseEvent) => {
      const { lines: drawn, links: all, onMenu: open } = latest.current;
      if (!open || event.defaultPrevented) return;
      const target = event.target as Element | null;
      const handleId = target?.closest?.("[data-link-id]")?.getAttribute("data-link-id");
      let link = handleId ? all.find((item) => item.id === handleId) ?? null : null;
      if (!link) {
        if (target?.closest?.("input, textarea, select, button, a")) return;
        for (const node of cardNodes.current.values()) if (target && node.contains(target)) return;
        const base = root.getBoundingClientRect();
        link = linkAt(drawn, event.clientX - base.left, event.clientY - base.top);
      }
      if (!link) return;
      event.preventDefault();
      open(link, event.clientX, event.clientY);
    };
    root.addEventListener("contextmenu", onContextMenu);
    return () => root.removeEventListener("contextmenu", onContextMenu);
  }, [cardNodes, rootRef]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const base = root.getBoundingClientRect();
      setLines(links.flatMap((link) => {
        const from = cardNodes.current.get(link.from);
        const to = cardNodes.current.get(link.to);
        if (!from || !to) return [];
        const a = from.getBoundingClientRect();
        const b = to.getBoundingClientRect();
        return [{
          link,
          x1: a.right - base.left,
          y1: a.top + a.height / 2 - base.top,
          x2: b.left - base.left,
          y2: b.top + b.height / 2 - base.top,
        }];
      }));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const node of cardNodes.current.values()) observer.observe(node);
    const scrollers = [root.closest(".prompt-chart-tab"), root.querySelector(".agent-prompt-timeline-body"), root.querySelector(".agent-prompt-draft-viewport")];
    for (const scroller of scrollers) scroller?.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      for (const scroller of scrollers) scroller?.removeEventListener("scroll", measure);
    };
  }, [cardNodes, links, rootRef, version]);
  const base = rootRef.current?.getBoundingClientRect();
  return (
    <svg className="agent-prompt-links" aria-hidden="true">
      <defs>
        <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      {lines.map(({ link, x1, y1, x2, y2 }) => (
        <path
          key={link.id}
          className={selectedId === link.from || selectedId === link.to ? "is-selected" : ""}
          d={path(x1, y1, x2, y2)}
          markerEnd={link.kind === "after" ? `url(#${marker})` : undefined}
        />
      ))}
      {onEdit && lines.map(({ link, x1, y1, x2, y2 }) => {
        // The bezier's control points mirror each other, so its t = ½ point
        // is the chord's midpoint.
        const commands = link.kind === "after" ? link.preface ?? [] : [];
        return (
          <g
            key={`handle:${link.id}`}
            className={`agent-prompt-link-handle${commands.length ? " has-commands" : ""}`}
            transform={`translate(${(x1 + x2) / 2} ${(y1 + y2) / 2})`}
            data-testid={`prompt-link-handle-${link.id}`}
            data-link-id={link.id}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); onEdit(link, event.clientX, event.clientY); }}
          >
            {editLabel && <title>{editLabel}</title>}
            <circle r={5} />
            {commands.length > 0 && <text x={9} y={3}>{commands.join(" · ")}</text>}
          </g>
        );
      })}
      {preview && base && (
        <path
          className="is-preview"
          d={path(preview.x1 - base.left, preview.y1 - base.top, preview.x2 - base.left, preview.y2 - base.top)}
          markerEnd={preview.kind === "after" ? `url(#${marker})` : undefined}
        />
      )}
    </svg>
  );
}
