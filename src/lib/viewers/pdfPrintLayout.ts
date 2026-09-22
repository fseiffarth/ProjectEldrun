// The print preview's sheets, laid out as a real PDF.
//
// The preview (`printDocument`) shows a PDF as page images, because the webview
// has no PDF engine; printing those images is what made PDF printouts soft. With
// a native print path (`printPdfNative`) the preview is only the *picture* of the
// job: what it arranged — order, dropped and turned sheets, page selection,
// copies — and what it set — paper, margins, scale, page numbers — is rebuilt
// here onto the document's own pages, each placed as a form XObject, so text and
// vector art reach the printer as they are in the file.
//
// The geometry mirrors the preview's paged stylesheet (`buildOptionsCss`): the
// sheet is the paper minus the margin on every side; the page is fitted into it
// on its binding axis, capped at `scale` percent, and centred; a page number
// takes a 16 px band above the bottom margin and sits centred in it.

import { PDFDocument, StandardFonts, degrees, rgb, type PDFEmbeddedPage } from "pdf-lib";
import { MARGIN_CM, clampCopies, clampScale, pageBoxCm, withCopies, type PrintOptions } from "./print";

const PT_PER_CM = 72 / 2.54;
/** The preview's page-number band and font: 16 px and 10 px, in points. */
const NUMBER_BAND_PT = 12;
const NUMBER_SIZE_PT = 7.5;

/** One printed sheet: a 1-based page of the source PDF, and the turn the
 *  preview's strip added to it (clockwise degrees, a multiple of 90). */
export interface PrintSheet {
  page: number;
  rot: number;
}

/** Where to draw a page, scaled by `k`, so that after a clockwise `turn` its
 *  bounding box has its lower-left corner at (`bx`, `by`). pdf-lib rotates
 *  counter-clockwise about the drawing origin, hence the origin moves to the
 *  corner the turn carries onto the box's lower left. Exported for its tests. */
export function turnedOrigin(
  turn: number,
  bx: number,
  by: number,
  w: number,
  h: number,
): { x: number; y: number } {
  switch (turn) {
    case 90:
      return { x: bx, y: by + w };
    case 180:
      return { x: bx + w, y: by + h };
    case 270:
      return { x: bx + h, y: by };
    default:
      return { x: bx, y: by };
  }
}

/**
 * Lay `sheets` (print order, the preview's `printSequence`) out of `bytes` onto
 * paper as `opts` sets it, `opts.copies` times collated — the document the
 * preview shows, as a PDF.
 */
export async function layoutPrintPdf(
  bytes: Uint8Array,
  sheets: readonly PrintSheet[],
  opts: PrintOptions,
): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const [wCm, hCm] = pageBoxCm(opts);
  const paperW = wCm * PT_PER_CM;
  const paperH = hCm * PT_PER_CM;
  const pad = (MARGIN_CM[opts.margin] ?? MARGIN_CM.normal) * PT_PER_CM;
  const band = opts.pageNumbers ? NUMBER_BAND_PT : 0;
  const boxW = Math.max(1, paperW - 2 * pad);
  const boxH = Math.max(1, paperH - 2 * pad - band);
  const fill = clampScale(opts.scale) / 100;
  const font = opts.pageNumbers ? await out.embedFont(StandardFonts.Helvetica) : null;

  const pages = src.getPages();
  // One XObject per source page, shared by every copy that prints it.
  const embedded = new Map<number, PDFEmbeddedPage>();
  const sequence = withCopies(sheets, clampCopies(opts.copies));
  for (const [i, sheet] of sequence.entries()) {
    const from = pages[sheet.page - 1];
    if (!from) continue;
    let emb = embedded.get(sheet.page);
    if (!emb) {
      // The crop box is what a reader shows and what the preview pictured.
      const crop = from.getCropBox();
      emb = await out.embedPage(from, {
        left: crop.x,
        bottom: crop.y,
        right: crop.x + crop.width,
        top: crop.y + crop.height,
      });
      embedded.set(sheet.page, emb);
    }
    // The page's own /Rotate plus the strip's turn, both clockwise — an embedded
    // page is its unrotated content, so the whole turn is applied here.
    const turn = (((from.getRotation().angle + sheet.rot) % 360) + 360) % 360;
    const quarter = turn === 90 || turn === 270;
    const contentW = quarter ? emb.height : emb.width;
    const contentH = quarter ? emb.width : emb.height;
    const k = Math.min(boxW / contentW, boxH / contentH) * fill;
    const bx = pad + (boxW - contentW * k) / 2;
    const by = pad + band + (boxH - contentH * k) / 2;
    const page = out.addPage([paperW, paperH]);
    page.drawPage(emb, {
      ...turnedOrigin(turn, bx, by, emb.width * k, emb.height * k),
      xScale: k,
      yScale: k,
      rotate: degrees(-turn),
    });
    if (font) {
      // Numbered per copy, each copy being a whole document — as the preview does.
      const label = String((i % sheets.length) + 1);
      page.drawText(label, {
        x: (paperW - font.widthOfTextAtSize(label, NUMBER_SIZE_PT)) / 2,
        y: pad + NUMBER_SIZE_PT * 0.25,
        size: NUMBER_SIZE_PT,
        font,
        color: rgb(0x55 / 255, 0x55 / 255, 0x55 / 255),
      });
    }
  }
  if (out.getPageCount() === 0) throw new Error("nothing to print");
  return out.save();
}
