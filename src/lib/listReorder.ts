/**
 * The arithmetic behind a drag-to-reorder: where a carried row would land, and
 * what the list looks like once it lands there.
 *
 * Pure and shared, because the *gesture* (`hooks/useListReorder`) is the same
 * on every list that has one — a to-do card's checklist, the Agents view's
 * collected prompts — while the thing each list does with the result is not.
 * Keeping the two halves apart is what lets the half that can be tested be
 * tested.
 */

/** A row measured once, at pointerdown — see `hooks/useListReorder` on why the
 *  rects are frozen for the length of the gesture. */
export interface ReorderRect {
  id: string;
  top: number;
  height: number;
}

/**
 * Where a dragged row would land, from the pointer's Y over the rects measured
 * when the drag started: the number of OTHER rows whose midpoint it has passed
 * — i.e. an index into the list **without** the dragged row.
 *
 * That exclusive-of-the-dragged-row convention is the one thing to get right: a
 * row pulled out of the list and spliced back in cannot be addressed in the
 * coordinates of the list it is still in, and mixing the two is how a downward
 * drag lands one row short.
 */
export function dropSlot(rects: ReorderRect[], id: string, clientY: number): number {
  return rects
    .filter((rect) => rect.id !== id)
    .filter((rect) => clientY > rect.top + rect.height / 2).length;
}

/**
 * The ids of a list after one of them is carried to slot `to` — `to` counted in
 * the list without that id, matching `dropSlot`.
 *
 * The index is clamped rather than refused: a pointer that left the list at the
 * bottom means "last", not "nothing happened". An unknown id, and a move that
 * changes nothing, return the order unchanged, so a stray drop is not a write.
 */
export function reorderedIds(ids: string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const rest = ids.filter((entry) => entry !== id);
  const at = Math.max(0, Math.min(Math.trunc(to), rest.length));
  if (at === from) return ids;
  rest.splice(at, 0, id);
  return rest;
}
