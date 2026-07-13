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
import { PDFDocument, degrees } from "pdf-lib";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PageList, SourceId } from "../../../lib/viewers/pageModel";

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
 * Throws when the arrangement is empty (a PDF must have at least one page) or when a
 * source it references is not loaded.
 */
export async function buildPdf(list: PageList, sources: PdfSources): Promise<Uint8Array> {
  if (list.length === 0) {
    throw new Error("A PDF must have at least one page.");
  }

  const out = await PDFDocument.create();

  // Copy from each source in ONE `copyPages` call, so shared resources (fonts,
  // images) are brought over once per source rather than once per page.
  const copies = new Map<string, Awaited<ReturnType<PDFDocument["copyPages"]>>[number]>();
  for (const src of new Set(list.map((r) => r.src))) {
    const bytes = sources.get(src)?.bytes;
    if (!bytes) throw new Error(`The source document for some pages is no longer open.`);
    const from = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const refs = list.filter((r) => r.src === src);
    const copied = await out.copyPages(
      from,
      refs.map((r) => r.page - 1),
    );
    refs.forEach((r, i) => copies.set(r.id, copied[i]));
  }

  for (const ref of list) {
    const page = copies.get(ref.id);
    if (!page) continue;
    if (ref.rot) {
      const base = page.getRotation().angle;
      page.setRotation(degrees((((base + ref.rot) % 360) + 360) % 360));
    }
    out.addPage(page);
  }

  return out.save();
}
