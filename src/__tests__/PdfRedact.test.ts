/**
 * Blacking text out of a PDF (#pdf-redact).
 *
 * Two halves, and the second is the one that matters. The pure ops
 * (`lib/viewers/redact`) are tested as ordinary list transforms; the burn-in is
 * tested END TO END through pdf-lib — a real PDF with real text is built, marked,
 * saved, and the resulting bytes are searched for the string that was supposed to be
 * destroyed. That is the whole security claim of the feature, and a mock's call log
 * cannot make it. `buildPdf`'s rasteriser is injected here (jsdom has no canvas), so
 * what these assert is the document surgery, not the pixels.
 */
import { describe, it, expect } from "vitest";
import { PDFDocument, PDFArray, PDFRawStream, StandardFonts, decodePDFRawStream } from "pdf-lib";
import { buildPdf, type PdfSources, type PageRasterizer } from "../components/embed/pdf/pdfDoc";
import {
  SELF,
  initialPages,
  duplicatePages,
  movePages,
  isPristine,
  type PageList,
} from "../lib/viewers/pageModel";
import {
  rectFromDrag,
  isDraggedFar,
  snapToText,
  addMark,
  addMarks,
  removeMark,
  clearMarks,
  markCount,
  markedSheetCount,
  markMatches,
  marksOf,
} from "../lib/viewers/redact";
import type { SyncRect, TextItemBox } from "../lib/viewers/tex";

/** A one-line text run at (x, y), 10 points tall. */
const run = (str: string, x: number, y: number, w: number): TextItemBox => ({ str, x, y, w, h: 10 });

describe("drawing a mark", () => {
  it("normalises a drag made in any direction", () => {
    const downRight = rectFromDrag({ x: 10, y: 20 }, { x: 40, y: 60 });
    const upLeft = rectFromDrag({ x: 40, y: 60 }, { x: 10, y: 20 });
    expect(downRight).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(upLeft).toEqual(downRight);
  });

  it("treats a click as a click rather than a zero-size blackout", () => {
    expect(isDraggedFar(rectFromDrag({ x: 5, y: 5 }, { x: 6, y: 6 }))).toBe(false);
    expect(isDraggedFar(rectFromDrag({ x: 5, y: 5 }, { x: 50, y: 30 }))).toBe(true);
  });
});

describe("snapping a drawn box to the text under it", () => {
  const items = [run("Alice", 100, 200, 40), run("Bob", 200, 200, 30), run("Carol", 100, 400, 45)];

  it("grows a box that clips a word out to the whole word", () => {
    // Drawn short and shallow: it catches the middle of "Alice" only.
    const snapped = snapToText({ x: 110, y: 203, w: 10, h: 3 }, items, 0);
    expect(snapped).toEqual({ x: 100, y: 200, w: 40, h: 10 });
  });

  it("covers every run the box touches, and none it does not", () => {
    const snapped = snapToText({ x: 130, y: 202, w: 80, h: 4 }, items, 0);
    // Spans Alice→Bob; Carol is 200 points below and stays untouched.
    expect(snapped).toEqual({ x: 100, y: 200, w: 130, h: 10 });
  });

  it("only ever grows — a box drawn wider than the text keeps its own edges", () => {
    const drawn = { x: 50, y: 150, w: 400, h: 100 };
    expect(snapToText(drawn, items, 0)).toEqual(drawn);
  });

  it("leaves a box over a figure exactly as drawn", () => {
    const drawn = { x: 300, y: 600, w: 120, h: 90 };
    expect(snapToText(drawn, items)).toEqual(drawn);
  });
});

describe("marks on an arrangement", () => {
  it("makes the arrangement dirty, so a marked file can be saved at all", () => {
    const pages = initialPages(3);
    expect(isPristine(pages, 3)).toBe(true);
    expect(isPristine(addMark(pages, pages[0].id, { x: 1, y: 1, w: 10, h: 10 }), 3)).toBe(false);
  });

  it("travels with the page it was drawn on when pages are reordered", () => {
    const pages = initialPages(3);
    const marked = addMark(pages, pages[2].id, { x: 1, y: 1, w: 10, h: 10 });
    const moved = movePages(marked, [pages[2].id], 0);
    expect(moved[0].page).toBe(3);
    expect(marksOf(moved[0])).toHaveLength(1);
    expect(marksOf(moved[1])).toHaveLength(0);
  });

  it("is copied — not shared — when a page is duplicated", () => {
    const pages = initialPages(1);
    const marked = addMark(pages, pages[0].id, { x: 1, y: 1, w: 10, h: 10 });
    const twinned = duplicatePages(marked, [pages[0].id]);
    expect(twinned).toHaveLength(2);
    expect(marksOf(twinned[1])).toHaveLength(1);
    expect(twinned[0].marks).not.toBe(twinned[1].marks);
    // Removing one page's mark leaves its twin's alone.
    const half = removeMark(twinned, twinned[0].id, marksOf(twinned[0])[0].id);
    expect(marksOf(half[0])).toHaveLength(0);
    expect(marksOf(half[1])).toHaveLength(1);
  });

  it("counts areas and the pages they sit on separately", () => {
    let pages = initialPages(4);
    pages = addMarks(pages, pages[0].id, [
      { x: 0, y: 0, w: 5, h: 5 },
      { x: 9, y: 9, w: 5, h: 5 },
    ]);
    pages = addMark(pages, pages[2].id, { x: 0, y: 0, w: 5, h: 5 });
    expect(markCount(pages)).toBe(3);
    expect(markedSheetCount(pages)).toBe(2);
  });

  it("leaves a sheet pristine again once its last mark goes", () => {
    const pages = initialPages(2);
    const marked = addMark(pages, pages[0].id, { x: 1, y: 1, w: 4, h: 4 });
    const bare = removeMark(marked, pages[0].id, marksOf(marked[0])[0].id);
    expect(bare[0].marks).toBeUndefined();
    expect(isPristine(bare, 2)).toBe(true);
  });

  it("clears every page at once", () => {
    let pages = initialPages(3);
    pages = addMark(pages, pages[0].id, { x: 0, y: 0, w: 4, h: 4 });
    pages = addMark(pages, pages[1].id, { x: 0, y: 0, w: 4, h: 4 });
    expect(markCount(clearMarks(pages))).toBe(0);
  });
});

describe("blacking out every search hit", () => {
  const hits = (page: number, boxes: [number, number][]): SyncRect[][] =>
    boxes.map(([x, y]) => [{ page, x, y, w: 30, h: 10 }]);

  it("marks each hit on the sheet it was found on", () => {
    const pages = initialPages(3);
    const marked = markMatches(pages, new Map([[2, hits(2, [[10, 20], [10, 40]])]]), 0);
    expect(markCount(marked)).toBe(2);
    expect(marksOf(marked[1])[0]).toMatchObject({ x: 10, y: 20, w: 30, h: 10 });
    expect(marksOf(marked[0])).toHaveLength(0);
  });

  it("does not stack duplicates when run twice over the same hits", () => {
    const pages = initialPages(2);
    const byPage = new Map([[1, hits(1, [[10, 20]])]]);
    const once = markMatches(pages, byPage, 0);
    const twice = markMatches(once, byPage, 0);
    expect(markCount(twice)).toBe(1);
  });

  it("still marks a hit that an existing box only clips", () => {
    let pages = initialPages(1);
    // A hand-drawn box covering the left half of the hit: the rest is still legible,
    // so the hit needs its own.
    pages = addMark(pages, pages[0].id, { x: 10, y: 20, w: 15, h: 10 });
    const marked = markMatches(pages, new Map([[1, hits(1, [[10, 20]])]]), 0);
    expect(markCount(marked)).toBe(2);
  });
});

// ── The burn-in ─────────────────────────────────────────────────────────────

/** A 1×1 PNG — valid enough for pdf-lib to embed, which is all the stub raster
 *  needs to be. The real rasteriser paints the page and the black areas itself. */
const PNG_1X1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/** Stands in for the pdf.js/canvas rasteriser: records what it was asked to flatten
 *  and hands back a page-sized image. */
function stubRasterizer(): PageRasterizer & { calls: { page: number; marks: number }[] } {
  const calls: { page: number; marks: number }[] = [];
  const fn: PageRasterizer = async (_src, ref) => {
    calls.push({ page: ref.page, marks: ref.marks?.length ?? 0 });
    return { bytes: PNG_1X1, mime: "image/png", widthPt: 200, heightPt: 400 };
  };
  return Object.assign(fn, { calls });
}

/** A PDF whose pages carry a distinct, findable word each, and distinct widths so
 *  the page order of a rebuilt document can be read off the geometry. */
async function makeTextPdf(words: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  words.forEach((word, i) => {
    const page = doc.addPage([100 * (i + 1), 400]);
    page.drawText(word, { x: 20, y: 200, size: 24, font });
  });
  return doc.save();
}

/**
 * Every page's DECODED content stream, as text.
 *
 * Decoded rather than searched raw, because a copied page's stream comes across
 * Flate-compressed — and a grep over the compressed bytes would "find" nothing on a
 * page whose text is perfectly intact, which is the one false pass this file cannot
 * afford. What is asserted against these strings is whether the glyphs a redaction
 * was supposed to destroy are still in the document at all.
 */
async function pageContentText(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const decoder = new TextDecoder("latin1");
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((ref) => doc.context.lookup(ref))
        : [contents];
    const raw = streams
      .map((s) => (s instanceof PDFRawStream ? decoder.decode(decodePDFRawStream(s).decode()) : ""))
      .join("");
    // A shown string is written `<48656C6C6F> Tj`, so the words are hex in the
    // stream: spelled out, or a search for the redacted word would come back clean
    // from a page that still prints it in full.
    return raw.replace(/<([0-9A-Fa-f]+)>/g, (whole, hex: string) =>
      hex.length % 2 === 0
        ? (hex.match(/../g) ?? []).map((b) => String.fromCharCode(parseInt(b, 16))).join("")
        : whole,
    );
  });
}

/** Is the string anywhere in the document's page content at all? */
const documentContains = async (bytes: Uint8Array, needle: string) =>
  (await pageContentText(bytes)).some((text) => text.includes(needle));

const sourcesOf = (bytes: Uint8Array): PdfSources =>
  new Map([[SELF, { bytes, doc: undefined as never }]]);

describe("burning blackouts into the saved file", () => {
  it("removes the text of a marked page from the bytes entirely", async () => {
    const bytes = await makeTextPdf(["SECRETWORD", "PUBLICWORD"]);
    const pages = initialPages(2);

    // Unmarked, both words are in the written file — i.e. the check can see them,
    // so its later "gone" verdict means something.
    const plain = await buildPdf(pages, sourcesOf(bytes));
    expect(await documentContains(plain, "SECRETWORD")).toBe(true);
    expect(await documentContains(plain, "PUBLICWORD")).toBe(true);

    const marked: PageList = addMark(pages, pages[0].id, { x: 10, y: 180, w: 180, h: 40 });
    const out = await buildPdf(marked, sourcesOf(bytes), { rasterize: stubRasterizer() });

    // The marked page's text is gone — not covered, gone — and the untouched page
    // keeps its own.
    expect(await documentContains(out, "SECRETWORD")).toBe(false);
    expect(await documentContains(out, "PUBLICWORD")).toBe(true);

    // And what the flattened page holds instead is one image draw, with no text
    // operator left to extract from.
    const [flattened] = await pageContentText(out);
    expect(flattened).toContain("Do");
    expect(flattened).not.toContain("Tj");
  });

  it("flattens only the pages that carry a mark", async () => {
    const bytes = await makeTextPdf(["A", "B", "C"]);
    const pages = initialPages(3);
    const marked = addMark(pages, pages[1].id, { x: 0, y: 0, w: 50, h: 50 });
    const raster = stubRasterizer();

    const out = await buildPdf(marked, sourcesOf(bytes), { rasterize: raster });
    expect(raster.calls).toEqual([{ page: 2, marks: 1 }]);

    // Page order survives, and the flattened sheet takes the raster's page box while
    // its neighbours keep their own widths.
    const back = await PDFDocument.load(out);
    expect(back.getPages().map((p) => Math.round(p.getWidth()))).toEqual([100, 200, 300]);
  });

  it("keeps a flattened sheet in its arranged position", async () => {
    const bytes = await makeTextPdf(["A", "B", "C"]);
    const pages = initialPages(3);
    const marked = addMark(pages, pages[0].id, { x: 0, y: 0, w: 50, h: 50 });
    // Drag the marked page to the end.
    const moved = movePages(marked, [pages[0].id], 2);

    const out = await buildPdf(moved, sourcesOf(bytes), { rasterize: stubRasterizer() });
    const back = await PDFDocument.load(out);
    // 200 and 300 are copied through; the flattened sheet is the raster's 200×400
    // box and lands last, where the arrangement put it.
    expect(back.getPages().map((p) => Math.round(p.getWidth()))).toEqual([200, 300, 200]);
  });

  it("gives the flattened page no rotation of its own — the turn is in the pixels", async () => {
    const bytes = await makeTextPdf(["A"]);
    const pages = initialPages(1).map((p) => ({ ...p, rot: 90 as const }));
    const marked = addMark(pages, pages[0].id, { x: 0, y: 0, w: 50, h: 50 });

    const out = await buildPdf(marked, sourcesOf(bytes), { rasterize: stubRasterizer() });
    const back = await PDFDocument.load(out);
    expect(back.getPages()[0].getRotation().angle).toBe(0);
  });

  it("still refuses to write a page whose source is gone", async () => {
    const pages = addMark(initialPages(1), initialPages(1)[0].id, { x: 0, y: 0, w: 5, h: 5 });
    const orphan = pages.map((p) => ({ ...p, src: "gone" }));
    await expect(buildPdf(orphan, new Map(), { rasterize: stubRasterizer() })).rejects.toThrow(
      /no longer open/,
    );
  });
});
