/**
 * Tests for deck snapping (`lib/viewers/deck/snap`).
 *
 * This module gets the heaviest coverage in the feature for a specific reason: a
 * sign error in snapping is invisible in code review and infuriating in use. The
 * cases below pin the decisions rather than the arithmetic — that the threshold
 * is per-axis (a widescreen page makes a single scalar twice as grabby
 * vertically), that a resize handle only ever moves its own edges, that the
 * winner is the smallest *correction* rather than the nearest target, and that
 * every guide returned is one the result genuinely snapped to.
 */

import { describe, it, expect } from "vitest";
import {
  type SnapContext,
  MIN_SIZE,
  axisLock,
  snapMove,
  snapResize,
  thresholdFor,
} from "../lib/viewers/deck/snap";
import type { Box } from "../lib/viewers/deck/model";

const ctx = (over: Partial<SnapContext> = {}): SnapContext => ({
  others: [],
  margin: 0,
  threshold: { x: 0.02, y: 0.02 },
  enabled: true,
  ...over,
});

const box = (x: number, y: number, w = 0.2, h = 0.2): Box => ({ x, y, w, h });

describe("threshold", () => {
  it("is per-axis, so a widescreen page snaps evenly in both directions", () => {
    const t = thresholdFor(8, 1600, 900);
    expect(t.x).toBeCloseTo(0.005);
    expect(t.y).toBeCloseTo(8 / 900);
    expect(t.y).toBeGreaterThan(t.x); // the whole point
  });

  it("degrades to zero rather than dividing by zero before first layout", () => {
    expect(thresholdFor(8, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe("snapMove", () => {
  it("does nothing at all when suspended (Alt)", () => {
    const r = snapMove(box(0.001, 0.001), ctx({ enabled: false }));
    expect(r).toEqual({ x: 0.001, y: 0.001, guides: [] });
  });

  it("snaps the near edge to the page edge", () => {
    const r = snapMove(box(0.005, 0.005), ctx());
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(0);
    expect(r.guides.every((g) => g.kind === "page")).toBe(true);
  });

  it("snaps the CENTER to the page centre", () => {
    // Box is 0.2 wide, so centring puts its origin at 0.4.
    const r = snapMove(box(0.39, 0), ctx());
    expect(r.x).toBeCloseTo(0.4);
  });

  it("snaps the FAR edge to the page's far edge", () => {
    const r = snapMove(box(0.795, 0), ctx());
    expect(r.x).toBeCloseTo(0.8); // 0.8 + 0.2 = 1
  });

  it("picks the smallest correction, not the first or nearest target", () => {
    // The near edge is 0.015 from the page edge; the centre is 0.005 from 0.5.
    // The centre must win.
    const r = snapMove(box(0.395, 0), ctx({ threshold: { x: 0.05, y: 0.05 } }));
    expect(r.x).toBeCloseTo(0.4);
  });

  it("snaps to another object's edges and centre", () => {
    // Deliberately NOT at 0.5: an object edge sitting on the page centre is a
    // real tie, and the page target legitimately wins it (see below).
    const other = box(0.62, 0.5, 0.2, 0.2);
    const r = snapMove(box(0.625, 0), ctx({ others: [other] }));
    expect(r.x).toBeCloseTo(0.62);
    expect(r.guides.find((g) => g.axis === "x")?.kind).toBe("object");
  });

  it("reports the PAGE guide when an object edge happens to sit on it", () => {
    // Both targets are at 0.5 and the correction is identical, so which one is
    // 'the' reason is a genuine tie. Naming the page is the more useful answer,
    // and pinning it here stops the tie-break drifting silently.
    const r = snapMove(box(0.505, 0), ctx({ others: [box(0.5, 0.5, 0.2, 0.2)] }));
    expect(r.x).toBeCloseTo(0.5);
    expect(r.guides.find((g) => g.axis === "x")?.kind).toBe("page");
  });

  it("snaps to the safe margin when one is set", () => {
    const r = snapMove(box(0.045, 0), ctx({ margin: 0.05 }));
    expect(r.x).toBeCloseTo(0.05);
    expect(r.guides.find((g) => g.axis === "x")?.kind).toBe("margin");
  });

  it("leaves a far-away box completely alone", () => {
    const r = snapMove(box(0.333, 0.222), ctx());
    expect(r.x).toBe(0.333);
    expect(r.y).toBe(0.222);
    expect(r.guides).toEqual([]);
  });

  it("snaps to an equal gap — distribute-by-drag", () => {
    // a and b sit 0.1 apart. Dragging c near "0.1 after b" must lock to it.
    const a = box(0.0, 0, 0.1, 0.1);
    const b = box(0.2, 0, 0.1, 0.1); // gap a→b = 0.1
    const r = snapMove(box(0.395, 0, 0.1, 0.1), ctx({ others: [a, b] }));
    expect(r.x).toBeCloseTo(0.4); // 0.3 (b's right edge) + 0.1
    expect(r.guides.some((g) => g.kind === "spacing")).toBe(true);
  });

  it("ignores a 'gap' between two overlapping objects", () => {
    const a = box(0, 0, 0.5, 0.1);
    const b = box(0.2, 0, 0.5, 0.1); // overlaps a — negative gap
    const r = snapMove(box(0.333, 0.5, 0.1, 0.1), ctx({ others: [a, b] }));
    expect(r.guides.some((g) => g.kind === "spacing")).toBe(false);
  });

  it("returns a guide spanning both the moving box and what it aligned with", () => {
    const other = box(0.5, 0.8, 0.2, 0.1); // far below
    const r = snapMove(box(0.505, 0.1, 0.2, 0.1), ctx({ others: [other] }));
    const g = r.guides.find((gg) => gg.axis === "x")!;
    expect(g.from).toBeCloseTo(0.1); // top of the moving box
    expect(g.to).toBeCloseTo(0.9); // bottom of the other one
  });
});

describe("snapResize", () => {
  it("moves ONLY the edges its handle owns", () => {
    // The west edge is near 0, but we drag the east handle: x must not move.
    const r = snapResize(box(0.004, 0.3, 0.5, 0.2), "e", ctx());
    expect(r.box.x).toBeCloseTo(0.004);
  });

  it("snaps the dragged east edge to the page edge", () => {
    const r = snapResize(box(0.2, 0.3, 0.795, 0.2), "e", ctx());
    expect(r.box.x + r.box.w).toBeCloseTo(1);
    expect(r.box.x).toBeCloseTo(0.2);
  });

  it("snaps the dragged west edge without moving the east one", () => {
    const r = snapResize(box(0.004, 0.3, 0.5, 0.2), "w", ctx());
    expect(r.box.x).toBeCloseTo(0);
    expect(r.box.x + r.box.w).toBeCloseTo(0.504); // right edge held
  });

  it("snaps a corner on both axes at once", () => {
    const r = snapResize(box(0.2, 0.2, 0.795, 0.795), "se", ctx());
    expect(r.box.w).toBeCloseTo(0.8);
    expect(r.box.h).toBeCloseTo(0.8);
    expect(r.guides).toHaveLength(2);
  });

  it("snaps to ANOTHER object's exact width — same-size", () => {
    const other = box(0.5, 0.5, 0.3, 0.1);
    // Dragging east to a width of 0.295: the page targets are far away, so the
    // only thing in range is "same width as `other`".
    const r = snapResize(box(0.1, 0.1, 0.295, 0.1), "e", ctx({ others: [other] }));
    expect(r.box.w).toBeCloseTo(0.3);
    expect(r.guides.some((g) => g.kind === "size")).toBe(true);
  });

  it("never lets a handle invert or collapse the box", () => {
    const r = snapResize(box(0.5, 0.5, -0.4, 0), "e", ctx({ enabled: false }));
    expect(r.box.w).toBe(MIN_SIZE);
    expect(r.box.h).toBe(MIN_SIZE);
  });

  it("still clamps when snapping is suspended", () => {
    const r = snapResize(box(0.004, 0.3, 0.5, 0.2), "w", ctx({ enabled: false }));
    expect(r.box.x).toBe(0.004);
    expect(r.guides).toEqual([]);
  });
});

describe("axisLock", () => {
  it("keeps the dominant axis and zeroes the other", () => {
    expect(axisLock(0.3, 0.1)).toEqual({ dx: 0.3, dy: 0 });
    expect(axisLock(0.1, -0.3)).toEqual({ dx: 0, dy: -0.3 });
  });

  it("breaks an exact tie toward horizontal, deterministically", () => {
    expect(axisLock(0.2, 0.2)).toEqual({ dx: 0.2, dy: 0 });
  });
});
