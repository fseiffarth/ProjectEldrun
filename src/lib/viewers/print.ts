// Frontend-only print pipeline for the in-app file viewers.
//
// The strategy is deliberately dependency-free: instead of generating a PDF on
// disk, each viewer renders the content it already has into a clean, paginated
// standalone HTML document, which we drop into an off-screen iframe and hand to
// the platform's own `window.print()`. The native (GTK/WebKit) print dialog then
// lets the user send it to a printer OR "Print to File → PDF" — so for plain text
// and Markdown this *is* the "transform to PDF before printing" step, with no
// backend and no new dependency.
//
// WebKitGTK has no built-in PDF engine (that's why the app renders PDFs with
// pdf.js onto <canvas>), so a PDF can't be printed by feeding the file to an
// iframe. `renderPdfToPrintImages` re-renders the already-open pages to images
// which then print through the same path as everything else.

import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * Assemble a complete, self-contained print document. Pure (no DOM), so the
 * scaffolding + escaping is unit-testable. `bodyHtml` is trusted markup the
 * caller has already sanitised/escaped; `css` is inlined into a <style> after a
 * small print-oriented base (page margins, reset).
 */
export function buildPrintDoc(bodyHtml: string, css: string, title = "Print"): string {
  const base = `*{box-sizing:border-box}html,body{margin:0;padding:0}` +
    `@page{margin:1.5cm}` +
    `body{background:#fff;color:#111;` +
    `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;` +
    `font-size:12px;line-height:1.5}`;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>${escapeAttr(title)}</title>` +
    `<style>${base}\n${css}</style>` +
    `</head><body>${bodyHtml}</body></html>`
  );
}

/**
 * Render a complete HTML document via the platform print dialog. Mounts an
 * off-screen iframe, waits for its images to decode, then calls `print()` on the
 * iframe's own window so only the document — not the surrounding app — prints.
 * The iframe is torn down on `afterprint` and, as a backstop, a timeout.
 */
export function printDocument(fullHtml: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.style.opacity = "0";
    iframe.style.pointerEvents = "none";

    let done = false;
    let cleanupTimer: number | null = null;
    const cleanup = () => {
      if (done) return;
      done = true;
      if (cleanupTimer != null) window.clearTimeout(cleanupTimer);
      iframe.remove();
      resolve();
    };

    iframe.onload = () => {
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!win || !doc) {
        cleanup();
        return;
      }
      const imgs = Array.from(doc.images);
      Promise.all(
        imgs.map((img) =>
          img.decode().catch(() => {
            /* broken/missing image: print what loaded rather than block */
          }),
        ),
      ).then(() => {
        // `afterprint` removes the iframe once the dialog closes; the timeout is
        // a backstop for engines that don't fire it (WebKitGTK's print() blocks
        // until dismissed, so by the time it returns we can also clean up).
        win.addEventListener("afterprint", cleanup);
        try {
          win.focus();
          win.print();
        } catch {
          /* printing unsupported / dialog refused: still tear the iframe down */
        }
        cleanupTimer = window.setTimeout(cleanup, 60_000);
      });
    };

    document.body.appendChild(iframe);
    iframe.srcdoc = fullHtml;
  });
}

/** Convenience: build the document from a body + css and print it. */
export function printHtmlBody(bodyHtml: string, css: string, title?: string): Promise<void> {
  return printDocument(buildPrintDoc(bodyHtml, css, title));
}

/**
 * Re-render every page of an already-open pdf.js document to a PNG data URL for
 * printing. `scale` trades size for print sharpness (~2× ≈ good on paper).
 */
export async function renderPdfToPrintImages(
  doc: PDFDocumentProxy,
  scale = 2,
): Promise<string[]> {
  const urls: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    await page.render({ canvasContext: ctx, viewport }).promise;
    urls.push(canvas.toDataURL("image/png"));
  }
  return urls;
}

/** Escape a string for use inside a double-quoted HTML attribute. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ── Print stylesheets ────────────────────────────────────────────────────────
// Concrete light-on-white colors: the app's themed `var(--…)` tokens don't exist
// inside the print iframe, and print output is on paper.

/** Print styling for `renderMarkdown` output wrapped in `.markdown-body`. */
export const MARKDOWN_PRINT_CSS = `
.markdown-body{max-width:100%;color:#111}
.markdown-body h1,.markdown-body h2,.markdown-body h3,
.markdown-body h4,.markdown-body h5,.markdown-body h6{
  line-height:1.25;margin:1.2em 0 .5em;font-weight:600;page-break-after:avoid}
.markdown-body h1{font-size:1.9em;border-bottom:1px solid #ddd;padding-bottom:.2em}
.markdown-body h2{font-size:1.5em;border-bottom:1px solid #eee;padding-bottom:.2em}
.markdown-body h3{font-size:1.25em}
.markdown-body p,.markdown-body ul,.markdown-body ol,.markdown-body blockquote{margin:.6em 0}
.markdown-body ul,.markdown-body ol{padding-left:1.6em}
.markdown-body a{color:#0645ad;text-decoration:underline}
.markdown-body code{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:.9em;background:#f4f4f4;padding:.1em .3em;border-radius:3px}
.markdown-body pre{
  background:#f6f8fa;border:1px solid #e1e4e8;border-radius:4px;padding:.8em;
  overflow:auto;page-break-inside:avoid}
.markdown-body pre code{background:none;padding:0}
.markdown-body blockquote{
  border-left:4px solid #ddd;color:#555;padding-left:1em;margin-left:0}
.markdown-body table{border-collapse:collapse;margin:.6em 0;page-break-inside:avoid}
.markdown-body th,.markdown-body td{border:1px solid #ccc;padding:.35em .6em;text-align:left}
.markdown-body th{background:#f4f4f4}
.markdown-body img,.markdown-body svg{max-width:100%;height:auto}
.markdown-body hr{border:0;border-top:1px solid #ddd;margin:1.2em 0}
`;

/** Print styling for plain text / source shown in a single `<pre>`. */
export const TEXT_PRINT_CSS = `
pre.print-pre{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11px;line-height:1.45;color:#111;margin:0;
  white-space:pre-wrap;word-break:break-word}
`;

/** Print styling for a single image / one image per PDF page. */
export const IMAGE_PRINT_CSS = `
.print-page{text-align:center}
.print-page img{max-width:100%;max-height:100vh;height:auto}
.print-page + .print-page{page-break-before:always}
`;

/** Alias — PDF prints as one image per page with the same rules. */
export const PDF_PRINT_CSS = IMAGE_PRINT_CSS;
