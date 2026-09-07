/**
 * The fullscreen **PDF present window** — the OS window that shows one PDF and
 * nothing else, for reading a beamer deck (or any PDF) off a projector without
 * the tab bar, the toolbar and the desktop around it.
 *
 * Deliberately a *sibling* of the deck presenter's audience window rather than
 * something new (`src/lib/viewers/deck/present.ts`, `commands/presenter.rs`):
 *
 *  - The label carries the `present-` prefix because that is what
 *    `capabilities/default.json` grants window permissions by and what
 *    `valid_presenter_label` accepts — a label outside that shape opens a window
 *    that cannot call anything. The extra `pdf-` segment is what tells the two
 *    kinds apart in `App`, and cannot collide with a deck label: those are
 *    `present-<hash>`, with the hash carrying no hyphen of its own.
 *  - It is derived from the PATH, not minted per click, so presenting the same
 *    PDF twice re-uses (and re-focuses) the window already on the projector
 *    instead of stacking a second one on it.
 *
 * What crosses between the windows is only the *address* of the file: two Tauri
 * windows are two JS heaps, and a 130 MB thesis has no business travelling as an
 * event payload. The present window opens the path itself over the ordinary
 * confined file commands — which also means it shows the file **as saved on
 * disk**, not the unsaved page arrangement the viewer may be holding. The
 * toolbar button says so when that difference exists.
 *
 * Unlike the deck's audience window there is no "one owner" of the position
 * here: once seeded, the present window navigates itself. A talk has two
 * displays that must never disagree; a PDF opened fullscreen is one display, and
 * making the editor tab drive it would only mean two places to press the same
 * arrow key.
 *
 * Pure, so both windows and the tests share it.
 */

/**
 * FNV-1a (32-bit), base36 — the same shape `deck/present.ts` and
 * `pageFingerprint.ts` use. It only needs to be deterministic and collision-shy
 * across the handful of PDFs one session presents: it names a window, it does
 * not secure anything.
 */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The present window's Tauri label for a PDF. */
export function pdfPresentLabel(path: string): string {
  return `present-pdf-${hash32(path)}`;
}

/**
 * Is this present-window label a PDF one (rather than a deck audience one)?
 * `App` routes on it, so it is matched exactly rather than by prefix alone.
 */
export function isPdfPresentLabel(label: string): boolean {
  return /^present-pdf-[a-z0-9]+$/.test(label);
}

/** Editor → present window, namespaced by label: which file, and where to start. */
export const pdfPresentSeedEvent = (label: string) => `pdf-present-seed-${label}`;

/** Present window → editor: "I am mounted, send me a seed" (carries its label). */
export const PDF_PRESENT_READY = "pdf-present-ready";

export interface PdfPresentSeed {
  /** The PDF's path, opened by the present window itself. */
  path: string;
  /** File scope (owning project id) for the confined file commands; null = root. */
  scope: string | null;
  /** The 1-based sheet to open on — the one the reader is looking at. */
  page: number;
}

export interface PdfPresentReady {
  label: string;
}

/**
 * The sheet a request lands on: 1-based, inside the document, and 1 for a
 * document with no pages at all (there is nothing else to show, and a 0 would
 * mean asking pdf.js for a page that does not exist).
 *
 * Every navigation goes through this rather than clamping at the key handler,
 * because the seed arrives before the document is open: the page it asks for is
 * only checkable once the page count is known.
 */
export function clampPage(page: number, count: number): number {
  if (!Number.isFinite(page) || count <= 0) return 1;
  return Math.min(Math.max(Math.trunc(page), 1), count);
}
