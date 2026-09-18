/**
 * Two facts about "is something being presented right now" that have to be
 * readable from **outside** the component that owns them.
 *
 * Both exist because of one bug class: three independent `window` keydown
 * listeners can see a single Escape, and none of them can see each other. Press
 * Escape to put the laser away during a talk and `DeckPresenter` — which has no
 * idea a tool was armed — reads it as "peel a layer", finds no grid and no blank
 * screen, and ends the talk (TODO V #98). A component tree cannot fix that,
 * because the listeners are siblings mounted by unrelated parents:
 * `FileViewerPane` mounts a `PresentationOverlay` over every viewer, the deck's
 * presenter mounts another inside its own portal, and `useKeyboard` is global.
 *
 *  - **`armed`** — how many `PresentationOverlay`s currently have the marker or
 *    laser active. Read imperatively (`getState()`) by the presenter's key
 *    handler, which runs *first* (it mounted first, and the overlay only
 *    registers its Escape listener once a tool is armed), so it can decline the
 *    key and leave the disarm to the overlay.
 *  - **`presenting`** — how many deck presenters are on screen. Subscribed to by
 *    `FileViewerPane`, which stops rendering its own overlay while a talk is
 *    running: that overlay stays mounted *behind* the presenter's portal, invisible
 *    and inert, but with its Escape listener very much alive.
 *
 * Counters rather than booleans because a popout window and the main window can
 * each hold one, and a stale `false` from whichever unmounts second would be
 * exactly the failure this is here to prevent.
 */

import { create } from "zustand";

interface PresentationState {
  /** `PresentationOverlay`s with a tool armed. */
  armed: number;
  /** Deck presenters currently on screen. */
  presenting: number;
  setArmed: (on: boolean) => void;
  setPresenting: (on: boolean) => void;
}

export const usePresentationStore = create<PresentationState>((set) => ({
  armed: 0,
  presenting: 0,
  setArmed: (on) => set((s) => ({ armed: Math.max(0, s.armed + (on ? 1 : -1)) })),
  setPresenting: (on) => set((s) => ({ presenting: Math.max(0, s.presenting + (on ? 1 : -1)) })),
}));

/** Is a marker/laser tool armed anywhere? Read imperatively — see the module note. */
export function isToolArmed(): boolean {
  return usePresentationStore.getState().armed > 0;
}
