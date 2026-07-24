/**
 * Loading a deck's **base plate** — the PDF the layers sit on.
 *
 * Kept apart from `DeckView` because it is the one piece with an awkward
 * lifetime: a `PDFDocumentProxy` owns a worker and must be destroyed, and pdf.js
 * *detaches* the ArrayBuffer it is handed, so the bytes cannot be reused
 * afterwards (the same trap `pdf/pdfDoc.ts` documents). Both facts are easy to
 * get wrong in a component body and invisible when you do — the symptom is a
 * leaked worker per reload, which only shows up after an hour of editing.
 */

import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { readFileBytes } from "../fileAccess";
import type { BasePage } from "../../../lib/viewers/deck/sidecar";

// Idempotent: the PDF viewer sets the same value, and a deck can be opened
// without that module ever having loaded.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** How much page text the fingerprint needs. Reading more costs time per page
 *  for nothing — see `sidecar.FINGERPRINT_CHARS`. */
const TEXT_BUDGET = 400;

export interface LoadedBase {
  doc: PDFDocumentProxy;
  pages: BasePage[];
}

/**
 * Open `path` and describe every page: its box in points, and enough text to
 * fingerprint it.
 *
 * The caller owns the returned `doc` and **must** `destroy()` it.
 */
export async function loadBase(path: string, scope: string | null): Promise<LoadedBase> {
  const bytes = await readFileBytes(path, scope);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;

  const pages: BasePage[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    let text = "";
    try {
      const content = await page.getTextContent();
      for (const item of content.items) {
        const s = (item as { str?: string }).str;
        if (!s) continue;
        text += `${s} `;
        if (text.length >= TEXT_BUDGET) break;
      }
    } catch {
      // A page whose text layer will not extract still has a valid box, and a
      // fingerprint over an empty string is stable. Anchoring falls back to
      // SyncTeX or to order, which is exactly what it is there for.
    }
    pages.push({ page: n, width: vp.width, height: vp.height, text: text.trim() });
  }
  return { doc, pages };
}

/**
 * Render 1-based `pageNumber` into `canvas` at `cssW × cssH`.
 *
 * The canvas contract is the PDF viewer's, deliberately: backing store in
 * **device** pixels (`css × dpr`), CSS size in **CSS** pixels. Getting this wrong
 * is what makes a slide look soft on a HiDPI screen and, worse, look fine on the
 * laptop and soft on the projector.
 *
 * Returns a cancel function; pdf.js render tasks must be cancelled when the
 * component re-renders under them, or two tasks race for one canvas.
 */
export function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
): () => void {
  let cancelled = false;
  let task: { cancel: () => void } | null = null;

  void (async () => {
    try {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      const base = page.getViewport({ scale: 1 });
      // Fit the page box to the requested CSS size. They agree in aspect for a
      // normal deck, but a mixed-size PDF must not stretch.
      const scale = Math.min(cssW / base.width, cssH / base.height);
      const viewport = page.getViewport({ scale: scale * dpr });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx || cancelled) return;
      task = page.render({ canvasContext: ctx, viewport });
      await (task as unknown as { promise: Promise<void> }).promise;
    } catch {
      // A cancelled render rejects; so does a page that disappeared under a
      // reload. Neither is worth surfacing — the next render replaces it.
    }
  })();

  return () => {
    cancelled = true;
    try {
      task?.cancel();
    } catch {
      /* already finished */
    }
  };
}

/** Raster resolution for a TeX figure, as a multiple of the PDF's own point
 *  size. Higher than the base plate's on-screen render because a figure is
 *  often placed small and then enlarged — a blurry formula is worse than a
 *  slightly larger PNG. */
const TEX_FIGURE_SCALE = 3;

export interface RasterizedFigure {
  png: Uint8Array;
  /** Pixel size of the PNG — callers use the ratio to size the deck object so a
   *  wide formula doesn't get squashed into a square placeholder box. */
  width: number;
  height: number;
}

/**
 * Compile a standalone TeX figure's PDF into a PNG of its (cropped) first page.
 *
 * Used for the deck's TeX-figure objects: `standalone` crops the PDF to its
 * content, so page 1 at a fixed scale is the whole figure with no page
 * furniture to trim. Opens its own throwaway `PDFDocumentProxy` — this PDF is
 * never the base plate, so it has none of `loadBase`'s multi-page/lifetime
 * concerns — and destroys it before returning.
 */
export async function renderPdfPageToPng(bytes: Uint8Array): Promise<RasterizedFigure | null> {
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: TEX_FIGURE_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return null;
    return { png: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
  } finally {
    await doc.destroy();
  }
}
