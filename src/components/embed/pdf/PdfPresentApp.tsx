/**
 * The fullscreen **PDF present window**: one PDF, one sheet at a time, nothing
 * else on the screen.
 *
 * It is its own OS window and its own JS heap (`?present=present-pdf-…`, see
 * `present.ts`), so it loads the file itself, keeps its own theme, and owns its
 * own position in the document from the moment it is seeded. The editor tab that
 * opened it is not a remote control — a PDF on a projector is *one* display, and
 * the reader is standing at whichever keyboard is in front of them.
 *
 * Everything here is deliberately small: no toolbar, no thumbnails, no text
 * layer, no remarks. The heavy viewer already exists in `PdfViewer` and is what
 * this window is an escape *from*; reusing it would have put a toolbar on the
 * projector.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { readFileBytes } from "../fileAccess";
import { applyTheme, THEME_CHANGED_EVENT, useSettingsStore } from "../../../stores/settings";
import { useT } from "../../../lib/i18n";
import {
  type PdfPresentSeed,
  PDF_PRESENT_READY,
  clampPage,
  pdfPresentSeedEvent,
} from "./present";

// Idempotent, and set here rather than relied upon: this window loads the PDF
// viewer's module for nothing else, and a worker-less pdf.js parses on the UI
// thread — which on a 300-page document is a black projector for seconds.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** How often to re-announce readiness until a seed lands (the editor may still
 *  be mounting its listener when this window first asks). */
const READY_RETRY_MS = 400;

/** How long the key hint stays up after the first sheet appears. */
const HINT_MS = 4000;

export interface PdfPresentAppProps {
  /** This window's Tauri label, from `?present=` — the seed channel's namespace. */
  label: string;
}

export function PdfPresentApp({ label }: PdfPresentAppProps) {
  const t = useT();
  const loadSettings = useSettingsStore((s) => s.load);

  const [seed, setSeed] = useState<PdfPresentSeed | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [painted, setPainted] = useState(false);
  const [fullscreen, setFullscreen] = useState(true);
  const [hint, setHint] = useState(true);

  // The live sheet for the key handler, which must step off the sheet on screen
  // without re-subscribing on every turn of the page.
  const pageRef = useRef(1);
  pageRef.current = page;
  const countRef = useRef(0);
  countRef.current = count;

  // --- window chrome -------------------------------------------------------
  //
  // Theme: this window has its own settings store, so it loads them itself and
  // follows the main window's live broadcast — the bargain `DetachedApp` and the
  // deck's audience window both strike. Zoom is NOT applied: a projected sheet is
  // sized by the window, not by the editor's zoom.

  useEffect(() => {
    void loadSettings({ skipZoom: true });
  }, [loadSettings]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string>(THEME_CHANGED_EVENT, (e) => applyTheme(e.payload))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Don't let the screensaver blank a projector mid-talk. The inhibitor is the
  // deck presenter's — global, idempotent and released on the way out — so a PDF
  // shown fullscreen gets the same treatment a deck does for free.
  useEffect(() => {
    void invoke("presenter_inhibit_sleep", { reason: "Presenting a PDF" }).catch(() => {});
    return () => {
      void invoke("presenter_release_sleep").catch(() => {});
    };
  }, []);

  /** Close this window. The inhibitor is released FIRST: `destroy()` takes the
   *  renderer with it, so an unmount cleanup after it is not guaranteed to run. */
  const closeSelf = useCallback(() => {
    void (async () => {
      await invoke("presenter_release_sleep").catch(() => {});
      await getCurrentWindow().destroy().catch(() => {});
    })();
  }, []);

  // Whether the window is actually fullscreen — the pointer is hidden only then.
  // A window the WM dropped out of fullscreen (a display unplugged mid-talk)
  // needs a pointer to be draggable at all, which is the same trap the deck's
  // audience window documents.
  useEffect(() => {
    const win = getCurrentWindow();
    void win.isFullscreen().then(setFullscreen).catch(() => {});
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void win
      .onResized(() => {
        void win.isFullscreen().then(setFullscreen).catch(() => {});
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // --- the seed ------------------------------------------------------------

  const seededRef = useRef(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listen<PdfPresentSeed>(pdfPresentSeedEvent(label), (e) => {
      seededRef.current = true;
      setSeed(e.payload);
      // A re-seed (the reader pressed Present again, from a different sheet)
      // moves this window to where they now are. The clamp needs the page count,
      // which the load effect below re-applies once the document is open.
      setPage(clampPage(e.payload.page, countRef.current || e.payload.page));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    // Ask, and keep asking until answered: this window and the editor's listener
    // race on open, and a dropped first request would leave a blank projector
    // with nothing to press.
    void emit(PDF_PRESENT_READY, { label });
    const retry = setInterval(() => {
      if (seededRef.current) return;
      void emit(PDF_PRESENT_READY, { label });
    }, READY_RETRY_MS);

    return () => {
      cancelled = true;
      clearInterval(retry);
      unlisten?.();
    };
  }, [label]);

  // --- the document --------------------------------------------------------

  const path = seed?.path ?? "";
  const scope = seed?.scope ?? null;
  const startPage = seed?.page ?? 1;

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    void (async () => {
      try {
        const bytes = await readFileBytes(path, scope);
        // pdf.js DETACHES the buffer it is handed; nothing here needs the bytes
        // afterwards (this window never writes), so it is given them outright.
        const loaded = await pdfjs.getDocument({ data: bytes }).promise;
        opened = loaded;
        if (cancelled) {
          loaded.loadingTask.destroy();
          return;
        }
        setDoc(loaded);
        setCount(loaded.numPages);
        setPage(clampPage(startPage, loaded.numPages));
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      opened?.loadingTask.destroy();
      setDoc(null);
      setPainted(false);
    };
    // Keyed on the FILE, not on the seed: a re-seed for the same path (Present
    // pressed again) moves the sheet without tearing down the document and
    // re-parsing it in front of the room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, scope]);

  // --- painting ------------------------------------------------------------

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(() => ({
    w: typeof window === "undefined" ? 0 : window.innerWidth,
    h: typeof window === "undefined" ? 0 : window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!doc || size.w <= 0 || size.h <= 0) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    void (async () => {
      const sheet = await doc.getPage(clampPage(page, doc.numPages));
      if (cancelled) return;
      // The page's own `/Rotate` is what `getViewport` applies by default, and
      // this window offers no turning of its own — a projected sheet is shown the
      // way the document says it should be.
      const base = sheet.getViewport({ scale: 1 });
      // Whole-sheet fit, never fit-width: a sheet that has to be scrolled to be
      // read is not a presentation.
      const fit = Math.min(size.w / base.width, size.h / base.height);
      const dpr = window.devicePixelRatio || 1;
      const viewport = sheet.getViewport({ scale: fit * dpr });
      const w = Math.floor(viewport.width);
      const h = Math.floor(viewport.height);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      // Paint OFF SCREEN and blit the finished sheet in, the way `PdfPageCanvas`
      // does: sizing a canvas clears it, so rendering straight onto the visible
      // one would show a blank rectangle for as long as the render takes — a
      // whole second on a dense sheet, on the projector, on every page turn.
      const off = document.createElement("canvas");
      const offCtx = off.getContext("2d");
      if (!offCtx) return;
      off.width = w;
      off.height = h;
      task = sheet.render({ canvas: off, canvasContext: offCtx, viewport });
      try {
        await task.promise;
      } catch {
        // Cancelled by a newer page or size — leave the sheet already up there.
        off.width = 0;
        off.height = 0;
        return;
      }
      if (cancelled) {
        off.width = 0;
        off.height = 0;
        return;
      }
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      ctx.drawImage(off, 0, 0);
      off.width = 0;
      off.height = 0;
      setPainted(true);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, size.w, size.h]);

  /** Fullscreen has been asserted once; a reader who pressed F11 afterwards is
   *  never overridden. */
  const assertedRef = useRef(false);

  // Make sure this window really is fullscreen — but only ONCE the first sheet is
  // on it. `open_presenter_window` places the window and fullscreens it itself,
  // and this is deliberately not a race with that: it goes fullscreen only after
  // the deferred ±1 resize that forces WebKitGTK to paint at all, because a window
  // already fullscreen skips that nudge and stays a black rectangle (the exact
  // failure `commands/presenter.rs` documents). By the time a sheet has been
  // rendered here — a seed, a file read and a parse later — that kick is long
  // done, so this can only ever be a no-op or the fix for a window the backend
  // left windowed.
  useEffect(() => {
    if (!painted || assertedRef.current) return;
    assertedRef.current = true;
    void (async () => {
      const win = getCurrentWindow();
      if (await win.isFullscreen().catch(() => true)) return;
      await win.setFullscreen(true).catch(() => {});
      setFullscreen(true);
    })();
  }, [painted]);

  // The hint retires by itself once there is something to look at.
  useEffect(() => {
    if (!painted) return;
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [painted]);

  // --- keys ----------------------------------------------------------------

  const step = useCallback((delta: number) => {
    setPage((p) => clampPage(p + delta, countRef.current));
  }, []);

  /** Digits typed toward a "go to sheet N", completed by Enter — the same
   *  gesture the deck presenter answers. */
  const gotoRef = useRef("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          closeSelf();
          return;
        case "F11":
          e.preventDefault();
          void (async () => {
            const win = getCurrentWindow();
            const fs = await win.isFullscreen().catch(() => false);
            await win.setFullscreen(!fs).catch(() => {});
            setFullscreen(!fs);
          })();
          return;
        case "Enter":
          e.preventDefault();
          if (gotoRef.current) {
            const n = Number(gotoRef.current);
            gotoRef.current = "";
            setPage(clampPage(n, countRef.current));
          } else {
            step(1);
          }
          return;
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case " ":
        case "n":
          e.preventDefault();
          step(1);
          return;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
        case "Backspace":
        case "p":
          e.preventDefault();
          step(-1);
          return;
        case "Home":
          e.preventDefault();
          setPage(1);
          return;
        case "End":
          e.preventDefault();
          setPage(clampPage(countRef.current, countRef.current));
          return;
        default:
          break;
      }
      if (/^[0-9]$/.test(e.key)) {
        // Capped, so a leaned-on key cannot build a number that means nothing.
        gotoRef.current = (gotoRef.current + e.key).slice(-4);
        return;
      }
      gotoRef.current = "";
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeSelf, step]);

  // A wheel is the other way a sheet gets turned — one notch, one sheet, because
  // there is nothing here to scroll *within*.
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.deltaY === 0) return;
      step(e.deltaY > 0 ? 1 : -1);
    },
    [step],
  );

  // --- render --------------------------------------------------------------

  const shellClass = `pdf-present${fullscreen ? " is-fullscreen" : ""}`;

  return (
    <div
      className={shellClass}
      onWheel={onWheel}
      // Click advances, the way a clicker does. The right button goes back,
      // which is what the second button on most presenters is wired to.
      onClick={() => step(1)}
      onContextMenu={(e) => {
        e.preventDefault();
        step(-1);
      }}
    >
      <canvas ref={canvasRef} className="pdf-present-sheet" />
      {!painted && (
        <div className="pdf-present-status">
          {error
            ? t("pdfPresent.loadError", { msg: error })
            : seed
              ? t("pdfPresent.opening")
              : t("pdfPresent.waiting")}
        </div>
      )}
      {painted && count > 0 && (
        <div className="pdf-present-count" aria-live="off">
          {page} / {count}
        </div>
      )}
      {painted && hint && <div className="pdf-present-hint">{t("pdfPresent.keyHint")}</div>}
    </div>
  );
}
