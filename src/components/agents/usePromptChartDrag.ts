import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { bindDragRelease, dragPlatform } from "../../lib/dragPlatform";
import type { PromptChartCard } from "../../lib/agentPromptChart";
import {
  timelineHitZone,
  type TimelineRect,
  type TimelineRects,
  type TimelineWindow,
  type TimelineZone,
} from "../../lib/agentPromptTimeline";

/** How far the pointer must travel before a press becomes a drag. */
export const PROMPT_DRAG_THRESHOLD = 5;

export type ChartDrag =
  | {
      kind: "card";
      card: PromptChartCard;
      /** Pointer position; the ghost is drawn at pointer minus grab offset. */
      x: number;
      y: number;
      grabDx: number;
      grabDy: number;
      width: number;
      height: number;
      zone: TimelineZone;
    }
  | {
      kind: "link";
      from: PromptChartCard;
      /** The port the line starts at. */
      x1: number;
      y1: number;
      x: number;
      y: number;
      overId: string | null;
    };

export interface ChartMeasure {
  rects: TimelineRects;
  /** The body's content width — the axis's pixel span. */
  width: number;
  scrollLeft: number;
}

export interface ChartCardRect {
  id: string;
  rect: TimelineRect;
}

interface Options {
  win: TimelineWindow;
  now: Date;
  /** The drop zones, read fresh on every move so a scrolling body stays true. */
  measure: () => ChartMeasure;
  /** Every card's rect, read once when a link drag starts. */
  measureCards: () => ChartCardRect[];
  onDropCard: (card: PromptChartCard, zone: TimelineZone) => void;
  onDropLink: (from: PromptChartCard, toId: string) => void;
}

/** Presses on these are the control's, never a drag's. */
const NO_DRAG = "button, input, textarea, select, a, .dropdown, [data-no-drag]";

/**
 * The chart's two gestures — carrying a card, pulling a link out of a port —
 * as one state machine, on the pattern `TodoBoard` settled for this engine:
 *
 * - **The release is bound at pointerdown**, synchronously, through
 *   `bindDragRelease`: WebKitGTK delivers `pointermove` but never the
 *   terminal event to a listener added mid-gesture, and it ends an ordinary
 *   drop with `pointercancel` rather than `pointerup`, which that binding
 *   turns into a commit where the engine means one.
 * - **Nothing moves until the threshold**, so a click is a click. The card
 *   that was pressed never moves at all: the ghost is drawn from this state,
 *   because the card can unmount mid-gesture when a write re-keys it.
 * - **Capture goes on `documentElement`** and only where the engine needs
 *   it — a capture target that unmounts drops the capture with a spurious
 *   cancel, and on Linux the implicit grab already delivers the release.
 * - **A commit with no zone does nothing**, which is what makes a cancel
 *   that commits safe: a card dropped over nothing stays where it was.
 *
 * Hit-testing reads rects the callers measured, never `elementFromPoint`, so
 * the same gesture runs under jsdom.
 */
export function usePromptChartDrag(options: Options) {
  const [drag, setDrag] = useState<ChartDrag | null>(null);
  const latest = useRef(options);
  latest.current = options;

  const start = (
    event: ReactPointerEvent<HTMLElement>,
    gesture: {
      begin: (pointer: PointerEvent) => ChartDrag;
      move: (current: ChartDrag, pointer: PointerEvent) => ChartDrag;
      commit: (current: ChartDrag) => void;
    },
  ) => {
    if (event.button !== 0) return;
    // Suppress the engine's own selection gesture, which otherwise hijacks
    // the pointer stream and ends it with a cancel mid-drag.
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const captureEl = document.documentElement;
    let current: ChartDrag | null = null;

    const onMove = (pointer: PointerEvent) => {
      if (!current) {
        if (Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < PROMPT_DRAG_THRESHOLD) return;
        if (dragPlatform.needsPointerCapture) {
          try {
            captureEl.setPointerCapture(pointerId);
          } catch {
            /* capture is an optimization; the gesture works without it */
          }
        }
        current = gesture.begin(pointer);
      } else {
        current = gesture.move(current, pointer);
      }
      setDrag(current);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      if (dragPlatform.needsPointerCapture) {
        try {
          captureEl.releasePointerCapture(pointerId);
        } catch {
          /* already released */
        }
      }
    };
    const onCommit = () => {
      cleanup();
      const finished = current;
      current = null;
      setDrag(null);
      // Never crossed the threshold: a click, and the card's own click handles it.
      if (finished) gesture.commit(finished);
    };
    const onAbort = () => {
      cleanup();
      current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    bindDragRelease({ onCommit, onAbort });
  };

  const onCardPointerDown = (card: PromptChartCard) => (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as Element).closest(NO_DRAG)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const zoneAt = (pointer: PointerEvent): TimelineZone => {
      const { win, now, measure } = latest.current;
      const measured = measure();
      return timelineHitZone({ x: pointer.clientX, y: pointer.clientY }, measured.rects, win, measured.width, measured.scrollLeft, now);
    };
    start(event, {
      begin: (pointer) => ({
        kind: "card",
        card,
        x: pointer.clientX,
        y: pointer.clientY,
        grabDx: event.clientX - rect.left,
        grabDy: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        zone: zoneAt(pointer),
      }),
      move: (current, pointer) => ({ ...current, x: pointer.clientX, y: pointer.clientY, zone: zoneAt(pointer) }),
      commit: (finished) => {
        if (finished.kind !== "card" || finished.zone.kind === "none") return;
        latest.current.onDropCard(finished.card, finished.zone);
      },
    });
  };

  const onPortPointerDown = (card: PromptChartCard) => (event: ReactPointerEvent<HTMLElement>) => {
    // The port sits inside the card, whose own pointerdown would start a carry.
    event.stopPropagation();
    const port = event.currentTarget.getBoundingClientRect();
    let cards: ChartCardRect[] = [];
    const over = (pointer: PointerEvent): string | null =>
      cards.find(({ id, rect }) =>
        id !== card.id
        && pointer.clientX >= rect.left && pointer.clientX <= rect.left + rect.width
        && pointer.clientY >= rect.top && pointer.clientY <= rect.top + rect.height)?.id ?? null;
    start(event, {
      begin: (pointer) => {
        cards = latest.current.measureCards();
        return {
          kind: "link",
          from: card,
          x1: port.left + port.width / 2,
          y1: port.top + port.height / 2,
          x: pointer.clientX,
          y: pointer.clientY,
          overId: over(pointer),
        };
      },
      move: (current, pointer) => ({ ...current, x: pointer.clientX, y: pointer.clientY, overId: over(pointer) }),
      commit: (finished) => {
        if (finished.kind !== "link" || !finished.overId) return;
        latest.current.onDropLink(finished.from, finished.overId);
      },
    });
  };

  return { drag, onCardPointerDown, onPortPointerDown };
}
