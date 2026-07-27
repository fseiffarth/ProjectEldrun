/**
 * The one place the deck's coordinates become PDF coordinates.
 *
 * Everything in a deck is **normalized, y-down, measured from the page's top-left**
 * — the same frame the browser and pdf.js use. A PDF is **absolute points, y-up,
 * measured from the bottom-left**. Nothing in this repo did that flip before (the
 * PDF viewer works entirely in pdf.js's already-flipped viewport space), so it is
 * written here once, isolated and unit-tested, rather than inline in the exporter
 * where a sign error would be invisible.
 *
 * Rotation is the subtle half. `DeckObject.rot` is degrees **clockwise as seen on
 * the slide**; PDF's positive rotation is **counter-clockwise**, so the exported
 * angle is negated. And pdf-lib rotates a drawing about the anchor point it is
 * given, not about the object's centre — so to spin an object in place, the
 * anchor must be moved to wherever the object's origin *lands* after the
 * rotation. {@link pdfPlacement} does both.
 */

/** A deck object's box, normalized to the page (0..1, y-down from top-left). */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A box in PDF points, y-up from the bottom-left. */
export interface PdfRect {
  /** Left edge. */
  x: number;
  /** **Bottom** edge — the PDF origin corner. */
  y: number;
  w: number;
  h: number;
  /** Top edge, i.e. `y + h`. The anchor a y-down drawing starts from. */
  top: number;
}

/** Normalized, y-down → absolute points, y-up. */
export function toPdfRect(r: NormRect, pageW: number, pageH: number): PdfRect {
  const w = r.w * pageW;
  const h = r.h * pageH;
  const x = r.x * pageW;
  // The flip. `r.y` measures down from the top, so the box's TOP edge is at
  // `pageH - r.y*pageH`, and its bottom is one height further down.
  const top = pageH - r.y * pageH;
  return { x, y: top - h, w, h, top };
}

export interface Placement {
  /** Anchor to hand pdf-lib, in PDF points. */
  x: number;
  y: number;
  /** Rotation to hand pdf-lib, in degrees (counter-clockwise positive). */
  rotate: number;
}

/**
 * Where to anchor a **y-down** drawing (an SVG path, a line of text, an image)
 * so that it lands rotated about the object's own centre.
 *
 * `originX`/`originY` are the drawing's start point *within* the object's box, in
 * points, measured y-down from the box's top-left — `(0, 0)` for a path or an
 * image, and `(indent, baselineOffset)` for a line of text.
 */
export function pdfPlacement(
  rect: PdfRect,
  rotDeg: number,
  originX = 0,
  originY = 0,
): Placement {
  // The drawing's start point, unrotated, in PDF space.
  const px = rect.x + originX;
  const py = rect.top - originY;

  // PDF rotation is counter-clockwise; the deck's is clockwise on screen.
  const rotate = -rotDeg;
  if (rotDeg === 0) return { x: px, y: py, rotate: 0 };

  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const rad = (rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - cx;
  const dy = py - cy;
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
    rotate,
  };
}

/** `#rgb` / `#rrggbb` / `#rrggbbaa` → components in 0..1, plus alpha. */
export function parseColor(
  hex: string | undefined,
): { r: number; g: number; b: number; a: number } | null {
  if (!hex) return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  const r = parseInt(s.slice(0, 2), 16) / 255;
  const g = parseInt(s.slice(2, 4), 16) / 255;
  const b = parseInt(s.slice(4, 6), 16) / 255;
  const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

/**
 * The scale and offset that fit a square `unit`-sized glyph box into `rect`,
 * centred — the `preserveAspectRatio="xMidYMid meet"` the icon renderer uses,
 * spelled out so the export places an icon exactly where the stage showed it.
 */
export function fitSquare(
  rect: PdfRect,
  unit: number,
): { scale: number; offsetX: number; offsetY: number } {
  const side = Math.min(rect.w, rect.h);
  return {
    scale: side / unit,
    offsetX: (rect.w - side) / 2,
    offsetY: (rect.h - side) / 2,
  };
}
