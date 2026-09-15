import { useEffect, useId, useState, type MutableRefObject, type RefObject } from "react";
import type { PromptLink } from "../../stores/agentPrompts";

interface Line { link: PromptLink; x1: number; y1: number; x2: number; y2: number }

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
 */
export function PromptChartLinks({
  rootRef,
  cardNodes,
  links,
  selectedId,
  preview,
  version,
  onEdit,
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
  editLabel?: string;
}) {
  const marker = `prompt-arrow-${useId().replace(/:/g, "")}`;
  const [lines, setLines] = useState<Line[]>([]);
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
