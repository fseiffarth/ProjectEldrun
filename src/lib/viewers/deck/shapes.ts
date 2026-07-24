/**
 * Parametric shape geometry for the deck — pure, and expressed as **SVG path
 * data** rather than SVG elements.
 *
 * That choice is forced by the export end: pdf-lib emits vector art through
 * `drawSvgPath`, which takes path data and nothing else — no `<rect>`, no
 * `<ellipse>`, no groups, no gradients. Generating paths here means the stage and
 * the PDF exporter draw from *one* geometry source, so a rounded corner can never
 * be 6pt on screen and 8pt in the export. It is also why the icon library is
 * single-path monochrome (`deck/icons.ts`): same renderer, same exporter.
 *
 * All coordinates are in the object's own box, `0,0` to `w,h`, with **y down**
 * (SVG's convention, and the deck's). The exporter flips to PDF's y-up once, at
 * the boundary, rather than every generator having to remember which way is up.
 */

import type { ArrowHead, ShapeKind } from "./model";

/** Turn a run of points into a path, optionally closed. */
function poly(pts: ReadonlyArray<readonly [number, number]>, close = false): string {
  if (pts.length === 0) return "";
  const [first, ...rest] = pts;
  const body = rest.map(([x, y]) => `L ${r(x)} ${r(y)}`).join(" ");
  return `M ${r(first[0])} ${r(first[1])} ${body}${close ? " Z" : ""}`;
}

/** Trim float noise so paths stay readable and diff cleanly in an export. */
function r(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * A cubic approximation of a quarter circle. The magic constant is the standard
 * circle-to-Bézier ratio: with control points at `k·radius` the curve deviates
 * from a true arc by <0.02%, which is invisible and avoids `A` arc commands that
 * pdf-lib's path parser handles less predictably than curves.
 */
const KAPPA = 0.5522847498307936;

export function rectPath(w: number, h: number): string {
  return poly(
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ],
    true,
  );
}

/** `radius` is a fraction of the shorter side, so a box keeps its look on resize. */
export function roundRectPath(w: number, h: number, radius: number): string {
  const rad = Math.min(Math.max(radius, 0), 0.5) * Math.min(w, h);
  if (rad <= 0) return rectPath(w, h);
  const c = rad * KAPPA;
  return [
    `M ${r(rad)} 0`,
    `L ${r(w - rad)} 0`,
    `C ${r(w - rad + c)} 0 ${r(w)} ${r(rad - c)} ${r(w)} ${r(rad)}`,
    `L ${r(w)} ${r(h - rad)}`,
    `C ${r(w)} ${r(h - rad + c)} ${r(w - rad + c)} ${r(h)} ${r(w - rad)} ${r(h)}`,
    `L ${r(rad)} ${r(h)}`,
    `C ${r(rad - c)} ${r(h)} 0 ${r(h - rad + c)} 0 ${r(h - rad)}`,
    `L 0 ${r(rad)}`,
    `C 0 ${r(rad - c)} ${r(rad - c)} 0 ${r(rad)} 0`,
    "Z",
  ].join(" ");
}

export function ellipsePath(w: number, h: number): string {
  const rx = w / 2;
  const ry = h / 2;
  const cx = rx;
  const cy = ry;
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  return [
    `M ${r(cx)} 0`,
    `C ${r(cx + ox)} 0 ${r(w)} ${r(cy - oy)} ${r(w)} ${r(cy)}`,
    `C ${r(w)} ${r(cy + oy)} ${r(cx + ox)} ${r(h)} ${r(cx)} ${r(h)}`,
    `C ${r(cx - ox)} ${r(h)} 0 ${r(cy + oy)} 0 ${r(cy)}`,
    `C 0 ${r(cy - oy)} ${r(cx - ox)} 0 ${r(cx)} 0`,
    "Z",
  ].join(" ");
}

/** A line across the box's diagonal — so dragging a corner aims it. */
export function linePath(w: number, h: number): string {
  return poly([
    [0, 0],
    [w, h],
  ]);
}

/**
 * A speech callout: a rounded box occupying the top ~80% with a tail dropping
 * from the lower-left third. The tail is part of the same path so fill and
 * stroke treat the whole thing as one shape rather than a box with a triangle
 * stuck on it.
 */
export function calloutPath(w: number, h: number, radius = 0.12): string {
  const bodyH = h * 0.78;
  const rad = Math.min(Math.max(radius, 0), 0.5) * Math.min(w, bodyH);
  const c = rad * KAPPA;
  const tailL = w * 0.22;
  const tailR = w * 0.4;
  return [
    `M ${r(rad)} 0`,
    `L ${r(w - rad)} 0`,
    `C ${r(w - rad + c)} 0 ${r(w)} ${r(rad - c)} ${r(w)} ${r(rad)}`,
    `L ${r(w)} ${r(bodyH - rad)}`,
    `C ${r(w)} ${r(bodyH - rad + c)} ${r(w - rad + c)} ${r(bodyH)} ${r(w - rad)} ${r(bodyH)}`,
    `L ${r(tailR)} ${r(bodyH)}`,
    `L ${r(tailL)} ${r(h)}`,
    `L ${r(tailL)} ${r(bodyH)}`,
    `L ${r(rad)} ${r(bodyH)}`,
    `C ${r(rad - c)} ${r(bodyH)} 0 ${r(bodyH - rad + c)} 0 ${r(bodyH - rad)}`,
    `L 0 ${r(rad)}`,
    `C 0 ${r(rad - c)} ${r(rad - c)} 0 ${r(rad)} 0`,
    "Z",
  ].join(" ");
}

/** The body path for a shape, in its own box. */
export function shapePath(
  shape: ShapeKind,
  w: number,
  h: number,
  radius = 0.12,
): string {
  switch (shape) {
    case "rect":
      return rectPath(w, h);
    case "roundrect":
      return roundRectPath(w, h, radius);
    case "ellipse":
      return ellipsePath(w, h);
    case "line":
    case "arrow":
      return linePath(w, h);
    case "callout":
      return calloutPath(w, h, radius);
  }
}

/** Whether a shape's path should be filled at all. A line has no interior. */
export function isClosedShape(shape: ShapeKind): boolean {
  return shape !== "line" && shape !== "arrow";
}

/**
 * A marker at `(x, y)` pointing along `angle` (radians).
 *
 * Sized from the stroke width rather than the object, so a head stays in
 * proportion to the line it terminates instead of ballooning when the arrow is
 * merely made longer.
 */
export function arrowHeadPath(
  head: ArrowHead,
  x: number,
  y: number,
  angle: number,
  strokeWidth: number,
): string {
  if (head === "none") return "";
  const s = Math.max(strokeWidth, 0.001) * 4;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  /** Rotate a point given in "along the line, across the line" space. */
  const at = (along: number, across: number): [number, number] => [
    x + along * cos - across * sin,
    y + along * sin + across * cos,
  ];
  switch (head) {
    case "arrow":
      return poly([at(0, 0), at(-s, s * 0.5), at(-s, -s * 0.5)], true);
    case "bar":
      return poly([at(0, -s * 0.6), at(0, s * 0.6)]);
    case "dot":
      return circlePath(x, y, s * 0.35);
  }
}

/** A circle centred on `(cx, cy)`, as curves. Used for the dot marker, which —
 *  unlike every other shape — is positioned by its centre, not its box. */
export function circlePath(cx: number, cy: number, rad: number): string {
  const o = rad * KAPPA;
  return [
    `M ${r(cx)} ${r(cy - rad)}`,
    `C ${r(cx + o)} ${r(cy - rad)} ${r(cx + rad)} ${r(cy - o)} ${r(cx + rad)} ${r(cy)}`,
    `C ${r(cx + rad)} ${r(cy + o)} ${r(cx + o)} ${r(cy + rad)} ${r(cx)} ${r(cy + rad)}`,
    `C ${r(cx - o)} ${r(cy + rad)} ${r(cx - rad)} ${r(cy + o)} ${r(cx - rad)} ${r(cy)}`,
    `C ${r(cx - rad)} ${r(cy - o)} ${r(cx - o)} ${r(cy - rad)} ${r(cx)} ${r(cy - rad)}`,
    "Z",
  ].join(" ");
}

/** The angle of a shape's line, for placing its end markers. */
export function lineAngle(w: number, h: number): number {
  return Math.atan2(h, w);
}
