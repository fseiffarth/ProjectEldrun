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
 * Show a print preview and, on confirmation, hand the document to the platform
 * print dialog. Mounts a modal overlay whose visible iframe renders the exact
 * standalone document that will print (WYSIWYG for paper), plus a toolbar with a
 * Print button that calls `print()` on the iframe's own window — so only the
 * document, not the surrounding app, prints. The overlay stays open after the
 * dialog closes (so the user can adjust and print again) and tears down on
 * Close / backdrop click / Escape, which is when the returned promise resolves.
 */
export function printDocument(fullHtml: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // ── Overlay chrome (reuses the app's shared modal classes) ──────────────
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop print-preview-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "settings-dialog print-preview-dialog";

    const titlebar = document.createElement("div");
    titlebar.className = "print-preview-titlebar";

    const title = document.createElement("span");
    title.className = "print-preview-title";
    title.textContent = "Print preview";

    const actions = document.createElement("div");
    actions.className = "print-preview-actions";

    const printBtn = document.createElement("button");
    printBtn.className = "print-preview-print";
    printBtn.type = "button";
    // Disabled with a "Preparing…" affordance until images decode; mirrors the
    // viewer toolbar's PrintButton busy state.
    printBtn.disabled = true;
    printBtn.innerHTML =
      `<span class="file-viewer-save-spinner" aria-hidden="true"></span>Preparing…`;

    const closeBtn = document.createElement("button");
    closeBtn.className = "dialog-close-btn print-preview-close";
    closeBtn.type = "button";
    closeBtn.textContent = "Close";

    const iframe = document.createElement("iframe");
    iframe.className = "print-preview-frame";
    iframe.setAttribute("title", "Print preview");

    actions.append(printBtn, closeBtn);
    titlebar.append(title, actions);
    dialog.append(titlebar, iframe);
    backdrop.append(dialog);

    // ── Teardown (single-shot) ──────────────────────────────────────────────
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKeyDown);
      backdrop.remove();
      resolve();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cleanup();
      }
    };

    closeBtn.addEventListener("click", cleanup);
    // Backdrop click closes; clicks inside the dialog must not bubble to it.
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) cleanup();
    });
    document.addEventListener("keydown", onKeyDown);

    iframe.onload = () => {
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!win || !doc) return;
      const imgs = Array.from(doc.images);
      Promise.all(
        imgs.map((img) =>
          img.decode().catch(() => {
            /* broken/missing image: preview what loaded rather than block */
          }),
        ),
      ).then(() => {
        if (done) return;
        printBtn.disabled = false;
        printBtn.textContent = "🖨 Print";
        printBtn.addEventListener("click", () => {
          try {
            win.focus();
            win.print();
          } catch {
            /* printing unsupported / dialog refused: leave preview open */
          }
        });
      });
    };

    document.body.appendChild(backdrop);
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

/** Print styling for `renderMarkdown` output wrapped in `.markdown-body`.
 *
 * Margins come from body padding, NOT `@page{margin}`: WebKitGTK (the Linux
 * webview) does not implement the `@page` margin box, so an `@page` margin alone
 * prints edge-to-edge. Body padding is honored by every engine. `@page` margin
 * is zeroed so Chromium-based WebView2 doesn't add its own on top (double
 * margin). This overrides the `html,body{padding:0}` reset in `buildPrintDoc`. */
export const MARKDOWN_PRINT_CSS = `
@page{margin:0}
body{padding:2.54cm}
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

/** Print styling for plain text / source shown in a single `<pre>`.
 * Margins via body padding — see MARKDOWN_PRINT_CSS for why `@page{margin}`
 * alone prints borderless on WebKitGTK. */
export const TEXT_PRINT_CSS = `
@page{margin:0}
body{padding:2.54cm}
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
