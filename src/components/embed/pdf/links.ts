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
 * Nor is a link rendered where the page prints nothing to click. `hyperref`
 * writes an annotation per *frame* and beamer emits a *page* per overlay, so a
 * citation revealed halfway through a slide carries its link on the overlays
 * before it as well — a rectangle over blank paper, which this viewer, unlike
 * every reader that draws nothing, would paint. Two tests answer that, cheap
 * first: {@link coversText} against the page's glyphs, then, for the links it
 * cannot vouch for, `pageInk`'s raster against the page's own pixels — so a
 * clickable logo with no text under it is kept and a leftover over blank paper
 * is not.
 *
 * Rects are produced in **big points from the page's top-left** — the same
 * {@link SyncRect} space the SyncTeX highlight and the Ctrl+F hits use — so a
 * link box is positioned by the one existing `bigPointsToCssRect` and follows
 * zoom and page rotation for free.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { SyncRect, TextItemBox } from "../../../lib/viewers/tex";
import { resolveDest, type PdfDest } from "./outline";
import { pageTextItemBoxesUnturned } from "./pageText";
import { pageInkAt } from "./pageInk";

/**
 * What an internal link *is*, which is the only thing that decides its colour.
 *
 * `hyperref` colours a citation and a cross-reference differently for a reason a
 * reader feels immediately: a `\cite` goes to the bibliography and comes back,
 * a `\ref` goes to the thing being talked about. The viewer keeps that
 * distinction rather than painting every internal link one colour.
 *
 * `nav` is the third and it is not a colour but the absence of one — a link that
 * is the document's own **chrome** rather than something written in its text.
 */
export type PdfLinkRole = "ref" | "cite" | "nav";

/** One clickable box on a page. */
export type PdfLink =
  /** Stays in this document: scroll to `dest`. */
  | { id: string; rect: SyncRect; kind: "internal"; role: PdfLinkRole; dest: PdfDest }
  /** Leaves the app: `url` is `http(s)` (or whatever `routeUri` will re-check). */
  | { id: string; rect: SyncRect; kind: "external"; url: string };

/** The part of a pdf.js viewport this module needs — narrowed to one method so
 *  the geometry can be exercised without a real document. pdf.js dropped the
 *  rectangle form of this conversion in 6.x, so the two corners are mapped
 *  separately here and reassembled below, exactly as it used to do. */
export interface RectViewport {
  convertToViewportPoint(x: number, y: number): number[];
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
  const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
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
 * How much of a glyph a link box has to touch before it counts as sitting on
 * text, in big points, in each axis independently.
 *
 * Deliberately small — about a third of a small glyph — because the job here is
 * to tell "lands on the words" from "lands on nothing at all", not to score how
 * well a producer aligned its rectangle. A link whose box is a line off is still
 * a link; only one with no ink underneath it anywhere is a phantom.
 */
const TEXT_TOUCH_BP = 1;

/** Do these two boxes overlap by at least `TEXT_TOUCH_BP` in both axes? */
function touches(rect: SyncRect, item: TextItemBox): boolean {
  const ox = Math.min(rect.x + rect.w, item.x + item.w) - Math.max(rect.x, item.x);
  const oy = Math.min(rect.y + rect.h, item.y + item.h) - Math.max(rect.y, item.y);
  return ox >= TEXT_TOUCH_BP && oy >= TEXT_TOUCH_BP;
}

/**
 * Is there text under this link box? — the cheap half of the test that keeps a
 * **beamer** deck from wearing citation-green blobs on blank paper.
 *
 * `hyperref` writes its annotations per *frame*, while beamer emits one *page*
 * per overlay, so a `\cite` revealed on overlay 3 still carries its link
 * annotation on overlays 1 and 2 — where the citation mark is not printed at
 * all. Every other reader gets away with this because it draws nothing for a
 * link; this viewer paints one, so the file's own bookkeeping showed up as two
 * green boxes floating in the middle of an otherwise empty slide. The same shape
 * of leftover comes out of `\only`, a `\pause`d table row, and any macro that
 * hides content the reference machinery has already been told about.
 *
 * A `false` here is deliberately **not** a verdict, only a failure to answer
 * from the text: a clickable logo and a figure carrying an `\href` have no
 * glyphs under them either, and both are content rather than leftovers. Those
 * links go on to `pageInk`'s raster, which asks whether the page draws anything
 * there at all — so nothing is dropped on the strength of this test alone.
 *
 * Pure.
 */
export function coversText(rect: SyncRect, items: readonly TextItemBox[]): boolean {
  return items.some((it) => touches(rect, it));
}

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

/**
 * Beamer's navigation anchor — the one link family in a slide deck that is
 * *furniture* rather than something the author wrote.
 *
 * A beamer theme hyperlinks its own chrome: the running title in the footer, the
 * little navigation-symbol bar, the section strip along the top. Every one of
 * them targets `Navigation<n>`, and there are as many as there are pages — 56 of
 * the 131 links in a 57-slide deck, on the same two centimetres of every single
 * sheet. Painting those is the layer arguing with the theme: the deck already
 * shows the running title in its own link colour, the marks say nothing that is
 * not already true on every page, and the reader gets a coloured bar under the
 * footer of all 57 slides in exchange for nothing.
 *
 * Read off the anchor name and nothing else, exactly as {@link CITE_DEST} is —
 * the same bargain: a producer convention is the only thing in the file that
 * says what a link *is*, and guessing instead from where the box sits on the
 * page ("near the bottom edge, therefore furniture") would unpaint a real
 * footnote in a two-column paper.
 */
const NAV_DEST = /^navigation\d+$/i;

/** Which colour an internal link earns — or, for `nav`, that it earns none. Pure;
 *  a non-named destination is a ref. */
export function destRole(dest: string | unknown[] | null | undefined): PdfLinkRole {
  if (typeof dest !== "string") return "ref";
  if (NAV_DEST.test(dest)) return "nav";
  return CITE_DEST.test(dest) ? "cite" : "ref";
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
 *
 * Links that land on nothing are dropped — the leftovers a `hyperref` document
 * carries on a beamer overlay that does not print the mark. The test is in two
 * stages, and the split is what makes it both cheap and safe to be wrong about:
 * {@link coversText} admits every link sitting on a glyph, which is nearly all of
 * them and costs one text read; only the remainder reaches `pageInk`'s raster,
 * which asks whether the page draws *anything* there — so a clickable logo or a
 * figure with an `\href` keeps working, and a page whose links all sit on text
 * never rasterises at all.
 *
 * Every failure keeps the link. A text read that throws, a page that cannot be
 * rasterised, a build with no DOM: this is a filter over artifacts, not a second
 * gate on what may be clicked, and it may only ever drop a link it has positive
 * evidence against.
 *
 * Both stages run in the page's **own unturned space**, against rects measured
 * there, because "does the page show anything under this annotation?" is a
 * question about the page rather than about the turn the viewer has applied to
 * it — and because the text runs are only true to the glyphs in that space
 * ({@link pageTextItemBoxesUnturned}).
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
    const built = await Promise.all(
      raws.map((raw, i) => linkFromAnnotation(doc, pageNumber, raw, viewport, i)),
    );
    // Each surviving link keeps the annotation it came from, so the two tests below
    // can re-measure its rect in the unturned space without re-reading them.
    const links = raws
      .map((raw, i) => ({ raw, link: built[i] }))
      .filter((p): p is { raw: RawAnnotation; link: PdfLink } => p.link != null);
    if (links.length === 0) return [];
    const all = () => links.map((p) => p.link);
    let items: TextItemBox[];
    try {
      items = await pageTextItemBoxesUnturned(doc, pageNumber);
    } catch {
      return all();
    }
    const flat = page.getViewport({ scale: 1, rotation: 0 });
    // A link exists at all only if `linkFromAnnotation` accepted its rect, so the
    // fallback here is unreachable except for a shape that never produced one.
    const rects = links.map(({ raw }) =>
      Array.isArray(raw.rect) && raw.rect.length >= 4
        ? rectFromAnnotation(pageNumber, raw.rect, flat)
        : null,
    );
    const onText = rects.map((r) => r == null || coversText(r, items));
    if (onText.every(Boolean)) return all();

    // The remainder is adjudicated against the page's own pixels — one raster,
    // answering every candidate on the sheet at once.
    const candidates = rects.filter((r, i): r is SyncRect => r != null && !onText[i]);
    const ink = await pageInkAt(doc, pageNumber, candidates);
    if (!ink) return all();
    let next = 0;
    return links.filter((_, i) => onText[i] || ink[next++]).map((p) => p.link);
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
