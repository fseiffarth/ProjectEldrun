/**
 * The PDF's own hyperlinks — the clickable boxes a LaTeX document ships when it
 * loads `hyperref`, plus the plain URL links any exporter writes.
 *
 * A PDF carries them as *link annotations*: a rectangle on a page plus an action.
 * Two actions are worth honouring here and they behave nothing alike:
 *
 *  - a **GoTo** — an internal destination. This is what `\ref`, `\eqref`,
 *    `\cite`, `\autoref`, a footnote mark and every table-of-contents row become,
 *    and it is by far the most common link in an academic PDF. It stays inside
 *    the document, so following one is a scroll and nothing leaves the app.
 *  - a **URI** — an outside address (`\url`, a DOI, an arXiv link). That one
 *    crosses the boundary, so it is confirmed before it is opened; the viewer
 *    treats a PDF as untrusted content like a mail body, because it is.
 *
 * Everything else an annotation can be (a form widget, a `Launch` action naming a
 * local program, a named action like `NextPage`, a `GoToR` into another file) is
 * deliberately *not* rendered. An un-rendered link is a link that does nothing;
 * a rendered one that opens a program is a hole.
 *
 * Rects are produced in **big points from the page's top-left** — the same
 * {@link SyncRect} space the SyncTeX highlight and the Ctrl+F hits use — so a
 * link box is positioned by the one existing `bigPointsToCssRect` and follows
 * zoom and page rotation for free.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { SyncRect } from "../../../lib/viewers/tex";
import { resolveDest, type PdfDest } from "./outline";

/**
 * What an internal link *is*, which is the only thing that decides its colour.
 *
 * `hyperref` colours a citation and a cross-reference differently for a reason a
 * reader feels immediately: a `\cite` goes to the bibliography and comes back,
 * a `\ref` goes to the thing being talked about. The viewer keeps that
 * distinction rather than painting every internal link one colour.
 */
export type PdfLinkRole = "ref" | "cite";

/** One clickable box on a page. */
export type PdfLink =
  /** Stays in this document: scroll to `dest`. */
  | { id: string; rect: SyncRect; kind: "internal"; role: PdfLinkRole; dest: PdfDest }
  /** Leaves the app: `url` is `http(s)` (or whatever `routeUri` will re-check). */
  | { id: string; rect: SyncRect; kind: "external"; url: string };

/** The part of a pdf.js viewport this module needs — narrowed to one method so
 *  the geometry can be exercised without a real document. */
export interface RectViewport {
  convertToViewportRectangle(rect: number[]): number[];
}

/** The fields we read off a pdf.js annotation. */
export interface RawAnnotation {
  id?: string;
  subtype?: string;
  rect?: number[];
  url?: string;
  dest?: string | unknown[] | null;
}

/**
 * An annotation's rectangle in big points from the page's top-left.
 *
 * The viewport does the real work — it already carries the page's crop-box
 * origin and the total rotation — so this only normalises the corners, which a
 * PDF is under no obligation to give in any particular order. Pure.
 */
export function rectFromAnnotation(
  page: number,
  rect: number[],
  viewport: RectViewport,
): SyncRect {
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);
  return {
    page,
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

/** A box too thin to hit, or one with no area at all, is not offered — some
 *  producers emit degenerate link rects and a 0×0 target is only ever a
 *  mis-click waiting to happen. */
const MIN_LINK_SIDE = 1.5;

/**
 * Resolved destinations, per open document.
 *
 * Every resolution is at least one worker round trip (`getDestination`, then
 * `getPageIndex`), and a bibliography page alone can carry a hundred links —
 * most of them, in a `hyperref` document, pointing at the same handful of
 * anchors. The cache is keyed by the destination as written, held weakly against
 * the document so it goes when the document is destroyed, and stores the
 * *promise* so two links resolving the same anchor in the same frame share one
 * round trip rather than racing to make two.
 */
const destCache = new WeakMap<PDFDocumentProxy, Map<string, Promise<PdfDest | null>>>();

function cachedDest(doc: PDFDocumentProxy, dest: string | unknown[]): Promise<PdfDest | null> {
  let byKey = destCache.get(doc);
  if (!byKey) destCache.set(doc, (byKey = new Map()));
  // A named destination is its own key; an explicit array is keyed by its
  // content, which is what makes two annotations on one anchor share an entry.
  const key = typeof dest === "string" ? `n:${dest}` : `e:${safeKey(dest)}`;
  let hit = byKey.get(key);
  if (!hit) byKey.set(key, (hit = resolveDest(doc, dest)));
  return hit;
}

/** A stable key for an explicit destination array. `JSON.stringify` is enough —
 *  the array holds a `{num, gen}` ref, a name object and numbers — but it is not
 *  worth an exception in a link click if a producer put something exotic in it. */
function safeKey(dest: unknown[]): string {
  try {
    return JSON.stringify(dest);
  } catch {
    return String(dest);
  }
}

/**
 * Every anchor `hyperref` writes for a bibliography entry. A citation's
 * destination is *named* — `cite.knuth1984`, or `Hy@cite.…` where the package
 * had to indirect — which is the only thing in the file that says a link is a
 * `\cite` rather than a `\ref`. An explicit destination array carries no name at
 * all, so it can only be answered "an ordinary cross-reference"; guessing
 * further from the target page (a bibliography is usually last) would colour a
 * `\ref` to the final appendix as a citation, which is worse than not trying.
 */
const CITE_DEST = /^(?:hy@)?cite[.:_]/i;

/** Which colour an internal link earns. Pure; a non-named destination is a ref. */
export function destRole(dest: string | unknown[] | null | undefined): PdfLinkRole {
  return typeof dest === "string" && CITE_DEST.test(dest) ? "cite" : "ref";
}

/**
 * Turn one annotation into a {@link PdfLink}, or null when it is not a link this
 * viewer will honour. Pure except for the destination lookup, which is the
 * document's own (`resolveDest`).
 *
 * `url` rather than `unsafeUrl` on purpose: pdf.js only fills `url` for an
 * address that passed its own scheme check, so a `javascript:` or `file:` action
 * arrives here with `url` unset and is dropped — before `routeUri`, which checks
 * again. Two gates, neither trusting the other.
 */
export async function linkFromAnnotation(
  doc: PDFDocumentProxy,
  page: number,
  raw: RawAnnotation,
  viewport: RectViewport,
  index: number,
): Promise<PdfLink | null> {
  if (raw.subtype !== "Link" || !Array.isArray(raw.rect) || raw.rect.length < 4) return null;
  const rect = rectFromAnnotation(page, raw.rect, viewport);
  if (rect.w < MIN_LINK_SIDE || rect.h < MIN_LINK_SIDE) return null;
  const id = `${page}:${raw.id ?? index}`;
  if (typeof raw.url === "string" && raw.url) {
    return { id, rect, kind: "external", url: raw.url };
  }
  if (raw.dest != null) {
    const dest = await cachedDest(doc, raw.dest);
    // An unresolvable destination is dropped rather than rendered inert: a box
    // that highlights under the cursor and then does nothing reads as a bug.
    if (dest) return { id, rect, kind: "internal", role: destRole(raw.dest), dest };
  }
  return null;
}

/**
 * Every link on one page, in the rotated space the canvas is painted in.
 *
 * `rot` is the turn the *viewer* has applied to this sheet, added to the page's
 * own `/Rotate` exactly as the render does, so the boxes land on the glyphs after
 * the page has been turned. Best-effort throughout: a document whose annotations
 * cannot be read yields no links rather than failing the page.
 */
export async function loadPageLinks(
  doc: PDFDocumentProxy,
  pageNumber: number,
  rot = 0,
): Promise<PdfLink[]> {
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({
      scale: 1,
      rotation: (((page.rotate + rot) % 360) + 360) % 360,
    });
    const raws = (await page.getAnnotations({ intent: "display" })) as RawAnnotation[];
    const links = await Promise.all(
      raws.map((raw, i) => linkFromAnnotation(doc, pageNumber, raw, viewport, i)),
    );
    return links.filter((l): l is PdfLink => l != null);
  } catch {
    return [];
  }
}

/**
 * Where a destination lands on its page, in big points from that page's top —
 * the number the scroller needs, and the reason {@link PdfDest} keeps `top` in
 * the file's own units: the conversion depends on the turn the viewer has applied
 * to the *target* sheet, which is known only here, at the jump.
 *
 * Null when the destination names no position (a whole-page `/Fit`) or the page
 * cannot be read — the caller then scrolls to the top of the page, which is what
 * every other jump in this viewer already does.
 */
export async function destTopInBigPoints(
  doc: PDFDocumentProxy,
  dest: PdfDest,
  rot = 0,
): Promise<number | null> {
  if (dest.top == null) return null;
  try {
    const page = await doc.getPage(dest.page);
    const viewport = page.getViewport({
      scale: 1,
      rotation: (((page.rotate + rot) % 360) + 360) % 360,
    });
    const [, y] = viewport.convertToViewportPoint(0, dest.top);
    return y;
  } catch {
    return null;
  }
}
