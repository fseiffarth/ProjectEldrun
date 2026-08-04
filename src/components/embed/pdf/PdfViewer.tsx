/**
 * The in-app PDF viewer: a pdf.js canvas stack with a zoom/fit toolbar, Ctrl+F
 * find (#71), print, and bidirectional SyncTeX (#66).
 *
 * Lifted verbatim out of `FileViewerPane` (which had grown past 6.6k lines) to give
 * the page-arrangement work a home of its own. Behaviour is unchanged.
 *
 * Like the sibling viewers (`TableView`, `OdtView`, `NotebookView`), this imports
 * shared viewer plumbing back from `FileViewerPane`; the resulting import cycle is
 * the established pattern here and is safe because every use is at call time.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { usePdfSyncStore } from "../../../stores/pdfSync";
import { useScrollSync } from "../../../stores/scrollSync";
import {
  useFileScope,
  usePaneVisible,
  readFileBytes,
  readFileText,
  writeFileBytes,
  fileMtime,
  describeFileError,
} from "../fileAccess";
import { useExperimental } from "../../../lib/experimental";
import { emptyDeck } from "../../../lib/viewers/deck/model";
import { deckPathForPdf, serializeDeck } from "../../../lib/viewers/deck/sidecar";
import { jumpToSource, SaveButton, useViewerState } from "../FileViewerPane";
import {
  renderPdfPagesToImages,
  printHtmlBody,
  PDF_PRINT_CSS,
} from "../../../lib/viewers/print";
import {
  SELF,
  initialPages,
  insertPages,
  deletePages,
  pagesOf,
  isPristine,
  type PageList,
  type RedactRect,
} from "../../../lib/viewers/pageModel";
import {
  rectFromDrag,
  isDraggedFar,
  snapToText,
  addMark,
  removeMark,
  clearMarks,
  markMatches,
  markCount,
  markedSheetCount,
  type Rect,
} from "../../../lib/viewers/redact";
import {
  openSource,
  newSourceId,
  buildPdf,
  readPdfMetadata,
  REDACT_DEFAULT_DPI,
  type PdfSources,
  type PdfMetadata,
} from "./pdfDoc";
import {
  loadOutline,
  detectHeadings,
  flattenOutline,
  outlineIsNavigable,
  type OutlineNode,
  type HeadingRun,
  type PdfDest,
} from "./outline";
import { loadPageLinks, destTopInBigPoints, type PdfLink } from "./links";
import { PdfLinkConfirmDialog } from "./PdfLinkDialog";
import { openRoutedUri } from "../../../lib/linkTarget";
import { useSettingsStore } from "../../../stores/settings";
import { PageStrip } from "../../common/PageStrip";
import { PrinterIcon } from "../../common/PrinterIcon";
import { UntestedTag } from "../../common/UntestedTag";
import { subscribePageDragActive, type PageTransfer } from "../../../stores/pdfDrag";
import { ContextFilePicker } from "../ContextFilePicker";
import { useProjectsStore } from "../../../stores/projects";
import { resolveProjectDirectory } from "../../../types";
import { basename, dirname, isPathWithin } from "../../../lib/paths";
import {
  pdfPageMatches,
  pdfPointToBigPoints,
  bigPointsToCssRect,
  synctexEdit,
  resolveTexRoot,
  refineToWord,
  type SyncRect,
  type SyncSource,
  type TextItemBox,
  type CaretPhrase,
} from "../../../lib/viewers/tex";
import { useT, type TranslationKey } from "../../../lib/i18n";

// pdf.js renders pages on a worker; point it at the bundled worker asset. Vite
// emits a hashed URL that resolves in both dev and the packaged Tauri build.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** How often the open PDF re-checks its file's mtime for an on-disk change (a
 *  LaTeX recompile rewrites the very bytes this tab is showing). Mirrors the
 *  other viewers' poll interval. */
const RELOAD_POLL_MS = 1500;

/** A recompile rewrites the PDF in place, so a reload can catch the file
 *  mid-write and pdf.js throws `InvalidPDFException: Invalid PDF structure` on
 *  the truncated bytes. That is transient — the write finishes in well under a
 *  second — so a failed parse is retried a few times before it counts as a real
 *  error, at this spacing, while the last good document stays on screen. */
const RELOAD_RETRY_MS = 250;
const RELOAD_MAX_RETRIES = 12;

const PDF_MIN_SCALE = 0.1;
const PDF_MAX_SCALE = 8;
const PDF_ZOOM_STEP = 1.2;
const clampPdfScale = (s: number) => Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, s));

/** The eight standard `/Info` field names, bound to their wording (#pdf-meta). A
 *  map rather than a derived key, because these are the only names in the dict that
 *  belong to the format: everything else is the producer's own invention, and the
 *  lookup missing is how the panel knows to print the raw name instead. */
const META_FIELD_KEYS: Record<string, TranslationKey> = {
  Title: "pdfMeta.field.Title",
  Author: "pdfMeta.field.Author",
  Subject: "pdfMeta.field.Subject",
  Keywords: "pdfMeta.field.Keywords",
  Creator: "pdfMeta.field.Creator",
  Producer: "pdfMeta.field.Producer",
  CreationDate: "pdfMeta.field.CreationDate",
  ModDate: "pdfMeta.field.ModDate",
};

/**
 * Extract a PDF page's positioned text runs as {@link TextItemBox}es in big
 * points (scale-1 viewport, top-left origin). Each box hugs the glyph band
 * (ascender→descender, ≈0.8 em up / 0.2 em down of the baseline) so an overlay
 * sits on the text rather than riding high over it. Shared by SyncTeX word
 * refinement and Ctrl+F search so both box the text identically.
 *
 * `rot` is the turn the viewer has applied to this sheet. The boxes are measured in
 * the SAME rotated space the canvas is painted in, so a search hit still lands on its
 * word after the page has been turned.
 */
async function pageTextItemBoxes(
  doc: PDFDocumentProxy,
  pageNumber: number,
  rot = 0,
): Promise<TextItemBox[]> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({
    scale: 1,
    rotation: (((page.rotate + rot) % 360) + 360) % 360,
  });
  const content = await page.getTextContent();
  const items: TextItemBox[] = [];
  for (const it of content.items) {
    // Skip marked-content markers (no `str`/`transform`).
    if (!("str" in it) || typeof it.str !== "string" || !it.str) continue;
    const tx = pdfjs.Util.transform(viewport.transform, it.transform);
    const em = Math.hypot(tx[2], tx[3]); // scaled font size (em) in big points
    const ascent = em * 0.8;
    const descent = em * 0.2;
    items.push({ str: it.str, x: tx[4], y: tx[5] - ascent, w: it.width, h: ascent + descent });
  }
  return items;
}

/** Height in CSS px of a page rail thumbnail. The width follows the page's aspect. */
const RAIL_THUMB_H = 96;

// Distinguishes two viewers showing the SAME file (a split view), which would
// otherwise collide on a tabKey/path-derived strip id.
let stripSeq = 0;
const nextStripId = () => ++stripSeq;

/**
 * One page rail thumbnail.
 *
 * Rendered LAZILY: a rail over a 500-page document would otherwise rasterise 500
 * pages the moment it opens. An IntersectionObserver paints each thumbnail only once
 * it is near the visible part of the rail, and the card reserves its box beforehand
 * so the rail's scroll height is right from the start.
 */
function PdfThumb({
  doc,
  page,
  rot,
  marks,
}: {
  doc?: PDFDocumentProxy;
  page: number;
  rot: number;
  /** Pending blackouts on this sheet (#pdf-redact) — painted onto the thumbnail so
   *  the rail shows the same page the reader does. */
  marks?: readonly RedactRect[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true); // no observer (tests/jsdom): just render
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { root: null, rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near || !doc) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    void (async () => {
      const p = await doc.getPage(page);
      if (cancelled) return;
      const rotation = (((p.rotate + rot) % 360) + 360) % 360;
      const base = p.getViewport({ scale: 1, rotation });
      const viewport = p.getViewport({
        scale: RAIL_THUMB_H / (base.height || 1),
        rotation,
      });
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      task = p.render({ canvasContext: ctx, viewport });
      try {
        await task.promise;
      } catch {
        /* superseded by a newer render — ignore */
      }
      if (cancelled || !marks?.length) return;
      ctx.fillStyle = "#000000";
      for (const m of marks) {
        ctx.fillRect(
          m.x * viewport.scale,
          m.y * viewport.scale,
          m.w * viewport.scale,
          m.h * viewport.scale,
        );
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, doc, page, rot, marks]);

  // pdf.js has ALREADY painted this canvas at the sheet's rotation, so the card must
  // not turn it again in CSS — that is why the strip's rotate transform is scoped to
  // `img` (which the print strip needs, its thumbnails being flat page images).
  return <canvas ref={canvasRef} className="page-strip-canvas" />;
}

/** One PDF page rendered to a canvas at `scale` (× devicePixelRatio for
 *  crispness). Re-renders when the page or scale changes; cancels an in-flight
 *  render on cleanup so rapid zooming doesn't paint stale frames. */
function PdfPageCanvas({
  doc,
  pageNumber,
  rot = 0,
  scale,
  cssSize,
  onSyncClick,
  syncArmed,
  highlight,
  onReveal,
  searchMatches,
  searchScrollNonce,
  onLink,
  destMark,
  marks,
  redacting,
  copySelecting,
  textItems,
  onRedactAdd,
  onRedactRemove,
  onCopySelection,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  /** The turn the viewer has applied to this sheet, on top of the page's own
   *  `/Rotate`. pdf.js takes the TOTAL rotation, so the two are added. */
  rot?: number;
  scale: number;
  /** This page's intrinsic (scale-1) CSS dimensions, if known. Used to RESERVE
   *  the canvas's on-screen size immediately — before its async render fills
   *  pixels — so the page stack reaches its true scroll height right away. Without
   *  this the canvas defaults to ~150px until rendered, so the container height
   *  grows page-by-page and a deep restored scroll position is unreachable until
   *  every page above it has rendered (#viewerpos PDF restore). */
  cssSize?: { w: number; h: number };
  /** SyncTeX reverse search: a click maps to big points on this page. */
  onSyncClick?: (page: number, xBp: number, yBp: number) => void;
  /** True while Ctrl/⌘ is held, so the page shows the reverse-search cursor. */
  syncArmed?: boolean;
  /** SyncTeX forward search: when this page is the target, the box (big points)
   *  to scroll into view and flash. `nonce` re-triggers a repeat reveal.
   *  `phrase`, when set, narrows the box to the clicked word via the page's text
   *  content (using the surrounding words to disambiguate). */
  highlight?: { rect: SyncRect; nonce: number; phrase?: CaretPhrase } | null;
  /** Explicit navigation supersedes a same-path reload's scroll restoration. */
  onReveal?: () => void;
  /** Ctrl+F search hits on THIS page: each match is its constituent boxes (big
   *  points), and `current` marks the one the find bar is parked on (#71).
   *  Painted as translucent overlays over the canvas. */
  searchMatches?: { rects: SyncRect[]; current: boolean }[];
  /** Bumped when the current search match lands on this page, so the current
   *  match's box scrolls into view (mirrors the SyncTeX reveal). */
  searchScrollNonce?: number;
  /** A link on this page was clicked (#pdf-links). Without a handler the page
   *  carries no link layer at all — the rule the rest of this viewer follows for
   *  an action its host cannot honour. */
  onLink?: (link: PdfLink) => void;
  /** A band marking where an internal link just landed, in big points from the
   *  page top; `nonce` re-triggers the fade for a repeat jump to the same spot. */
  destMark?: { top: number; nonce: number } | null;
  /** Areas already marked for blacking out on this sheet (#pdf-redact), in big
   *  points. Drawn solid black whether or not the tool is armed: a mark is what the
   *  saved page will look like, and showing it only in an editing mode would hide
   *  from the reader exactly what is about to be destroyed. */
  marks?: readonly RedactRect[];
  /** The blackout tool is armed: a drag over the page marks an area. */
  redacting?: boolean;
  /** The image-copy tool is armed: a drag copies that page region as a PNG. */
  copySelecting?: boolean;
  /** This page's text runs (big points), so a drag can be snapped out to whole
   *  words. Absent = mark exactly what was dragged. */
  textItems?: readonly TextItemBox[];
  /** A drag finished: `rect` is in big points, already snapped. */
  onRedactAdd?: (rect: Rect) => void;
  /** A mark was clicked while the tool is armed. */
  onRedactRemove?: (markId: string) => void;
  /** A selected page region has been rasterised into a PNG. */
  onCopySelection?: (png: Uint8Array) => void;
}) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const searchCurrentRef = useRef<HTMLDivElement>(null);
  // A SyncTeX box narrowed to the clicked word (when `highlight.phrase` is set and
  // found in this page's text), else null → the original line box is used.
  const [refined, setRefined] = useState<SyncRect | null>(null);
  // A transient marker at the point the user reverse-search-clicked (CSS px within
  // the page wrapper), giving the jump visible feedback on the PDF side; it
  // auto-clears after ~2s. `nonce` re-triggers the fade for a repeat click on the
  // same spot. See `onClick`.
  const [clickMark, setClickMark] = useState<{ left: number; top: number; nonce: number } | null>(null);
  const clickTimer = useRef<number | null>(null);
  useEffect(() => () => { if (clickTimer.current != null) window.clearTimeout(clickTimer.current); }, []);

  // Rasterise LAZILY, the way the page rail's PdfThumb already does. Every page
  // is MOUNTED (so search/scroll-restore/syncTeX can address any of them), but a
  // full-resolution page canvas is several MB of backing store — painting all of
  // a 300-page document at once holds gigabytes and hands the compositor hundreds
  // of large layers to juggle on every scroll frame, which is the scroll jank
  // (and the renderer-memory blowup). An IntersectionObserver paints each page
  // only while it is near the viewport; the wrapper's box stays reserved by
  // `cssSize`, so scroll height, search scroll-into-view and link jumps are
  // unaffected. In jsdom (tests) there is no observer, so it renders eagerly as
  // before.
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      // A generous margin paints a page a screenful or two before it scrolls into
      // view (no blank flash in normal scrolling) and drops it once well past.
      { root: null, rootMargin: "150% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    // Scrolled well away: release the backing store (keeping the reserved CSS
    // box) so a long document holds only the pages around the viewport. Repainted
    // on return.
    if (!near) {
      const canvas = canvasRef.current;
      if (canvas && canvas.width > 0) {
        canvas.width = 0;
        canvas.height = 0;
      }
      return;
    }
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({
        scale: scale * dpr,
        rotation: (((page.rotate + rot) % 360) + 360) % 360,
      });
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      task = page.render({ canvasContext: ctx, viewport });
      try {
        await task.promise;
      } catch {
        /* render cancelled by a newer scale — ignore */
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, rot, scale, near]);

  // The page's own hyperlinks (#pdf-links). Keyed off the sheet and its turn but
  // NOT off `scale` — the boxes are stored in big points and multiplied into CSS
  // pixels at render, exactly as the search hits are, so zooming never re-reads
  // the annotations.
  const [links, setLinks] = useState<PdfLink[]>([]);
  useEffect(() => {
    // Gated on `near` for the render effect's reason: reading every page's
    // annotations on load is wasted work, and a link can't be clicked on a page
    // that isn't near the viewport anyway.
    if (!onLink || !near) {
      setLinks([]);
      return;
    }
    let cancelled = false;
    setLinks([]);
    void loadPageLinks(doc, pageNumber, rot).then((ls) => {
      if (!cancelled) setLinks(ls);
    });
    return () => {
      cancelled = true;
    };
    // `onLink` is only read for its presence; a caller re-creating it must not
    // re-read every page's annotations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageNumber, rot, onLink == null, near]);

  // Narrow the SyncTeX line box to the clicked word: pull this page's text runs
  // (big points, top-left origin, at viewport scale 1) and find the word nearest
  // the line box. Best-effort — on no match (or no word) the original box stands.
  useEffect(() => {
    setRefined(null);
    const phrase = highlight?.phrase;
    if (!highlight || !phrase) return;
    let cancelled = false;
    (async () => {
      try {
        const items = await pageTextItemBoxes(doc, pageNumber);
        if (cancelled) return;
        const r = refineToWord(highlight.rect, phrase, items);
        if (!cancelled && r) setRefined(r);
      } catch {
        /* fall back to the synctex box */
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.nonce]);

  // Scroll a forward-search target into view on a new nonce. Center the
  // highlight *box*, not the whole page — on a tall page the target line can sit
  // far from page-center, which is what made the jump feel imprecise.
  useEffect(() => {
    if (!highlight) return;
    onReveal?.();
    (boxRef.current ?? wrapRef.current)?.scrollIntoView({ block: "center", inline: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.nonce]);

  // Ctrl+F: scroll the current match into view when the find bar parks it on this
  // page (`searchScrollNonce` bumps). All pages are mounted, so the target page's
  // box is always present to scroll to.
  useEffect(() => {
    if (!searchScrollNonce) return;
    searchCurrentRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [searchScrollNonce]);

  // Reverse search, by client coordinates rather than by the event's own target:
  // the link layer sits ON TOP of the canvas, so a Ctrl-click that lands on a
  // link box must still map to the same point on the page. Measuring the canvas
  // explicitly is what lets both callers share one implementation.
  const syncClickAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!onSyncClick || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const { x, y } = pdfPointToBigPoints(rect, clientX, clientY, scale);
    // Mark the clicked point so the source-jump has feedback on the PDF side; the
    // canvas sits flush at the wrapper's top-left, so canvas-local offsets are
    // wrapper-local. Clear any prior marker's timer and fade out after ~2s.
    setClickMark((m) => ({
      left: clientX - rect.left,
      top: clientY - rect.top,
      nonce: (m?.nonce ?? 0) + 1,
    }));
    if (clickTimer.current != null) window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => setClickMark(null), 2000);
    onSyncClick(pageNumber, x, y);
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // Reverse search is a Ctrl/⌘-click affordance; plain clicks stay free for
    // text selection in the PDF.
    if (!onSyncClick || !(e.ctrlKey || e.metaKey)) return;
    syncClickAt(e.clientX, e.clientY);
  };

  // ── Blacking an area out (#pdf-redact) ──────────────────────────────────
  // The gesture is a plain drag over the page, tracked in big points so the box the
  // reader is drawing means the same thing at any zoom. Pointer events, not HTML5
  // DnD (WebKitGTK), with the capture taken by the layer itself — it is mounted for
  // the whole gesture, unlike the canvas underneath, which re-renders on zoom.
  const [dragBox, setDragBox] = useState<Rect | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const pointInPage = (clientX: number, clientY: number) => {
    const el = wrapRef.current ?? canvasRef.current;
    const rect = el?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  };

  const onRedactDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!redacting || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = pointInPage(e.clientX, e.clientY);
    dragStart.current = start;
    setDragBox({ ...start, w: 0, h: 0 });
  };

  const onRedactMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    setDragBox(rectFromDrag(dragStart.current, pointInPage(e.clientX, e.clientY)));
  };

  // `pointercancel` commits as well as `pointerup`: on this engine a gesture can end
  // with either (the same trap the tab and card drags document), and a drag that
  // silently did nothing would leave the reader believing an area is covered. The
  // commit is safe under both — a box that was not wanted is one click away from
  // gone, and Ctrl+Z covers it too.
  const onRedactUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    dragStart.current = null;
    setDragBox(null);
    if (!start) return;
    const drawn = rectFromDrag(start, pointInPage(e.clientX, e.clientY));
    // The threshold is in CSS pixels, so "that was a click, not a drag" means the
    // same thing whether the page is at 40% or 400%.
    if (!isDraggedFar(drawn, 3 / scale)) return;
    onRedactAdd?.(textItems ? snapToText(drawn, textItems) : drawn);
  };

  // ── Select a region and copy it as an image ──────────────────────────────
  // Geometry stays in big points while dragging, just like redaction, but the
  // copied pixels come from the already-rendered page canvas. That makes the
  // clipboard image exactly as sharp as the visible page (including DPR) without
  // asking pdf.js to render a second full page for every selection.
  const [copyBox, setCopyBox] = useState<Rect | null>(null);
  const copyStart = useRef<{ x: number; y: number } | null>(null);

  const pointInCanvas = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.min(Math.max(clientX - rect.left, 0), rect.width) / scale,
      y: Math.min(Math.max(clientY - rect.top, 0), rect.height) / scale,
    };
  };

  const selectionPng = async (selected: Rect): Promise<Uint8Array | null> => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const pxX = canvas.width / rect.width;
    const pxY = canvas.height / rect.height;
    const sx = Math.max(0, Math.floor(selected.x * scale * pxX));
    const sy = Math.max(0, Math.floor(selected.y * scale * pxY));
    const sw = Math.min(canvas.width - sx, Math.max(1, Math.ceil(selected.w * scale * pxX)));
    const sh = Math.min(canvas.height - sy, Math.max(1, Math.ceil(selected.h * scale * pxY)));
    if (sw <= 0 || sh <= 0) return null;

    const out = document.createElement("canvas");
    out.width = sw;
    out.height = sh;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

    // Pending blackouts are overlays rather than canvas pixels. Burn their
    // intersection into the clipboard crop so copying a page that visibly hides
    // sensitive text cannot reveal that text in the pasted image.
    if (marks?.length) {
      ctx.fillStyle = "#000000";
      for (const mark of marks) {
        const left = Math.max(mark.x, selected.x);
        const top = Math.max(mark.y, selected.y);
        const right = Math.min(mark.x + mark.w, selected.x + selected.w);
        const bottom = Math.min(mark.y + mark.h, selected.y + selected.h);
        if (right <= left || bottom <= top) continue;
        ctx.fillRect(
          (left - selected.x) * scale * pxX,
          (top - selected.y) * scale * pxY,
          (right - left) * scale * pxX,
          (bottom - top) * scale * pxY,
        );
      }
    }

    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  };

  const onCopyDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!copySelecting || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = pointInCanvas(e.clientX, e.clientY);
    copyStart.current = start;
    setCopyBox({ ...start, w: 0, h: 0 });
  };
  const onCopyMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!copyStart.current) return;
    setCopyBox(rectFromDrag(copyStart.current, pointInCanvas(e.clientX, e.clientY)));
  };
  const onCopyUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = copyStart.current;
    copyStart.current = null;
    setCopyBox(null);
    if (!start) return;
    const selected = rectFromDrag(start, pointInCanvas(e.clientX, e.clientY));
    if (!isDraggedFar(selected, 3 / scale)) return;
    void selectionPng(selected).then((png) => {
      if (png) onCopySelection?.(png);
    });
  };

  const box = highlight ? bigPointsToCssRect(refined ?? highlight.rect, scale) : null;

  return (
    <div className="file-viewer-pdf-page-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={`file-viewer-pdf-page${onSyncClick && syncArmed ? " is-syncable" : ""}`}
        // Reserve the page's true size up-front (the async render sets the same
        // values once pixels are ready), so the stack's scroll height is correct
        // immediately and a restored scroll position is reachable on the first
        // ResizeObserver tick rather than only after every page has rendered.
        style={cssSize ? { width: cssSize.w * scale, height: cssSize.h * scale } : undefined}
        onClick={onClick}
      />
      {searchMatches?.map((m, mi) =>
        m.rects.map((r, ri) => {
          const css = bigPointsToCssRect(r, scale);
          // Anchor the scroll ref on the first box of the current match.
          const ref = m.current && ri === 0 ? searchCurrentRef : undefined;
          return (
            <div
              key={`s-${mi}-${ri}`}
              ref={ref}
              className={`file-viewer-pdf-search-hit${m.current ? " current" : ""}`}
              style={{ left: css.left, top: css.top, width: css.width, height: css.height }}
            />
          );
        }),
      )}
      {/* The link layer (#pdf-links), above the canvas and below the highlights.
          Each box is a real <button>, so a link is reachable by keyboard and
          announced as an action — a bare <div> with an onClick would be neither.
          A Ctrl/⌘-click on one still performs SyncTeX reverse search rather than
          following the link: the modifier is the reverse-search gesture over the
          WHOLE page, and a `\ref` sitting where the user clicked must not steal
          it.

          The boxes are PAINTED, not invisible-until-hovered: a link nobody can
          see is a link nobody clicks, and a reader looking for the equation a
          `\ref` points at should not have to sweep the pointer across the page
          to find out that the number is one. The class carries the link's *role*
          (`ref` / `cite` / external) because that is what the colour says —
          the same three-way split `hyperref`'s own `colorlinks` makes. */}
      {links.map((l) => {
        const css = bigPointsToCssRect(l.rect, scale);
        return (
          <button
            key={l.id}
            type="button"
            className={`file-viewer-pdf-link is-${l.kind}${
              l.kind === "internal" ? ` is-${l.role}` : ""
            }`}
            style={{ left: css.left, top: css.top, width: css.width, height: css.height }}
            title={
              l.kind === "external"
                ? t("pdfLinks.externalTitle", { url: l.url })
                : t(l.role === "cite" ? "pdfLinks.citeTitle" : "pdfLinks.internalTitle", {
                    page: l.dest.page,
                  })
            }
            onClick={(e) => {
              if ((e.ctrlKey || e.metaKey) && onSyncClick) {
                syncClickAt(e.clientX, e.clientY);
                return;
              }
              onLink?.(l);
            }}
          />
        );
      })}
      {destMark && (
        <div
          key={`dest-${destMark.nonce}`}
          className="file-viewer-pdf-dest-mark"
          style={{ top: destMark.top * scale }}
          aria-hidden="true"
        />
      )}
      {box && (
        <div
          key={highlight!.nonce}
          ref={boxRef}
          className="file-viewer-pdf-sync-highlight"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
      {clickMark && (
        <div
          key={`click-${clickMark.nonce}`}
          className="file-viewer-pdf-click-mark"
          style={{ left: clickMark.left, top: clickMark.top }}
        />
      )}
      {/* The blackout surface (#pdf-redact), under the marks so an armed click on an
          existing one removes it rather than starting a drag on top of it. */}
      {redacting && (
        <div
          className="file-viewer-pdf-redact-layer"
          onPointerDown={onRedactDown}
          onPointerMove={onRedactMove}
          onPointerUp={onRedactUp}
          onPointerCancel={onRedactUp}
        >
          {dragBox && (
            <div
              className="file-viewer-pdf-redact-draft"
              style={{
                left: dragBox.x * scale,
                top: dragBox.y * scale,
                width: dragBox.w * scale,
                height: dragBox.h * scale,
              }}
            />
          )}
        </div>
      )}
      {copySelecting && (
        <div
          className="file-viewer-pdf-copy-layer"
          style={cssSize ? { width: cssSize.w * scale, height: cssSize.h * scale } : undefined}
          onPointerDown={onCopyDown}
          onPointerMove={onCopyMove}
          onPointerUp={onCopyUp}
          onPointerCancel={onCopyUp}
        >
          {copyBox && (
            <div
              className="file-viewer-pdf-copy-draft"
              style={{
                left: copyBox.x * scale,
                top: copyBox.y * scale,
                width: copyBox.w * scale,
                height: copyBox.h * scale,
              }}
            />
          )}
        </div>
      )}
      {marks?.map((m) => {
        const css = bigPointsToCssRect({ page: pageNumber, ...m }, scale);
        const style = { left: css.left, top: css.top, width: css.width, height: css.height };
        // Armed, a mark is a real <button> so it is removable by keyboard as well as
        // by pointer; otherwise it is inert paint — the page underneath must stay
        // clickable for links and reverse search.
        return redacting ? (
          <button
            key={m.id}
            type="button"
            className="file-viewer-pdf-redact-box is-armed"
            style={style}
            title={t("pdfRedact.removeMarkTitle")}
            aria-label={t("pdfRedact.removeMarkTitle")}
            onClick={() => onRedactRemove?.(m.id)}
          />
        ) : (
          <div key={m.id} className="file-viewer-pdf-redact-box" style={style} aria-hidden="true" />
        );
      })}
      <div className="file-viewer-pdf-page-gap" aria-hidden="true">
        {pageNumber} / {doc.numPages}
      </div>
    </div>
  );
}

/**
 * One row of the contents sidebar, plus its children. A node with a resolved page
 * is a jump button; one without (an unresolvable destination) is inert text. A
 * node with children carries a ▸/▾ disclosure that toggles its subtree.
 */
/** The leading sign for a leaf row, one per level: a dot for the top tiers, a
 *  dash deeper down — the disclosure caret (a triangle) stands in for it on a row
 *  that has children, so a branch reads as ▸/▾, a mid leaf as •, a deep leaf as –. */
const leafSign = (depth: number) => (depth >= 2 ? "–" : "•");

function OutlineRow({
  node,
  depth,
  collapsed,
  currentId,
  onToggle,
  onJump,
  onHover,
}: {
  node: OutlineNode;
  depth: number;
  collapsed: Set<string>;
  currentId: string | null;
  onToggle: (id: string) => void;
  onJump: (page: number) => void;
  onHover: (page: number | null, rect: DOMRect | null) => void;
}) {
  const t = useT();
  const hasKids = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  return (
    <>
      <div
        className={`file-viewer-pdf-outline-row${node.id === currentId ? " current" : ""}${node.page == null ? " inert" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        {hasKids ? (
          <button
            className="file-viewer-pdf-outline-caret"
            onClick={() => onToggle(node.id)}
            aria-label={isCollapsed ? t("pdfOutline.expand") : t("pdfOutline.collapse")}
            title={isCollapsed ? t("pdfOutline.expand") : t("pdfOutline.collapse")}
          >
            {isCollapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span className="file-viewer-pdf-outline-caret is-sign" aria-hidden="true">
            {leafSign(depth)}
          </span>
        )}
        <button
          className={`file-viewer-pdf-outline-title depth-${Math.min(depth, 3)}`}
          onClick={() => node.page != null && onJump(node.page)}
          onMouseEnter={(e) =>
            node.page != null && onHover(node.page, e.currentTarget.getBoundingClientRect())
          }
          onMouseLeave={() => onHover(null, null)}
          disabled={node.page == null}
          title={node.page != null ? t("pdfOutline.titlePageSuffix", { title: node.title, page: node.page }) : node.title}
        >
          {node.title}
        </button>
      </div>
      {hasKids &&
        !isCollapsed &&
        node.children.map((c) => (
          <OutlineRow
            key={c.id}
            node={c}
            depth={depth + 1}
            collapsed={collapsed}
            currentId={currentId}
            onToggle={onToggle}
            onJump={onJump}
            onHover={onHover}
          />
        ))}
    </>
  );
}

/** Preview card width in CSS px; the thumbnail's height follows the page aspect. */
const OUTLINE_PREVIEW_W = 220;

/**
 * A floating thumbnail of a contents entry's page, shown while its row is
 * hovered. Renders the page once at preview width and memoises it in the shared
 * `cache` (keyed by file page), so re-hovering the same chapter is instant and a
 * long document only rasterises the pages actually pointed at.
 */
function OutlinePreview({
  doc,
  page,
  top,
  left,
  cache,
}: {
  doc: PDFDocumentProxy;
  page: number;
  top: number;
  left: number;
  cache: Map<number, string>;
}) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(() => cache.get(page) ?? null);
  useEffect(() => {
    const hit = cache.get(page);
    if (hit) {
      setUrl(hit);
      return;
    }
    setUrl(null);
    let cancelled = false;
    void (async () => {
      try {
        const p = await doc.getPage(page);
        if (cancelled) return;
        const base = p.getViewport({ scale: 1, rotation: p.rotate });
        const dpr = window.devicePixelRatio || 1;
        const scale = (OUTLINE_PREVIEW_W / (base.width || 1)) * dpr;
        const viewport = p.getViewport({ scale, rotation: p.rotate });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        await p.render({ canvasContext: ctx, viewport }).promise;
        if (cancelled) return;
        const data = canvas.toDataURL("image/png");
        cache.set(page, data);
        setUrl(data);
      } catch {
        /* leave the card in its loading state on a render failure */
      }
    })();
    return () => { cancelled = true; };
  }, [doc, page, cache]);

  return (
    <div className="file-viewer-pdf-outline-preview" style={{ top, left, width: OUTLINE_PREVIEW_W }}>
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : (
        <div className="file-viewer-pdf-outline-preview-loading">{t("pdfOutline.renderingPage", { page })}</div>
      )}
      <div className="file-viewer-pdf-outline-preview-cap">{t("pdfOutline.pageCaption", { page })}</div>
    </div>
  );
}

/**
 * The contents sidebar: the PDF's embedded outline (chapters/sections) as a
 * collapsible tree. Clicking an entry jumps the reader to its page; the entry
 * whose page is currently in view is highlighted; hovering an entry shows a
 * thumbnail of its page. A PDF with no outline shows a short notice.
 */
function OutlinePane({
  doc,
  nodes,
  placeholder,
  derived,
  currentId,
  onJump,
}: {
  /** The file's own document, for rendering hover previews (null while loading). */
  doc: PDFDocumentProxy | null;
  /** The chapters to show, or null while they're still being loaded/scanned. */
  nodes: OutlineNode[] | null;
  /** The message to show when there is nothing to render (loading or empty). */
  placeholder: string | null;
  /** True when `nodes` came from the font-size fallback, not an embedded outline. */
  derived: boolean;
  currentId: string | null;
  onJump: (page: number) => void;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Hover preview: a small debounce keeps a quick pass down the list from
  // rasterising every page it crosses; the card is placed just right of the pane
  // at the hovered row's height (clamped to stay on screen).
  const paneRef = useRef<HTMLDivElement>(null);
  const previewCache = useRef<Map<number, string>>(new Map());
  const [preview, setPreview] = useState<{ page: number; top: number; left: number } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const onHover = useCallback((page: number | null, rect: DOMRect | null) => {
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current);
    if (page == null || !rect) {
      setPreview(null);
      return;
    }
    hoverTimer.current = window.setTimeout(() => {
      const pane = paneRef.current?.getBoundingClientRect();
      const left = (pane?.right ?? rect.right) + 8;
      // Keep the card on screen: assume up to ~320px tall and nudge up if the row
      // sits near the bottom edge.
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - 328));
      setPreview({ page, top, left });
    }, 140);
  }, []);
  useEffect(
    () => () => { if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current); },
    [],
  );

  return (
    <div className="file-viewer-pdf-outline" ref={paneRef}>
      <div className="file-viewer-pdf-outline-head">
        <span>{t("pdfOutline.contentsHeader")}</span>
        <UntestedTag />
      </div>
      {derived && nodes && nodes.length > 0 && (
        <div className="file-viewer-pdf-outline-note" title={t("pdfOutline.derivedNoteTitle")}>
          {t("pdfOutline.derivedNote")}
        </div>
      )}
      <div
        className="file-viewer-pdf-outline-body"
        // A stale row rect after a scroll would misplace the card, so drop it.
        onScroll={() => setPreview(null)}
      >
        {placeholder != null ? (
          <div className="file-viewer-pdf-outline-empty">{placeholder}</div>
        ) : (
          nodes!.map((n) => (
            <OutlineRow
              key={n.id}
              node={n}
              depth={0}
              collapsed={collapsed}
              currentId={currentId}
              onToggle={toggle}
              onJump={onJump}
              onHover={onHover}
            />
          ))
        )}
      </div>
      {preview && doc && (
        <OutlinePreview
          doc={doc}
          page={preview.page}
          top={preview.top}
          left={preview.left}
          cache={previewCache.current}
        />
      )}
    </div>
  );
}

/**
 * Reusable pdf.js-backed PDF view: a zoom toolbar over a scrolling stack of page
 * canvases. Unlike the old native `<iframe>`, every surface here is ours, so the
 * surround and (via the global scrollbar rules) the scrollbar follow the app
 * theme — giving a dark viewer in dark themes while the pages stay as authored.
 *
 * The bytes at `path` can change under us — e.g. the LaTeX viewer recompiles the
 * PDF this tab is showing — so we poll `file_mtime` and reload when it advances,
 * the PDF counterpart to the editors' diff-aware reload (#43).
 */
function PdfCanvas({
  path,
  onOpenExternally,
  tabKey,
  groupId,
  onReverseSource,
}: {
  path: string;
  /** When set, an "Open externally" button is shown at the end of the toolbar.
   *  Used by the standalone PDF tab, which has no separate header row. */
  onOpenExternally?: () => void;
  /** This viewer tab's key, for #viewerpos scroll/zoom persistence. */
  tabKey?: string;
  /** Hosting subwindow (group) id, for proportional scroll-linking (scrollSync). */
  groupId?: string | null;
  /** SyncTeX reverse-search host seam. When present, a Ctrl/⌘-click on a page
   *  routes the resolved source location here (with the PDF's main-`.tex`
   *  `anchor`) INSTEAD of the module `jumpToSource` — the TeX workspace uses it
   *  to switch its own center to the producing child rather than open a tab.
   *  Absent ⇒ today's standalone behavior (a real source tab), so the plain PDF
   *  tab and its tests are unaffected. */
  onReverseSource?: (src: SyncSource, anchor: string) => void;
}) {
  const t = useT();
  const scope = useFileScope();
  const paneVisible = usePaneVisible();

  // "Present": turn this PDF into a deck — a sidecar of editable layers beside
  // it, plus the fullscreen presenter. Experimental, so the button is absent
  // unless the flag is on. Creating the sidecar is deliberately non-destructive:
  // the PDF is untouched, and an existing deck is opened rather than replaced.
  const deckEnabled = useExperimental("deck_presenter");
  // What an external link in the PDF is routed by (#33). Read here rather than at
  // the click so the routing sees the same settings the rest of the app does.
  const settings = useSettingsStore((s) => s.settings);
  const browserEnabled = useExperimental("web_browser");
  const mailEnabled = useExperimental("mail_client");
  const [makingDeck, setMakingDeck] = useState(false);
  const openAsDeck = useCallback(async () => {
    setMakingDeck(true);
    try {
      const deckPath = deckPathForPdf(path);
      let exists = true;
      try {
        await readFileText(deckPath, scope);
      } catch {
        exists = false;
      }
      if (!exists) {
        const deck = emptyDeck(basename(path));
        await writeFileBytes(
          deckPath,
          new TextEncoder().encode(serializeDeck(deck)),
          scope,
        );
      }
      // Imported lazily: `FileViewerPane` already imports this module, so a
      // static import would close a cycle. The call happens in a callback, long
      // after both modules have initialised, so deferring it costs nothing and
      // keeps the dependency one-way on paper — the same reason
      // `openProjectFilesTab` lives beside its tab rather than in the view.
      const { openLinkedFile } = await import("../FileViewerPane");
      openLinkedFile(tabKey, dirname(path) || "/", {
        path: deckPath,
        viewer: "eldeck",
        label: basename(deckPath),
      });
    } catch (e) {
      setError(describeFileError(e));
    } finally {
      setMakingDeck(false);
    }
  }, [path, scope, tabKey]);
  const viewPos = useViewerState(tabKey);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── The working arrangement (#page-arrange) ──────────────────────────────
  // The sheets this viewer shows, and the documents they are drawn from. The
  // reader below renders straight off `pages`, so reordering/deleting/turning a
  // page is an array operation — nothing is re-parsed and nothing touches disk
  // until Save, which is the only place pdf-lib runs (`buildPdf`).
  const [sources, setSources] = useState<PdfSources>(() => new Map());
  // The authoritative live map. State mirrors it for rendering, but the ref is what
  // the load effect's cleanup frees from — correct even if teardown beats a re-render.
  const sourcesRef = useRef<PdfSources>(new Map());
  const [pages, setPages] = useState<PageList>([]);
  // A drag's callbacks outlive the render they were created in (an import can land
  // seconds later, from another window), so they read the arrangement from here
  // rather than closing over a stale snapshot.
  const pagesRef = useRef<PageList>([]);
  pagesRef.current = pages;
  // "Page X / N" toolbar readout: the page occupying the viewport. Declared here
  // (rather than beside `updateVisiblePage` below) so the go-to-page control,
  // which seeds its input from the current value, can read it too.
  const [visiblePage, setVisiblePage] = useState(1);
  // Undo/redo: the arrangement is a small immutable list, so history is just a
  // stack of them.
  const [past, setPast] = useState<PageList[]>([]);
  const [future, setFuture] = useState<PageList[]>([]);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /** The page rail (the thumbnail strip you arrange pages in) is showing. */
  const [railOpen, setRailOpen] = useState(false);
  // The rail is the ONLY drop target for a page drag, so a viewer holding it closed
  // cannot receive pages at all. These two drive the spring-loaded rail below: the
  // live open state (read from a subscription callback, which closes over nothing),
  // and whether it was WE who opened it — only a rail this feature opened may be
  // closed again behind the reader's back.
  const railOpenRef = useRef(false);
  railOpenRef.current = railOpen;
  const railAutoOpenedRef = useRef(false);
  /** The contents sidebar (the PDF's chapters/outline) is showing. */
  const [outlineOpen, setOutlineOpen] = useState(false);
  /** The document's resolved outline: null = not loaded yet, [] = none. */
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  /** The font-size heading fallback, used only when `outline` is empty: null =
   *  not scanned yet, [] = none found. */
  const [headings, setHeadings] = useState<OutlineNode[] | null>(null);
  /** The rail's current selection, so an insert lands where the reader is looking. */
  const [selection, setSelection] = useState<Set<string>>(new Set());
  /** The "Insert PDF…" picker is open. */
  const [pickerOpen, setPickerOpen] = useState(false);
  // Identifies this viewer's rail among every strip mounted in this window, so a drag
  // from another rail can target it. Stable for the life of the viewer.
  const [stripId] = useState(() => `pdfrail:${tabKey ?? path}:${nextStripId()}`);
  // The file changed on disk while we hold unsaved edits — reloading would throw
  // them away, so ask instead of silently clobbering either side.
  const [staleOnDisk, setStaleOnDisk] = useState(false);

  // ── Blacking text out (#pdf-redact) ──────────────────────────────────────
  // Marks live ON the arrangement (`PageRef.marks`), so they are edits like any
  // other: undoable, carried by a page that is moved or duplicated, and nothing at
  // all until Save. These four are only the tool's own state.
  /** The blackout tool is armed — a drag over a page marks an area. */
  const [redacting, setRedacting] = useState(false);
  /** The image-copy tool is armed — a drag over a page writes that crop to the
   *  native system clipboard. Mutually exclusive with redaction because both
   *  tools own the same plain drag gesture. */
  const [copySelecting, setCopySelecting] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const copyNoticeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyNoticeTimer.current != null) window.clearTimeout(copyNoticeTimer.current);
    },
    [],
  );
  const copySelection = useCallback(
    async (png: Uint8Array) => {
      setCopyBusy(true);
      setCopyNotice(null);
      try {
        await invoke("copy_png_bytes_to_clipboard", { png: Array.from(png) });
        setCopyNotice(t("pdfViewer.copySelectionDone"));
        if (copyNoticeTimer.current != null) window.clearTimeout(copyNoticeTimer.current);
        copyNoticeTimer.current = window.setTimeout(() => setCopyNotice(null), 2500);
      } catch (e) {
        setEditError(t("pdfViewer.copySelectionFailed", { msg: String(e) }));
      } finally {
        setCopyBusy(false);
      }
    },
    [t],
  );
  /** Grow each drawn box out to the words it touches. On by default: a box drawn by
   *  eye clips ascenders and word ends, and the burn-in is pixel-exact, so an
   *  unsnapped mark is how a legible sliver of the redacted word survives. */
  const [snap, setSnap] = useState(true);
  /** Resolution the flattened sheets are rendered at. */
  const [redactDpi, setRedactDpi] = useState(REDACT_DEFAULT_DPI);
  /** The save that would burn the marks in is waiting to be confirmed. Flattening
   *  is irreversible and takes the page's text with it, so it is never the silent
   *  half of a Save the user pressed for a page reorder. */
  const [confirmRedact, setConfirmRedact] = useState(false);
  /** How much is pending: areas, and the sheets a save would flatten. Both are
   *  quoted wherever the price is named, because they are different numbers — 40
   *  boxes on one page costs one page's text, and one box on 40 pages costs forty. */
  const marksTotal = markCount(pages);
  const markedSheets = markedSheetCount(pages);

  // ── Deleting the metadata (#pdf-meta) ────────────────────────────────────
  // Unlike a blackout, this is not an edit to the arrangement — there is no page it
  // belongs to — so it rides beside it as one flag on the save. It is deliberately
  // *pending* rather than immediate: nothing is written until Save, so it is as
  // cancellable as every other edit in this viewer, and one Save writes the lot.
  /** The metadata panel is open. */
  const [metaOpen, setMetaOpen] = useState(false);
  /** A save would write the file with no metadata at all. */
  const [stripMeta, setStripMeta] = useState(false);
  /** What the loaded document says about itself, read once per load. `null` while
   *  the read is still out — "nothing found" and "not asked yet" are different
   *  answers, and only the first may be reported as an empty list. */
  const [meta, setMeta] = useState<PdfMetadata | null>(null);

  /** Unsaved edits: the arrangement no longer describes the file on disk, or the
   *  metadata is pending deletion — which is an edit with no page to sit on, and
   *  the only reason Save is reachable at all on an otherwise untouched file. */
  const dirty =
    doc != null && pages.length > 0 && (stripMeta || !isPristine(pages, doc.numPages));
  // The mtime poll runs on an interval that closes over its own scope; it needs
  // the LIVE dirty flag to decide whether an on-disk change may auto-reload.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  /** A metadata field's name. Only the eight standard `/Info` keys are translated —
   *  everything else is a name the producer invented, and printing an i18n key back
   *  at the reader is worse than printing the producer's own word. */
  const metaFieldLabel = useCallback(
    (key: string) => {
      const label = META_FIELD_KEYS[key];
      return label ? t(label) : key;
    },
    [t],
  );

  // Read what the document says about itself, on demand rather than at load: the
  // panel is the only thing that shows it, and pdf.js has to be asked, so a reader
  // who never opens it pays nothing — including on the reload of every recompile.
  useEffect(() => {
    if (!metaOpen || !doc || meta) return;
    let cancelled = false;
    void readPdfMetadata(doc).then((m) => {
      if (!cancelled) setMeta(m);
    });
    return () => {
      cancelled = true;
    };
  }, [metaOpen, doc, meta]);

  /** Record an arrangement edit, making it undoable. */
  const applyEdit = useCallback((next: PageList) => {
    setPages((cur) => {
      setPast((p) => [...p, cur]);
      setFuture([]);
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setPages((cur) => {
        setFuture((f) => [cur, ...f]);
        return prev;
      });
      return p.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setPages((cur) => {
        setPast((p) => [...p, cur]);
        return next;
      });
      return f.slice(1);
    });
  }, []);

  // Marking, unmarking and clearing are ordinary arrangement edits — which is the
  // whole reason marks were put on the entries: undo/redo, the dirty flag and the
  // page rail all cover redaction without knowing anything about it.
  const addRedactMark = useCallback(
    (entryId: string, rect: Rect) => applyEdit(addMark(pagesRef.current, entryId, rect)),
    [applyEdit],
  );
  const removeRedactMark = useCallback(
    (entryId: string, markId: string) => applyEdit(removeMark(pagesRef.current, entryId, markId)),
    [applyEdit],
  );
  const clearAllMarks = useCallback(
    () => applyEdit(clearMarks(pagesRef.current)),
    [applyEdit],
  );
  // Restore the saved zoom if there is one; otherwise the load effect fits the
  // page width. `1.2` is only the pre-load placeholder.
  const [scale, setScale] = useState(viewPos.initial?.scale ?? 1.2);
  // True while the PDF is at the fit-to-width baseline, so a pane/tab resize
  // re-fits. A manual zoom (buttons / Ctrl+wheel) clears it; the "Fit width"
  // button and the initial fit restore it. Mirrors ImageViewer's `fittedRef`.
  const fittedRef = useRef(viewPos.initial?.scale == null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Proportional scroll-link to a paired subwindow (no-op unless linked).
  const reportScrollSync = useScrollSync(groupId, scrollRef);
  const contentRef = useRef<HTMLDivElement>(null);
  // True once the first document load has run, so only that load restores the
  // session-persisted scroll/zoom (#viewerpos); later reloads behave as before.
  const didInitialLoad = useRef(false);
  // After a Ctrl+wheel zoom changes `scale`, the page canvases re-render to the
  // new size asynchronously. We stash the scroll target that keeps the cursor's
  // document point fixed and apply it once the content has actually resized.
  const pendingScroll = useRef<{ top: number; left: number } | null>(null);
  // Bumped whenever the file's mtime advances on disk, forcing a byte reload.
  const [diskVersion, setDiskVersion] = useState(0);
  // The diskVersion that produced `doc`. Compile-triggered forward search waits
  // for this to reach the requested fresh version before it scrolls.
  const [loadedDiskVersion, setLoadedDiskVersion] = useState(-1);
  const lastMtime = useRef<number | null>(null);
  // The path the currently-loaded document came from. A reload that keeps the
  // same path (a recompile bumped `diskVersion`) should preserve the reader's
  // scroll position; switching to a different file should not.
  const loadedPath = useRef<string | null>(null);
  // Scroll target to restore after a same-path reload (a recompile). The page
  // canvases re-render asynchronously, so the content grows over several frames;
  // the ResizeObserver below re-applies this until the position is reachable.
  const restoreScroll = useRef<{ top: number; left: number } | null>(null);
  // True when the document about to load is a same-path reload (a recompile
  // rewrote this PDF). The fit effect reads it to keep the reader's current zoom
  // instead of snapping back to fit-width. Set at load-start so it reflects the
  // load that produced the current `doc`, regardless of effect timing.
  const reloadKeepZoom = useRef(false);
  // True when a `.synctex(.gz)` sits beside the PDF, enabling reverse search.
  const [syncable, setSyncable] = useState(false);
  // True while Ctrl/⌘ is held: reverse-search clicks fire and pages show the
  // crosshair cursor only then, leaving plain clicks free for text selection.
  const [syncArmed, setSyncArmed] = useState(false);
  useEffect(() => {
    if (!syncable) return;
    const sync = (e: KeyboardEvent | MouseEvent) =>
      setSyncArmed(e.ctrlKey || e.metaKey);
    const clear = () => setSyncArmed(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("mousemove", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("mousemove", sync);
      window.removeEventListener("blur", clear);
    };
  }, [syncable]);

  // SyncTeX forward search: a pending reveal/highlight request for this PDF.
  // Copied into local state so we can consume the store request immediately
  // (avoiding a re-fire) while keeping the highlight mounted to animate.
  const reveal = usePdfSyncStore((s) => s.byPath[path] ?? null);
  const consumeReveal = usePdfSyncStore((s) => s.consume);
  const [highlight, setHighlight] = useState<{ rect: SyncRect; nonce: number; phrase?: CaretPhrase } | null>(null);
  const [reloadReveal, setReloadReveal] = useState<{
    rect: SyncRect;
    nonce: number;
    phrase?: CaretPhrase;
    targetVersion: number;
  } | null>(null);
  useEffect(() => {
    if (!reveal) return;
    if (reveal.afterReload) {
      // An already-open PDF must read the bytes the compiler just replaced.
      // A newly mounted PDF is already loading those bytes, so wait on its
      // current version instead of starting a redundant second read.
      const targetVersion = doc ? diskVersion + 1 : diskVersion;
      setReloadReveal({
        rect: reveal.rect,
        nonce: reveal.nonce,
        phrase: reveal.phrase,
        targetVersion,
      });
      if (doc) {
        // Keep the ordinary mtime poll from noticing the same compiler write
        // afterward and performing a duplicate reload.
        void fileMtime(path, scope)
          .then((mtime) => { lastMtime.current = mtime; })
          .catch(() => {});
        setDiskVersion(targetVersion);
      }
    } else {
      setHighlight({ rect: reveal.rect, nonce: reveal.nonce, phrase: reveal.phrase });
    }
    consumeReveal(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);
  useEffect(() => {
    if (!doc || !reloadReveal || loadedDiskVersion < reloadReveal.targetVersion) return;
    setHighlight({
      rect: reloadReveal.rect,
      nonce: reloadReveal.nonce,
      phrase: reloadReveal.phrase,
    });
    setReloadReveal(null);
  }, [doc, loadedDiskVersion, reloadReveal]);

  // A SyncTeX reveal names a page of the FILE, but the reader shows an arrangement —
  // that page may have been moved, or dropped. Resolve it to the sheet currently
  // showing it (-1 = not on screen any more, so no highlight).
  const syncSheetIndex = useMemo(
    () =>
      highlight
        ? pages.findIndex((r) => r.src === SELF && r.page === highlight.rect.page)
        : -1,
    [highlight, pages],
  );

  // ── Ctrl+F text search (#71) ───────────────────────────────────────
  // A floating find bar over the page stack with next/previous navigation, a
  // live match count, and a case toggle. Matches are found in each page's
  // extracted text (`getTextContent`) and painted as translucent boxes over the
  // canvases (`pdfPageMatches` → per-page rects), the current one brighter and
  // scrolled into view — the PDF counterpart to the editors' in-text search.
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [current, setCurrent] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  // Print: the webview can't print a PDF directly, so rasterise the already-open
  // pages to images and print those through the shared pipeline. `printing`
  // disables the button while the (async) render runs.
  const [printing, setPrinting] = useState(false);
  const handlePrint = useCallback(async () => {
    if (!doc || printing || pages.length === 0) return;
    setPrinting(true);
    try {
      // Rasterise the ARRANGEMENT, not the file: printing an edited PDF prints what
      // is on screen, without having to save it first.
      const images = await renderPdfPagesToImages(pages, (id) => sources.get(id)?.doc);
      const body = images
        .map((src) => `<div class="print-page"><img src="${src}" alt=""></div>`)
        .join("");
      await printHtmlBody(body, PDF_PRINT_CSS);
    } finally {
      setPrinting(false);
    }
  }, [doc, printing, pages, sources]);

  /**
   * Write the arrangement back to the file. The ONLY place a PDF is written.
   *
   * After a successful save the reader must be showing exactly what is now on disk,
   * so rather than trying to reconcile the arrangement in place we bump `diskVersion`
   * and let the load effect re-read the file — which resets the arrangement to the
   * identity, clears the history and frees any merged-in sources. `lastMtime` is
   * advanced first so our OWN write can't also trip the external-change poll.
   */
  const handleSave = useCallback(async (redactConfirmed = false) => {
    if (!dirty || saving) return;
    // Blackouts are burned in by rasterising the sheets that carry them, which
    // destroys their text for good. Ask first — the same Save also writes ordinary
    // page moves, and "I reordered two pages" must not silently flatten a page.
    if (!redactConfirmed && markCount(pagesRef.current) > 0) {
      setConfirmRedact(true);
      return;
    }
    setConfirmRedact(false);
    setSaving(true);
    setEditError(null);
    try {
      const bytes = await buildPdf(pages, sources, {
        emptyMsg: t("pdfViewer.pdfBuildEmpty"),
        sourceClosedMsg: t("pdfViewer.pdfSourceClosed"),
        redactDpi,
        stripMetadata: stripMeta,
      });
      await writeFileBytes(path, bytes, scope);
      const m = await fileMtime(path, scope).catch(() => null);
      if (m != null) lastMtime.current = m;
      setStaleOnDisk(false);
      setDiskVersion((v) => v + 1);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, pages, sources, path, scope, redactDpi, stripMeta, t]);

  // ── Merge: splice another PDF's pages into this arrangement ──────────────
  // The project the viewed file belongs to (the longest project directory that is a
  // prefix of `path`), so the picker lists the right tree even in a detached window.
  // It must stay project-scoped: the backend confines every read to the scope's tree,
  // so an arbitrary path from an OS file dialog would simply be refused.
  const pdfProjectDir = useMemo(() => {
    const { projects } = useProjectsStore.getState();
    let best = "";
    for (const p of projects) {
      const dir = resolveProjectDirectory(p);
      if (dir && isPathWithin(path, dir) && dir.length > best.length) best = dir;
    }
    return best;
  }, [path]);

  /** Where an insert lands: after the last selected sheet, else at the end. */
  const insertAt = useCallback(() => {
    if (selection.size === 0) return pages.length;
    let last = -1;
    pages.forEach((r, i) => {
      if (selection.has(r.id)) last = i;
    });
    return last < 0 ? pages.length : last + 1;
  }, [pages, selection]);

  /** Open a PDF's bytes as a new source and splice all of its pages in at `at`. */
  const spliceIn = useCallback(
    async (bytes: Uint8Array, at: number) => {
      const src = await openSource(bytes);
      const id = newSourceId();
      // The ref is authoritative (the load effect's cleanup frees from it), so it
      // and the state map are updated together.
      sourcesRef.current = new Map(sourcesRef.current).set(id, src);
      setSources(sourcesRef.current);
      applyEdit(insertPages(pagesRef.current, pagesOf(id, src.doc.numPages), at));
    },
    [applyEdit],
  );

  /** Read a PDF from the project and splice all of its pages in. */
  const mergePdf = useCallback(
    async (abs: string) => {
      setEditError(null);
      try {
        const bytes = await readFileBytes(abs, scope);
        await spliceIn(new Uint8Array(bytes), insertAt());
      } catch (e) {
        setEditError(
          t("pdfViewer.insertFailed", { name: basename(abs), msg: e instanceof Error ? e.message : String(e) }),
        );
      }
    },
    [scope, spliceIn, insertAt, t],
  );

  // ── Dragging pages to another PDF viewer, in this window or another ──────
  // The bytes cannot ride a JS object across a window boundary (separate WebViews,
  // separate heaps), so the dragged pages are built into a small PDF and parked in the
  // backend page clipboard; the drag carries only its token. See `stores/pdfDrag`.

  /** Build the dragged pages into a standalone PDF and park it for the drop. */
  const exportPages = useCallback(
    async (ids: string[]): Promise<PageTransfer | null> => {
      const picked = pagesRef.current.filter((r) => ids.includes(r.id));
      if (picked.length === 0) return null;
      try {
        // A dragged-out page carries its blackouts BURNED IN, not as pending marks:
        // the bytes are what lands in the other viewer (or the other window), and a
        // mark that travelled as an editable overlay would arrive as a page whose
        // text is still there under a black box.
        // Pending metadata deletion travels with the pages for the blackouts'
        // reason: these bytes are what lands in the other viewer, and a page that
        // arrived carrying the XMP packet its reader had just asked to be rid of
        // would put it back into a document they never associated it with.
        const bytes = await buildPdf(picked, sourcesRef.current, {
          emptyMsg: t("pdfViewer.pdfBuildEmpty"),
          sourceClosedMsg: t("pdfViewer.pdfSourceClosed"),
          redactDpi,
          stripMetadata: stripMeta,
        });
        const token = await invoke<string>("pdf_clip_set", { bytes: Array.from(bytes) });
        return { token, count: picked.length };
      } catch (e) {
        setEditError(
          t("pdfViewer.copyPagesFailed", { msg: e instanceof Error ? e.message : String(e) }),
        );
        return null;
      }
    },
    [redactDpi, stripMeta, t],
  );

  /** Take pages dragged out of another viewer and splice them in at `index`. */
  const importPages = useCallback(
    (transfer: PageTransfer, index: number) => {
      // Pages landed here, so the rail is now showing something the reader asked for
      // — it stays open when the drag ends, however it came to be open. Set
      // SYNCHRONOUSLY, before the await below: the close is only deferred by a
      // macrotask, and the fetch takes far longer than that.
      railAutoOpenedRef.current = false;
      void (async () => {
        try {
          const bytes = await invoke<number[]>("pdf_clip_get", { token: transfer.token });
          await spliceIn(new Uint8Array(bytes), index);
        } catch (e) {
          setEditError(
            t("pdfViewer.insertPagesFailed", { msg: e instanceof Error ? e.message : String(e) }),
          );
        }
      })();
    },
    [spliceIn, t],
  );

  /** The dragged pages were MOVED (Shift) and the drop was acknowledged: drop them. */
  const dropMovedPages = useCallback(
    (ids: string[]) => {
      applyEdit(deletePages(pagesRef.current, ids));
    },
    [applyEdit],
  );

  // ── The spring-loaded rail ───────────────────────────────────────────────
  // Dragging pages needs a rail at BOTH ends, and the rail starts closed — so the
  // feature used to require arming every document by hand before it could be a
  // destination, which is a setup step nobody discovers. Instead: while a page drag
  // is in flight, every open PDF shows its rail, and puts it away again afterwards
  // unless pages actually landed in it.
  //
  // This lives on the VIEWER, not on the strip, and that is the whole point — the
  // strip only exists while the rail is open, so a strip-level subscription could
  // never hear the drag that ought to open it.
  useEffect(
    () =>
      subscribePageDragActive((active) => {
        if (active) {
          if (railOpenRef.current) return; // already the reader's own choice
          railAutoOpenedRef.current = true;
          setRailOpen(true);
          return;
        }
        if (!railAutoOpenedRef.current) return; // the reader opened it — leave it
        // Deferred by a macrotask because a drop in ANOTHER window is delivered to
        // two listeners on one event — this one and the strip's — in registration
        // order, not in the order the work depends on. Closing here could therefore
        // unmount the very strip that is about to claim the pages. `onImport` clears
        // the flag synchronously, so by the time this runs a claimed rail stays open.
        setTimeout(() => {
          if (!railAutoOpenedRef.current) return;
          railAutoOpenedRef.current = false;
          setRailOpen(false);
        }, 0);
      }),
    [],
  );
  // Per-SHEET text runs, extracted lazily the first time the find bar is used and
  // cached until the arrangement changes. Indexed by position in the arrangement —
  // not by page number in the file — so a search hit points at the sheet you are
  // actually looking at once pages have been moved, deleted or merged in. Each
  // sheet is read from its own source document, at its own rotation.
  const [pageText, setPageText] = useState<TextItemBox[][] | null>(null);
  // Invalidated by what the text actually depends on — which sheet, from which
  // document, at which turn — and NOT by the arrangement object itself. Marking an
  // area produces a new `pages` array, and dropping the cache on that would re-read
  // every page's text content once per box drawn, exactly while the tool that needs
  // it most is in use.
  const textKey = useMemo(() => pages.map((r) => `${r.src}:${r.page}:${r.rot}`).join("|"), [pages]);
  useEffect(() => { setPageText(null); }, [textKey]);
  // Read while the find bar is open OR the blackout tool is armed: snapping a drawn
  // box out to whole words needs exactly the boxes the search already measures, so
  // arming the tool warms the same cache rather than a second one.
  useEffect(() => {
    if ((!findOpen && !redacting) || pageText || pages.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const texts = await Promise.all(
          pages.map((ref) => {
            const d = sources.get(ref.src)?.doc;
            return d ? pageTextItemBoxes(d, ref.page, ref.rot) : Promise.resolve([]);
          }),
        );
        if (!cancelled) setPageText(texts);
      } catch {
        if (!cancelled) setPageText([]); // give up gracefully — search finds nothing
      }
    })();
    return () => { cancelled = true; };
  }, [pages, sources, findOpen, redacting, pageText]);

  // Flat list of matches across all pages, in document order; each carries its
  // 1-based page and the big-point boxes covering it.
  const matches = useMemo(() => {
    if (!findOpen || !query || !pageText) return [];
    const out: { page: number; rects: SyncRect[] }[] = [];
    pageText.forEach((items, i) => {
      for (const rects of pdfPageMatches(items, i + 1, query, caseSensitive)) {
        out.push({ page: i + 1, rects });
      }
    });
    return out;
  }, [findOpen, query, caseSensitive, pageText]);

  /**
   * Black out every hit of the current search, across the whole document — the fast
   * path the feature is really for. Redacting a name out of a 200-page report by
   * hand is 300 drags; here it is a search and one click, and because the boxes come
   * from the same measurement the overlay is drawn from, what gets covered is
   * exactly what was highlighted.
   *
   * Marks already covering a hit are left alone (`markMatches`), so running it again
   * after refining the query does not stack duplicates.
   */
  const redactAllMatches = useCallback(() => {
    if (matches.length === 0) return;
    const byPage = new Map<number, SyncRect[][]>();
    for (const m of matches) {
      const list = byPage.get(m.page) ?? [];
      list.push(m.rects);
      byPage.set(m.page, list);
    }
    applyEdit(markMatches(pagesRef.current, byPage));
  }, [matches, applyEdit]);

  // Bumped to ask the page holding the current match to scroll it into view.
  const [searchScrollNonce, setSearchScrollNonce] = useState(0);

  // Per-page search overlays passed to each PdfPageCanvas: its matches (with the
  // current one flagged) plus a scroll nonce that only advances for the page the
  // current match sits on.
  const searchByPage = useMemo(() => {
    const map = new Map<number, { rects: SyncRect[]; current: boolean }[]>();
    matches.forEach((m, i) => {
      const list = map.get(m.page) ?? [];
      list.push({ rects: m.rects, current: i === current });
      map.set(m.page, list);
    });
    return map;
  }, [matches, current]);
  const currentPage = matches[current]?.page ?? 0;

  // #71 scrollbar markers: one tick per match positioned over the native
  // scrollbar track at the match's fractional position through the document, so
  // hits scrolled off-screen are still locatable at a glance. Each tick's `top`
  // is px within the track (= the scroll area's visible height); the current
  // match's tick is flagged. Derived from live geometry — the page wraps'
  // on-screen rects plus the match box's y within its page — so it stays correct
  // across zoom and resize (recomputed by the effect below).
  const [markerTops, setMarkerTops] = useState<{ top: number; current: boolean }[]>([]);
  const recomputeMarkers = useCallback(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!findOpen || !scroll || !content || matches.length === 0) {
      setMarkerTops((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const wraps = content.children; // page wraps, in page order
    const scrollTop0 = scroll.getBoundingClientRect().top;
    const track = scroll.clientHeight; // scrollbar track height = visible height
    const total = scroll.scrollHeight;
    if (total <= 0) return;
    const tops: { top: number; current: boolean }[] = [];
    matches.forEach((m, i) => {
      const wrap = wraps[m.page - 1] as HTMLElement | undefined;
      if (!wrap) return;
      // The page's top in scroll-content coordinates (independent of the current
      // scroll offset), plus the match box's y within the page.
      const pageTop = wrap.getBoundingClientRect().top - scrollTop0 + scroll.scrollTop;
      const matchTop = pageTop + (m.rects[0]?.y ?? 0) * scale;
      tops.push({ top: (matchTop / total) * track, current: i === current });
    });
    setMarkerTops(tops);
  }, [findOpen, matches, current, scale]);

  // Recompute markers when the match set / zoom / find-bar visibility changes,
  // and whenever the scroll area or page stack resizes (canvases render lazily,
  // growing the stack over several frames; a window/pane resize changes the
  // track height).
  useEffect(() => {
    recomputeMarkers();
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => recomputeMarkers());
    ro.observe(scroll);
    ro.observe(content);
    return () => ro.disconnect();
  }, [recomputeMarkers]);

  // Clamp the current index when the match set shrinks (query/case change).
  useEffect(() => {
    if (current > 0 && current >= matches.length) {
      setCurrent(matches.length > 0 ? matches.length - 1 : 0);
    }
  }, [matches.length, current]);

  // Jump to the first match whenever the query/case changes, the bar opens, or
  // the page text finishes extracting (so a query typed before extraction
  // completed still scrolls to its first hit).
  useEffect(() => {
    if (!findOpen) return;
    setCurrent(0);
    setSearchScrollNonce((n) => n + 1);
  }, [query, caseSensitive, findOpen, pageText]);

  const goToMatch = useCallback(
    (dir: 1 | -1) => {
      if (matches.length === 0) return;
      setCurrent((c) => (c + dir + matches.length) % matches.length);
      setSearchScrollNonce((n) => n + 1);
    },
    [matches.length],
  );

  const openFind = useCallback(() => {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    scrollRef.current?.focus();
  }, []);

  // ── Go to page (Ctrl+G) ───────────────────────────────────────────────────
  // Jumps by ARRANGEMENT position — the same "X / N" the toolbar readout and
  // `visiblePage` already count in — so it lands right even after pages have
  // been reordered/merged/deleted, without having to resolve a file page first.
  const [pageJumpOpen, setPageJumpOpen] = useState(false);
  const [pageJumpValue, setPageJumpValue] = useState("");
  const pageJumpInputRef = useRef<HTMLInputElement>(null);
  const jumpToArrangementIndex = useCallback((pos: number) => {
    const count = pagesRef.current.length;
    if (count === 0) return;
    const idx = Math.min(Math.max(Math.trunc(pos), 1), count) - 1;
    const wrap = contentRef.current?.children[idx] as HTMLElement | undefined;
    wrap?.scrollIntoView({ block: "start", inline: "nearest" });
  }, []);
  const openPageJump = useCallback(() => {
    if (pages.length === 0) return;
    setPageJumpValue(String(visiblePage));
    setPageJumpOpen(true);
    requestAnimationFrame(() => {
      pageJumpInputRef.current?.focus();
      pageJumpInputRef.current?.select();
    });
  }, [pages.length, visiblePage]);
  const closePageJump = useCallback(() => {
    setPageJumpOpen(false);
    scrollRef.current?.focus();
  }, []);
  const commitPageJump = useCallback(() => {
    const n = parseInt(pageJumpValue, 10);
    if (Number.isFinite(n)) jumpToArrangementIndex(n);
    closePageJump();
  }, [pageJumpValue, jumpToArrangementIndex, closePageJump]);

  // ── The document's own hyperlinks (#pdf-links) ────────────────────────────
  // A `hyperref` PDF is full of them — every `\ref`, `\cite`, `\autoref` and
  // contents row is a GoTo annotation — so following one has to feel like part of
  // reading, not like navigation: the jump lands ON the target rather than at the
  // top of its page, marks where it landed, and leaves a way back.

  /** Where the reader was before each followed internal link (newest last). */
  const [linkBack, setLinkBack] = useState<{ top: number; left: number }[]>([]);
  /** The landing band: which sheet, how far down it (big points), and a nonce so
   *  a repeat jump to the same anchor flashes again. */
  const [destMark, setDestMark] = useState<{ index: number; top: number; nonce: number } | null>(null);
  const destMarkTimer = useRef<number | null>(null);
  /** The external address awaiting the confirm, or null. */
  const [linkConfirm, setLinkConfirm] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (destMarkTimer.current != null) window.clearTimeout(destMarkTimer.current);
    },
    [],
  );
  // A different file is a different document: its back stack and its landing mark
  // are positions in a page stack that no longer exists.
  useEffect(() => {
    setLinkBack([]);
    setDestMark(null);
    setLinkConfirm(null);
  }, [path]);

  /** How far below the viewport top an internal link's target is parked, so the
   *  landing line is not flush against the edge (and, on a `\ref`, the line above
   *  it is readable as context). */
  const DEST_PAD = 24;

  /** Scroll to a resolved destination. Returns false when nothing was moved —
   *  the arrangement may no longer contain the target page at all (it was
   *  deleted), and a back entry must not be pushed for a jump that did nothing. */
  const jumpToDest = useCallback(
    async (dest: PdfDest): Promise<boolean> => {
      const list = pagesRef.current;
      const idx = list.findIndex((r) => r.src === SELF && r.page === dest.page);
      if (idx < 0) return false;
      const scroller = scrollRef.current;
      const wrap = contentRef.current?.children[idx] as HTMLElement | undefined;
      if (!scroller || !wrap) return false;
      // Explicit navigation supersedes a same-path reload's scroll restoration —
      // the rule `onReveal` already applies to a SyncTeX jump.
      restoreScroll.current = null;
      const srcDoc = sourcesRef.current.get(SELF)?.doc;
      const top = srcDoc ? await destTopInBigPoints(srcDoc, dest, list[idx].rot ?? 0) : null;
      if (top == null) {
        // A whole-page destination (`/Fit`) names no line to land on.
        wrap.scrollIntoView({ block: "start", inline: "nearest" });
        return true;
      }
      // Measured rather than read off `offsetTop`: the page stack's offset parent
      // is not guaranteed to be the scroller, and a rect delta is right either way.
      const delta = wrap.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += delta + top * scale - DEST_PAD;
      setDestMark((m) => ({ index: idx, top, nonce: (m?.nonce ?? 0) + 1 }));
      if (destMarkTimer.current != null) window.clearTimeout(destMarkTimer.current);
      destMarkTimer.current = window.setTimeout(() => setDestMark(null), 2200);
      return true;
    },
    [scale],
  );

  /** Step back to where the last internal link was followed from. */
  const linkGoBack = useCallback(() => {
    setLinkBack((s) => {
      const last = s[s.length - 1];
      if (!last) return s;
      const el = scrollRef.current;
      if (el) {
        restoreScroll.current = null;
        el.scrollTop = last.top;
        el.scrollLeft = last.left;
      }
      return s.slice(0, -1);
    });
  }, []);

  const onPdfLink = useCallback(
    (link: PdfLink) => {
      if (link.kind === "external") {
        setLinkConfirm(link.url);
        return;
      }
      const el = scrollRef.current;
      const from = el ? { top: el.scrollTop, left: el.scrollLeft } : null;
      void jumpToDest(link.dest).then((moved) => {
        // Bounded: the stack is a way back from a chain of citations, not a
        // history of the session.
        if (moved && from) setLinkBack((s) => [...s.slice(-19), from]);
      });
    },
    [jumpToDest],
  );

  /** Open a confirmed external address through the app's ONE routing table
   *  (#33). `origin: "viewer"` is the load-bearing argument: a URL that came out
   *  of a file the user is looking at is untrusted, so it can never become a live
   *  in-app page in one click. No `openBrowserTab` hook is passed — this viewer
   *  does not own a tab store — so an in-app target degrades to the user's real
   *  browser rather than to a click that goes nowhere. */
  const openPdfLink = useCallback(
    (url: string) => {
      openRoutedUri(
        url,
        {
          setting: settings?.browser_link_target,
          browserEnabled,
          mailEnabled,
          origin: "viewer",
          browserRoleConfigured: !!settings?.global_apps?.browser?.exec,
        },
        {
          globalApps: settings?.global_apps,
          onRefuse: (reason) => setEditError(t("pdfLinks.refused", { reason })),
        },
      );
    },
    [settings, browserEnabled, mailEnabled, t],
  );

  // Ctrl/Cmd+F opens the find bar, Ctrl/Cmd+G opens go-to-page; Esc closes
  // whichever is open. Bound on the host so it fires wherever focus sits within
  // the PDF pane (the scroll area is focusable).
  const onHostKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "f") {
        e.preventDefault();
        openFind();
      } else if (mod && key === "g") {
        e.preventDefault();
        openPageJump();
      } else if (mod && key === "s") {
        e.preventDefault();
        void handleSave();
      } else if (mod && key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (e.altKey && e.key === "ArrowLeft") {
        // The browser's own "back" gesture, for the same thing it means here:
        // return from the link you just followed.
        e.preventDefault();
        linkGoBack();
      } else if (e.key === "Escape" && pageJumpOpen) {
        e.preventDefault();
        closePageJump();
      } else if (e.key === "Escape" && findOpen) {
        e.preventDefault();
        closeFind();
      } else if (e.key === "Escape" && redacting) {
        // Last of the Escape branches: putting the blackout tool away matters less
        // than closing whatever was opened on top of it, and disarming while the
        // find bar is up would leave the bar with nothing to close it.
        e.preventDefault();
        setRedacting(false);
      } else if (e.key === "Escape" && copySelecting) {
        e.preventDefault();
        setCopySelecting(false);
      }
    },
    [
      openFind,
      closeFind,
      findOpen,
      openPageJump,
      closePageJump,
      pageJumpOpen,
      handleSave,
      undo,
      redo,
      redacting,
      copySelecting,
      linkGoBack,
    ],
  );
  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  };

  // Probe for SyncTeX data beside the PDF; re-checked after each disk change
  // (a recompile may have just written it).
  useEffect(() => {
    let cancelled = false;
    const base = path.replace(/\.pdf$/i, "");
    const exists = (p: string) =>
      fileMtime(p, scope).then(() => true).catch(() => false);
    void Promise.all([exists(`${base}.synctex.gz`), exists(`${base}.synctex`)]).then(
      ([gz, raw]) => { if (!cancelled) setSyncable(gz || raw); },
    );
    return () => { cancelled = true; };
  }, [path, scope, diskVersion]);

  // Reverse search: a click on a page → which source line produced it → jump.
  // Resolve the clicked source's root (the main `.tex` that produces this PDF) and
  // pass it as the routing anchor, so a subfile with no tab yet opens in the
  // subwindow that already holds the main `.tex` rather than the focused group.
  const onSyncClick = useCallback(
    async (page: number, x: number, y: number) => {
      const src = await synctexEdit(path, page, x, y);
      if (!src) return;
      const anchor = await resolveTexRoot(src.input).catch(() => src.input);
      // In a TeX workspace the host handles reverse search itself (it switches
      // the docked editor's center to the producing child); standalone falls
      // back to the module jump (open/focus the source tab).
      if (onReverseSource) {
        onReverseSource(src, anchor);
        return;
      }
      jumpToSource(src.input, src.line, src.column, anchor);
    },
    [path, onReverseSource],
  );

  // Seed the mtime baseline once per file, visible or not, so it pairs with the
  // bytes the load effect read — the re-show catch-up below compares against it.
  useEffect(() => {
    lastMtime.current = null;
    let cancelled = false;
    fileMtime(path, scope)
      .then((m) => { if (!cancelled) lastMtime.current = m; })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path, scope]);

  // Poll mtime; on an advance (e.g. a recompile wrote a new PDF), bump
  // diskVersion so the load effect re-reads the fresh bytes (#43-style).
  // Visible panes only — a hidden PDF tab (every backgrounded project's, and a
  // TeX PDF behind another tab in its group) polled an SFTP stat per tick on a
  // remote project forever. The immediate check on re-show catches a recompile
  // that happened while the tab was hidden.
  useEffect(() => {
    if (!paneVisible) return;
    let cancelled = false;
    const check = () => {
      fileMtime(path, scope)
        .then((m) => {
          if (cancelled || lastMtime.current == null || m <= lastMtime.current) return;
          lastMtime.current = m;
          // A reload REPLACES the arrangement, so it would silently throw away any
          // unsaved page edits. With edits pending we raise a banner and let the
          // reader choose; without them the old auto-reload stands (a LaTeX
          // recompile must still refresh the PDF on its own).
          if (dirtyRef.current) setStaleOnDisk(true);
          else setDiskVersion((v) => v + 1);
        })
        .catch(() => {});
    };
    check();
    const id = setInterval(check, RELOAD_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [path, scope, paneVisible]);

  // Load (and reload on path / disk change) the document. pdf.js detaches the
  // backing buffer, so each load gets a fresh Uint8Array; the prior documents are
  // destroyed on cleanup to free worker memory.
  useEffect(() => {
    let cancelled = false;
    // Same-path reload (a recompile): remember where the reader was so we can
    // restore it once the fresh pages have laid out, instead of jumping to the
    // top. A genuine file switch starts fresh. On the FIRST load, instead restore
    // the position persisted from a prior session (#viewerpos) so an Eldrun
    // restart reopens the PDF where the reader left it.
    const el = scrollRef.current;
    let firstRestore: { top: number; left: number } | null = null;
    if (!didInitialLoad.current) {
      didInitialLoad.current = true;
      const init = viewPos.initial;
      if (init && ((init.scrollTop ?? 0) > 0 || (init.scrollLeft ?? 0) > 0)) {
        firstRestore = { top: init.scrollTop ?? 0, left: init.scrollLeft ?? 0 };
      }
    }
    const samePathReload = loadedPath.current === path;
    restoreScroll.current =
      firstRestore ??
      (samePathReload
        ? // A same-path re-run that lands while a restore is still PENDING must
          // keep that target rather than recapture the live position — because
          // the target was never reached, so `el.scrollTop` is still 0 and
          // capturing it would silently replace the persisted position with the
          // top of the document. This fires on React StrictMode's dev-mode
          // double-mount (the hot-reload build wraps the app in <StrictMode>) and
          // on a disk-change reload arriving mid-restore, and was "the PDF forgot
          // where I was" on every dev restart. Once the pending restore has been
          // applied and cleared, a genuine same-path reload (a recompile) falls
          // through to capturing where the reader actually is.
          (restoreScroll.current ??
            (el ? { top: el.scrollTop, left: el.scrollLeft } : null))
        : null);
    reloadKeepZoom.current = samePathReload;
    loadedPath.current = path;
    // The documents the on-screen arrangement is currently drawn from — the file
    // itself AND any merged-in PDFs. Freed once the fresh load has swapped in,
    // not up front: keeping them alive is what lets a same-path reload (a
    // recompile) leave the old pages painted until the new ones are ready.
    const prevSources = sourcesRef.current;
    const freePrev = () => {
      for (const s of prevSources.values()) s.doc.destroy();
    };
    // A same-path reload keeps the current document on screen while the fresh
    // bytes load — blanking it would flash the page (and, on a truncated
    // mid-compile read, an error) on every poll of a multi-second compile. A
    // genuine file switch shows the loading state as before.
    if (!samePathReload) {
      setDoc(null);
      setError(null);
    }
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    // Safety net: stop re-applying the restore target once the pages have had
    // time to lay out, so a target the (re)loaded PDF can't reach — a recompile
    // shortened it, or the file changed on disk while Eldrun was closed — never
    // keeps yanking the scroll back and fighting the reader. Armed only AFTER
    // the document loads (below), not here at effect start: the byte read +
    // parse can itself take seconds for a large PDF (a LaTeX thesis on a busy
    // restart), and a clock started before that would expire before the content
    // ever reached its full height — dropping the restore for exactly the big
    // documents where a remembered position matters most.
    let restoreDeadline: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const bytes = await readFileBytes(path, scope);
          if (cancelled) return;
          // `openSource` keeps a pristine copy of the bytes for pdf-lib: pdf.js
          // DETACHES the buffer it is handed, so a save could not reuse them.
          const src = await openSource(new Uint8Array(bytes));
          if (cancelled) {
            src.doc.destroy();
            return;
          }
          // A load is a fresh start: one source, the identity arrangement, no
          // history. Swap in the new document, THEN free the one it replaces —
          // freeing after the swap is what keeps the old pages painted through
          // the change instead of flashing empty.
          sourcesRef.current = new Map([[SELF, src]]);
          setSources(sourcesRef.current);
          setPages(initialPages(src.doc.numPages));
          setPast([]);
          setFuture([]);
          // The metadata is a property of the bytes, so a reload re-reads it and
          // disarms the pending deletion — after a save that performed one, the
          // panel must show the (now empty) file rather than still offering to
          // strip what has already gone.
          setStripMeta(false);
          setMeta(null);
          setStaleOnDisk(false);
          setError(null);
          setEditError(null);
          setLoadedDiskVersion(diskVersion);
          setDoc(src.doc);
          freePrev();
          // Start the give-up clock now that the pages are about to lay out —
          // see the note where `restoreDeadline` is declared.
          if (restoreScroll.current) {
            restoreDeadline = setTimeout(() => {
              restoreScroll.current = null;
            }, 4000);
          }
          return;
        } catch (e) {
          if (cancelled) return;
          // A truncated read while the compiler is still writing is transient:
          // retry a few times before treating it as a real error.
          if (attempt < RELOAD_MAX_RETRIES) {
            await sleep(RELOAD_RETRY_MS);
            if (cancelled) return;
            continue;
          }
          // Out of retries. On a reload there is a last good document to keep
          // showing (the next mtime poll will try the fresh file again), so say
          // nothing; on a first load there is nothing to fall back on.
          if (!samePathReload) {
            freePrev();
            setError(String(e));
          }
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
      if (restoreDeadline) clearTimeout(restoreDeadline);
    };
  }, [path, scope, diskVersion]);

  // Release the open source documents when the viewer unmounts. This is its own
  // effect (not the load effect's cleanup) because the load effect now hands its
  // outgoing sources to the next load to free on success — so a same-path reload
  // never tears down the document that is still on screen.
  useEffect(
    () => () => {
      for (const s of sourcesRef.current.values()) s.doc.destroy();
      sourcesRef.current = new Map();
    },
    [],
  );

  // Intrinsic (scale-1) CSS dimensions of every page, computed once per document
  // load. Lets each PdfPageCanvas reserve its true size before rendering so the
  // page stack reaches its full scroll height immediately — without it the
  // restored scroll position (#viewerpos) is unreachable until every page above
  // it has finished rendering, which on a slow startup loses the position to the
  // restore deadline. getPage()/getViewport() read only page metadata (no
  // rasterisation), so this is cheap relative to actually rendering the pages.
  const [pageSizes, setPageSizes] = useState<{ w: number; h: number }[] | null>(null);
  useEffect(() => {
    if (pages.length === 0) {
      setPageSizes(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const sizes = await Promise.all(
          pages.map(async (ref) => {
            const d = sources.get(ref.src)?.doc;
            if (!d) return { w: 0, h: 0 };
            const page = await d.getPage(ref.page);
            // A quarter turn swaps the sheet's box; asking for the rotated viewport
            // means the reserved height is right for turned pages too.
            const vp = page.getViewport({
              scale: 1,
              rotation: (((page.rotate + ref.rot) % 360) + 360) % 360,
            });
            return { w: vp.width, h: vp.height };
          }),
        );
        if (!cancelled) setPageSizes(sizes);
      } catch {
        /* leave heights unreserved — restore falls back to the old behaviour */
      }
    })();
    return () => { cancelled = true; };
  }, [pages, sources]);

  // Fit the first page to the viewport width when a document loads.
  const fitWidth = useCallback(async (d: PDFDocumentProxy) => {
    const el = scrollRef.current;
    if (!el) return;
    const page = await d.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const avail = el.clientWidth - 24; // leave room for page margins
    if (avail > 0 && vp.width > 0) {
      setScale(clampPdfScale(avail / vp.width));
      fittedRef.current = true;
    }
  }, []);

  // Fit to width when a document loads — UNLESS this is the first load and a zoom
  // was persisted from a prior session, in which case honour the saved scale
  // (already seeded into `scale`). A same-path reload (a recompile rewrote this
  // PDF) keeps the reader's current zoom rather than snapping back to fit-width;
  // only a genuine switch to a different file refits.
  const didInitialFit = useRef(false);
  useEffect(() => {
    if (!doc) return;
    if (!didInitialFit.current) {
      didInitialFit.current = true;
      if (viewPos.initial?.scale != null) return;
    } else if (reloadKeepZoom.current) {
      return;
    }
    void fitWidth(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, fitWidth]);

  // Re-fit to width when the pane/tab resizes, but only while at the fit
  // baseline — a manual zoom opts out. Same contract as ImageViewer's resize
  // re-fit. `fitWidth` reads scrollRef.clientWidth, so the pane width alone
  // drives it; a scale change doesn't alter the pane width, so no feedback loop.
  useEffect(() => {
    const el = scrollRef.current;
    if (!doc || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (fittedRef.current) void fitWidth(doc);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc, fitWidth]);

  // #viewerpos: persist the zoom whenever it changes (only once a document is up,
  // so the pre-load placeholder scale is never written). setViewerState dedups,
  // so re-persisting an unchanged scale is a no-op.
  useEffect(() => {
    if (doc) viewPos.persist({ scale });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, doc]);

  // "Page X / N" toolbar readout: the page occupying the viewport. The anchor
  // is a third of the way down the viewport (typical PDF-viewer feel); the page
  // wraps are always all mounted, so a linear scan over their live rects stays
  // correct across zoom, resize, and mixed page heights.
  const updateVisiblePage = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const anchor = el.getBoundingClientRect().top + el.clientHeight / 3;
    const pages = content.children;
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].getBoundingClientRect().bottom >= anchor) {
        setVisiblePage(i + 1);
        return;
      }
    }
    if (pages.length > 0) setVisiblePage(pages.length);
  }, []);
  useEffect(() => {
    setVisiblePage(1);
    if (doc) updateVisiblePage();
  }, [doc, updateVisiblePage]);

  // ── Contents / outline (#pdf-outline) ────────────────────────────────────
  // Load the PDF's embedded outline (its chapters) when a document loads. Reset
  // to "not loaded" first so a file switch never shows the prior file's chapters.
  useEffect(() => {
    setOutline(null);
    setHeadings(null);
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      try {
        const nodes = await loadOutline(doc, t("pdfOutline.untitled"));
        if (!cancelled) setOutline(nodes);
      } catch {
        if (!cancelled) setOutline([]); // treat an unreadable outline as none
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // Font-size heading fallback: when the PDF ships NO embedded outline, infer
  // chapters from the text's typography (`detectHeadings`). Run it lazily — only
  // once the contents pane is opened on an outline-less document — because it
  // reads every page's text content, which is far heavier than `getOutline`.
  useEffect(() => {
    if (!outlineOpen || !doc) return;
    // A lone title bookmark (some LaTeX templates ship exactly that) is not real
    // navigation, so scan for headings as if the outline were absent.
    if (outline == null || outlineIsNavigable(outline)) return; // usable outline present/pending
    if (headings != null) return; // already scanned
    let cancelled = false;
    void (async () => {
      const runs: HeadingRun[] = [];
      // Sequential (not Promise.all): a 500-page document would otherwise fire
      // 500 concurrent text extractions at the pdf.js worker at once.
      for (let p = 1; p <= doc.numPages; p++) {
        if (cancelled) return;
        try {
          const page = await doc.getPage(p);
          const viewport = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          for (const it of content.items) {
            if (!("str" in it) || typeof it.str !== "string" || !it.str.trim()) continue;
            const tx = pdfjs.Util.transform(viewport.transform, it.transform);
            const size = Math.hypot(tx[2], tx[3]);
            runs.push({ str: it.str, size, page: p, x: tx[4], y: tx[5] - size });
          }
        } catch {
          /* skip an unreadable page */
        }
      }
      if (!cancelled) setHeadings(detectHeadings(runs));
    })();
    return () => { cancelled = true; };
  }, [outlineOpen, doc, outline, headings]);

  // The chapters actually shown: the embedded outline if the PDF has one, else
  // the inferred headings. `activeOutline` is null while its source is still
  // loading/scanning; `outlineDerived` says the fallback is in use.
  // A present-but-degenerate outline (a lone title bookmark) is treated as absent:
  // the fallback headings stand in, and the sidebar labels them as derived.
  const outlineUsable = outline != null && outlineIsNavigable(outline);
  const outlineDerived = outline != null && !outlineUsable;
  const activeOutline: OutlineNode[] | null =
    outline == null ? null : outlineUsable ? outline : headings;
  const outlinePlaceholder =
    activeOutline && activeOutline.length > 0
      ? null
      : outline == null
        ? t("pdfOutline.reading")
        : outlineDerived && headings == null
          ? t("pdfOutline.scanning")
          : t("pdfOutline.noChapters");

  // Jump the reader to a 1-based FILE page from the contents sidebar. The reader
  // shows an arrangement, so resolve the file page to whichever sheet is showing
  // it now (a moved/merged page still lands right; a deleted one is a no-op).
  const jumpToPage = useCallback((filePage: number) => {
    const idx = pagesRef.current.findIndex((r) => r.src === SELF && r.page === filePage);
    if (idx < 0) return;
    const wrap = contentRef.current?.children[idx] as HTMLElement | undefined;
    wrap?.scrollIntoView({ block: "start", inline: "nearest" });
  }, []);

  // The outline entry to highlight: the last chapter (in document order) whose
  // page is at or before the page currently in view. Recomputed from the flat
  // outline as the reader scrolls (`visiblePage`) — but keyed off the *file* page
  // the visible SHEET shows, so it stays right after pages are rearranged.
  const currentOutlineId = useMemo(() => {
    if (!activeOutline || activeOutline.length === 0) return null;
    const sheet = pages[visiblePage - 1];
    const filePage = sheet && sheet.src === SELF ? sheet.page : visiblePage;
    let best: string | null = null;
    for (const { node } of flattenOutline(activeOutline)) {
      if (node.page != null && node.page <= filePage) best = node.id;
    }
    return best;
  }, [activeOutline, visiblePage, pages]);

  // #viewerpos: persist the scroll position as the reader scrolls (throttled,
  // trailing-edge). Ignored while a programmatic restore is still settling so we
  // don't overwrite the saved target with an intermediate frame.
  const scrollPersistTimer = useRef<number | null>(null);
  const onScrollPersist = useCallback(() => {
    const el = scrollRef.current;
    updateVisiblePage();
    if (!el || restoreScroll.current) return;
    reportScrollSync();
    const top = el.scrollTop;
    const left = el.scrollLeft;
    if (scrollPersistTimer.current != null) window.clearTimeout(scrollPersistTimer.current);
    scrollPersistTimer.current = window.setTimeout(
      () => viewPos.persist({ scrollTop: top, scrollLeft: left }),
      200,
    );
  }, [viewPos, reportScrollSync, updateVisiblePage]);
  useEffect(
    () => () => {
      if (scrollPersistTimer.current != null) window.clearTimeout(scrollPersistTimer.current);
    },
    [],
  );

  // Ctrl/Cmd+wheel zooms the page stack toward the cursor (a plain wheel keeps
  // native scrolling). Because the canvases resize asynchronously, we only
  // compute the cursor-anchored scroll target here and let the ResizeObserver
  // below apply it once the content has grown/shrunk.
  const onWheel = useCallback((e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    // A user zoom takes over; abandon any in-flight recompile scroll restore.
    restoreScroll.current = null;
    const rect = el.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    setScale((prev) => {
      const factor = e.deltaY < 0 ? PDF_ZOOM_STEP : 1 / PDF_ZOOM_STEP;
      const next = clampPdfScale(prev * factor);
      if (next === prev) return prev;
      fittedRef.current = false; // manual zoom opts out of resize re-fit
      const eff = next / prev;
      pendingScroll.current = {
        top: (el.scrollTop + cursorY) * eff - cursorY,
        left: (el.scrollLeft + cursorX) * eff - cursorX,
      };
      return next;
    });
  }, []);

  // Bind the zoom wheel non-passively so `preventDefault()` above actually
  // cancels the native scroll — a React `onWheel` is passive, so Ctrl+wheel
  // would otherwise scroll the page to its limit before the zoom took hold.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // Apply a pending cursor-anchored scroll target once the page content has
  // resized after a zoom (the observer fires when the canvases repaint).
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      // Cursor-anchored zoom target: apply once, the moment the canvases resize.
      const target = pendingScroll.current;
      if (target) {
        pendingScroll.current = null;
        el.scrollTop = target.top;
        el.scrollLeft = target.left;
      }
      // Recompile reload: the page stack grows over several frames as canvases
      // render, so keep re-applying the saved position until it's reached, then
      // stop. A target the new (shorter) document can't hold is dropped by the
      // bounded fallback timer in the load effect.
      const restore = restoreScroll.current;
      if (restore) {
        el.scrollTop = restore.top;
        el.scrollLeft = restore.left;
        if (el.scrollTop >= restore.top - 1) restoreScroll.current = null;
      }
      // A layout-height change (zoom re-render, pages appearing) moves which
      // page sits under the anchor even without a scroll event.
      updateVisiblePage();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [doc, updateVisiblePage]);

  return (
    <div className="file-viewer-pdf-host" onKeyDown={onHostKeyDown}>
      <div className="file-viewer-pdf-toolbar" role="group" aria-label={t("pdfViewer.zoomControlsLabel")}>
        {/* Contents (chapters) sits at the far left — it opens the navigation
            column on the same side, so the button lines up over it. */}
        <button
          className={`file-viewer-zoom-btn${outlineOpen ? " active" : ""}`}
          onClick={() => setOutlineOpen((v) => !v)}
          disabled={!doc}
          title={t("pdfViewer.contentsTitle")}
          aria-label={t("pdfViewer.contentsLabel")}
          aria-pressed={outlineOpen}
        >
          ☰
        </button>
        {/* Back to where the last link was followed from (#pdf-links). Rendered
            only once there is somewhere to go back to: a permanently disabled
            arrow in a viewer whose links most documents don't have would be
            chrome that never does anything. */}
        {linkBack.length > 0 && (
          <button
            className="file-viewer-zoom-btn"
            onClick={linkGoBack}
            title={t("pdfLinks.backTitle")}
            aria-label={t("pdfLinks.backLabel")}
          >
            ←
          </button>
        )}
        {linkBack.length > 0 && <UntestedTag />}
        <span className="file-viewer-pdf-toolbar-sep" aria-hidden="true" />
        <button
          className="file-viewer-zoom-btn"
          onClick={() => {
            fittedRef.current = false;
            setScale((s) => clampPdfScale(s / PDF_ZOOM_STEP));
          }}
          disabled={!doc || scale <= PDF_MIN_SCALE}
          title={t("imageZoom.zoomOutTitle")}
          aria-label={t("imageZoom.zoomOutTitle")}
        >
          −
        </button>
        <span className="file-viewer-zoom-level">{Math.round(scale * 100)}%</span>
        <button
          className="file-viewer-zoom-btn"
          onClick={() => {
            fittedRef.current = false;
            setScale((s) => clampPdfScale(s * PDF_ZOOM_STEP));
          }}
          disabled={!doc || scale >= PDF_MAX_SCALE}
          title={t("imageZoom.zoomInTitle")}
          aria-label={t("imageZoom.zoomInTitle")}
        >
          +
        </button>
        <button
          className="file-viewer-zoom-btn file-viewer-zoom-text"
          onClick={() => doc && void fitWidth(doc)}
          disabled={!doc}
          title={t("pdfViewer.fitPageWidthTitle")}
        >
          {t("pdfViewer.fitWidthButton")}
        </button>
        {doc && (
          pageJumpOpen ? (
            <input
              ref={pageJumpInputRef}
              className="file-viewer-pdf-pagejump-input"
              type="number"
              min={1}
              max={pages.length}
              value={pageJumpValue}
              aria-label={t("pdfViewer.goToPageLabel")}
              onChange={(e) => setPageJumpValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitPageJump();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closePageJump();
                }
              }}
              onBlur={closePageJump}
            />
          ) : (
            <button
              className="file-viewer-zoom-btn file-viewer-pdf-pagenum"
              onClick={openPageJump}
              title={t("pdfViewer.goToPageTitle")}
              aria-label={t("pdfViewer.goToPageLabel")}
            >
              {visiblePage} / {pages.length}
            </button>
          )
        )}
        <button
          className={`file-viewer-zoom-btn${findOpen ? " active" : ""}`}
          onClick={() => (findOpen ? closeFind() : openFind())}
          disabled={!doc}
          title={t("pdfViewer.findTitle")}
          aria-label={t("pdfViewer.findLabel")}
          aria-pressed={findOpen}
        >
          🔍
        </button>
        {/* Black out text (#pdf-redact). Beside the find button because the two work
            as a pair — search for the name, black out every hit. */}
        <button
          className={`file-viewer-zoom-btn${redacting ? " active" : ""}`}
          onClick={() => {
            setRedacting((v) => !v);
            setCopySelecting(false);
          }}
          disabled={!doc}
          title={t("pdfRedact.toolTitle")}
          aria-label={t("pdfRedact.toolLabel")}
          aria-pressed={redacting}
        >
          ▮
        </button>
        <UntestedTag />
        <button
          className={`file-viewer-zoom-btn${copySelecting ? " active" : ""}`}
          onClick={() => {
            setCopySelecting((v) => !v);
            setRedacting(false);
            setCopyNotice(null);
          }}
          disabled={!doc || copyBusy}
          title={t("pdfViewer.copySelectionTitle")}
          aria-label={t("pdfViewer.copySelectionLabel")}
          aria-pressed={copySelecting}
        >
          ✂
        </button>
        {/* Delete the metadata (#pdf-meta). Beside the blackout tool because the two
            are the same job on the file's two halves — what is on the page, and what
            the file says about itself off it. */}
        <button
          className={`file-viewer-zoom-btn${metaOpen ? " active" : ""}${stripMeta ? " is-armed" : ""}`}
          onClick={() => setMetaOpen((v) => !v)}
          disabled={!doc}
          title={t("pdfMeta.toolTitle")}
          aria-label={t("pdfMeta.toolLabel")}
          aria-pressed={metaOpen}
        >
          🏷
        </button>
        <UntestedTag />
        {/* ── Page arranging (#page-arrange) ────────────────────────────────
            Edits live in memory until Save, so a stray delete is always one Ctrl+Z
            away and never touches the file. */}
        <button
          className={`file-viewer-zoom-btn${railOpen ? " active" : ""}`}
          onClick={() => setRailOpen((v) => !v)}
          disabled={!doc}
          title={t("pdfViewer.arrangePagesTitle")}
          aria-label={t("pdfViewer.arrangePagesTitle")}
          aria-pressed={railOpen}
        >
          ▤
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={() => setPickerOpen(true)}
          disabled={!doc || !pdfProjectDir}
          title={
            pdfProjectDir
              ? t("pdfViewer.insertPdfTitle")
              : t("pdfViewer.insertPdfNoProjectTitle")
          }
          aria-label={t("pdfViewer.insertPdfLabel")}
        >
          ⊕
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={undo}
          disabled={past.length === 0}
          title={t("pdfViewer.undoTitle")}
          aria-label={t("common.undo")}
        >
          ↶
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={redo}
          disabled={future.length === 0}
          title={t("pdfViewer.redoTitle")}
          aria-label={t("common.redo")}
        >
          ↷
        </button>
        <SaveButton
          isDirty={dirty}
          saving={saving}
          save={() => void handleSave()}
          title={dirty ? t("pdfViewer.saveDirtyTitle") : t("pdfViewer.saveCleanTitle")}
        />
        <button
          className={`file-viewer-print file-viewer-pdf-print${printing ? " is-busy" : ""}`}
          onClick={() => void handlePrint()}
          disabled={!doc || printing}
          title={printing ? t("pdfViewer.preparing") : t("pdfViewer.printLabel")}
          aria-label={t("pdfViewer.printLabel")}
        >
          {printing ? (
            <span className="file-viewer-save-spinner" aria-hidden="true" />
          ) : (
            <PrinterIcon />
          )}
        </button>
        {deckEnabled && (
          <button
            className="file-viewer-zoom-btn file-viewer-zoom-text"
            onClick={() => void openAsDeck()}
            disabled={!doc || makingDeck}
            title={t("pdfViewer.presentTitle")}
          >
            {makingDeck ? "…" : `▶ ${t("pdfViewer.presentButton")}`}
          </button>
        )}
        {onOpenExternally && (
          <button
            className="file-viewer-open-external file-viewer-pdf-external"
            onClick={onOpenExternally}
            title={t("pdfViewer.openExternalTitle")}
            aria-label={t("pdfViewer.openExternalTitle")}
          >
            ↗
          </button>
        )}
      </div>
      {redacting && (
        // The blackout tool's own strip. It says what the tool does, what it will
        // cost at save, and offers the two bulk actions — never a "redact" button
        // that silently rewrites the file, which is the shape this feature must not
        // have.
        <div className="file-viewer-pdf-redact-bar" role="group" aria-label={t("pdfRedact.toolLabel")}>
          <span className="file-viewer-pdf-redact-hint">{t("pdfRedact.dragHint")}</span>
          <label className="file-viewer-pdf-redact-opt">
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
            {t("pdfRedact.snapToText")}
          </label>
          <label className="file-viewer-pdf-redact-opt">
            {t("pdfRedact.quality")}
            <select
              value={redactDpi}
              onChange={(e) => setRedactDpi(Number(e.target.value))}
              aria-label={t("pdfRedact.quality")}
            >
              <option value={150}>{t("pdfRedact.qualityDraft")}</option>
              <option value={REDACT_DEFAULT_DPI}>{t("pdfRedact.qualityStandard")}</option>
              <option value={300}>{t("pdfRedact.qualitySharp")}</option>
            </select>
          </label>
          <span className="file-viewer-pdf-toolbar-sep" aria-hidden="true" />
          {/* Search-driven bulk marking. Offered only with hits on screen: a button
              that can only report "nothing matched" is chrome, and the find bar is
              where the query it would use lives. */}
          {findOpen && matches.length > 0 ? (
            <button className="file-viewer-zoom-btn file-viewer-zoom-text" onClick={redactAllMatches}>
              {t("pdfRedact.blackOutMatches", { n: matches.length })}
            </button>
          ) : (
            <button
              className="file-viewer-zoom-btn file-viewer-zoom-text"
              onClick={openFind}
              title={t("pdfRedact.searchFirstTitle")}
            >
              {t("pdfRedact.searchFirstButton")}
            </button>
          )}
          <span className="file-viewer-pdf-redact-count">
            {marksTotal > 0
              ? t("pdfRedact.pending", { areas: marksTotal, pages: markedSheets })
              : t("pdfRedact.pendingNone")}
          </span>
          <button
            className="file-viewer-zoom-btn file-viewer-zoom-text"
            onClick={clearAllMarks}
            disabled={marksTotal === 0}
          >
            {t("pdfRedact.clearAll")}
          </button>
          <span className="file-viewer-pdf-redact-warn">{t("pdfRedact.flattenWarning")}</span>
        </div>
      )}
      {copySelecting && (
        <div
          className="file-viewer-pdf-copy-bar"
          role="status"
          aria-live="polite"
        >
          <span>{t("pdfViewer.copySelectionHint")}</span>
          {copyBusy && <span>{t("pdfViewer.copySelectionWorking")}</span>}
          {copyNotice && <span className="file-viewer-pdf-copy-success">{copyNotice}</span>}
        </div>
      )}
      {metaOpen && doc && (
        // The metadata panel — the blackout tool's strip, wearing the same class so
        // the two read as the pair they are. It shows the fields BEFORE it offers to
        // delete them, which is the whole point: none of this is on the page, so a
        // bare "Delete all metadata" button would be a control whose effect the
        // reader could neither see beforehand nor verify afterwards.
        <div className="file-viewer-pdf-redact-bar" role="group" aria-label={t("pdfMeta.toolLabel")}>
          <span className="file-viewer-pdf-redact-hint">{t("pdfMeta.hint")}</span>
          <span className="file-viewer-pdf-toolbar-sep" aria-hidden="true" />
          {meta == null ? (
            <span className="file-viewer-pdf-redact-count">{t("pdfMeta.reading")}</span>
          ) : meta.entries.length === 0 && !meta.xmp ? (
            <span className="file-viewer-pdf-redact-count">{t("pdfMeta.none")}</span>
          ) : (
            <span className={`file-viewer-pdf-meta-list${stripMeta ? " is-doomed" : ""}`}>
              {meta.entries.map((e) => (
                <span key={e.key} className="file-viewer-pdf-meta-entry">
                  <span className="file-viewer-pdf-meta-key">{metaFieldLabel(e.key)}</span>
                  <span className="file-viewer-pdf-meta-value">{e.value}</span>
                </span>
              ))}
              {/* The XMP packet has no value worth printing — it is a whole XML
                  document — so it is named as a presence rather than quoted. */}
              {meta.xmp && (
                <span className="file-viewer-pdf-meta-entry">
                  <span className="file-viewer-pdf-meta-key">{t("pdfMeta.xmp")}</span>
                </span>
              )}
            </span>
          )}
          <span className="file-viewer-pdf-toolbar-sep" aria-hidden="true" />
          {/* Arms a pending deletion; it is Save that writes it, exactly as a
              blackout is. Offered even for a file with nothing listed, because the
              list is what pdf.js can see — the per-page packets and the private
              scratch space an editor left behind are cleared by the same save and
              are not in it. */}
          <button
            className={`file-viewer-zoom-btn file-viewer-zoom-text${stripMeta ? " active" : ""}`}
            onClick={() => setStripMeta((v) => !v)}
            aria-pressed={stripMeta}
            title={t("pdfMeta.deleteAllTitle")}
          >
            {stripMeta ? t("pdfMeta.keepButton") : t("pdfMeta.deleteAllButton")}
          </button>
          {stripMeta && (
            <span className="file-viewer-pdf-redact-warn">{t("pdfMeta.pendingSave")}</span>
          )}
        </div>
      )}
      {findOpen && (
        <div className="file-viewer-find file-viewer-find-pdf" role="search">
          <div className="file-viewer-find-row">
            <input
              ref={findInputRef}
              className="file-viewer-find-input"
              type="text"
              value={query}
              placeholder={t("pdfViewer.findPlaceholder")}
              aria-label={t("pdfViewer.findLabel")}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onFindKeyDown}
            />
            <span className="file-viewer-find-count" aria-live="polite">
              {matches.length > 0 ? `${current + 1}/${matches.length}` : query ? "0/0" : ""}
            </span>
            <button
              className={`file-viewer-find-btn${caseSensitive ? " active" : ""}`}
              onClick={() => setCaseSensitive((v) => !v)}
              aria-pressed={caseSensitive}
              title={t("pdfViewer.matchCaseTitle")}
              aria-label={t("pdfViewer.matchCaseTitle")}
            >
              Aa
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={() => goToMatch(-1)}
              disabled={matches.length === 0}
              title={t("pdfViewer.prevMatchTitle")}
              aria-label={t("pdfViewer.prevMatchLabel")}
            >
              ↑
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={() => goToMatch(1)}
              disabled={matches.length === 0}
              title={t("pdfViewer.nextMatchTitle")}
              aria-label={t("pdfViewer.nextMatchLabel")}
            >
              ↓
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={closeFind}
              title={t("pdfViewer.closeFindTitle")}
              aria-label={t("pdfViewer.closeFindLabel")}
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {confirmRedact && (
        // The one gate in front of an irreversible write. It names both numbers and
        // says plainly what is destroyed — a "this cannot be undone" with no subject
        // is what gets clicked through.
        <div className="file-viewer-banner is-warn" role="alert">
          <span>{t("pdfRedact.confirmMessage", { areas: marksTotal, pages: markedSheets })}</span>
          <button onClick={() => void handleSave(true)}>{t("pdfRedact.confirmSaveButton")}</button>
          <button onClick={() => setConfirmRedact(false)}>{t("common.cancel")}</button>
        </div>
      )}
      {staleOnDisk && (
        // The file changed underneath our unsaved edits. Reloading would throw them
        // away and saving would overwrite the newer file, so neither happens on its
        // own — the reader picks.
        <div className="file-viewer-banner" role="alert">
          <span>{t("pdfViewer.staleOnDiskMessage")}</span>
          <button
            onClick={() => {
              setStaleOnDisk(false);
              setDiskVersion((v) => v + 1);
            }}
          >
            {t("pdfViewer.reloadDiscardButton")}
          </button>
          <button onClick={() => setStaleOnDisk(false)}>{t("pdfViewer.keepChangesButton")}</button>
        </div>
      )}
      {editError && (
        <div className="file-viewer-banner is-error" role="alert">
          <span>{editError}</span>
          <button onClick={() => setEditError(null)}>{t("pdfViewer.dismiss")}</button>
        </div>
      )}
      <div className="file-viewer-pdf-scroll-wrap">
        {outlineOpen && doc && (
          <OutlinePane
            doc={doc}
            nodes={activeOutline}
            placeholder={outlinePlaceholder}
            derived={outlineDerived}
            currentId={currentOutlineId}
            onJump={jumpToPage}
          />
        )}
        {railOpen && doc && (
          // The page rail: the SAME <PageStrip> the print preview uses, stood on its
          // side. Drag to reorder, shift-click for a range, right-click for the rest.
          <div className="file-viewer-pdf-rail">
            <PageStrip
              pages={pages}
              onChange={applyEdit}
              orientation="column"
              onSelectionChange={setSelection}
              // Drag pages out of this rail and into another PDF viewer's — in this
              // window or in a detached one. Copy by default; Shift moves them.
              stripId={stripId}
              onExport={exportPages}
              onImport={importPages}
              onMovedOut={dropMovedPages}
              renderThumb={(ref) => (
                <PdfThumb
                  doc={sources.get(ref.src)?.doc}
                  page={ref.page}
                  rot={ref.rot}
                  marks={ref.marks}
                />
              )}
              badgeFor={(_ref, i) => String(i + 1)}
              titleFor={(ref) =>
                (ref.src === SELF
                  ? t("pdfViewer.pageOf", { n: ref.page })
                  : t("pdfViewer.pageOfMerged", { n: ref.page })) +
                (ref.rot ? t("pdfViewer.turnedSuffix", { deg: ref.rot }) : "")
              }
            />
          </div>
        )}
        <div
          className="file-viewer-pdf-scroll"
          ref={scrollRef}
          tabIndex={0}
          onScroll={onScrollPersist}
        >
          {error != null ? (
            <div className="file-viewer-error">{error}</div>
          ) : !doc ? (
            <div className="file-viewer-loading">{t("common.loading")}</div>
          ) : (
            <div className="file-viewer-pdf-pages" ref={contentRef}>
              {/* The reader renders the ARRANGEMENT, sheet by sheet — each pulled
                  from its own source document — so an edit shows up immediately with
                  nothing re-parsed. An unedited PDF is the identity arrangement over
                  its own pages, i.e. exactly what it always was. Keyed by entry id so
                  a reorder MOVES the canvas rather than repainting it. */}
              {pages.map((ref, i) => {
                const srcDoc = sources.get(ref.src)?.doc;
                if (!srcDoc) return null;
                return (
                  <PdfPageCanvas
                    key={ref.id}
                    doc={srcDoc}
                    pageNumber={ref.page}
                    rot={ref.rot}
                    scale={scale}
                    cssSize={pageSizes?.[i]}
                    // SyncTeX only means anything for pages of the file itself: a
                    // page merged in from another PDF has no line in this source.
                    onSyncClick={syncable && ref.src === SELF ? onSyncClick : undefined}
                    syncArmed={syncArmed}
                    highlight={highlight && i === syncSheetIndex ? highlight : null}
                    onReveal={() => { restoreScroll.current = null; }}
                    searchMatches={searchByPage.get(i + 1)}
                    searchScrollNonce={currentPage === i + 1 ? searchScrollNonce : 0}
                    // Only pages of the file itself carry a link layer for now:
                    // a merged-in page's GoTo destinations point into ITS
                    // document, and following one into this arrangement would
                    // land on whatever happens to sit at that page number here.
                    onLink={ref.src === SELF ? onPdfLink : undefined}
                    destMark={destMark && destMark.index === i ? destMark : null}
                    marks={ref.marks}
                    redacting={redacting}
                    copySelecting={copySelecting && !copyBusy}
                    textItems={snap ? pageText?.[i] : undefined}
                    onRedactAdd={(rect) => addRedactMark(ref.id, rect)}
                    onRedactRemove={(markId) => removeRedactMark(ref.id, markId)}
                    onCopySelection={copySelection}
                  />
                );
              })}
            </div>
          )}
        </div>
        {findOpen && markerTops.length > 0 && (
          <div className="file-viewer-pdf-search-rail" aria-hidden="true">
            {markerTops.map((m, i) => (
              <div
                key={i}
                className={`file-viewer-pdf-search-tick${m.current ? " current" : ""}`}
                style={{ top: m.top }}
              />
            ))}
          </div>
        )}
      </div>
      {linkConfirm && (
        <PdfLinkConfirmDialog
          url={linkConfirm}
          onOpen={() => openPdfLink(linkConfirm)}
          onClose={() => setLinkConfirm(null)}
        />
      )}
      {pickerOpen && (
        // Deliberately the project-scoped picker rather than an OS file dialog: the
        // backend confines every read to the scope's tree, so a path from outside it
        // would be refused anyway — better to only offer what can actually be read.
        <ContextFilePicker
          projectDir={pdfProjectDir}
          attached={[]}
          onPick={(rel) => {
            const abs = `${pdfProjectDir}/${rel}`;
            if (!/\.pdf$/i.test(abs)) {
              setEditError(t("pdfViewer.notAPdf", { name: basename(abs) }));
              return;
            }
            setPickerOpen(false);
            void mergePdf(abs);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

export function PdfView({
  path,
  onOpenExternally,
  tabKey,
  groupId,
  onReverseSource,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
  groupId?: string | null;
  /** SyncTeX reverse-search host seam (see `PdfCanvas`). The TeX workspace passes
   *  it to keep a reverse click inside its own tab; a standalone PDF omits it. */
  onReverseSource?: (src: SyncSource, anchor: string) => void;
}) {
  // No ViewerHeader: the tab already shows the file name, so a filename row would
  // be redundant. The "Open externally" action lives in the PdfCanvas toolbar.
  return (
    <div className="file-viewer">
      <div className="file-viewer-body">
        <PdfCanvas
          path={path}
          onOpenExternally={onOpenExternally}
          tabKey={tabKey}
          groupId={groupId}
          onReverseSource={onReverseSource}
        />
      </div>
    </div>
  );
}
