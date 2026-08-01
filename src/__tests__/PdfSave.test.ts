/**
 * Tests for the one place a PDF is actually written (`components/embed/pdf/pdfDoc`).
 *
 * These run pdf-lib end to end in memory — real PDFs are built, saved, and read back
 * — so what is asserted is the bytes' actual page order, size and rotation, not a
 * mock's call log. Nothing touches the disk.
 */
import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName, degrees } from "pdf-lib";
import { buildPdf, formatPdfDate, type PdfSources } from "../components/embed/pdf/pdfDoc";
import { SELF, initialPages, pagesOf, insertPages, rotatePages, deletePages, movePages } from "../lib/viewers/pageModel";

/**
 * A PDF whose pages have distinct, recognisable widths (100, 200, 300…), so the page
 * order of a rebuilt document can be read straight back off the geometry.
 */
async function makePdf(widths: number[], rotate = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const w of widths) {
    const page = doc.addPage([w, 400]);
    if (rotate) page.setRotation(degrees(rotate));
  }
  return doc.save();
}

/** The widths of each page of a saved PDF, in order — i.e. which page went where. */
async function widthsOf(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => Math.round(p.getWidth()));
}

async function rotationsOf(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getRotation().angle);
}

/** Sources map holding just the document under test — `openSource` needs pdf.js, so
 *  the bytes are supplied directly (only `bytes` is read at save time). */
const sourcesOf = (entries: Record<string, Uint8Array>): PdfSources =>
  new Map(
    Object.entries(entries).map(([id, bytes]) => [
      id,
      { bytes, doc: undefined as never },
    ]),
  );

describe("buildPdf", () => {
  it("writes the pages in the arrangement's order", async () => {
    const bytes = await makePdf([100, 200, 300]);
    const sources = sourcesOf({ [SELF]: bytes });

    const pages = initialPages(3);
    // Drag page 3 to the front.
    const moved = movePages(pages, [pages[2].id], 0);

    expect(await widthsOf(await buildPdf(moved, sources))).toEqual([300, 100, 200]);
  });

  it("drops deleted pages from the written file", async () => {
    const bytes = await makePdf([100, 200, 300]);
    const sources = sourcesOf({ [SELF]: bytes });

    const pages = initialPages(3);
    const kept = deletePages(pages, [pages[1].id]);

    expect(await widthsOf(await buildPdf(kept, sources))).toEqual([100, 300]);
  });

  it("merges pages from a second document, interleaved with the first", async () => {
    const mine = await makePdf([100, 200]);
    const other = await makePdf([700, 800, 900]);
    const sources = sourcesOf({ [SELF]: mine, "src1": other });

    const pages = initialPages(2);
    // Splice the other document's pages 1-2 in between my two pages.
    const merged = insertPages(pages, pagesOf("src1", 3).slice(0, 2), 1);

    expect(await widthsOf(await buildPdf(merged, sources))).toEqual([100, 700, 800, 200]);
  });

  it("adds the viewer's turn to the page's existing rotation", async () => {
    // The source page is already turned 90°; the viewer turns it another 90°.
    const bytes = await makePdf([100, 200], 90);
    const sources = sourcesOf({ [SELF]: bytes });

    const pages = initialPages(2);
    const turned = rotatePages(pages, [pages[0].id], 90);

    expect(await rotationsOf(await buildPdf(turned, sources))).toEqual([180, 90]);
  });

  it("gives a duplicated page its own copy, turnable on its own", async () => {
    const bytes = await makePdf([100, 200]);
    const sources = sourcesOf({ [SELF]: bytes });

    // Page 1 twice, with only the second copy turned — the thing the old
    // rotation-keyed-by-page-number model could not represent.
    const pages = initialPages(2);
    const dup = insertPages(pages, [pages[0]], 1);
    const turned = rotatePages(dup, [dup[1].id], 90);

    const out = await buildPdf(turned, sources);
    expect(await widthsOf(out)).toEqual([100, 100, 200]);
    expect(await rotationsOf(out)).toEqual([0, 90, 0]);
  });

  it("refuses to write a document with no pages", async () => {
    const sources = sourcesOf({ [SELF]: await makePdf([100]) });
    await expect(buildPdf([], sources)).rejects.toThrow(/at least one page/);
  });

  it("fails loudly when a merged source is no longer open", async () => {
    const sources = sourcesOf({ [SELF]: await makePdf([100]) });
    const orphan = pagesOf("gone", 1);
    await expect(buildPdf(orphan, sources)).rejects.toThrow(/no longer open/);
  });
});

/**
 * Deleting the metadata (#pdf-meta).
 *
 * These assert against the SAVED BYTES, not against pdf-lib's object model: the whole
 * failure this feature has to avoid is a field that is unreferenced in the structure
 * and still perfectly readable in the file — the same shape as a black rectangle
 * drawn over text that is still in the content stream.
 */
describe("buildPdf — stripMetadata", () => {
  /** A PDF carrying a filled-in `/Info` dict and an XMP packet on its first page. */
  async function makeStampedPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.setTitle("Quarterly review");
    doc.setAuthor("A. Person");
    doc.setSubject("Internal only");
    doc.setKeywords(["confidential"]);
    doc.setCreator("SomeEditor 7");
    doc.setProducer("SomeEditor PDF engine");
    const page = doc.addPage([100, 400]);
    // A per-page XMP packet — the store `copyPages` genuinely brings across.
    const xmp = doc.context.stream("<?xpacket?><x:xmpmeta>A. Person</x:xmpmeta>", {
      Type: "Metadata",
      Subtype: "XML",
    });
    page.node.set(PDFName.of("Metadata"), doc.context.register(xmp));
    return doc.save();
  }

  const text = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

  it("leaves the metadata alone by default", async () => {
    const sources = sourcesOf({ [SELF]: await makeStampedPdf() });
    const out = await buildPdf(initialPages(1), sources);
    const doc = await PDFDocument.load(out);
    // The `/Info` dict is the OUTPUT document's, so the source's title was never in
    // it — but pdf-lib's own producer stamp and creation date are, and that is what
    // an ordinary save has always written.
    expect(doc.getProducer()).toMatch(/pdf-lib/);
    expect(text(out)).toContain("A. Person");
  });

  it("writes no /Info dict at all", async () => {
    const sources = sourcesOf({ [SELF]: await makeStampedPdf() });
    const out = await buildPdf(initialPages(1), sources, { stripMetadata: true });
    // `updateMetadata: false` on the READ as well: pdf-lib's loader stamps its own
    // producer and dates into a document the moment it opens one, so the default
    // load would report an `/Info` dict this file does not have.
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getProducer()).toBeUndefined();
    expect(doc.getCreator()).toBeUndefined();
    expect(doc.getCreationDate()).toBeUndefined();
    expect(doc.getModificationDate()).toBeUndefined();
    // pdf-lib's own stamp is declined at the source rather than removed afterwards,
    // so the string is nowhere in the bytes either.
    expect(text(out)).not.toContain("pdf-lib");
  });

  it("removes a page's XMP packet from the bytes, not just from the page dict", async () => {
    const sources = sourcesOf({ [SELF]: await makeStampedPdf() });
    const out = await buildPdf(initialPages(1), sources, { stripMetadata: true });

    const doc = await PDFDocument.load(out);
    expect(doc.getPages()[0].node.get(PDFName.of("Metadata"))).toBeUndefined();
    // The point of the sweep: the stream itself is gone, not merely unreferenced.
    // (Object streams are uncompressed here so the assertion reads the real bytes.)
    const raw = await (await PDFDocument.load(out)).save({ useObjectStreams: false });
    expect(text(raw)).not.toContain("xmpmeta");
    expect(text(raw)).not.toContain("A. Person");
  });

  it("keeps the pages themselves — a strip is not an edit to the document", async () => {
    const sources = sourcesOf({ [SELF]: await makePdf([100, 200, 300]) });
    const pages = initialPages(3);
    const moved = movePages(pages, [pages[2].id], 0);
    const out = await buildPdf(moved, sources, { stripMetadata: true });
    expect(await widthsOf(out)).toEqual([300, 100, 200]);
  });
});

describe("formatPdfDate", () => {
  it("reads a PDF date in the file's own wall clock", () => {
    expect(formatPdfDate("D:20240115103000+01'00'")).toBe("2024-01-15 10:30");
  });

  it("handles a date with no time of day", () => {
    expect(formatPdfDate("D:20240115")).toBe("2024-01-15");
  });

  it("hands back anything that is not a PDF date unchanged", () => {
    expect(formatPdfDate("last Tuesday")).toBe("last Tuesday");
  });
});
