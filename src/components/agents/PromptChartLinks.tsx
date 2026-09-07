import { useEffect, useId, useState, type MutableRefObject, type RefObject } from "react";
import type { PromptLink } from "../../stores/agentPrompts";

interface Line { link: PromptLink; x1: number; y1: number; x2: number; y2: number }

export function PromptChartLinks({
  rootRef,
  cardNodes,
  links,
  selectedId,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  cardNodes: MutableRefObject<Map<string, HTMLElement>>;
  links: PromptLink[];
  selectedId: string | null;
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
    const scroll = root.closest(".agent-prompt-chart-scroll");
    scroll?.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      scroll?.removeEventListener("scroll", measure);
    };
  }, [cardNodes, links, rootRef]);
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
          d={`M ${x1} ${y1} C ${x1 + 30} ${y1}, ${x2 - 30} ${y2}, ${x2} ${y2}`}
          markerEnd={link.kind === "after" ? `url(#${marker})` : undefined}
        />
      ))}
    </svg>
  );
}
