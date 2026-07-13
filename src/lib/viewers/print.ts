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

import { createElement } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { initialPages, isPristine, type PageList } from "./pageModel";
import {
  mountPageStrip,
  type MountedPageStrip,
} from "../../components/common/mountPageStrip";
import type { PageStripProps } from "../../components/common/PageStrip";

// ── Print options ────────────────────────────────────────────────────────────
// The preview overlay exposes the options a printer dialog normally would. They
// are applied by injecting one stylesheet into the *already-loaded* preview
// document (see `printDocument`) rather than by rebuilding it: the HTML/SVG/CSS
// viewer prints a document Eldrun did not assemble (`buildPreviewDoc`), and an
// injected sheet reaches that one too — and never costs an iframe reload.

export type PaperSize = "A4" | "Letter" | "Legal" | "A3" | "A5";
export type Orientation = "portrait" | "landscape";
export type MarginPreset = "none" | "narrow" | "normal" | "wide";
export type PageSelection = "all" | "odd" | "even" | "custom";

export interface PrintOptions {
  paper: PaperSize;
  orientation: Orientation;
  margin: MarginPreset;
  /** Percent; the printer-dialog "Scale" equivalent. */
  scale: number;
  pages: PageSelection;
  /** Custom page spec, e.g. "1-3, 5". Only read when `pages === "custom"`. */
  range: string;
  grayscale: boolean;
  /** Print background colors/images (off saves ink). */
  background: boolean;
  /** Footer page numbers; only possible on page-based documents (see below). */
  pageNumbers: boolean;
}

/** Paper dimensions in cm, portrait (width × height). */
export const PAPER_CM: Record<PaperSize, readonly [number, number]> = {
  A3: [29.7, 42],
  A4: [21, 29.7],
  A5: [14.8, 21],
  Letter: [21.59, 27.94],
  Legal: [21.59, 35.56],
};

/** Margin presets in cm. `normal` matches the padding the viewers hardcoded. */
export const MARGIN_CM: Record<MarginPreset, number> = {
  none: 0,
  narrow: 1.27,
  normal: 2.54,
  wide: 3.81,
};

export const SCALE_CHOICES = [50, 75, 90, 100, 110, 125, 150, 200] as const;

export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  paper: "A4",
  orientation: "portrait",
  margin: "normal",
  scale: 100,
  pages: "all",
  range: "",
  grayscale: false,
  background: true,
  pageNumbers: false,
};

/** Sheet box in cm for the chosen paper + orientation (landscape swaps them). */
export function pageBoxCm(opts: PrintOptions): [number, number] {
  const [w, h] = PAPER_CM[opts.paper] ?? PAPER_CM.A4;
  return opts.orientation === "landscape" ? [h, w] : [w, h];
}

/** The printable box in cm: the sheet minus the margin on each side. */
export function contentBoxCm(opts: PrintOptions): [number, number] {
  const [w, h] = pageBoxCm(opts);
  const m = MARGIN_CM[opts.margin] ?? MARGIN_CM.normal;
  return [round2(Math.max(1, w - 2 * m)), round2(Math.max(1, h - 2 * m))];
}

/**
 * Thumbnail box in px for the strip, in the sheet's own proportions — so a
 * landscape sheet gets a landscape card rather than an upright one. Height is
 * fixed so the strip keeps a single row height; the width follows the aspect.
 */
export function thumbSizePx(opts: PrintOptions, height = 84): [number, number] {
  const [w, h] = pageBoxCm(opts);
  return [Math.round((height * w) / h), height];
}

/**
 * Parse a printer-style page spec ("1-3, 5", "2 4", "7-") against a known page
 * count. Deliberately tolerant — it runs on every keystroke of the range input,
 * so garbage is dropped rather than thrown. Result is clamped to 1..total,
 * deduped and sorted.
 */
export function parsePageRange(spec: string, total: number): number[] {
  const pages = new Set<number>();
  if (total <= 0) return [];
  for (const part of spec.split(/[,;\s]+/)) {
    if (!part) continue;
    const m = /^(\d*)(-?)(\d*)$/.exec(part);
    if (!m || (!m[1] && !m[3])) continue;
    const open = m[2] === "-";
    let lo = m[1] ? Number(m[1]) : open ? 1 : NaN;
    let hi = open ? (m[3] ? Number(m[3]) : total) : lo;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    if (lo > hi) [lo, hi] = [hi, lo];
    for (let p = Math.max(1, lo); p <= Math.min(total, hi); p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

/** The 1-based pages the current options select out of `total`. */
export function selectedPages(opts: PrintOptions, total: number): number[] {
  if (total <= 0) return [];
  const all = Array.from({ length: total }, (_, i) => i + 1);
  switch (opts.pages) {
    case "odd":
      return all.filter((p) => p % 2 === 1);
    case "even":
      return all.filter((p) => p % 2 === 0);
    case "custom":
      return parsePageRange(opts.range, total);
    default:
      return all;
  }
}

// ── Page arrangement ─────────────────────────────────────────────────────────
// The arrangement itself lives in `lib/viewers/pageModel` — the same model the PDF
// viewer's page rail edits, so reordering/deleting/turning pages behaves identically
// in both places. Only the *print* reading of it belongs here.

/**
 * The sheets that will actually print, in print order: the arrangement, filtered by
 * the page selection. The selection counts *positions* in the current arrangement
 * (so "1-3" means the first three sheets as shown), which is the only reading that
 * stays meaningful once pages have been moved.
 */
export function printSequence(pages: PageList, opts: PrintOptions): PageList {
  const positions = new Set(selectedPages(opts, pages.length));
  return pages.filter((_, i) => positions.has(i + 1));
}

/**
 * The stylesheet the options translate to, injected last into the print
 * document so it overrides both the `buildPrintDoc` base and the caller's CSS.
 *
 * Margins are body padding and scale is `zoom` — NOT `@page{margin}` — because
 * WebKitGTK does not implement the `@page` margin box (same reason the viewer
 * stylesheets below set `body{padding}`; a bare `@page` margin prints
 * edge-to-edge). On screen the sheet must stay true size while the content
 * scales inside it (that is what a printer's scale does), so the sheet box is
 * divided by the zoom factor, which then multiplies it back.
 */
export function buildOptionsCss(opts: PrintOptions): string {
  const [w, h] = pageBoxCm(opts);
  const pad = MARGIN_CM[opts.margin] ?? MARGIN_CM.normal;
  const zoom = clampScale(opts.scale) / 100;
  const sheetW = round2(w / zoom);
  const sheetH = round2(h / zoom);

  const css = [
    `@page{size:${w}cm ${h}cm;margin:0}`,
    `body{margin:0;padding:${pad}cm;zoom:${zoom};background:#fff}`,
    `.eldrun-print-hidden{display:none!important}`,
    // Screen-only: show the actual sheet on a backdrop, so the preview is WYSIWYG.
    `@media screen{html{background:#3f4245;padding:18px 0}` +
      `body{width:${sheetW}cm;min-height:${sheetH}cm;margin:0 auto;` +
      `box-shadow:0 2px 12px rgba(0,0,0,.45)}}`,
  ];

  if (opts.grayscale) css.push(`body{filter:grayscale(1)}`);

  if (opts.background) {
    css.push(`body,body *{-webkit-print-color-adjust:exact;print-color-adjust:exact}`);
  } else {
    // Scoped to body's descendants so the sheet itself keeps its white/shadow.
    css.push(
      `body *{background:transparent!important;background-image:none!important;` +
        `box-shadow:none!important}`,
    );
  }

  // Per-page rotation (classes stamped on the page elements by printDocument).
  // A quarter turn is the awkward one: `transform` does not change the layout
  // box, so a rotated page would reserve its *unrotated* size and overflow the
  // sheet. The page therefore becomes a fixed printable-height box and the image
  // is centred out of flow inside it, pre-constrained to the *swapped* printable
  // box — after the turn its bounding box is exactly the printable area.
  const [cw, ch] = contentBoxCm(opts);
  css.push(
    `.print-page.eldrun-rot-90,.print-page.eldrun-rot-270{position:relative;height:${ch}cm}` +
      `.print-page.eldrun-rot-90 img,.print-page.eldrun-rot-270 img{position:absolute;` +
      `left:50%;top:50%;width:auto;height:auto;max-width:${ch}cm;max-height:${cw}cm}` +
      `.print-page.eldrun-rot-90 img{transform:translate(-50%,-50%) rotate(90deg)}` +
      `.print-page.eldrun-rot-270 img{transform:translate(-50%,-50%) rotate(270deg)}` +
      `.print-page.eldrun-rot-180 img{transform:rotate(180deg)}`,
  );

  if (opts.pageNumbers) {
    // A real running footer would need @page margin boxes, which WebKitGTK does
    // not have — hence numbers are stamped onto the page elements themselves
    // (`data-page`, set by printDocument) and exist only for paged documents.
    css.push(
      `.print-page{position:relative;padding-bottom:16px}` +
        `.print-page::after{content:attr(data-page);position:absolute;` +
        `left:0;right:0;bottom:0;text-align:center;color:#555;` +
        `font:10px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}`,
    );
  }

  return css.join("\n");
}

const STORAGE_KEY = "eldrun.print.options";

/**
 * Last used options, or the defaults. Never throws (private mode, junk JSON).
 *
 * The page *selection* is deliberately not restored: a range like "2-3" belongs
 * to the document it was typed for, and silently re-applying it to the next file
 * would drop pages the user never chose to drop. Printer settings (paper,
 * margins, scale…) do carry over, which is what a printer dialog does.
 */
export function loadPrintOptions(): PrintOptions {
  const stored = (() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? sanitizePrintOptions(JSON.parse(raw)) : { ...DEFAULT_PRINT_OPTIONS };
    } catch {
      return { ...DEFAULT_PRINT_OPTIONS };
    }
  })();
  return { ...stored, pages: DEFAULT_PRINT_OPTIONS.pages, range: DEFAULT_PRINT_OPTIONS.range };
}

export function savePrintOptions(opts: PrintOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(opts));
  } catch {
    /* storage unavailable: options simply don't persist */
  }
}

/** Coerce arbitrary stored JSON back into a valid `PrintOptions`. */
export function sanitizePrintOptions(v: unknown): PrintOptions {
  const o = (v && typeof v === "object" ? v : {}) as Partial<PrintOptions>;
  const pick = <T extends string>(val: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(val as T) ? (val as T) : fallback;
  return {
    paper: pick(o.paper, Object.keys(PAPER_CM) as PaperSize[], DEFAULT_PRINT_OPTIONS.paper),
    orientation: pick(o.orientation, ["portrait", "landscape"], DEFAULT_PRINT_OPTIONS.orientation),
    margin: pick(o.margin, ["none", "narrow", "normal", "wide"], DEFAULT_PRINT_OPTIONS.margin),
    scale: clampScale(typeof o.scale === "number" ? o.scale : DEFAULT_PRINT_OPTIONS.scale),
    pages: pick(o.pages, ["all", "odd", "even", "custom"], DEFAULT_PRINT_OPTIONS.pages),
    range: typeof o.range === "string" ? o.range : "",
    grayscale: o.grayscale === true,
    background: o.background !== false,
    pageNumbers: o.pageNumbers === true,
  };
}

function clampScale(n: number): number {
  if (!Number.isFinite(n)) return 100;
  return Math.min(400, Math.max(10, Math.round(n)));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Assemble a complete, self-contained print document. Pure (no DOM), so the
 * scaffolding + escaping is unit-testable. `bodyHtml` is trusted markup the
 * caller has already sanitised/escaped; `css` is inlined into a <style> after a
 * small print-oriented base (page margins, reset). The print options are layered
 * on later, by `printDocument`, as an injected stylesheet.
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
 * standalone document that will print (WYSIWYG for paper), an options row with
 * the settings a printer dialog normally carries (paper, orientation, margins,
 * scale, page selection, backgrounds, grayscale, page numbers), and a Print
 * button that calls `print()` on the iframe's own window — so only the document,
 * not the surrounding app, prints. The overlay stays open after the dialog closes
 * (so the user can adjust and print again) and tears down on Close / backdrop
 * click / Escape, which is when the returned promise resolves.
 *
 * Page selection *and* rearranging are exact for *paged* documents — those built
 * out of `.print-page` elements (the PDF and image viewers) — because those pages
 * are real elements we can reorder, hide and drop. Those documents also get a
 * thumbnail strip for drag-to-reorder and per-page delete. Flowing documents
 * (markdown, text, HTML) have no such elements; there the page controls are
 * disabled and the system dialog's own range field does the job.
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

    // ── Options row ─────────────────────────────────────────────────────────
    let opts = loadPrintOptions();
    const optionsRow = document.createElement("div");
    optionsRow.className = "print-preview-options";

    const paper = selectField(
      "Paper",
      (Object.keys(PAPER_CM) as PaperSize[]).sort().map((p) => [p, p] as const),
      opts.paper,
      (v) => set({ paper: v as PaperSize }),
    );
    const orientation = selectField(
      "Layout",
      [
        ["portrait", "Portrait"],
        ["landscape", "Landscape"],
      ],
      opts.orientation,
      (v) => set({ orientation: v as Orientation }),
    );
    const margin = selectField(
      "Margins",
      [
        ["none", "None"],
        ["narrow", "Narrow"],
        ["normal", "Normal"],
        ["wide", "Wide"],
      ],
      opts.margin,
      (v) => set({ margin: v as MarginPreset }),
    );
    const scale = selectField(
      "Scale",
      SCALE_CHOICES.map((s) => [String(s), `${s}%`] as const),
      String(opts.scale),
      (v) => set({ scale: Number(v) }),
    );
    const pages = selectField(
      "Pages",
      [
        ["all", "All"],
        ["odd", "Odd"],
        ["even", "Even"],
        ["custom", "Custom"],
      ],
      opts.pages,
      (v) => set({ pages: v as PageSelection }),
    );

    const rangeInput = document.createElement("input");
    rangeInput.className = "print-opt-range";
    rangeInput.type = "text";
    rangeInput.placeholder = "e.g. 1-3, 5";
    rangeInput.value = opts.range;
    rangeInput.setAttribute("aria-label", "Page range");
    rangeInput.addEventListener("input", () => set({ range: rangeInput.value }));

    const background = checkField("Backgrounds", opts.background, (v) =>
      set({ background: v }),
    );
    const grayscale = checkField("Grayscale", opts.grayscale, (v) => set({ grayscale: v }));
    const pageNumbers = checkField("Page numbers", opts.pageNumbers, (v) =>
      set({ pageNumbers: v }),
    );

    optionsRow.append(
      paper.wrap,
      orientation.wrap,
      margin.wrap,
      scale.wrap,
      pages.wrap,
      rangeInput,
      background.wrap,
      grayscale.wrap,
      pageNumbers.wrap,
    );

    // ── Page strip (paged documents only) ───────────────────────────────────
    const strip = document.createElement("div");
    strip.className = "print-preview-strip";
    strip.hidden = true;

    const stripHint = document.createElement("span");
    stripHint.className = "print-strip-hint";
    stripHint.textContent =
      "Drag to reorder · shift-click for a range · ⟳ turns a page · ✕ removes it";

    const resetBtn = document.createElement("button");
    resetBtn.className = "print-strip-reset";
    resetBtn.type = "button";
    resetBtn.textContent = "Reset pages";
    resetBtn.addEventListener("click", () => {
      arrangement = initialPages(pageEls.length);
      opts = { ...opts, pages: "all", range: "" };
      pages.select.value = "all";
      rangeInput.value = "";
      apply();
    });

    const stripBar = document.createElement("div");
    stripBar.className = "print-strip-bar";
    stripBar.append(stripHint, resetBtn);

    const stripPages = document.createElement("div");
    stripPages.className = "print-strip-pages";
    strip.append(stripBar, stripPages);

    actions.append(printBtn, closeBtn);
    titlebar.append(title, actions);
    dialog.append(titlebar, optionsRow, strip, iframe);
    backdrop.append(dialog);

    // ── Live state of the previewed document ────────────────────────────────
    let frameWin: Window | null = null;
    let styleEl: HTMLStyleElement | null = null;
    /** Page elements indexed by original page number − 1; never reordered. */
    let pageEls: HTMLElement[] = [];
    /** Working arrangement (see `pageModel`): the sheets, moved/dropped/turned by
     *  the strip. Every entry's `src` is SELF — a print job never merges documents. */
    let arrangement: PageList = [];
    let ready = false; // images decoded — safe to print
    /** The mounted <PageStrip>; created on the first paged render. */
    let stripUi: MountedPageStrip | null = null;

    const NO_PAGES_HINT =
      "This document has no fixed pages — use the system print dialog's page range.";

    /** Push the arrangement + options into the previewed document and the UI. */
    const apply = () => {
      savePrintOptions(opts);
      const paged = pageEls.length > 0;
      pages.select.disabled = !paged;
      pageNumbers.input.disabled = !paged;
      rangeInput.disabled = !paged || opts.pages !== "custom";
      pages.wrap.title = paged ? "" : NO_PAGES_HINT;
      pageNumbers.wrap.title = paged ? "" : NO_PAGES_HINT;
      rangeInput.title = paged ? "" : NO_PAGES_HINT;
      strip.hidden = !paged;
      resetBtn.disabled = isPristine(arrangement, pageEls.length) && opts.pages === "all";

      if (styleEl) styleEl.textContent = buildOptionsCss(opts);

      // Cards take the sheet's proportions, so a landscape sheet gets a landscape
      // card instead of an upright one. Set on the host, inherited by the cards.
      const [thumbW, thumbH] = thumbSizePx(opts);
      stripPages.style.setProperty("--page-thumb-w", `${thumbW}px`);
      stripPages.style.setProperty("--page-thumb-h", `${thumbH}px`);

      const sequence = printSequence(arrangement, opts);
      const printing = new Set(sequence.map((r) => r.page));
      const parent = pageEls[0]?.parentElement ?? null;
      // `pageEls` is indexed by original page number − 1 and never reordered.
      pageEls.forEach((el, i) =>
        el.classList.toggle("eldrun-print-hidden", !printing.has(i + 1)),
      );
      // The DOM *is* the print order, so realise the arrangement by re-appending
      // the pages in sequence. The page break is set inline per page rather than
      // left to `.print-page + .print-page`, whose sibling match would also fire
      // on the first printed page when a removed one still precedes it in the DOM
      // — one blank leading sheet.
      sequence.forEach((ref, i) => {
        const el = pageEls[ref.page - 1];
        if (!el) return;
        parent?.appendChild(el);
        el.style.pageBreakBefore = i === 0 ? "auto" : "always";
        el.style.breakBefore = i === 0 ? "auto" : "page";
        el.setAttribute("data-page", String(i + 1));
        el.classList.remove("eldrun-rot-90", "eldrun-rot-180", "eldrun-rot-270");
        if (ref.rot) el.classList.add(`eldrun-rot-${ref.rot}`);
      });

      // Safe to re-render mid-drag: React reorders the SAME card elements (they are
      // keyed by page id), so the dragged card keeps its identity — and its grab.
      renderStrip(sequence);

      if (!ready) return;
      const empty = paged && sequence.length === 0;
      printBtn.disabled = empty;
      printBtn.textContent = empty
        ? "No pages selected"
        : paged && sequence.length < pageEls.length
          ? `🖨 Print (${sequence.length} ${sequence.length === 1 ? "page" : "pages"})`
          : "🖨 Print";
    };

    /** Merge an option change and re-apply. */
    const set = (patch: Partial<PrintOptions>) => {
      opts = { ...opts, ...patch };
      apply();
    };

    /**
     * Push the current arrangement into the strip.
     *
     * The strip is the shared `<PageStrip>` — the very component the PDF viewer's
     * page rail uses — so dragging, shift-selecting, turning and deleting pages
     * behave the same in both. It owns the gesture and reports each edit back
     * through `onChange`; `arrangement` (and thus the preview) follows.
     */
    const renderStrip = (sequence: PageList) => {
      if (pageEls.length === 0) return;
      const printing = new Set(sequence.map((r) => r.id));
      const props: PageStripProps = {
        pages: arrangement,
        orientation: "row",
        onChange: (next) => {
          arrangement = next;
          apply();
        },
        // The thumbnail is the page's own already-rasterised image, taken straight
        // from the previewed document (the PDF viewer rasterises pages itself).
        renderThumb: (ref) => {
          const src = pageEls[ref.page - 1]?.querySelector("img")?.src;
          return src
            ? createElement("img", { src, alt: "" })
            : createElement("span", { className: "page-strip-blank" }, String(ref.page));
        },
        badgeFor: (ref) =>
          printing.has(ref.id)
            ? String(sequence.findIndex((r) => r.id === ref.id) + 1)
            : "—",
        isExcluded: (ref) => !printing.has(ref.id),
        titleFor: (ref) =>
          `Page ${ref.page} of the original document` +
          (ref.rot ? ` · turned ${ref.rot}°` : ""),
      };
      if (stripUi) stripUi.update(props);
      else stripUi = mountPageStrip(stripPages, props);
    };

    // ── Teardown (single-shot) ──────────────────────────────────────────────
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKeyDown);
      stripUi?.destroy();
      stripUi = null;
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

    printBtn.addEventListener("click", () => {
      if (printBtn.disabled || !frameWin) return;
      try {
        frameWin.focus();
        frameWin.print();
      } catch {
        /* printing unsupported / dialog refused: leave preview open */
      }
    });

    iframe.onload = () => {
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!win || !doc) return;
      frameWin = win;

      // Injected last, so it wins over the document's own rules at equal
      // specificity — including for documents Eldrun did not assemble.
      styleEl = doc.createElement("style");
      styleEl.id = "eldrun-print-options";
      (doc.head ?? doc.documentElement).appendChild(styleEl);

      pageEls = Array.from(doc.querySelectorAll<HTMLElement>(".print-page"));
      arrangement = initialPages(pageEls.length);
      apply(); // style the preview immediately; the button stays "Preparing…"

      Promise.all(
        Array.from(doc.images).map((img) =>
          Promise.resolve(img.decode?.()).catch(() => {
            /* broken/missing image: preview what loaded rather than block */
          }),
        ),
      ).then(() => {
        if (done) return;
        ready = true;
        apply();
      });
    };

    document.body.appendChild(backdrop);
    iframe.srcdoc = fullHtml;
  });
}

/** A labelled `<select>` for the options row. */
function selectField(
  label: string,
  choices: readonly (readonly [string, string])[],
  value: string,
  onChange: (value: string) => void,
): { wrap: HTMLLabelElement; select: HTMLSelectElement } {
  const wrap = document.createElement("label");
  wrap.className = "print-opt";
  const text = document.createElement("span");
  text.className = "print-opt-label";
  text.textContent = label;
  const select = document.createElement("select");
  select.className = "print-opt-select";
  for (const [v, l] of choices) {
    const option = document.createElement("option");
    option.value = v;
    option.textContent = l;
    select.appendChild(option);
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  wrap.append(text, select);
  return { wrap, select };
}

/** A labelled checkbox for the options row. */
function checkField(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const wrap = document.createElement("label");
  wrap.className = "print-opt print-opt-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const text = document.createElement("span");
  text.className = "print-opt-label";
  text.textContent = label;
  wrap.append(input, text);
  return { wrap, input };
}

/** Convenience: build the document from a body + css and print it. */
export function printHtmlBody(bodyHtml: string, css: string, title?: string): Promise<void> {
  return printDocument(buildPrintDoc(bodyHtml, css, title));
}

/**
 * Rasterise an ARRANGEMENT — the sheets the PDF viewer is currently showing, in its
 * current order and with its turns applied — to PNG data URLs for printing, pulling
 * each sheet from its own already-open pdf.js document. So printing an edited PDF
 * prints what you see, without first having to save it. `scale` trades size for print
 * sharpness (~2× ≈ good on paper).
 */
export async function renderPdfPagesToImages(
  refs: readonly { src: string; page: number; rot: number }[],
  docFor: (src: string) => PDFDocumentProxy | undefined,
  scale = 2,
): Promise<string[]> {
  const urls: string[] = [];
  for (const ref of refs) {
    const doc = docFor(ref.src);
    if (!doc) continue;
    const page = await doc.getPage(ref.page);
    // The viewer's turn rides ON TOP of whatever the page already carried, and
    // pdf.js' `rotation` is the total — so the two are added, not substituted.
    const viewport = page.getViewport({
      scale,
      rotation: (((page.rotate + ref.rot) % 360) + 360) % 360,
    });
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
