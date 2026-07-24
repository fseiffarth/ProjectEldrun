/**
 * Snapping and alignment guides for the deck stage — pure, so the stage only has
 * to paint what it is told (`docs/deck_presenter_plan.md` §4).
 *
 * Two things about this module are load-bearing.
 *
 * **The threshold is per-axis.** Everything in a deck is normalized to the page
 * box, but a 16:9 page is not square — so one normalized unit is a different
 * number of screen pixels horizontally and vertically. A single scalar threshold
 * would make vertical snapping roughly twice as grabby as horizontal on a
 * widescreen deck, which reads as "the snapping is broken" long before anyone
 * works out why. Callers convert their pixel threshold once, per axis.
 *
 * **A guide is evidence, not decoration.** Every returned {@link Guide} is a line
 * the result actually snapped to, carrying the span it should be drawn over. If
 * the stage paints them faithfully, a snap that fires for the wrong reason is
 * visible immediately rather than being felt as vague misbehaviour — which is the
 * only practical defence against the sign errors this module is prone to.
 */

import type { Box } from "./model";

/** A line to paint, plus why it exists. */
export interface Guide {
  /** `"x"` = a vertical line at `at`; `"y"` = a horizontal one. */
  axis: "x" | "y";
  /** Normalized position of the line along `axis`. */
  at: number;
  /** The span to draw, along the *other* axis. */
  from: number;
  to: number;
  kind: "page" | "margin" | "object" | "spacing" | "size";
}

/** Per-axis snap radius, in normalized page units. */
export interface Threshold {
  x: number;
  y: number;
}

export interface SnapContext {
  /** Boxes to snap against. The caller excludes the selection itself. */
  others: readonly Box[];
  /** Safe-area inset as a fraction of the page. `0` disables margin targets. */
  margin: number;
  threshold: Threshold;
  /** `false` while Alt is held — snapping suspended, guides empty. */
  enabled: boolean;
}

/** Smallest box a resize may produce, so a handle can never invert or vanish. */
export const MIN_SIZE = 0.01;

interface Candidate {
  /** Where the moving anchor should end up. */
  at: number;
  kind: Guide["kind"];
}

/** Targets along one axis: page edges/center, margins, and every other box's
 *  near edge, center and far edge. */
function axisTargets(
  others: readonly Box[],
  margin: number,
  axis: "x" | "y",
): Candidate[] {
  const out: Candidate[] = [
    { at: 0, kind: "page" },
    { at: 0.5, kind: "page" },
    { at: 1, kind: "page" },
  ];
  if (margin > 0) {
    out.push({ at: margin, kind: "margin" }, { at: 1 - margin, kind: "margin" });
  }
  for (const o of others) {
    const lo = axis === "x" ? o.x : o.y;
    const len = axis === "x" ? o.w : o.h;
    out.push(
      { at: lo, kind: "object" },
      { at: lo + len / 2, kind: "object" },
      { at: lo + len, kind: "object" },
    );
  }
  return out;
}

/**
 * Equal-spacing targets: positions where the moving box would sit at the same
 * distance from a neighbour as some existing pair of boxes already are from each
 * other. This is distribute-by-drag, and it is the one snapping behaviour people
 * miss most when it is absent.
 *
 * `movingLen` is needed because placing the box to the *left* of a neighbour
 * positions its far edge, not its near one.
 */
function spacingTargets(
  others: readonly Box[],
  axis: "x" | "y",
  movingLen: number,
): Candidate[] {
  const lo = (o: Box) => (axis === "x" ? o.x : o.y);
  const len = (o: Box) => (axis === "x" ? o.w : o.h);
  const sorted = [...others].sort((a, b) => lo(a) - lo(b));

  const gaps = new Set<number>();
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = lo(sorted[i]) - (lo(sorted[i - 1]) + len(sorted[i - 1]));
    // A negative gap means the two overlap; there is no spacing to match.
    if (gap > 0) gaps.add(round(gap));
  }
  if (gaps.size === 0) return [];

  const out: Candidate[] = [];
  for (const o of sorted) {
    for (const gap of gaps) {
      out.push({ at: lo(o) + len(o) + gap, kind: "spacing" });
      out.push({ at: lo(o) - gap - movingLen, kind: "spacing" });
    }
  }
  return out;
}

/** Kill float noise so `0.1 + 0.2` and `0.3` are one gap, not two. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Best delta to apply along one axis.
 *
 * `anchors` are the moving box's own snap points on this axis (near edge, center,
 * far edge). The winner is the smallest correction across every (anchor, target)
 * pair — not the nearest *target*, which would let a far edge 1 px away lose to a
 * near edge 3 px away simply because the latter's target sorted first.
 */
function bestDelta(
  anchors: readonly number[],
  targets: readonly Candidate[],
  threshold: number,
): { delta: number; at: number; kind: Guide["kind"] } | null {
  let best: { delta: number; at: number; kind: Guide["kind"] } | null = null;
  for (const a of anchors) {
    for (const t of targets) {
      const delta = t.at - a;
      if (Math.abs(delta) > threshold) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) {
        best = { delta, at: t.at, kind: t.kind };
      }
    }
  }
  return best;
}

/** The span a guide should be drawn over: from the moving box out to whatever it
 *  aligned with, so the line visibly connects the two. */
function guideSpan(
  moving: Box,
  others: readonly Box[],
  axis: "x" | "y",
  at: number,
): { from: number; to: number } {
  // Along the OTHER axis.
  const lo = (b: Box) => (axis === "x" ? b.y : b.x);
  const hi = (b: Box) => (axis === "x" ? b.y + b.h : b.x + b.w);
  let from = lo(moving);
  let to = hi(moving);
  for (const o of others) {
    const oLo = axis === "x" ? o.x : o.y;
    const oLen = axis === "x" ? o.w : o.h;
    const touches =
      near(oLo, at) || near(oLo + oLen / 2, at) || near(oLo + oLen, at);
    if (!touches) continue;
    from = Math.min(from, lo(o));
    to = Math.max(to, hi(o));
  }
  return { from, to };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

export interface SnapResult {
  x: number;
  y: number;
  guides: Guide[];
}

/**
 * Snap a dragged box's position. `box` is where the pointer would put it; the
 * result is where it should actually go.
 */
export function snapMove(box: Box, ctx: SnapContext): SnapResult {
  if (!ctx.enabled) return { x: box.x, y: box.y, guides: [] };

  const guides: Guide[] = [];

  const xTargets = [
    ...axisTargets(ctx.others, ctx.margin, "x"),
    ...spacingTargets(ctx.others, "x", box.w),
  ];
  const yTargets = [
    ...axisTargets(ctx.others, ctx.margin, "y"),
    ...spacingTargets(ctx.others, "y", box.h),
  ];

  const bx = bestDelta([box.x, box.x + box.w / 2, box.x + box.w], xTargets, ctx.threshold.x);
  const by = bestDelta([box.y, box.y + box.h / 2, box.y + box.h], yTargets, ctx.threshold.y);

  const x = box.x + (bx?.delta ?? 0);
  const y = box.y + (by?.delta ?? 0);
  const snapped: Box = { ...box, x, y };

  if (bx) {
    guides.push({ axis: "x", at: bx.at, kind: bx.kind, ...guideSpan(snapped, ctx.others, "x", bx.at) });
  }
  if (by) {
    guides.push({ axis: "y", at: by.at, kind: by.kind, ...guideSpan(snapped, ctx.others, "y", by.at) });
  }
  return { x, y, guides };
}

/** Which handle is being dragged. */
export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface ResizeResult {
  box: Box;
  guides: Guide[];
}

/**
 * Snap a resize. Only the edges the handle actually moves are snapped — dragging
 * the east handle must never shift the west edge, however close a guide is.
 *
 * Beyond the ordinary edge targets this adds **same-size** snapping: matching
 * another object's exact width or height. Two boxes that are *nearly* the same
 * size read as a mistake, and nothing else in the UI makes them agree.
 */
export function snapResize(
  box: Box,
  handle: ResizeHandle,
  ctx: SnapContext,
): ResizeResult {
  const clamp = (b: Box): Box => ({
    x: b.x,
    y: b.y,
    w: Math.max(MIN_SIZE, b.w),
    h: Math.max(MIN_SIZE, b.h),
  });

  if (!ctx.enabled) return { box: clamp(box), guides: [] };

  const movesW = handle.includes("w");
  const movesE = handle.includes("e");
  const movesN = handle.includes("n");
  const movesS = handle.includes("s");

  const guides: Guide[] = [];
  let { x, y, w, h } = box;

  const xTargets = axisTargets(ctx.others, ctx.margin, "x");
  const yTargets = axisTargets(ctx.others, ctx.margin, "y");

  // Same-size candidates are expressed as a target for the moving edge, so they
  // flow through the same comparison as every other candidate and cannot win by
  // a different rule.
  const sizeX: Candidate[] = ctx.others.map((o) =>
    movesE ? { at: x + o.w, kind: "size" as const } : { at: x + w - o.w, kind: "size" as const },
  );
  const sizeY: Candidate[] = ctx.others.map((o) =>
    movesS ? { at: y + o.h, kind: "size" as const } : { at: y + h - o.h, kind: "size" as const },
  );

  if (movesW) {
    const b = bestDelta([x], [...xTargets, ...sizeX], ctx.threshold.x);
    if (b) {
      const right = x + w;
      x = b.at;
      w = right - x;
      guides.push({ axis: "x", at: b.at, kind: b.kind, ...guideSpan(box, ctx.others, "x", b.at) });
    }
  }
  if (movesE) {
    const b = bestDelta([x + w], [...xTargets, ...sizeX], ctx.threshold.x);
    if (b) {
      w = b.at - x;
      guides.push({ axis: "x", at: b.at, kind: b.kind, ...guideSpan(box, ctx.others, "x", b.at) });
    }
  }
  if (movesN) {
    const b = bestDelta([y], [...yTargets, ...sizeY], ctx.threshold.y);
    if (b) {
      const bottom = y + h;
      y = b.at;
      h = bottom - y;
      guides.push({ axis: "y", at: b.at, kind: b.kind, ...guideSpan(box, ctx.others, "y", b.at) });
    }
  }
  if (movesS) {
    const b = bestDelta([y + h], [...yTargets, ...sizeY], ctx.threshold.y);
    if (b) {
      h = b.at - y;
      guides.push({ axis: "y", at: b.at, kind: b.kind, ...guideSpan(box, ctx.others, "y", b.at) });
    }
  }

  return { box: clamp({ x, y, w, h }), guides };
}

/**
 * Constrain a drag to one axis (Shift). Applied to the *raw* delta before
 * snapping, so the locked axis cannot be reintroduced by a snap on the other one.
 */
export function axisLock(dx: number, dy: number): { dx: number; dy: number } {
  return Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0 } : { dx: 0, dy };
}

/**
 * Convert a pixel snap radius into normalized per-axis thresholds.
 * `pageW`/`pageH` are the page's rendered size in CSS px.
 */
export function thresholdFor(px: number, pageW: number, pageH: number): Threshold {
  return {
    x: pageW > 0 ? px / pageW : 0,
    y: pageH > 0 ? px / pageH : 0,
  };
}
