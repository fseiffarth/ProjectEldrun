import { create } from "zustand";
import { useProjectsStore } from "./projects";

/**
 * Where in the window steering is pointing. The mode is a small hierarchy the
 * arrows walk: ↓ goes one level in, ↑ one level out. It opens on the tabs of
 * the current project — switching tabs is what it is mostly for.
 *
 *   projects — ←/→ switch the project (the station ring), ↓ into its windows
 *   panes    — ←/→ step the subwindows (the tabs, when there is only one)
 *   tabs     — ←/→ step the focused subwindow's tabs
 *   region   — a keyboard cursor walking the controls of one surface that
 *              has no tab bar: the side panel, the mail / calendar / to-do
 *              overlays, or a pane's + menu (`SteeringRegion`)
 */
export type SteeringLevel = "projects" | "panes" | "tabs" | "region";

/** The surfaces the region cursor can walk (see `lib/shortcuts/steeringRegion`). */
export type SteeringRegion = "side" | "mail" | "calendar" | "todo" | "addTab";

/** Every level but the region — where a region returns to. */
export type SteeringBaseLevel = Exclude<SteeringLevel, "region">;

/**
 * Transient state for keyboard steering mode (the `steeringMode` chord).
 *
 * `subwindowNav`'s sibling: kept out of the tabs store so entering/leaving the
 * mode never churns the layout tree, and deliberately not persisted — a
 * relaunch never starts steering. While `active`, `useKeyboard` swallows every
 * key in a capture-phase listener (nothing may leak to the terminal
 * underneath), `FocusFrameOverlay` shows the subwindow badges, the project
 * pills wear their station numbers on the projects level, and the bottom legend
 * renders the current level's keys from `STEERING_KEYS`.
 *
 * `useKeyboard` mutates this imperatively via `getState()`; the overlays
 * subscribe reactively.
 */
interface KeyboardSteeringState {
  /** Steering on → keys captured, badges/legend visible. */
  active: boolean;
  level: SteeringLevel;
  /** The surface the region cursor walks; set only while `level` is "region". */
  region: SteeringRegion | null;
  /** The level Escape returns to from a region. */
  regionReturn: SteeringBaseLevel;
  /** Enter the mode on the current project's tabs. */
  enter: () => void;
  exit: () => void;
  setLevel: (level: SteeringBaseLevel) => void;
  enterRegion: (region: SteeringRegion) => void;
  /** Leave the region for the level it was entered from. */
  leaveRegion: () => void;
}

export const useKeyboardSteeringStore = create<KeyboardSteeringState>((set, get) => ({
  active: false,
  level: "tabs",
  region: null,
  regionReturn: "tabs",
  enter: () => set({ active: true, level: "tabs", region: null }),
  exit: () => set({ active: false, level: "tabs", region: null }),
  setLevel: (level) => set({ level, region: null }),
  enterRegion: (region) => {
    const { level, regionReturn } = get();
    set({
      level: "region",
      region,
      // Regions never nest: switching straight from one to another still
      // returns to the base level the first was entered from.
      regionReturn: level === "region" ? regionReturn : level,
    });
  },
  leaveRegion: () => set({ level: get().regionReturn, region: null }),
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
