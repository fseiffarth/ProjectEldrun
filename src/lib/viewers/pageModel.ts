/**
 * The page-arrangement model shared by the print preview and the PDF viewer's
 * page rail.
 *
 * An arrangement is a plain ordered list of {@link PageRef}s — one entry per sheet,
 * in the order it appears. Every operation is pure and returns a new list, so a
 * history stack is just an array of lists, and rendering is a straight map.
 *
 * Each entry carries its OWN id, source and rotation. That is the whole point, and
 * it is what the print preview's earlier model (`order: number[]` plus rotations
 * keyed by original page number) could not express:
 *
 *   - `src` lets one arrangement draw pages from SEVERAL documents, which is what
 *     merging a second PDF needs.
 *   - `rot` per entry lets a duplicated page be turned independently of its twin;
 *     keyed by original page number, both copies would have turned together.
 *   - the operations take a SET of ids, so a multi-selection moves as one block.
 *
 * The print preview is the degenerate case: every entry has `src === SELF`, and the
 * list starts as the identity mapping over the document's own pages.
 */

/** Which document an entry's page comes from. */
export type SourceId = string;

/** The source id of the document the arrangement belongs to (the file on disk). */
export const SELF: SourceId = "self";

/** A quarter-turn multiple. Anything else is not representable in a PDF's /Rotate. */
export type Rotation = 0 | 90 | 180 | 270;

/**
 * An area of a sheet to black out, in big points at scale 1 in the sheet's *rotated*
 * space (top-left origin) — the same coordinates the Ctrl+F hits, the SyncTeX
 * highlight and the link boxes are stored in, so one `bigPointsToCssRect` positions
 * all of them and a mark follows zoom and rotation for free.
 *
 * A mark is a *pending* redaction: it is drawn over the page while the arrangement
 * is being edited and only becomes real at save, where the sheet carrying it is
 * flattened (see `pdf/pdfDoc`'s `buildPdf`). Covering text with a black rectangle
 * is the classic redaction failure — the glyphs stay in the content stream and come
 * straight back out of any copy/extract — so nothing here ever draws a box *into* a
 * PDF.
 */
export interface RedactRect {
  /** Unique within its sheet — the key a click removes one by. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One sheet in an arrangement: a 1-based page of some source, at some rotation. */
export interface PageRef {
  /** Unique within its list, and stable across moves — selection keys off it. */
  id: string;
  src: SourceId;
  /** 1-based page number *within `src`*. */
  page: number;
  rot: Rotation;
  /** Areas to black out. Absent (not `[]`) on a sheet nobody has redacted, so an
   *  untouched arrangement stays byte-identical to what it always was. Marks ride
   *  ON the entry rather than in a side map so they travel with the sheet through
   *  every op here — a moved page keeps its blackouts, a duplicate gets its own
   *  copy of them, and undo/redo needs no second history. */
  marks?: RedactRect[];
}

/** An arrangement: the sheets, in order. The single source of truth. */
export type PageList = PageRef[];

// Ids only have to be unique within one list, so a counter is enough — and unlike a
// random id it keeps tests readable and diffs stable.
let nextId = 0;

/** A fresh entry id. */
export function newPageId(): string {
  nextId += 1;
  return `p${nextId}`;
}

/** The identity arrangement over a document's own pages — the starting point. */
export function initialPages(pageCount: number, src: SourceId = SELF): PageList {
  return Array.from({ length: Math.max(0, pageCount) }, (_, i) => ({
    id: newPageId(),
    src,
    page: i + 1,
    rot: 0 as Rotation,
  }));
}

/** Build entries for `pageCount` pages of `src` — the pages a merge splices in. */
export function pagesOf(src: SourceId, pageCount: number): PageList {
  return initialPages(pageCount, src);
}

/**
 * Move every entry in `ids` so the block lands at `toIndex`.
 *
 * `toIndex` counts the entries that are NOT being moved — it is an index into the
 * list with the selection already taken out ("insert before the `toIndex`-th
 * survivor"; `>= survivors` appends). That is the index a drag naturally produces,
 * because the dragged cards are exactly the ones the pointer is not hit-testing
 * against, and it is the convention the print strip has always used.
 *
 * The moved entries keep their relative order, so dragging a multi-selection moves
 * it as a block rather than collapsing it.
 */
export function movePages(list: PageList, ids: readonly string[], toIndex: number): PageList {
  const moving = new Set(ids);
  const selected = list.filter((r) => moving.has(r.id));
  if (selected.length === 0) return [...list];
  const rest = list.filter((r) => !moving.has(r.id));
  const at = Math.min(Math.max(toIndex, 0), rest.length);
  return [...rest.slice(0, at), ...selected, ...rest.slice(at)];
}

/** Drop every entry in `ids`. Unknown ids are ignored. */
export function deletePages(list: PageList, ids: readonly string[]): PageList {
  const dropping = new Set(ids);
  return list.filter((r) => !dropping.has(r.id));
}

/**
 * Turn every entry in `ids` by `by` degrees (default a quarter turn clockwise).
 * Wraps, so four turns is a full circle back to upright.
 */
export function rotatePages(list: PageList, ids: readonly string[], by = 90): PageList {
  const turning = new Set(ids);
  return list.map((r) =>
    turning.has(r.id)
      ? { ...r, rot: ((((r.rot + by) % 360) + 360) % 360) as Rotation }
      : r,
  );
}

/**
 * Copy every entry in `ids`, placing each copy right after its original. Copies get
 * fresh ids, so they select, move and rotate independently of the pages they came
 * from.
 */
export function duplicatePages(list: PageList, ids: readonly string[]): PageList {
  const copying = new Set(ids);
  return list.flatMap((r) =>
    // The copy gets its OWN marks array: the ops in `lib/viewers/redact` are all
    // pure, so sharing it would be safe today, but a shared array is exactly the
    // kind of aliasing that makes a later in-place edit black out two sheets.
    copying.has(r.id)
      ? [r, { ...r, id: newPageId(), ...(r.marks ? { marks: [...r.marks] } : {}) }]
      : [r],
  );
}

/**
 * Splice `refs` in before the entry at `atIndex` (`>= list.length` appends). The
 * refs are re-id'd, so inserting the same pages twice — or pages that came from
 * this very list — never collides.
 */
export function insertPages(list: PageList, refs: PageList, atIndex: number): PageList {
  const at = Math.min(Math.max(atIndex, 0), list.length);
  const fresh = refs.map((r) => ({ ...r, id: newPageId() }));
  return [...list.slice(0, at), ...fresh, ...list.slice(at)];
}

/**
 * True when `list` is still the untouched identity arrangement over a `pageCount`-page
 * document: same length, original order, nothing turned, nothing merged in, nothing
 * marked for blacking out. Drives the "Reset pages" affordance and the viewer's dirty
 * marker.
 */
export function isPristine(list: PageList, pageCount: number): boolean {
  return (
    list.length === pageCount &&
    list.every(
      (r, i) => r.src === SELF && r.page === i + 1 && r.rot === 0 && !r.marks?.length,
    )
  );
}
