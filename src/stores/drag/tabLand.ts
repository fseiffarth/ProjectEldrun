import { create } from "zustand";

/**
 * One-shot "landing" flourish played when a tab is dropped INTO a different tab
 * bar (a cross-group move or a split-off into a new subwindow). The destination
 * `TabBar` mounts the moved tab fresh, so it plays a brief drop-in animation
 * (the tab settles into its slot with an accent glow) to make it clear WHERE the
 * dragged tab landed.
 *
 * Kept in its own store (mirroring `drag.ts` / `detachAnim.ts`) so the single
 * drop authority (`commitDrop`) can fire it and the destination `TabBar` can
 * render it, without threading props. Within-bar reorders never land here — they
 * already have the gap feedback during the drag — and out-of-window detaches use
 * the `detachAnim` fly-out instead.
 */
export interface TabLanding {
  /** Key of the tab that just landed in a new bar. */
  key: string;
  /** Strictly-increasing id so a repeat landing re-runs the CSS animation and
   *  the destination `TabBar` clears exactly the play it started. */
  nonce: number;
}

interface TabLandStore {
  landed: TabLanding | null;
  /** Mark `key` as freshly landed so its destination tab plays the drop-in. */
  markLanded: (key: string) => void;
  /** Clear the landing once its animation has finished (matched by `nonce`). */
  clear: (nonce: number) => void;
}

// Module counter: the nonce must strictly increase across plays so a repeat
// landing for the same tab still re-triggers the animation.
let landSeq = 0;

export const useTabLandStore = create<TabLandStore>((set) => ({
  landed: null,
  markLanded: (key) => set({ landed: { key, nonce: ++landSeq } }),
  clear: (nonce) =>
    set((s) => (s.landed?.nonce === nonce ? { landed: null } : {})),
}));
