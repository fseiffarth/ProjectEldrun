import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import type { PromptChartCard } from "../../lib/agentPromptChart";
import { useT } from "../../lib/i18n";
import type { ChartDrag } from "./usePromptChartDrag";

interface Point { x: number; y: number }
interface Layout { free: boolean; positions: Record<string, Point> }
export interface DraftBoardHandle { place: (id: string, x: number, y: number) => boolean }

function readLayout(key: string): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as Layout | null;
    const positions = Object.fromEntries(Object.entries(saved?.positions ?? {}).filter(([, point]) =>
      point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0));
    return { free: saved?.free === true, positions };
  } catch { return { free: false, positions: {} }; }
}

/** A view-only layout, scoped to the project. Moving a draft never assigns it
 * a time. The chart still owns the ports and every prompt/schedule write. */
export const PromptDraftBoard = forwardRef<DraftBoardHandle, {
  scope: string;
  cards: PromptChartCard[];
  drag: ChartDrag | null;
  renderCard: (card: PromptChartCard) => ReactNode;
  onLayout: () => void;
}>(function PromptDraftBoard({ scope, cards, drag, renderCard, onLayout }, ref) {
  const t = useT();
  const key = `eldrun.promptChart.drafts.${scope}`;
  const [layout, setLayout] = useState(() => readLayout(key));
  const canvas = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const columns = Math.max(1, Math.floor(width / 192));
  const pointOf = (id: string, index: number): Point => layout.positions[id] ?? { x: index % columns * 192 + 8, y: Math.floor(index / columns) * 152 + 8 };
  const clientPoint = (x: number, y: number): Point => {
    const rect = canvas.current?.getBoundingClientRect();
    return { x: Math.max(0, x - (rect?.left ?? 0)), y: Math.max(0, y - (rect?.top ?? 0)) };
  };
  useImperativeHandle(ref, () => ({
    place: (id, x, y) => {
      if (!layout.free) return false;
      const point = clientPoint(x, y);
      setLayout((value) => ({ ...value, positions: { ...value.positions, [id]: point } }));
      return true;
    },
  }));
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(layout)); } catch { /* retain it for this session */ }
    onLayout();
  }, [key, layout, onLayout]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth || 720));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = canvas.current;
    if (!node || !layout.free) return;
    const observer = new ResizeObserver(() => {
      setSizes(Object.fromEntries([...node.children].map((child) => {
        const slot = child as HTMLElement;
        const card = slot.firstElementChild as HTMLElement | null;
        return [slot.dataset.draftId, { width: card?.offsetWidth || 168, height: card?.offsetHeight || 120 }];
      })));
    });
    for (const slot of node.children) if (slot.firstElementChild) observer.observe(slot.firstElementChild);
    return () => observer.disconnect();
  }, [cards, layout.free]);

  const points = cards.map((card, index) => drag?.kind === "card" && drag.zone.kind === "strip" && drag.card.id === card.id
    ? clientPoint(drag.x - drag.grabDx, drag.y - drag.grabDy)
    : pointOf(card.id, index));
  return <>
    <div className="agent-prompt-draft-layout-bar">
      <button type="button" className={`agent-composer-chip${layout.free ? " active" : ""}`} aria-pressed={layout.free}
        onClick={() => setLayout((value) => ({ free: !value.free, positions: Object.fromEntries(cards.map((card, index) => [card.id, pointOf(card.id, index)])) }))}>
        {t("promptChart.freeLayout")}
      </button>
      <small>{t("promptChart.draftLayoutHint")}</small>
    </div>
    <small className="agent-prompt-completion-hint">{t("promptChart.completionHint")}</small>
    <div ref={viewport} className={layout.free ? "agent-prompt-draft-viewport" : undefined}>
      <div ref={canvas} data-testid="prompt-draft-board" className={layout.free ? "agent-prompt-draft-canvas" : "agent-prompt-drafts-row"}
        style={layout.free ? {
          width: Math.max(width, ...points.map((point, index) => point.x + (sizes[cards[index].id]?.width ?? 168) + 32)),
          height: Math.max(320, ...points.map((point, index) => point.y + (sizes[cards[index].id]?.height ?? 120) + 64)),
        } : undefined}>
        {cards.map((card, index) => layout.free
          ? <div key={card.key} data-draft-id={card.id} className="agent-prompt-draft-position" style={{ left: points[index].x, top: points[index].y }}>{renderCard(card)}</div>
          : renderCard(card))}
        {cards.length === 0 && <div className="file-tree-empty">{t("promptChart.noDrafts")}</div>}
      </div>
    </div>
  </>;
});
