import { describe, expect, it } from "vitest";

import {
  RANK_STEP,
  autoscrollDelta,
  insertionIndex,
  orderedColumn,
  provisionalRank,
} from "../lib/todoBoard";
import type { CalendarTask } from "../types";

/**
 * Ordering and drag geometry.
 *
 * The gesture itself cannot be tested — jsdom has no layout, and the terminal
 * pointer event is the engine's — so what is tested instead is every pure thing
 * the gesture calls: where a drop lands, how the column sorts, and how the
 * autoscroll responds to a pointer near an edge.
 */

function task(over: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id: "t",
    calendar_id: "work",
    title: "t",
    priority: 0,
    percent: 0,
    ...over,
  };
}

describe("provisionalRank", () => {
  it("ranks the only card in a column", () => {
    expect(provisionalRank(null, null)).toBe(RANK_STEP);
  });

  it("appends below the last card", () => {
    expect(provisionalRank(2048, null)).toBe(2048 + RANK_STEP);
  });

  it("inserts above the first card", () => {
    expect(provisionalRank(null, 1024)).toBe(1024 - RANK_STEP);
  });

  it("bisects between two neighbours", () => {
    expect(provisionalRank(1024, 2048)).toBe(1536);
  });
});

describe("orderedColumn", () => {
  const today = "2026-07-08";

  it("puts ranked cards before unranked ones", () => {
    const out = orderedColumn(
      [task({ id: "unranked" }), task({ id: "ranked", rank: 5000 })],
      today,
    );
    expect(out.map((t) => t.id)).toEqual(["ranked", "unranked"]);
  });

  it("sorts ranked cards ascending", () => {
    const out = orderedColumn(
      [task({ id: "b", rank: 2048 }), task({ id: "a", rank: 1024 })],
      today,
    );
    expect(out.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("orders unranked cards overdue → due → priority", () => {
    // What a task arriving from the calendar's Tasks view gets, with nobody
    // having had to write it a rank.
    const out = orderedColumn(
      [
        task({ id: "undated" }),
        task({ id: "later", due: "2026-08-01" }),
        task({ id: "overdue", due: "2026-07-01" }),
        task({ id: "prio", priority: 1 }),
      ],
      today,
    );
    expect(out.map((t) => t.id)).toEqual(["overdue", "later", "prio", "undated"]);
  });

  it("breaks ties by id, never by array position", () => {
    // Array position changes whenever a card is deleted, so ordering by it would
    // make a tied column reshuffle for an unrelated reason.
    const a = orderedColumn([task({ id: "b", rank: 1 }), task({ id: "a", rank: 1 })]);
    const b = orderedColumn([task({ id: "a", rank: 1 }), task({ id: "b", rank: 1 })]);
    expect(a.map((t) => t.id)).toEqual(["a", "b"]);
    expect(b.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("insertionIndex", () => {
  const rects = [
    { top: 0, height: 40 },
    { top: 40, height: 40 },
    { top: 80, height: 40 },
  ];

  it("drops above the first card", () => {
    expect(insertionIndex(rects, 5)).toBe(0);
  });

  it("drops below the last card", () => {
    expect(insertionIndex(rects, 200)).toBe(3);
  });

  it("flips at a card's vertical midpoint", () => {
    expect(insertionIndex(rects, 59)).toBe(1);
    expect(insertionIndex(rects, 61)).toBe(2);
  });

  it("puts anything into an empty column at 0", () => {
    expect(insertionIndex([], 123)).toBe(0);
  });
});

describe("autoscrollDelta", () => {
  it("does nothing in the middle", () => {
    expect(autoscrollDelta(0, 500, 250)).toBe(0);
  });

  it("scrolls back near the near edge and forward near the far one", () => {
    expect(autoscrollDelta(0, 500, 10)).toBeLessThan(0);
    expect(autoscrollDelta(0, 500, 495)).toBeGreaterThan(0);
  });

  it("clamps at the maximum step", () => {
    expect(Math.abs(autoscrollDelta(0, 500, -400))).toBeLessThanOrEqual(18);
    expect(autoscrollDelta(0, 500, 900)).toBeLessThanOrEqual(18);
  });
});
