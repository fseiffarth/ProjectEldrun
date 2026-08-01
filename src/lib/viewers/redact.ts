/**
 * Blacking text out of a PDF (#pdf-redact) — the pure half: where a mark goes, what
 * it covers, and how a marked arrangement changes.
 *
 * Two things about redaction are worth stating up front, because both decide the
 * shape of this module and of the burn-in that consumes it (`pdf/pdfDoc`'s
 * `buildPdf`).
 *
 * **A black rectangle is not a redaction.** Drawing an opaque box over a word leaves
 * every glyph in the page's content stream: select-all, copy, `pdftotext`, or simply
 * deleting the annotation gives the text straight back. That failure is the reason
 * this feature exists at all, so a mark here is never written into a PDF as a shape
 * — it names an *area to destroy*, and the sheet carrying one is rasterised at save
 * time so the covered pixels are the only thing left.
 *
 * **A mark is geometry, not a match.** It is stored in big points in the sheet's
 * rotated space (see {@link RedactRect}), which is the space the search hits and the
 * SyncTeX highlight already live in — so a mark drawn at 80% zoom, on a page later
 * turned and moved, still covers the same words. Nothing here holds the text it
 * covers: the string that motivated a mark is exactly what must not be carried
 * around.
 *
 * Marks ride on the arrangement entries themselves (`PageRef.marks`), so every op in
 * this file is the same shape as `pageModel`'s: pure, returning a new list, which is
 * what lets the viewer's existing undo/redo stack cover redaction for free.
 */
import type { PageList, RedactRect } from "./pageModel";
import type { SyncRect, TextItemBox } from "./tex";

/** A plain rectangle in a sheet's big-point space, before it becomes a mark. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Mark ids only have to be unique within one sheet, so a counter is enough — and
// unlike a random id it keeps tests readable.
let nextMarkId = 0;

/** A fresh mark id. */
export function newMarkId(): string {
  nextMarkId += 1;
  return `m${nextMarkId}`;
}

/**
 * The rectangle a drag from `a` to `b` describes, normalised so it is positive in
 * both axes — a box is dragged up-left as readily as down-right.
 */
export function rectFromDrag(
  a: { x: number; y: number },
  b: { x: number; y: number },
): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** True when a drag produced something worth marking rather than a stray click. */
export function isDraggedFar(rect: Rect, min = 3): boolean {
  return rect.w >= min && rect.h >= min;
}

/** Do two rectangles overlap at all? Touching edges do not count. */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The smallest rectangle containing both. */
function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/**
 * Grow `rect` to cover every text run it touches, plus `pad` around the result.
 *
 * A drag is done by eye at whatever zoom the reader happens to be at, so it clips
 * ascenders, stops a glyph short of the end of a word, or misses the tail of a line
 * by a point. The burn-in is pixel-exact, which means a clipped mark leaves a legible
 * sliver of the very word it was drawn over — the one failure mode that makes the
 * feature untrustworthy. Snapping only ever *grows* the box (it is a union, never an
 * intersection), so nothing the user meant to cover can be uncovered by it.
 *
 * With no text under the drag — a figure, a signature, a scanned page — the rect is
 * returned as drawn, which is the whole point of also having a freehand box.
 */
export function snapToText(rect: Rect, items: readonly TextItemBox[], pad = 1): Rect {
  let out: Rect | null = null;
  for (const it of items) {
    const box = { x: it.x, y: it.y, w: it.w, h: it.h };
    if (!overlaps(rect, box)) continue;
    out = out ? union(out, box) : box;
  }
  if (!out) return rect;
  const grown = union(rect, out);
  return { x: grown.x - pad, y: grown.y - pad, w: grown.w + pad * 2, h: grown.h + pad * 2 };
}

/** The marks on a sheet, never null — the reader maps straight over this. */
export function marksOf(ref: { marks?: RedactRect[] }): readonly RedactRect[] {
  return ref.marks ?? [];
}

/** How many areas the whole arrangement has marked. */
export function markCount(list: PageList): number {
  return list.reduce((n, r) => n + (r.marks?.length ?? 0), 0);
}

/** How many sheets carry at least one mark — i.e. how many pages a save rasterises. */
export function markedSheetCount(list: PageList): number {
  return list.reduce((n, r) => n + (r.marks?.length ? 1 : 0), 0);
}

/** Add a mark to one sheet. A zero-area rect is dropped rather than stored. */
export function addMark(list: PageList, entryId: string, rect: Rect): PageList {
  if (rect.w <= 0 || rect.h <= 0) return list;
  return list.map((r) =>
    r.id === entryId ? { ...r, marks: [...marksOf(r), { id: newMarkId(), ...rect }] } : r,
  );
}

/** Add several marks to one sheet in a single edit (one undo step, not N). */
export function addMarks(list: PageList, entryId: string, rects: readonly Rect[]): PageList {
  const keep = rects.filter((r) => r.w > 0 && r.h > 0);
  if (keep.length === 0) return list;
  return list.map((r) =>
    r.id === entryId
      ? { ...r, marks: [...marksOf(r), ...keep.map((rect) => ({ id: newMarkId(), ...rect }))] }
      : r,
  );
}

/** Drop one mark. The `marks` key goes away with the last one, so the sheet reads
 *  as pristine again rather than as edited-back-to-empty. */
export function removeMark(list: PageList, entryId: string, markId: string): PageList {
  return list.map((r) => {
    if (r.id !== entryId || !r.marks) return r;
    const rest = r.marks.filter((m) => m.id !== markId);
    if (rest.length === r.marks.length) return r;
    const { marks: _dropped, ...bare } = r;
    return rest.length > 0 ? { ...bare, marks: rest } : bare;
  });
}

/** Clear the marks on `entryIds` — or, with no ids, on the whole arrangement. */
export function clearMarks(list: PageList, entryIds?: readonly string[]): PageList {
  const targets = entryIds ? new Set(entryIds) : null;
  return list.map((r) => {
    if (!r.marks || (targets && !targets.has(r.id))) return r;
    const { marks: _dropped, ...bare } = r;
    return bare;
  });
}

/**
 * Mark every Ctrl+F hit in the document — the fast path, and the one that makes
 * redacting a name out of a 200-page report a single click rather than 300 drags.
 *
 * `byPage` is the viewer's own match map: 1-based *sheet* index (an index into the
 * arrangement, not a file page) to the big-point boxes covering each match, exactly
 * as the search overlay is fed. Matches already covered by an existing mark are
 * skipped, so running it twice — or over a document already partly redacted by
 * hand — does not stack duplicates.
 */
export function markMatches(
  list: PageList,
  byPage: ReadonlyMap<number, readonly SyncRect[][]>,
  pad = 1,
): PageList {
  return list.map((ref, i) => {
    const matches = byPage.get(i + 1);
    if (!matches || matches.length === 0) return ref;
    const existing = marksOf(ref);
    const add: RedactRect[] = [];
    for (const rects of matches) {
      for (const r of rects) {
        const box = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
        if (box.w <= 0 || box.h <= 0) continue;
        // "Already covered" is containment, not overlap: a mark that merely clips a
        // hit leaves the rest of it legible and the hit still needs its own box.
        const covered = [...existing, ...add].some(
          (m) =>
            m.x <= box.x &&
            m.y <= box.y &&
            m.x + m.w >= box.x + box.w &&
            m.y + m.h >= box.y + box.h,
        );
        if (!covered) add.push({ id: newMarkId(), ...box });
      }
    }
    return add.length > 0 ? { ...ref, marks: [...existing, ...add] } : ref;
  });
}
