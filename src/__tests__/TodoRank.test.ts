import { describe, expect, it } from "vitest";

import {
  RANK_STEP,
  autoscrollDelta,
  currentSlot,
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

describe("currentSlot", () => {
  const column = [task({ id: "a" }), task({ id: "b" }), task({ id: "c" })];

  it("is the card's own position in the column", () => {
    expect(currentSlot(column, "a")).toBe(0);
    expect(currentSlot(column, "b")).toBe(1);
    expect(currentSlot(column, "c")).toBe(2);
  });

  it("appends a card the column does not hold", () => {
    expect(currentSlot(column, "gone")).toBe(3);
    expect(currentSlot([], "a")).toBe(0);
  });

  /**
   * The identity the whole gesture rests on: the drag's indices are counted with
   * the dragged card removed, so re-inserting a card at its own slot has to put
   * it back exactly where it was. If this ever stopped holding, the board would
   * open its drag on the wrong placeholder AND write a move for a drop that
   * changed nothing.
   */
  it("round-trips: removing a card and re-inserting it at its slot is a no-op", () => {
    for (const id of ["a", "b", "c"]) {
      const slot = currentSlot(column, id);
      const siblings = column.filter((t) => t.id !== id);
      const back = [...siblings];
      back.splice(slot, 0, column.find((t) => t.id === id)!);
      expect(back.map((t) => t.id)).toEqual(["a", "b", "c"]);
    }
  });

  /**
   * And the reason the dragged card is rendered *out* of its column: with it
   * left in, `insertionIndex` (measured against the other cards) and the
   * rendered list disagree by one for every slot below it — which is exactly the
   * "the placeholder is offering the card's current position" symptom.
   */
  it("indexes the same list the placeholder is drawn into", () => {
    const rects = [
      { top: 0, height: 40 }, // a
      { top: 40, height: 40 }, // c — b is the one being dragged
    ];
    const visible = column.filter((t) => t.id !== "b");
    // Below c's midpoint: the card goes last, after both siblings.
    const index = insertionIndex(rects, 70);
    expect(index).toBe(2);
    expect(index).toBe(visible.length);
    // And it is NOT b's own slot, so the drop is a real move.
    expect(index).not.toBe(currentSlot(column, "b"));
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
