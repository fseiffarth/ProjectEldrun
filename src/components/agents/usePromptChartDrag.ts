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
    }
  | {
      /** A sent card pulled up or down its lane for a clearer view. */
      kind: "lift";
      /** The timeline item's key. */
      key: string;
      /** Pointer travel since the press, never above the body's top. */
      dy: number;
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
  onDropCard: (card: PromptChartCard, zone: TimelineZone, drag: Extract<ChartDrag, { kind: "card" }>) => void;
  onDropLink: (from: PromptChartCard, toId: string) => void;
  /** A lift ended: the item now sits `lift` px off its lane. */
  onLift: (key: string, lift: number) => void;
}

/** Presses on these are the control's, never a drag's. */
const NO_DRAG = "button, input, textarea, select, a, .dropdown, [data-no-drag]";

/** A lifted card travels with the pointer, so the release lands on it and the
 *  engine follows with a click that would toggle it open. That click belongs
 *  to the drag: swallow it, and only it — the listener is gone next task. */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

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
        swallowNextClick();
        latest.current.onDropCard(finished.card, finished.zone, finished);
      },
    });
  };

  /**
   * A sent card is history — its instant is not the reader's to change — but
   * where it sits in its column is: overlapping sessions stack lanes deep, and
   * the one being read is often under another. So it moves vertically only,
   * the card itself following the pointer (nothing is dropped anywhere, so no
   * ghost). The lane's own top and the item's drawn top are read off the item
   * wrapper `PromptTimeline` renders; the lift reported is measured from the
   * lane, so a card a repack pushed against the top edge has no dead zone.
   */
  const onLiftPointerDown = (key: string) => (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as Element).closest(NO_DRAG)) return;
    const item = event.currentTarget.closest<HTMLElement>("[data-lane-top]");
    if (!item) return;
    const top = parseFloat(item.style.top) || 0;
    const laneTop = Number(item.dataset.laneTop) || 0;
    const startY = event.clientY;
    const dyAt = (pointer: PointerEvent) => Math.max(-top, pointer.clientY - startY);
    start(event, {
      begin: (pointer) => ({ kind: "lift", key, dy: dyAt(pointer) }),
      move: (current, pointer) => (current.kind === "lift" ? { ...current, dy: dyAt(pointer) } : current),
      commit: (finished) => {
        if (finished.kind !== "lift") return;
        swallowNextClick();
        latest.current.onLift(key, top - laneTop + finished.dy);
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

  return { drag, onCardPointerDown, onLiftPointerDown, onPortPointerDown };
}
