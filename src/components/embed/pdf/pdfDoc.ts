/**
 * The PDF viewer's document plumbing: the open source documents an arrangement
 * draws from, and the one place a PDF is actually *written*.
 *
 * The viewer never rebuilds the file while you edit it. Reordering, deleting,
 * turning and merging pages only rewrite the `PageList` (see `lib/viewers/pageModel`),
 * and both the reader and the rail render straight off that list by resolving each
 * entry's source here — so an edit is an array operation, not a re-parse. pdf-lib is
 * pulled in exactly once, on save, by {@link buildPdf}.
 */
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFRef, PDFStream, degrees } from "pdf-lib";
import type { PDFContext } from "pdf-lib";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PageList, PageRef, SourceId } from "../../../lib/viewers/pageModel";

/**
 * One document an arrangement can draw pages from: the file being viewed (`SELF`)
 * or a PDF merged into it.
 *
 * `bytes` is a PRISTINE copy. pdf.js *detaches* the ArrayBuffer it is handed, so the
 * bytes given to `getDocument` are unusable afterwards — and pdf-lib needs them again
 * at save time. Every loader here therefore keeps its own copy.
 */
export interface PdfSource {
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
}

export type PdfSources = Map<SourceId, PdfSource>;

/** Open a PDF for rendering, keeping the bytes intact for a later save. */
export async function openSource(bytes: Uint8Array): Promise<PdfSource> {
  // One copy for pdf.js to detach, one to keep.
  const pristine = bytes.slice();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  return { bytes: pristine, doc };
}

/** Mint a source id for a merged-in document. */
let nextSourceId = 0;
export function newSourceId(): SourceId {
  nextSourceId += 1;
  return `src${nextSourceId}`;
}

/** The pdf.js document an entry renders from, if it is loaded. */
export function docFor(sources: PdfSources, src: SourceId): PDFDocumentProxy | undefined {
  return sources.get(src)?.doc;
}

// ── Deleting the metadata (#pdf-meta) ────────────────────────────────────────
// What a PDF says about itself, as opposed to what it shows: who wrote it, in which
// program, when, and whatever an editor left in its own private corner of the file.
// None of it is on the page, so none of it is visible in the reader — which is
// exactly why it is worth a control of its own.

/**
 * The `/Info` fields a reader thinks of as "the metadata", in the order they are
 * listed to them. pdf.js reports these on `getMetadata().info`, and it is the same
 * set every other PDF tool prints under "Document properties".
 */
export const PDF_INFO_FIELDS = [
  "Title",
  "Author",
  "Subject",
  "Keywords",
  "Creator",
  "Producer",
  "CreationDate",
  "ModDate",
] as const;

/** One thing the file says about itself. `value` is already a display string. */
export interface PdfMetaEntry {
  key: string;
  value: string;
}

/**
 * A PDF date string (`D:20240115103000+01'00'`) as something readable.
 *
 * Rendered in the file's **own** wall clock, with no conversion to the reader's zone:
 * the offset is the author's, and a "modified at 03:00" that is really 22:00 the
 * previous day where the document was written is a worse answer than the plain digits
 * it replaced. Anything that is not a PDF date comes back unchanged — the field is a
 * free string and plenty of producers write nonsense into it.
 */
export function formatPdfDate(raw: string): string {
  const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/.exec(raw.trim());
  if (!m) return raw;
  const [, y, mo, d, h, mi] = m;
  return h ? `${y}-${mo}-${d} ${h}:${mi ?? "00"}` : `${y}-${mo}-${d}`;
}

/** What {@link readPdfMetadata} found. */
export interface PdfMetadata {
  /** `/Info` fields that are actually filled in, plus any non-standard ones. */
  entries: PdfMetaEntry[];
  /** The document carries an XMP packet — the second, parallel metadata store. */
  xmp: boolean;
}

/**
 * Read what the open document says about itself.
 *
 * Deliberately a read of the document *as loaded* (pdf.js) rather than of the bytes
 * a save would produce: the point is to show the reader what is in the file in front
 * of them, so the list and the file cannot disagree.
 *
 * An empty value is not an entry. A `/Info` dict with `Title: ""` is the ordinary
 * state of a PDF nobody titled, and listing it as something to be deleted would make
 * every document look like it were carrying something.
 */
export async function readPdfMetadata(doc: PDFDocumentProxy): Promise<PdfMetadata> {
  const md = await doc.getMetadata().catch(() => null);
  if (!md) return { entries: [], xmp: false };
  const info = (md.info ?? {}) as Record<string, unknown> & { Custom?: Record<string, unknown> };
  const entries: PdfMetaEntry[] = [];
  const push = (key: string, raw: unknown) => {
    const text = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw);
    if (text) entries.push({ key, value: formatPdfDate(text) });
  };
  for (const key of PDF_INFO_FIELDS) push(key, info[key]);
  // Anything the producer invented for itself ("Company", "SourceModified", a
  // document-management id). pdf.js parks these under `Custom`, and they are
  // routinely the most identifying part of the whole dict.
  for (const [key, raw] of Object.entries(info.Custom ?? {})) push(key, raw);
  return { entries, xmp: md.metadata != null };
}

/**
 * Keys whose value describes the file rather than being part of it. `/Metadata` is
 * an XMP packet (a second, parallel copy of the `/Info` fields plus whatever else the
 * producer wrote), `/PieceInfo` is a private scratch space an editor left behind —
 * Illustrator and Word both keep whole working documents in there — and
 * `/LastModified` is the timestamp that belongs with it.
 */
const META_KEYS = ["Metadata", "PieceInfo", "LastModified"].map((k) => PDFName.of(k));

/**
 * Drop every trace of the sources' metadata from a document about to be written.
 *
 * Three separate stores have to be dealt with, which is the reason this is not a
 * one-liner. The **`/Info` dict** never arrives here at all — the output is a fresh
 * document, so {@link buildPdf} simply declines to have one created (pdf-lib writes
 * its own Producer, Creator and a `CreationDate` of *now* otherwise, and a timestamp
 * saying when the file was made is itself metadata). The **catalog** of a fresh
 * document holds no XMP either. What genuinely comes across is the **page** level:
 * `copyPages` brings each page's dict over as it stands, XMP packet, `/PieceInfo` and
 * all — so those keys are deleted here.
 *
 * Deleting the key is not enough on its own, and that is the subtle part. pdf-lib
 * serializes every object registered in the context, reachable or not, so an XMP
 * stream whose only reference has just been removed would still be written into the
 * file in full — deleted from the structure and perfectly readable in the bytes,
 * which is the same shape of failure as a black rectangle drawn over text. Hence the
 * sweep: everything the trailer cannot reach is dropped from the context as well.
 */
function scrubMetadata(out: PDFDocument): void {
  const dicts: PDFDict[] = [out.catalog, ...out.getPages().map((p) => p.node)];
  for (const dict of dicts) {
    for (const key of META_KEYS) dict.delete(key);
  }
  collectGarbage(out.context);
}

/**
 * Drop every registered object the trailer can no longer reach.
 *
 * A plain mark-and-sweep from the trailer's four entries. It is safe by construction
 * — anything still referenced from the catalog is kept — and it runs *before* the
 * save, i.e. before pdf-lib's own flush registers the images a redacted sheet
 * embeds; those are already referenced from their page's resources, so they are
 * reachable when it matters and simply not present yet when it does not.
 */
function collectGarbage(context: PDFContext): void {
  const live = new Set<string>();
  const stack: unknown[] = [
    context.trailerInfo.Root,
    context.trailerInfo.Info,
    context.trailerInfo.Encrypt,
    context.trailerInfo.ID,
  ];
  while (stack.length > 0) {
    const obj = stack.pop();
    if (obj instanceof PDFRef) {
      if (live.has(obj.tag)) continue;
      live.add(obj.tag);
      const target = context.lookup(obj);
      if (target) stack.push(target);
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    } else if (obj instanceof PDFDict) {
      stack.push(...obj.values());
    } else if (obj instanceof PDFArray) {
      stack.push(...obj.asArray());
    }
  }
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!live.has(ref.tag)) context.delete(ref);
  }
}

// ── Blacking text out (#pdf-redact) ──────────────────────────────────────────
// A redacted sheet is not copied at all: it is rasterised with its marked areas
// painted over, and the raster becomes the whole page. See `flattenPage` below for
// why nothing gentler is on offer.

/** How sharp a flattened page is. 200 dpi keeps 10pt text crisp on screen and in
 *  print while staying roughly a tenth of the size of a 600 dpi scan. */
export const REDACT_DEFAULT_DPI = 200;

/** JPEG rather than PNG: a text page at 200 dpi is ~0.4 MB against ~3 MB, and the
 *  quality is high enough that the artefacts are invisible at reading zoom. The
 *  black areas are painted BEFORE encoding, so nothing lossy is load-bearing. */
const REDACT_JPEG_QUALITY = 0.92;

/** Ceiling on a raster's pixel count. WebKit refuses to allocate an oversized
 *  canvas (silently, as a blank one), and an A0 poster at 300 dpi is 100 MP — so an
 *  outsized page loses resolution rather than its content. */
const REDACT_MAX_PIXELS = 40e6;

/** A page rendered to image bytes, with its blackouts already burned into them. */
export interface PageRaster {
  bytes: Uint8Array;
  /** `image/jpeg` or `image/png` — anything else is not embeddable. */
  mime: string;
  /** The page box the image fills, in big points (the sheet's rotated size). */
  widthPt: number;
  heightPt: number;
}

/** Renders one sheet with its marks burned in. Injectable so `buildPdf` is testable
 *  without a canvas, and so a future backend rasteriser can replace it wholesale. */
export type PageRasterizer = (src: PdfSource, ref: PageRef, dpi: number) => Promise<PageRaster>;

/** The base64 payload of a canvas data URL, as bytes. */
function dataUrlToBytes(url: string): Uint8Array {
  const base64 = url.slice(url.indexOf(",") + 1);
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Render a sheet at `dpi` with its marked areas filled black.
 *
 * The turn the viewer applied is baked into the raster (pdf.js takes the total
 * rotation, as everywhere else in this viewer), so the page this becomes carries no
 * `/Rotate` of its own — which is also why the marks, which are stored in that same
 * rotated space, are simply multiplied by the scale.
 */
export async function rasterizeRedactedPage(
  src: PdfSource,
  ref: PageRef,
  dpi = REDACT_DEFAULT_DPI,
): Promise<PageRaster> {
  const page = await src.doc.getPage(ref.page);
  const rotation = (((page.rotate + ref.rot) % 360) + 360) % 360;
  const base = page.getViewport({ scale: 1, rotation });
  const wanted = dpi / 72;
  const fit = Math.sqrt(REDACT_MAX_PIXELS / (base.width * base.height * wanted * wanted));
  const scale = fit < 1 ? wanted * fit : wanted;
  const viewport = page.getViewport({ scale, rotation });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not rasterise the page to black areas out.");
  // A page with no background of its own would otherwise flatten onto transparency,
  // which prints and composites as black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Painted over the rendered pixels, so the covered glyphs are gone from the image
  // as well as from the document — the pixels ARE the page from here on.
  ctx.fillStyle = "#000000";
  for (const m of ref.marks ?? []) {
    ctx.fillRect(m.x * scale, m.y * scale, m.w * scale, m.h * scale);
  }

  return {
    bytes: dataUrlToBytes(canvas.toDataURL("image/jpeg", REDACT_JPEG_QUALITY)),
    mime: "image/jpeg",
    widthPt: base.width,
    heightPt: base.height,
  };
}

/** How `buildPdf` writes the pages it is given. */
export interface BuildPdfOptions {
  emptyMsg?: string;
  sourceClosedMsg?: string;
  /** Resolution for sheets carrying blackouts; ignored by every other page. */
  redactDpi?: number;
  /** Overrides the pdf.js/canvas rasteriser (tests, and a future backend one). */
  rasterize?: PageRasterizer;
  /** Write the file with no metadata at all (#pdf-meta) — see {@link scrubMetadata}. */
  stripMetadata?: boolean;
}

/**
 * Add a redacted sheet to `out` as a flat image of itself.
 *
 * This is the whole security claim of the feature, so it is worth being explicit
 * about what it does and what it costs. The page is **not** copied and then covered:
 * a rectangle drawn over text hides nothing, because the glyphs stay in the content
 * stream and come back out of any copy, extract or annotation delete — that is the
 * standard way redactions leak, and it is the failure this code exists to make
 * impossible. Instead the sheet is rendered to pixels, the marked areas are painted
 * out of *those*, and the image becomes the page. What is destroyed with the text is
 * everything else the page held: its own text layer, its vector art, its links and
 * annotations, its tagging. That is a real cost, and it is why only sheets that carry
 * a mark are flattened — every other page of the document is copied across intact.
 *
 * The alternative — editing the content stream to drop just the glyphs inside each
 * box — keeps the rest of the page and is not on offer, deliberately: doing it
 * correctly means tracking text state, font metrics and every form XObject well
 * enough to know where each glyph lands, and a redaction that is subtly wrong is
 * worse than one that is heavy-handed.
 */
async function flattenPage(
  out: PDFDocument,
  src: PdfSource,
  ref: PageRef,
  dpi: number,
  rasterize: PageRasterizer,
): Promise<void> {
  const raster = await rasterize(src, ref, dpi);
  const image =
    raster.mime === "image/png"
      ? await out.embedPng(raster.bytes)
      : await out.embedJpg(raster.bytes);
  const page = out.addPage([raster.widthPt, raster.heightPt]);
  page.drawImage(image, { x: 0, y: 0, width: raster.widthPt, height: raster.heightPt });
}

/**
 * Build the arrangement into a real PDF.
 *
 * Pages are copied out of each source with `copyPages`, which brings the page's
 * content and resources across. A DUPLICATED entry gets its own copy — the same page
 * object cannot be added to a document twice — which is why the copy is driven by the
 * entry list rather than by a set of page numbers.
 *
 * `rot` is the turn the *viewer* applied, on top of whatever the page already carried
 * in its `/Rotate`, so the two are added rather than the latter overwritten.
 *
 * A sheet carrying blackouts takes the other path entirely — see {@link flattenPage}.
 *
 * `stripMetadata` writes the file with nothing said about it — see
 * {@link scrubMetadata} for which of the three metadata stores each step deals with.
 *
 * Throws when the arrangement is empty (a PDF must have at least one page) or when a
 * source it references is not loaded.
 */
export async function buildPdf(
  list: PageList,
  sources: PdfSources,
  opts: BuildPdfOptions = {},
): Promise<Uint8Array> {
  const {
    emptyMsg = "A PDF must have at least one page.",
    sourceClosedMsg = "The source document for some pages is no longer open.",
    redactDpi = REDACT_DEFAULT_DPI,
    rasterize = rasterizeRedactedPage,
    stripMetadata = false,
  } = opts;
  if (list.length === 0) {
    throw new Error(emptyMsg);
  }

  // `updateMetadata` is pdf-lib's own `/Info` dict: a Producer and Creator naming the
  // library, a ModDate of now, and a CreationDate of now. Harmless on an ordinary
  // save, and exactly the wrong thing to write into a file the reader just asked to
  // have its metadata deleted — so it is declined at the source rather than removed
  // afterwards, which would leave the dict serialized in the bytes as an orphan.
  const out = await PDFDocument.create({ updateMetadata: !stripMetadata });

  // Copy from each source in ONE `copyPages` call, so shared resources (fonts,
  // images) are brought over once per source rather than once per page. Redacted
  // sheets are left out of the copy: nothing of their original may reach the output.
  const plain = list.filter((r) => !r.marks?.length);
  const copies = new Map<string, Awaited<ReturnType<PDFDocument["copyPages"]>>[number]>();
  for (const src of new Set(plain.map((r) => r.src))) {
    const bytes = sources.get(src)?.bytes;
    if (!bytes) throw new Error(sourceClosedMsg);
    const from = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const refs = plain.filter((r) => r.src === src);
    const copied = await out.copyPages(
      from,
      refs.map((r) => r.page - 1),
    );
    refs.forEach((r, i) => copies.set(r.id, copied[i]));
  }

  // In list order, so a flattened sheet lands where it sits in the arrangement.
  // Sequential rather than concurrent: each raster is a full-page canvas, and a
  // 300-page document would otherwise hold every one of them at once.
  for (const ref of list) {
    if (ref.marks?.length) {
      const src = sources.get(ref.src);
      if (!src) throw new Error(sourceClosedMsg);
      await flattenPage(out, src, ref, redactDpi, rasterize);
      continue;
    }
    const page = copies.get(ref.id);
    if (!page) continue;
    if (ref.rot) {
      const base = page.getRotation().angle;
      page.setRotation(degrees((((base + ref.rot) % 360) + 360) % 360));
    }
    out.addPage(page);
  }

  // After the pages are in, so the copied page dicts are there to be scrubbed, and
  // before `save()`, whose flush is what would register the leftovers permanently.
  if (stripMetadata) scrubMetadata(out);

  return out.save();
}
