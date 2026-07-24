import { create } from "zustand";

/**
 * Pointer-driven project-pill reorder/group/assign-to-box state (replaces the
 * old native HTML5 DnD, which WebKitGTK's other draggables — TabBar, YamlTree,
 * MachinesIndicator — all avoid for the same reason: a native drag out of a
 * gesture the webview didn't originate can hang or drop mid-drag). Kept in its
 * own store, mirroring `stores/drag.ts`'s tab-drag isolation, so the
 * high-frequency pointermove updates only re-render the pills that actually
 * read it (the dragged pill + whichever siblings must part to open its landing
 * slot), not the whole switcher.
 *
 * `width` is the dragged pill's own measured width: removing an item of that
 * width from the strip and reinserting it elsewhere shifts every pill BETWEEN
 * the old and new slot by exactly that amount, regardless of their own widths
 * — so a uniform ± shift is correct even though pills vary in width (mirrors
 * MachinesIndicator's `dragH` shift, generalized to the horizontal axis).
 */
export interface PillDrag {
  id: string;
  width: number;
  /** Live pointer delta (px) since the gesture started — the dragged pill's
   *  own follow-the-cursor translateX. */
  dx: number;
  /** Index the dragged pill would land at, into the list of OTHER visible
   *  project pills (i.e. not counting the dragged one) — purely a preview for
   *  which siblings part; the actual commit re-resolves the drop target by
   *  hit-testing at release (see ProjectPill), so this never has to be exact. */
  overIndex: number;
  /** A box pill the cursor is currently over — assign-to-box target instead of
   *  a reorder; suppresses the parting preview (nothing will move). */
  overBoxId: string | null;
  /** Alt held while hovering another project pill — group (new box) target
   *  instead of reorder; also suppresses the parting preview. */
  groupTargetId: string | null;
}

interface PillDragStore {
  drag: PillDrag | null;
  start: (id: string, width: number, overIndex: number) => void;
  move: (dx: number) => void;
  setTarget: (t: Pick<PillDrag, "overIndex" | "overBoxId" | "groupTargetId">) => void;
  end: () => void;
}

export const usePillDragStore = create<PillDragStore>((set) => ({
  drag: null,
  start: (id, width, overIndex) =>
    set({ drag: { id, width, dx: 0, overIndex, overBoxId: null, groupTargetId: null } }),
  move: (dx) => set((s) => (s.drag ? { drag: { ...s.drag, dx } } : {})),
  setTarget: (t) => set((s) => (s.drag ? { drag: { ...s.drag, ...t } } : {})),
  end: () => set({ drag: null }),
}));
