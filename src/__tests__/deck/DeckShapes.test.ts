/**
 * `lib/viewers/deck/shapes.ts` — the deck's parametric geometry, as SVG path
 * data. The reason it is path data at all is the export: pdf-lib draws vector
 * art only through `drawSvgPath`, so the stage and the PDF must share one
 * geometry source. What is pinned here is that contract's consequences: every
 * generator emits only the path commands both renderers agree on, coordinates
 * stay in the object's own y-down box, float noise is trimmed, and the arrow
 * heads size from the stroke rather than the box.
 */
import { describe, expect, it } from "vitest";
import {
  arrowHeadPath,
  calloutPath,
  circlePath,
  ellipsePath,
  isClosedShape,
  lineAngle,
  linePath,
  rectPath,
  roundRectPath,
  shapePath,
} from "../../lib/viewers/deck/shapes";
import type { ShapeKind } from "../../lib/viewers/deck/model";

/** Path data made only of absolute M/L/C/Z commands and plain numbers — the
 *  subset pdf-lib's parser handles predictably (no `A` arcs, no relatives). */
const PDF_SAFE = /^M -?\d+(\.\d+)? -?\d+(\.\d+)?( [LC]( -?\d+(\.\d+)? -?\d+(\.\d+)?)+)*( Z)?$/;

/** Every coordinate pair in a path, in order. */
function points(path: string): Array<[number, number]> {
  const nums = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

const KINDS: ShapeKind[] = ["rect", "roundrect", "ellipse", "line", "arrow", "callout"];

describe("deck shapes — the pdf-lib contract", () => {
  it("every shape emits only absolute M/L/C/Z commands", () => {
    for (const kind of KINDS) {
      expect(shapePath(kind, 120, 80), kind).toMatch(PDF_SAFE);
    }
    expect(circlePath(10, 10, 4)).toMatch(PDF_SAFE);
    for (const head of ["arrow", "bar", "dot"] as const) {
      expect(arrowHeadPath(head, 50, 50, 0.3, 2), head).toMatch(PDF_SAFE);
    }
  });

  it("keeps every coordinate inside the object's own 0..w × 0..h box", () => {
    for (const kind of KINDS) {
      for (const [x, y] of points(shapePath(kind, 120, 80))) {
        expect(x, `${kind} x`).toBeGreaterThanOrEqual(0);
        expect(x, `${kind} x`).toBeLessThanOrEqual(120);
        expect(y, `${kind} y`).toBeGreaterThanOrEqual(0);
        expect(y, `${kind} y`).toBeLessThanOrEqual(80);
      }
    }
  });

  it("trims float noise to three decimals so exports diff cleanly", () => {
    const path = ellipsePath(10, 7);
    for (const n of path.match(/\d+\.\d+/g) ?? []) {
      expect(n.split(".")[1].length).toBeLessThanOrEqual(3);
    }
    // A width of 1/3 would otherwise print as 0.333333…
    expect(rectPath(1 / 3, 1)).toBe("M 0 0 L 0.333 0 L 0.333 1 L 0 1 Z");
  });

  it("a line has no interior; every other shape is closed and filled", () => {
    expect(isClosedShape("line")).toBe(false);
    expect(isClosedShape("arrow")).toBe(false);
    for (const kind of ["rect", "roundrect", "ellipse", "callout"] as const) {
      expect(isClosedShape(kind)).toBe(true);
      expect(shapePath(kind, 10, 10).endsWith(" Z")).toBe(true);
    }
    expect(linePath(10, 10).includes("Z")).toBe(false);
  });
});

describe("rect / roundrect", () => {
  it("a rect is the four corners, clockwise from the origin, closed", () => {
    expect(rectPath(30, 20)).toBe("M 0 0 L 30 0 L 30 20 L 0 20 Z");
  });

  it("a zero or negative radius degrades to a plain rect", () => {
    expect(roundRectPath(30, 20, 0)).toBe(rectPath(30, 20));
    expect(roundRectPath(30, 20, -1)).toBe(rectPath(30, 20));
  });

  it("the radius is a fraction of the SHORTER side and clamps at a half", () => {
    // 0.25 of the 20pt side = 5pt: the first straight edge starts at x=5.
    expect(roundRectPath(30, 20, 0.25).startsWith("M 5 0 L 25 0")).toBe(true);
    // Anything past 0.5 clamps: a 1.0 radius still yields a 10pt corner.
    expect(roundRectPath(30, 20, 1)).toBe(roundRectPath(30, 20, 0.5));
    expect(roundRectPath(30, 20, 0.5).startsWith("M 10 0 L 20 0")).toBe(true);
  });

  it("resizing keeps the look: the same fraction on a taller box uses the width", () => {
    // Shorter side is now the width (20), so the corner is still 5pt.
    expect(roundRectPath(20, 30, 0.25).startsWith("M 5 0 L 15 0")).toBe(true);
  });

  it("shapePath routes each kind to its generator", () => {
    expect(shapePath("rect", 30, 20)).toBe(rectPath(30, 20));
    expect(shapePath("roundrect", 30, 20, 0.2)).toBe(roundRectPath(30, 20, 0.2));
    expect(shapePath("ellipse", 30, 20)).toBe(ellipsePath(30, 20));
    expect(shapePath("line", 30, 20)).toBe(linePath(30, 20));
    expect(shapePath("arrow", 30, 20)).toBe(linePath(30, 20));
    expect(shapePath("callout", 30, 20, 0.2)).toBe(calloutPath(30, 20, 0.2));
  });
});

describe("ellipse / circle", () => {
  it("an ellipse starts at the top centre and touches all four box edges", () => {
    const path = ellipsePath(40, 20);
    expect(path.startsWith("M 20 0 ")).toBe(true);
    const pts = points(path);
    // The four on-curve points: top, right, bottom, left.
    expect(pts).toContainEqual([20, 0]);
    expect(pts).toContainEqual([40, 10]);
    expect(pts).toContainEqual([20, 20]);
    expect(pts).toContainEqual([0, 10]);
  });

  it("a circle is positioned by its centre, not its box", () => {
    const path = circlePath(50, 40, 10);
    const pts = points(path);
    expect(pts).toContainEqual([50, 30]);
    expect(pts).toContainEqual([60, 40]);
    expect(pts).toContainEqual([50, 50]);
    expect(pts).toContainEqual([40, 40]);
  });

  it("a circle in its own box is the same curve as a square ellipse, translated", () => {
    const fromEllipse = points(ellipsePath(20, 20)).map(([x, y]) => [x + 5, y + 5]);
    expect(points(circlePath(15, 15, 10))).toEqual(fromEllipse);
  });
});

describe("line / callout", () => {
  it("a line runs the box's diagonal so a corner drag aims it", () => {
    expect(linePath(30, 20)).toBe("M 0 0 L 30 20");
    expect(lineAngle(30, 20)).toBeCloseTo(Math.atan2(20, 30));
    expect(lineAngle(10, 0)).toBe(0);
    expect(lineAngle(0, 10)).toBeCloseTo(Math.PI / 2);
  });

  it("a callout's body stops at 78% and its tail reaches the box's bottom", () => {
    const path = calloutPath(100, 100, 0);
    const pts = points(path);
    // Tail tip at the very bottom, from the lower-left third.
    expect(pts).toContainEqual([22, 100]);
    // Body edge at 78.
    expect(pts).toContainEqual([40, 78]);
    expect(pts).toContainEqual([22, 78]);
    // Nothing on the body's baseline sits below the tail tip's y.
    expect(Math.max(...pts.map(([, y]) => y))).toBe(100);
  });

  it("a callout's corner radius is bounded by the body, not the whole height", () => {
    // Shorter side of (100 wide, 78 tall body) is 78; 0.5 → 39pt corner.
    expect(calloutPath(100, 100, 0.5).startsWith("M 39 0 L 61 0")).toBe(true);
  });
});

describe("arrow heads", () => {
  it("`none` draws nothing", () => {
    expect(arrowHeadPath("none", 10, 10, 0, 2)).toBe("");
  });

  it("sizes from the stroke width, so a longer line does not balloon its head", () => {
    // stroke 2 → s = 8: a right-pointing head at (100,50) spans back to x=92.
    expect(arrowHeadPath("arrow", 100, 50, 0, 2)).toBe("M 100 50 L 92 54 L 92 46 Z");
    // Twice the stroke, twice the head — the position is otherwise irrelevant.
    expect(arrowHeadPath("arrow", 100, 50, 0, 4)).toBe("M 100 50 L 84 58 L 84 42 Z");
  });

  it("rotates with the line's angle", () => {
    // Pointing straight down (π/2): the barbs sit ABOVE the tip, spread in x.
    const down = points(arrowHeadPath("arrow", 100, 50, Math.PI / 2, 2));
    expect(down[0]).toEqual([100, 50]);
    expect(down[1]).toEqual([96, 42]);
    expect(down[2]).toEqual([104, 42]);
  });

  it("a bar is a stroke across the line, a dot a small centred circle", () => {
    expect(arrowHeadPath("bar", 100, 50, 0, 2)).toBe("M 100 45.2 L 100 54.8");
    expect(arrowHeadPath("dot", 100, 50, 0, 2)).toBe(circlePath(100, 50, 2.8));
  });

  it("a zero stroke still yields a (tiny) head rather than NaN geometry", () => {
    const path = arrowHeadPath("arrow", 10, 10, 0, 0);
    expect(path).toMatch(PDF_SAFE);
    expect(path).not.toContain("NaN");
  });
});
