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
import { useFileScope, readFileBytes, writeFileBytes, fileMtime } from "../fileAccess";
import { jumpToSource, useViewerState } from "../FileViewerPane";
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
} from "../../../lib/viewers/pageModel";
import { openSource, newSourceId, buildPdf, type PdfSources } from "./pdfDoc";
import { PageStrip } from "../../common/PageStrip";
import type { PageTransfer } from "../../../stores/pdfDrag";
import { ContextFilePicker } from "../ContextFilePicker";
import { useProjectsStore } from "../../../stores/projects";
import { resolveProjectDirectory } from "../../../types";
import { basename, isPathWithin } from "../../../lib/paths";
import {
  pdfPageMatches,
  pdfPointToBigPoints,
  bigPointsToCssRect,
  synctexEdit,
  refineToWord,
  type SyncRect,
  type TextItemBox,
  type CaretPhrase,
} from "../../../lib/viewers/tex";

// pdf.js renders pages on a worker; point it at the bundled worker asset. Vite
// emits a hashed URL that resolves in both dev and the packaged Tauri build.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** How often the open PDF re-checks its file's mtime for an on-disk change (a
 *  LaTeX recompile rewrites the very bytes this tab is showing). Mirrors the
 *  other viewers' poll interval. */
const RELOAD_POLL_MS = 1500;

const PDF_MIN_SCALE = 0.1;
const PDF_MAX_SCALE = 8;
const PDF_ZOOM_STEP = 1.2;
const clampPdfScale = (s: number) => Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, s));

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
}: {
  doc?: PDFDocumentProxy;
  page: number;
  rot: number;
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
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, doc, page, rot]);

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
  searchMatches,
  searchScrollNonce,
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
  /** Ctrl+F search hits on THIS page: each match is its constituent boxes (big
   *  points), and `current` marks the one the find bar is parked on (#71).
   *  Painted as translucent overlays over the canvas. */
  searchMatches?: { rects: SyncRect[]; current: boolean }[];
  /** Bumped when the current search match lands on this page, so the current
   *  match's box scrolls into view (mirrors the SyncTeX reveal). */
  searchScrollNonce?: number;
}) {
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

  useEffect(() => {
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
  }, [doc, pageNumber, rot, scale]);

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
    (boxRef.current ?? wrapRef.current)?.scrollIntoView({ block: "center", inline: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.nonce]);

  // Ctrl+F: scroll the current match into view when the find bar parks it on this
  // page (`searchScrollNonce` bumps). All pages are mounted, so the target page's
  // box is always present to scroll to.
  useEffect(() => {
    if (!searchScrollNonce) return;
    searchCurrentRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchScrollNonce]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // Reverse search is a Ctrl/⌘-click affordance; plain clicks stay free for
    // text selection in the PDF.
    if (!onSyncClick || !(e.ctrlKey || e.metaKey)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const { x, y } = pdfPointToBigPoints(rect, e.clientX, e.clientY, scale);
    // Mark the clicked point so the source-jump has feedback on the PDF side; the
    // canvas sits flush at the wrapper's top-left, so canvas-local offsets are
    // wrapper-local. Clear any prior marker's timer and fade out after ~2s.
    setClickMark((m) => ({
      left: e.clientX - rect.left,
      top: e.clientY - rect.top,
      nonce: (m?.nonce ?? 0) + 1,
    }));
    if (clickTimer.current != null) window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => setClickMark(null), 2000);
    onSyncClick(pageNumber, x, y);
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
      <div className="file-viewer-pdf-page-gap" aria-hidden="true">
        {pageNumber} / {doc.numPages}
      </div>
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
}: {
  path: string;
  /** When set, an "Open externally" button is shown at the end of the toolbar.
   *  Used by the standalone PDF tab, which has no separate header row. */
  onOpenExternally?: () => void;
  /** This viewer tab's key, for #viewerpos scroll/zoom persistence. */
  tabKey?: string;
  /** Hosting subwindow (group) id, for proportional scroll-linking (scrollSync). */
  groupId?: string | null;
}) {
  const scope = useFileScope();
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
  // Undo/redo: the arrangement is a small immutable list, so history is just a
  // stack of them.
  const [past, setPast] = useState<PageList[]>([]);
  const [future, setFuture] = useState<PageList[]>([]);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /** The page rail (the thumbnail strip you arrange pages in) is showing. */
  const [railOpen, setRailOpen] = useState(false);
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

  /** Unsaved edits: the arrangement no longer describes the file on disk. */
  const dirty = doc != null && pages.length > 0 && !isPristine(pages, doc.numPages);
  // The mtime poll runs on an interval that closes over its own scope; it needs
  // the LIVE dirty flag to decide whether an on-disk change may auto-reload.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

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
  useEffect(() => {
    if (!reveal) return;
    setHighlight({ rect: reveal.rect, nonce: reveal.nonce, phrase: reveal.phrase });
    consumeReveal(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);

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
  const handleSave = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setEditError(null);
    try {
      const bytes = await buildPdf(pages, sources);
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
  }, [dirty, saving, pages, sources, path, scope]);

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
          `Could not insert ${basename(abs)}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    [scope, spliceIn, insertAt],
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
        const bytes = await buildPdf(picked, sourcesRef.current);
        const token = await invoke<string>("pdf_clip_set", { bytes: Array.from(bytes) });
        return { token, count: picked.length };
      } catch (e) {
        setEditError(
          `Could not copy those pages: ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      }
    },
    [],
  );

  /** Take pages dragged out of another viewer and splice them in at `index`. */
  const importPages = useCallback(
    (transfer: PageTransfer, index: number) => {
      void (async () => {
        try {
          const bytes = await invoke<number[]>("pdf_clip_get", { token: transfer.token });
          await spliceIn(new Uint8Array(bytes), index);
        } catch (e) {
          setEditError(
            `Could not insert those pages: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      })();
    },
    [spliceIn],
  );

  /** The dragged pages were MOVED (Shift) and the drop was acknowledged: drop them. */
  const dropMovedPages = useCallback(
    (ids: string[]) => {
      applyEdit(deletePages(pagesRef.current, ids));
    },
    [applyEdit],
  );
  // Per-SHEET text runs, extracted lazily the first time the find bar is used and
  // cached until the arrangement changes. Indexed by position in the arrangement —
  // not by page number in the file — so a search hit points at the sheet you are
  // actually looking at once pages have been moved, deleted or merged in. Each
  // sheet is read from its own source document, at its own rotation.
  const [pageText, setPageText] = useState<TextItemBox[][] | null>(null);
  useEffect(() => { setPageText(null); }, [pages]);
  useEffect(() => {
    if (!findOpen || pageText || pages.length === 0) return;
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
  }, [pages, sources, findOpen, pageText]);

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

  // Ctrl/Cmd+F opens the find bar; Esc closes it. Bound on the host so it fires
  // wherever focus sits within the PDF pane (the scroll area is focusable).
  const onHostKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "f") {
        e.preventDefault();
        openFind();
      } else if (mod && key === "s") {
        e.preventDefault();
        void handleSave();
      } else if (mod && key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (e.key === "Escape" && findOpen) {
        e.preventDefault();
        closeFind();
      }
    },
    [openFind, closeFind, findOpen, handleSave, undo, redo],
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
  const onSyncClick = useCallback(
    async (page: number, x: number, y: number) => {
      const src = await synctexEdit(path, page, x, y);
      if (src) jumpToSource(src.input, src.line, src.column);
    },
    [path],
  );

  // Poll mtime; on an advance (e.g. a recompile wrote a new PDF), bump
  // diskVersion so the load effect re-reads the fresh bytes (#43-style).
  useEffect(() => {
    lastMtime.current = null;
    let cancelled = false;
    fileMtime(path, scope)
      .then((m) => { if (!cancelled) lastMtime.current = m; })
      .catch(() => {});
    const id = setInterval(() => {
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
    }, RELOAD_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [path, scope]);

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
      (samePathReload && el
        ? { top: el.scrollTop, left: el.scrollLeft }
        : null);
    reloadKeepZoom.current = samePathReload;
    loadedPath.current = path;
    setDoc(null);
    setError(null);
    (async () => {
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
        // A load is a fresh start: one source, the identity arrangement, no history.
        // The ref is the authoritative map (the cleanup below frees from it, and it
        // is correct even if a teardown beats React's re-render).
        sourcesRef.current = new Map([[SELF, src]]);
        setSources(sourcesRef.current);
        setPages(initialPages(src.doc.numPages));
        setPast([]);
        setFuture([]);
        setStaleOnDisk(false);
        setEditError(null);
        setDoc(src.doc);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    // Safety net: stop trying to restore after the pages have had time to lay
    // out, so a target the reloaded PDF can't reach never re-applies later
    // (e.g. fighting a subsequent zoom).
    const restoreDeadline = restoreScroll.current
      ? setTimeout(() => { restoreScroll.current = null; }, 2000)
      : null;
    return () => {
      cancelled = true;
      // Release every document the outgoing arrangement drew from — the file itself
      // AND any merged-in PDFs — not just the one this effect opened.
      for (const s of sourcesRef.current.values()) s.doc.destroy();
      sourcesRef.current = new Map();
      if (restoreDeadline) clearTimeout(restoreDeadline);
    };
  }, [path, scope, diskVersion]);

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
  const [visiblePage, setVisiblePage] = useState(1);
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
      <div className="file-viewer-pdf-toolbar" role="group" aria-label="PDF zoom controls">
        <button
          className="file-viewer-zoom-btn"
          onClick={() => {
            fittedRef.current = false;
            setScale((s) => clampPdfScale(s / PDF_ZOOM_STEP));
          }}
          disabled={!doc || scale <= PDF_MIN_SCALE}
          title="Zoom out"
          aria-label="Zoom out"
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
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          className="file-viewer-zoom-btn file-viewer-zoom-text"
          onClick={() => doc && void fitWidth(doc)}
          disabled={!doc}
          title="Fit page width"
        >
          Fit width
        </button>
        {doc && (
          <span className="file-viewer-pdf-pagenum" title="Page">
            {visiblePage} / {pages.length}
          </span>
        )}
        <button
          className={`file-viewer-zoom-btn${findOpen ? " active" : ""}`}
          onClick={() => (findOpen ? closeFind() : openFind())}
          disabled={!doc}
          title="Find (Ctrl+F)"
          aria-label="Find"
          aria-pressed={findOpen}
        >
          🔍
        </button>
        {/* ── Page arranging (#page-arrange) ────────────────────────────────
            Edits live in memory until Save, so a stray delete is always one Ctrl+Z
            away and never touches the file. */}
        <button
          className={`file-viewer-zoom-btn${railOpen ? " active" : ""}`}
          onClick={() => setRailOpen((v) => !v)}
          disabled={!doc}
          title="Arrange pages"
          aria-label="Arrange pages"
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
              ? "Insert the pages of another PDF from this project"
              : "Insert PDF: no project tree to pick from"
          }
          aria-label="Insert PDF"
        >
          ⊕
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={undo}
          disabled={past.length === 0}
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
        >
          ↶
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={redo}
          disabled={future.length === 0}
          title="Redo (Ctrl+Shift+Z)"
          aria-label="Redo"
        >
          ↷
        </button>
        <button
          className={`file-viewer-zoom-btn file-viewer-zoom-text${dirty ? " is-dirty" : ""}`}
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
          title={dirty ? "Save the rearranged PDF (Ctrl+S)" : "No page changes to save"}
        >
          {saving ? (
            <span className="file-viewer-save-spinner" aria-hidden="true" />
          ) : (
            `Save${dirty ? " •" : ""}`
          )}
        </button>
        <button
          className={`file-viewer-print file-viewer-pdf-print${printing ? " is-busy" : ""}`}
          onClick={() => void handlePrint()}
          disabled={!doc || printing}
          title={printing ? "Preparing…" : "Print"}
          aria-label="Print"
        >
          {printing ? <span className="file-viewer-save-spinner" aria-hidden="true" /> : "🖨"}
        </button>
        {onOpenExternally && (
          <button
            className="file-viewer-open-external file-viewer-pdf-external"
            onClick={onOpenExternally}
            title="Open in external app"
            aria-label="Open in external app"
          >
            ↗
          </button>
        )}
      </div>
      {findOpen && (
        <div className="file-viewer-find file-viewer-find-pdf" role="search">
          <div className="file-viewer-find-row">
            <input
              ref={findInputRef}
              className="file-viewer-find-input"
              type="text"
              value={query}
              placeholder="Find in document"
              aria-label="Find"
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
              title="Match case"
              aria-label="Match case"
            >
              Aa
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={() => goToMatch(-1)}
              disabled={matches.length === 0}
              title="Previous match (Shift+Enter)"
              aria-label="Previous match"
            >
              ↑
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={() => goToMatch(1)}
              disabled={matches.length === 0}
              title="Next match (Enter)"
              aria-label="Next match"
            >
              ↓
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={closeFind}
              title="Close (Esc)"
              aria-label="Close find"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {staleOnDisk && (
        // The file changed underneath our unsaved edits. Reloading would throw them
        // away and saving would overwrite the newer file, so neither happens on its
        // own — the reader picks.
        <div className="file-viewer-banner" role="alert">
          <span>This PDF changed on disk, and you have unsaved page changes.</span>
          <button
            onClick={() => {
              setStaleOnDisk(false);
              setDiskVersion((v) => v + 1);
            }}
          >
            Reload &amp; discard my changes
          </button>
          <button onClick={() => setStaleOnDisk(false)}>Keep my changes</button>
        </div>
      )}
      {editError && (
        <div className="file-viewer-banner is-error" role="alert">
          <span>{editError}</span>
          <button onClick={() => setEditError(null)}>Dismiss</button>
        </div>
      )}
      <div className="file-viewer-pdf-scroll-wrap">
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
                <PdfThumb doc={sources.get(ref.src)?.doc} page={ref.page} rot={ref.rot} />
              )}
              badgeFor={(_ref, i) => String(i + 1)}
              titleFor={(ref) =>
                (ref.src === SELF
                  ? `Page ${ref.page}`
                  : `Page ${ref.page} of a merged document`) +
                (ref.rot ? ` · turned ${ref.rot}°` : "")
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
            <div className="file-viewer-loading">Loading…</div>
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
                    searchMatches={searchByPage.get(i + 1)}
                    searchScrollNonce={currentPage === i + 1 ? searchScrollNonce : 0}
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
              setEditError(`${basename(abs)} is not a PDF.`);
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
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
  groupId?: string | null;
}) {
  // No ViewerHeader: the tab already shows the file name, so a filename row would
  // be redundant. The "Open externally" action lives in the PdfCanvas toolbar.
  return (
    <div className="file-viewer">
      <div className="file-viewer-body">
        <PdfCanvas path={path} onOpenExternally={onOpenExternally} tabKey={tabKey} groupId={groupId} />
      </div>
    </div>
  );
}
