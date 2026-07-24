/**
 * Tests for the deck's coordinate transform (`lib/viewers/deck/transform`).
 *
 * This is the module most likely to be quietly wrong, because nothing else in the
 * repo does a bottom-left flip and there is no reference implementation to
 * compare against — the PDF viewer works entirely in pdf.js's already-flipped
 * viewport space. A sign error here puts every exported object in the wrong half
 * of the page, which is obvious in a rendered PDF and invisible in a diff.
 */

import { describe, it, expect } from "vitest";
import {
  fitSquare,
  parseColor,
  pdfPlacement,
  toPdfRect,
} from "../lib/viewers/deck/transform";

const PAGE_W = 400;
const PAGE_H = 200;

describe("toPdfRect", () => {
  it("flips y: the TOP of the deck is the HIGH y of the PDF", () => {
    // A box at the very top of the slide.
    const top = toPdfRect({ x: 0, y: 0, w: 0.5, h: 0.25 }, PAGE_W, PAGE_H);
    expect(top.top).toBe(200); // top edge = page top
    expect(top.y).toBe(150); // bottom edge = 200 - 50
    expect(top.h).toBe(50);

    // The same box at the very bottom.
    const bottom = toPdfRect({ x: 0, y: 0.75, w: 0.5, h: 0.25 }, PAGE_W, PAGE_H);
    expect(bottom.top).toBe(50);
    expect(bottom.y).toBe(0);
  });

  it("leaves x alone — only the vertical axis is flipped", () => {
    const r = toPdfRect({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 }, PAGE_W, PAGE_H);
    expect(r.x).toBe(100);
    expect(r.w).toBe(200);
  });

  it("keeps `top` and `y` exactly one height apart", () => {
    const r = toPdfRect({ x: 0.1, y: 0.3, w: 0.2, h: 0.4 }, PAGE_W, PAGE_H);
    expect(r.top - r.y).toBeCloseTo(r.h);
  });
});

describe("pdfPlacement", () => {
  const rect = toPdfRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, PAGE_W, PAGE_H);
  // → x 100..300, y 50..150, centre (200, 100).

  it("is the plain top-left corner when nothing is rotated", () => {
    const p = pdfPlacement(rect, 0);
    expect(p).toEqual({ x: 100, y: 150, rotate: 0 });
  });

  it("offsets INTO the box in y-down terms", () => {
    // 10pt right and 20pt DOWN from the box's top-left.
    const p = pdfPlacement(rect, 0, 10, 20);
    expect(p.x).toBe(110);
    expect(p.y).toBe(130); // down the slide = lower PDF y
  });

  it("negates the angle, because PDF rotates counter-clockwise", () => {
    expect(pdfPlacement(rect, 90).rotate).toBe(-90);
    expect(pdfPlacement(rect, -30).rotate).toBe(30);
  });

  it("rotates the anchor about the box's CENTRE, not about the corner", () => {
    // Worked by hand, in SCREEN terms, then flipped — which is the only way to
    // check this without a renderer.
    //
    // The box is 200 × 100 centred at screen (200, 100); its top-left corner is
    // at screen (100, 50). A quarter turn clockwise sends an offset (x, y) to
    // (−y, x), so (−100, −50) becomes (50, −100) and the corner lands at screen
    // (250, 0) — the top of a now 100 × 200 upright box. Flipped: PDF (250, 200).
    const p = pdfPlacement(rect, 90);
    expect(p.x).toBeCloseTo(250);
    expect(p.y).toBeCloseTo(200);
  });

  it("a half turn puts the origin diagonally opposite, through the centre", () => {
    const p = pdfPlacement(rect, 180);
    expect(p.x).toBeCloseTo(300);
    expect(p.y).toBeCloseTo(50);
  });

  it("a full turn is the identity", () => {
    const p = pdfPlacement(rect, 360);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(150);
  });

  it("preserves the distance from the centre for any angle", () => {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const d0 = Math.hypot(rect.x - cx, rect.top - cy);
    for (const deg of [17, 45, 123, 270, -88]) {
      const p = pdfPlacement(rect, deg);
      expect(Math.hypot(p.x - cx, p.y - cy)).toBeCloseTo(d0);
    }
  });
});

describe("parseColor", () => {
  it("reads the three hex lengths", () => {
    expect(parseColor("#000")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor("#ffffff")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    const half = parseColor("#00000080")!;
    expect(half.a).toBeCloseTo(128 / 255);
  });

  it("expands shorthand by doubling each digit", () => {
    expect(parseColor("#f00")).toEqual(parseColor("#ff0000"));
  });

  it("returns null for anything it cannot read, rather than a wrong colour", () => {
    expect(parseColor("red")).toBeNull();
    expect(parseColor("#12345")).toBeNull();
    expect(parseColor(undefined)).toBeNull();
  });
});

describe("fitSquare", () => {
  it("centres a square glyph box in a wide rect", () => {
    const r = toPdfRect({ x: 0, y: 0, w: 0.5, h: 0.5 }, 400, 200); // 200 × 100
    const f = fitSquare(r, 24);
    expect(f.scale).toBeCloseTo(100 / 24); // the SHORT side wins
    expect(f.offsetX).toBeCloseTo(50); // (200 - 100) / 2
    expect(f.offsetY).toBeCloseTo(0);
  });

  it("centres vertically in a tall rect", () => {
    const r = toPdfRect({ x: 0, y: 0, w: 0.25, h: 1 }, 400, 200); // 100 × 200
    const f = fitSquare(r, 24);
    expect(f.offsetX).toBeCloseTo(0);
    expect(f.offsetY).toBeCloseTo(50);
  });
});
