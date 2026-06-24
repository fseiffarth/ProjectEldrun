import { create } from "zustand";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { SyncRect, CaretPhrase } from "../lib/viewers/tex";

/**
 * Cross-tab "reveal + highlight this PDF box" channel for SyncTeX forward
 * search. After a compile, `synctex view` maps the source caret to a page + box
 * in the PDF; the PDF tab is a separate component (often already open), so the
 * TeX side posts the request here keyed by the absolute PDF path and `PdfCanvas`
 * for that path consumes it — scrolling the page into view and flashing a
 * highlight. The `nonce` lets a repeat reveal of the same spot fire again.
 *
 * #42 cross-window: the PDF may be popped out into a detached OS window, which is
 * a SEPARATE webview with its own Zustand heap — a local store write would never
 * reach it. So `requestReveal` also broadcasts the request over a global Tauri
 * event; every window registers `listenPdfReveal` and applies an incoming reveal
 * to its own store, so whichever window hosts the PDF reveals it. The originating
 * window stamps `from` and skips its own echo (it already applied it locally).
 */
export interface RevealRequest {
  rect: SyncRect;
  nonce: number;
  /** When set, the clicked word + its surrounding phrase: the PDF view narrows
   *  `rect` (a SyncTeX line box) to the exact clicked word, using the phrase to
   *  disambiguate which occurrence of a common word to highlight. */
  phrase?: CaretPhrase;
}

/** Tauri event carrying a reveal across the main/detached window boundary. */
export const PDF_REVEAL_EVENT = "pdf-sync-reveal";

/** Envelope for a cross-window reveal (the request plus the originating window's
 *  label, so a window ignores the echo of its own broadcast). */
export interface PdfRevealEnvelope {
  pdf: string;
  rect: SyncRect;
  phrase?: CaretPhrase;
  from: string;
}

/** The current window's Tauri label, or "" outside a Tauri context (tests). */
function currentLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "";
  }
}

interface PdfSyncStore {
  byPath: Record<string, RevealRequest>;
  /** Ask the PDF view for `pdf` to scroll to and highlight `rect`. When `phrase`
   *  is given, the view refines `rect` down to the clicked word on the target
   *  page. Applies locally AND broadcasts so a PDF hosted in another (detached)
   *  window reveals too (#42). */
  requestReveal: (pdf: string, rect: SyncRect, phrase?: CaretPhrase) => void;
  /** Record a reveal in THIS window's store (the local half of requestReveal, and
   *  what `listenPdfReveal` calls for a reveal broadcast from another window). */
  applyReveal: (pdf: string, rect: SyncRect, phrase?: CaretPhrase) => void;
  /** Clear the pending reveal for `pdf` once the view has applied it. */
  consume: (pdf: string) => void;
}

// Monotonic reveal counter. The nonce must STRICTLY increase across reveals:
// `PdfCanvas` copies each reveal into local `highlight` state that isn't cleared
// on consume, so a nonce derived from the (deleted-on-consume) store entry would
// reset to 1 and a repeat reveal would look unchanged — firing the scroll/flash
// only once. A module counter never resets, so every reveal re-triggers it.
let revealSeq = 0;

export const usePdfSyncStore = create<PdfSyncStore>((set, get) => ({
  byPath: {},
  applyReveal: (pdf, rect, phrase) =>
    set((s) => ({
      byPath: { ...s.byPath, [pdf]: { rect, nonce: ++revealSeq, phrase } },
    })),
  requestReveal: (pdf, rect, phrase) => {
    get().applyReveal(pdf, rect, phrase);
    // Broadcast to the other window(s) in case the PDF is popped out there (#42).
    // Best-effort: a non-Tauri env (tests) simply skips the broadcast.
    try {
      emit(PDF_REVEAL_EVENT, {
        pdf,
        rect,
        phrase,
        from: currentLabel(),
      } satisfies PdfRevealEnvelope).catch(() => {});
    } catch {
      /* no Tauri event bus available (synchronous failure) */
    }
  },
  consume: (pdf) =>
    set((s) => {
      if (!(pdf in s.byPath)) return {};
      const next = { ...s.byPath };
      delete next[pdf];
      return { byPath: next };
    }),
}));

/**
 * Register THIS window's listener for cross-window reveal broadcasts (#42). Every
 * window (main shell + each detached popout) calls this once at startup; an
 * incoming reveal that didn't originate here is applied to the local store, so
 * the `PdfCanvas` hosting that PDF reveals it regardless of which window the TeX
 * editor lives in. Returns an unlisten. No-ops outside a Tauri context.
 */
export async function listenPdfReveal(): Promise<() => void> {
  const self = currentLabel();
  try {
    return await listen<PdfRevealEnvelope>(PDF_REVEAL_EVENT, (ev) => {
      const { pdf, rect, phrase, from } = ev.payload;
      if (from === self) return; // we already applied our own reveal locally
      usePdfSyncStore.getState().applyReveal(pdf, rect, phrase);
    });
  } catch {
    return () => {};
  }
}
