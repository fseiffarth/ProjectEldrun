import { create } from "zustand";
import type { SyncRect } from "../components/files/tex";

/**
 * Cross-tab "reveal + highlight this PDF box" channel for SyncTeX forward
 * search. After a compile, `synctex view` maps the source caret to a page + box
 * in the PDF; the PDF tab is a separate component (often already open), so the
 * TeX side posts the request here keyed by the absolute PDF path and `PdfCanvas`
 * for that path consumes it — scrolling the page into view and flashing a
 * highlight. The `nonce` lets a repeat reveal of the same spot fire again.
 */
export interface RevealRequest {
  rect: SyncRect;
  nonce: number;
}

interface PdfSyncStore {
  byPath: Record<string, RevealRequest>;
  /** Ask the PDF view for `pdf` to scroll to and highlight `rect`. */
  requestReveal: (pdf: string, rect: SyncRect) => void;
  /** Clear the pending reveal for `pdf` once the view has applied it. */
  consume: (pdf: string) => void;
}

export const usePdfSyncStore = create<PdfSyncStore>((set) => ({
  byPath: {},
  requestReveal: (pdf, rect) =>
    set((s) => {
      const prev = s.byPath[pdf];
      return {
        byPath: { ...s.byPath, [pdf]: { rect, nonce: (prev?.nonce ?? 0) + 1 } },
      };
    }),
  consume: (pdf) =>
    set((s) => {
      if (!(pdf in s.byPath)) return {};
      const next = { ...s.byPath };
      delete next[pdf];
      return { byPath: next };
    }),
}));
