/**
 * Where the steering legend's key circles sit round its hub (`SteeringLegend`'s
 * `OrbitLegend`). Pure, so the geometry is testable without a layout engine.
 */

export interface Orbit {
  /** The hub centre's distance from the window's bottom edge. */
  bottom: number;
  scale: number;
  /** Per circle, in input order: diameter, centre relative to the hub centre
   *  (y up), the spoke's angle (radians, counter-clockwise from +x) and length. */
  circles: { d: number; x: number; y: number; phi: number; r: number }[];
}

export const HUB_R = 24;
export const HUB_BOTTOM = 18;
const EDGE = 10;
const GAP = 10;
const SPOKE = 22;
const MIN_D = 64;
const SPREAD = (170 * Math.PI) / 180;

/**
 * Each circle just holds its key list (the list's diagonal, so the rectangle
 * is inscribed), and the circles share one arc over the hub, spread over at
 * most 170° in input order, left to right. The arc grows until they fit side
 * by side; the hub rises when a low circle would cross the window's bottom
 * edge, and the whole fan scales down when the window is too narrow or short.
 */
export function orbitLayout(sizes: { w: number; h: number }[], vw: number, vh: number): Orbit {
  const d = sizes.map((s) => Math.max(MIN_D, Math.ceil(Math.hypot(s.w, s.h)) + 16));
  const sweep = (di: number, r: number) => 2 * Math.asin(Math.min(1, (di + GAP) / 2 / r));
  const need = (r: number) => d.reduce((sum, di) => sum + sweep(di, r), 0);
  let r = HUB_R + SPOKE + Math.max(0, ...d) / 2;
  while (need(r) > SPREAD) r *= 1.04;
  let at = Math.PI / 2 + need(r) / 2;
  const circles = d.map((di) => {
    const th = sweep(di, r);
    const phi = at - th / 2;
    at -= th;
    return { d: di, x: r * Math.cos(phi), y: r * Math.sin(phi), phi, r };
  });
  const bottom = Math.max(HUB_BOTTOM + HUB_R, ...circles.map((c) => EDGE + c.d / 2 - c.y));
  const wide = Math.max(HUB_R, ...circles.map((c) => Math.abs(c.x) + c.d / 2));
  const tall = Math.max(HUB_R, ...circles.map((c) => c.y + c.d / 2));
  const scale = Math.max(0.4, Math.min(1, (vw / 2 - EDGE) / wide, (vh - bottom - 48) / tall));
  return { bottom, scale, circles };
}
