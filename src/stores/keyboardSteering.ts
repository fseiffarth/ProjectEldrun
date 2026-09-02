import { create } from "zustand";
import { useProjectsStore } from "./projects";

/**
 * Transient state for keyboard steering mode (the `steeringMode` chord).
 *
 * `subwindowNav`'s sibling: kept out of the tabs store so entering/leaving the
 * mode never churns the layout tree, and deliberately not persisted — a
 * relaunch never starts steering. While `active`, `useKeyboard` swallows every
 * key in a capture-phase listener (nothing may leak to the terminal
 * underneath), `FocusFrameOverlay` shows the subwindow badges, the project
 * pills wear their station numbers, and the bottom legend renders from
 * `STEERING_KEYS`.
 *
 * `useKeyboard` mutates this imperatively via `getState()`; the overlays
 * subscribe reactively.
 */
interface KeyboardSteeringState {
  /** Steering on → keys captured, badges/legend visible. */
  active: boolean;
  enter: () => void;
  exit: () => void;
}

export const useKeyboardSteeringStore = create<KeyboardSteeringState>((set) => ({
  active: false,
  enter: () => set({ active: true }),
  exit: () => set({ active: false }),
}));

/**
 * The project "station" ring — the ONE list behind cycleProject / cycleProjectBack,
 * the steering digits (1 = station index 0), and the pill badges, so the three
 * can never number the strip differently.
 *
 * The **root terminal (`null`) leads the ring**: it is the pill strip's first
 * pill, so a shortcut that walks the strip has to stop there too (see the
 * history note on `useKeyboard`'s cycleProject). The rest are the non-inactive
 * projects in pill display order (`position`).
 */
export function projectStations(): (string | null)[] {
  const ps = useProjectsStore.getState();
  return [
    null,
    ...ps.projects
      .filter((p) => p.status !== "inactive")
      .sort((a, b) => a.position - b.position)
      .map((p) => p.id),
  ];
}
