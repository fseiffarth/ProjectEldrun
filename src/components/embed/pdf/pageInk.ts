/**
 * Does the page draw anything here? — asked of the page's own pixels.
 *
 * The link layer's first question is cheap and textual: is there a glyph under
 * this annotation ({@link coversText})? That answers nearly every link in a
 * paper, and it is what tells a real `\cite` from the phantom `hyperref` leaves
 * on a beamer overlay that does not print the mark. What it cannot answer is the
 * *other* kind of link with no text under it — a clickable logo, a figure
 * carrying a `\href` to a dataset — which is content, not a leftover, and must
 * keep working.
 *
 * So the links the text test rejects are adjudicated here, against a raster of
 * the page. The alternative was to walk pdf.js's operator list and track the
 * transform stack well enough to bound every image and path; that is a small
 * renderer, written against internals that move between pdf.js releases, to
 * answer a question a renderer already answers. Rasterising is more work per
 * page and immune to all of it.
 *
 * The cost is paid only where the question is actually open: a page whose links
 * all sit on text — every page of an ordinary paper — never rasterises anything,
 * and a page that does rasterises **once** for all of its candidates. The worst
 * case is a beamer theme with a navigation bar, where every page carries a strip
 * of drawn-not-typeset links; even there the probe is one 72 dpi raster of a
 * page the viewer is already painting at display scale, and only for the pages
 * near the viewport, since that is the only place links are read at all.
 */
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { SyncRect } from "../../../lib/viewers/tex";

/** 72 dpi. The probe is looking for a figure, a rule or a logo — things drawn at
 *  a size a reader can see — so page units are resolution enough, and one page at
 *  this scale is a fraction of what the viewer is already painting on screen. */
const INK_SCALE = 1;

/** A ceiling for a poster-sized page, so the probe's canvas cannot grow without
 *  bound. Below it the whole page is rasterised at {@link INK_SCALE}. */
const INK_MAX_PIXELS = 4_000_000;

/** How far outside the link box the probe looks, in device pixels.
 *
 * This margin is what separates a logo from blank paper. A link over a
 * flat-coloured mark would be *uniform* inside its own box and so read as empty;
 * reaching a little past the edge catches the boundary between the mark and the
 * paper around it, which is exactly what makes the thing visible to a reader in
 * the first place. */
const INK_MARGIN_PX = 3;

/** How far two samples may drift and still count as the same colour. Covers a
 *  renderer's antialiasing and a JPEG's noise without swallowing anything a
 *  reader would see as a separate mark. */
const INK_TOLERANCE = 6;

/**
 * For each rect, is anything drawn under it? — `null` when the question could not
 * be put at all (no DOM canvas, a render that failed), which the caller must read
 * as "keep the link": a probe that cannot answer may not be the thing that drops
 * a link.
 *
 * Rects are in the page's own **unturned** space, in big points from the top
 * left — the space {@link coversText} works in, and the one a question about the
 * page rather than about the viewer's turn belongs in.
 */
export async function pageInkAt(
  doc: PDFDocumentProxy,
  pageNumber: number,
  rects: readonly SyncRect[],
): Promise<boolean[] | null> {
  if (rects.length === 0) return [];
  if (typeof document === "undefined") return null;
  let canvas: HTMLCanvasElement | null = null;
  let page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | null = null;
  try {
    page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1, rotation: 0 });
    const fit = Math.sqrt(INK_MAX_PIXELS / (base.width * base.height * INK_SCALE * INK_SCALE));
    const scale = fit < 1 ? INK_SCALE * fit : INK_SCALE;
    const viewport = page.getViewport({ scale, rotation: 0 });

    canvas = document.createElement("canvas");
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    // A page carries no background of its own; without this, "blank" would be
    // transparent black and every unpainted region would read as ink.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    // DISABLE, and this is the whole point of the probe: the annotations are what
    // is on trial. A link with a border, or a highlight the file draws itself,
    // would otherwise paint into the very pixels being asked whether that link
    // has anything under it — an annotation vouching for its own existence.
    await page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      annotationMode: pdfjs.AnnotationMode.DISABLE,
    }).promise;

    return rects.map((r) => regionHasInk(ctx, r, scale, width, height));
  } catch {
    return null;
  } finally {
    // Free the backing store rather than waiting for the collector: this canvas is
    // page-sized and one is made per probed page.
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    // …and the page's parse with it. The probe's render decoded every image on
    // the sheet into the page object, exactly as the thumbnail's does, and a
    // probe is asked once per page per document — nothing is coming back for
    // that cache. pdf.js refuses the cleanup while the main view is painting
    // the same page, which is the one case it must not disturb.
    page?.cleanup();
  }
}

/** Is the box — plus {@link INK_MARGIN_PX} of the paper around it — anything but
 *  one flat colour? Pixels, so it judges the page the way its reader does. */
function regionHasInk(
  ctx: CanvasRenderingContext2D,
  rect: SyncRect,
  scale: number,
  width: number,
  height: number,
): boolean {
  const x0 = Math.max(0, Math.floor(rect.x * scale) - INK_MARGIN_PX);
  const y0 = Math.max(0, Math.floor(rect.y * scale) - INK_MARGIN_PX);
  const x1 = Math.min(width, Math.ceil((rect.x + rect.w) * scale) + INK_MARGIN_PX);
  const y1 = Math.min(height, Math.ceil((rect.y + rect.h) * scale) + INK_MARGIN_PX);
  // Wholly off the sheet: there is no paper there to have anything drawn on it.
  if (x1 <= x0 || y1 <= y0) return false;
  const { data } = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  return !isFlat(data);
}

/** Every pixel the same colour, within {@link INK_TOLERANCE}. Exported for the
 *  tests, which can compare buffers where jsdom cannot render a page. */
export function isFlat(data: Uint8ClampedArray | readonly number[]): boolean {
  if (data.length < 8) return true;
  const [r, g, b, a] = [data[0], data[1], data[2], data[3]];
  for (let i = 4; i < data.length; i += 4) {
    if (
      Math.abs(data[i] - r) > INK_TOLERANCE ||
      Math.abs(data[i + 1] - g) > INK_TOLERANCE ||
      Math.abs(data[i + 2] - b) > INK_TOLERANCE ||
      Math.abs(data[i + 3] - a) > INK_TOLERANCE
    ) {
      return false;
    }
  }
  return true;
}
