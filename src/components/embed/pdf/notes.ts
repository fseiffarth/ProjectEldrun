/**
 * The PDF's own **remarks** — what every other reader calls a comment: a sticky note
 * (`/Text`) and a highlight over words (`/Highlight`).
 *
 * This is `links.ts`'s sibling: the same page, the same annotation array, the same
 * {@link SyncRect} space (big points from the page's top-left, after the turn the
 * viewer applied), read for different subtypes. A sticky note is one point on a page
 * plus some text — the annotation carries a rectangle, but a `/Text` annotation's rect
 * is only the icon's box, and pdf.js normalises it to a fixed 22pt square whenever the
 * note ships no appearance stream of its own, which is the ordinary case. A highlight
 * is the same thing over an *area*: its `/QuadPoints` are the boxes the marked words
 * sit in, one per line.
 *
 * Reading `/Highlight` is what the text layer bought. Until it existed this module
 * deliberately ignored the subtype, and said so: a highlight is painted by the page
 * render itself (pdf.js synthesises an appearance for one that ships none), so
 * surfacing it here as well would draw it twice — and there was no honest way to
 * *offer* one either, because a viewer with no text layer cannot know which words a
 * highlight would cover. Both halves of that are now answered: the words come from the
 * selection, and the doubling is settled by suppressing the file's own paint for a
 * highlight we have read (`/NoView` through pdf.js's annotation storage, keyed by the
 * {@link RawNoteAnnotation.id} kept on the remark as `srcId`), so exactly one thing on
 * screen is drawing each highlight and it is the one that can be clicked.
 *
 * The other markup annotations a PDF can carry — an underline, a strikeout, an ink
 * scribble, a stamp — are still left to the page render, and still have no editor.
 * That is not an oversight but the same rule as before: what this module reads is what
 * a save rewrites, and a subtype nobody here can edit is one a save must not touch.
 *
 * The write side of the same idea lives in {@link noteRectInPdfSpace},
 * {@link quadPointsInPdfSpace} and in `pdfDoc.ts`'s `buildPdf`, which is the only
 * place a PDF is written.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PdfNote, PdfQuad } from "../../../lib/viewers/pageModel";
import { newNoteId, quadsAnchor } from "../../../lib/viewers/pdfNotes";
import { rectFromAnnotation, type RectViewport } from "./links";

/**
 * The size of a sticky note's icon box, in PDF units.
 *
 * 22pt because that is what pdf.js normalises an appearance-less `/Text` annotation's
 * rect to, so a note read from a file and a note written by us occupy the same square
 * — and a save followed by a reload puts every marker back exactly where it was.
 */
export const NOTE_ICON_PT = 22;

/**
 * The default highlighter colour, as the 0..1 triple a PDF wants: the yellow a
 * highlighter pen is, which is what a reader expects a marked sentence to look like in
 * whatever opens the file next. The palette the selection bar offers is
 * {@link HIGHLIGHT_COLORS}.
 */
export const HIGHLIGHT_DEFAULT_COLOR: [number, number, number] = [1, 0.92, 0.23];

/**
 * The colours a highlight can be made in.
 *
 * Four rather than a picker, because a highlighter is a physical object with a handful
 * of colours and choosing one is a decision made mid-sentence: a full colour wheel
 * turns "mark this" into a dialog. They are the pen colours (yellow, green, blue,
 * pink) rather than the theme's accents, since they land on the document's white paper
 * and travel with the file into readers that know nothing about this app's theme.
 */
export const HIGHLIGHT_COLORS: readonly (readonly [number, number, number])[] = [
  HIGHLIGHT_DEFAULT_COLOR,
  [0.55, 0.9, 0.42],
  [0.45, 0.75, 1],
  [1, 0.6, 0.82],
];

/** The fields we read off a pdf.js annotation. A superset of `links.ts`'s, since a
 *  markup annotation carries an author, two dates, a colour and — for a highlight —
 *  the quads its marked words sit in. */
export interface RawNoteAnnotation {
  id?: string;
  subtype?: string;
  rect?: number[];
  name?: string;
  contentsObj?: { str?: string } | null;
  contents?: string;
  titleObj?: { str?: string } | null;
  creationDate?: string | null;
  modificationDate?: string | null;
  color?: Uint8ClampedArray | number[] | null;
  /** pdf.js normalises `/QuadPoints` to a flat run of 8 numbers per quad, in the
   *  order (x1 y1) top-left, (x2 y2) top-right, (x3 y3) bottom-left, (x4 y4)
   *  bottom-right — already sorted, whatever order the producer wrote them in. */
  quadPoints?: Float32Array | number[] | null;
}

/** A stored colour as the 0..1 triple a PDF wants; null for "the viewer's default". */
function noteColor(raw: RawNoteAnnotation["color"]): [number, number, number] | undefined {
  if (!raw || raw.length < 3) return undefined;
  return [raw[0] / 255, raw[1] / 255, raw[2] / 255];
}

/**
 * A highlight's `/QuadPoints` as boxes in the sheet's rotated space.
 *
 * Each quad is read as its own rectangle rather than the four corners being kept: a
 * `/Highlight` quad is a line of text, which is axis-aligned in every document that
 * has ever been produced, and pdf.js has already normalised the corner order — so a
 * rectangle loses nothing and is what every overlay in this viewer is drawn from. A
 * quad with no area is dropped, since some producers pad the array.
 */
export function quadsFromAnnotation(
  quadPoints: Float32Array | number[],
  viewport: RectViewport,
): PdfQuad[] {
  const out: PdfQuad[] = [];
  for (let i = 0; i + 7 < quadPoints.length; i += 8) {
    const xs = [quadPoints[i], quadPoints[i + 2], quadPoints[i + 4], quadPoints[i + 6]];
    const ys = [quadPoints[i + 1], quadPoints[i + 3], quadPoints[i + 5], quadPoints[i + 7]];
    const r = rectFromAnnotation(
      0,
      [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      viewport,
    );
    if (r.w <= 0 || r.h <= 0) continue;
    out.push({ x: r.x, y: r.y, w: r.w, h: r.h });
  }
  return out;
}

/**
 * One annotation as a remark, or null when it is not one. Pure — the viewport does
 * the geometry, exactly as it does for a link box.
 *
 * A note with no text at all is still returned: it is in the file, some producer put
 * it there, and hiding it would leave the reader unable to delete a marker they can
 * see in every other viewer. For a highlight that is not even unusual — a marked
 * sentence with nothing written about it is the common case.
 *
 * A `/Highlight` whose quads cannot be read is **not** returned, and that asymmetry is
 * deliberate: a sticky note without a usable rect could still be placed somewhere, but
 * a highlight is nothing except the words it covers. Returning one would put an
 * un-clickable, un-drawable remark into the list — and, worse, hand the save a
 * highlight to write with no quads at all.
 */
export function noteFromAnnotation(
  raw: RawNoteAnnotation,
  viewport: RectViewport,
): PdfNote | null {
  const isHighlight = raw.subtype === "Highlight";
  if (!isHighlight && raw.subtype !== "Text") return null;
  const quads = isHighlight && raw.quadPoints ? quadsFromAnnotation(raw.quadPoints, viewport) : [];
  if (isHighlight && quads.length === 0) return null;
  if (!isHighlight && (!Array.isArray(raw.rect) || raw.rect.length < 4)) return null;
  // `page` is irrelevant here (a note belongs to the sheet that renders it), so the
  // shared rect helper is fed a placeholder and only its x/y are kept. A highlight is
  // anchored at the start of its text rather than at its `/Rect`, which for a
  // multi-line one is the corner of a box the sentence does not begin in.
  const at = isHighlight ? quadsAnchor(quads) : rectFromAnnotation(0, raw.rect!, viewport);
  const text = raw.contentsObj?.str ?? raw.contents ?? "";
  const author = raw.titleObj?.str ?? undefined;
  const color = noteColor(raw.color);
  return {
    // The file's own annotation id is a document-scoped object reference; a remark's
    // id only has to be unique within its sheet and is rewritten on every save, so a
    // fresh one is minted rather than the reference carried around.
    id: newNoteId(),
    x: at.x,
    y: at.y,
    ...(isHighlight ? { quads } : {}),
    // pdf.js's own id for the annotation, kept for exactly one purpose: telling the
    // page render not to paint the file's copy of a highlight underneath ours.
    ...(isHighlight && raw.id ? { srcId: raw.id } : {}),
    text,
    ...(author ? { author } : {}),
    ...(raw.creationDate ? { created: raw.creationDate } : {}),
    ...(raw.modificationDate ? { modified: raw.modificationDate } : {}),
    ...(!isHighlight && raw.name && raw.name !== "NoIcon" ? { icon: raw.name } : {}),
    ...(color ? { color } : {}),
  };
}

/**
 * Every remark on one page — sticky notes and highlights alike — in the rotated space
 * the canvas is painted in.
 *
 * `rot` is the turn the *viewer* has applied to this sheet, added to the page's own
 * `/Rotate` exactly as the render does, so a marker lands on the spot it was placed
 * at however the sheet has since been turned. Best-effort, like the link read: a
 * document whose annotations cannot be parsed yields no remarks rather than failing
 * the page.
 */
export async function loadPageNotes(
  doc: PDFDocumentProxy,
  pageNumber: number,
  rot = 0,
): Promise<PdfNote[]> {
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({
      scale: 1,
      rotation: (((page.rotate + rot) % 360) + 360) % 360,
    });
    const raws = (await page.getAnnotations({ intent: "display" })) as RawNoteAnnotation[];
    return raws
      .map((raw) => noteFromAnnotation(raw, viewport))
      .filter((n): n is PdfNote => n != null);
  } catch {
    return [];
  }
}

/** The part of a pdf.js viewport the *write* side needs — the inverse of the read's,
 *  narrowed to one method so the geometry can be exercised without a real document. */
export interface PointViewport {
  convertToPdfPoint(x: number, y: number): number[];
}

/**
 * A remark's `/Rect` in the page's own user space, from its anchor in the sheet's
 * rotated space.
 *
 * Both corners are converted rather than one plus a size: at 90° or 270° the two axes
 * swap, so an anchor plus a width would put the icon box on the wrong side of the
 * anchor on a turned page. Normalised afterwards because a `/Rect` is given
 * lower-left then upper-right, and the conversion is free to hand back either.
 */
export function noteRectInPdfSpace(
  note: { x: number; y: number },
  viewport: PointViewport,
  size = NOTE_ICON_PT,
): [number, number, number, number] {
  const [ax, ay] = viewport.convertToPdfPoint(note.x, note.y);
  const [bx, by] = viewport.convertToPdfPoint(note.x + size, note.y + size);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

/** One quad in the page's own user space, as its normalised bounding box. Both
 *  corners are mapped for {@link noteRectInPdfSpace}'s reason — a quarter turn swaps
 *  the axes, and a box derived from one corner plus a size would land beside the
 *  words rather than on them. */
function quadInPdfSpace(q: PdfQuad, viewport: PointViewport): [number, number, number, number] {
  const [ax, ay] = viewport.convertToPdfPoint(q.x, q.y);
  const [bx, by] = viewport.convertToPdfPoint(q.x + q.w, q.y + q.h);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

/**
 * A highlight's `/QuadPoints`, in the flat 8-numbers-per-quad run the format asks for:
 * top-left, top-right, bottom-left, bottom-right.
 *
 * That corner order is the one thing worth being careful about here. The spec's own
 * wording describes the points counter-clockwise from the lower-left, and essentially
 * no real file follows it — every producer writes the order above, and every reader
 * (pdf.js included, see {@link RawNoteAnnotation.quadPoints}) normalises to it. A
 * highlight written the spec's way is drawn as a bow tie by half the readers in
 * existence, so the convention wins over the sentence.
 */
export function quadPointsInPdfSpace(
  quads: readonly PdfQuad[],
  viewport: PointViewport,
): number[] {
  const out: number[] = [];
  for (const q of quads) {
    const [x1, y1, x2, y2] = quadInPdfSpace(q, viewport);
    out.push(x1, y2, x2, y2, x1, y1, x2, y1);
  }
  return out;
}

/**
 * A highlight's `/Rect`: the box its quads all fit inside, in the page's own space.
 *
 * Derived from the converted quads rather than from their bounding box in screen
 * space, because a turned page maps a bounding box to a bounding box only if the
 * mapping is axis-aligned — which it is, but re-deriving it here keeps the two
 * numbers the file carries (`/Rect` and `/QuadPoints`) from being produced by two
 * different pieces of arithmetic that could drift apart.
 */
export function highlightRectInPdfSpace(
  quads: readonly PdfQuad[],
  viewport: PointViewport,
): [number, number, number, number] {
  if (quads.length === 0) return [0, 0, 0, 0];
  const boxes = quads.map((q) => quadInPdfSpace(q, viewport));
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}
