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
  const bend = Math.max(24, Math.abs(y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
}

/**
 * The link overlay: one bezier per edge, from the source card's bottom port
 * to the target's top port, over rects measured from the registered card
 * nodes. `version` is the caller's way of saying the cards moved without
 * the links changing — a view switch, a drag that ended, a body that
 * scrolled — so the paths are re-measured.
 */
export function PromptChartLinks({
  rootRef,
  cardNodes,
  links,
  selectedId,
  preview,
  version,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  cardNodes: MutableRefObject<Map<string, HTMLElement>>;
  links: PromptLink[];
  selectedId: string | null;
  preview?: LinkPreview | null;
  version: number;
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
          x1: a.left + a.width / 2 - base.left,
          y1: a.bottom - base.top,
          x2: b.left + b.width / 2 - base.left,
          y2: b.top - base.top,
        }];
      }));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const node of cardNodes.current.values()) observer.observe(node);
    const scrollers = [root.closest(".prompt-chart-tab"), root.querySelector(".agent-prompt-timeline-body")];
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
