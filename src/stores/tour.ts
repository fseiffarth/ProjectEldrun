import { create } from "zustand";
import { useSettingsStore } from "./settings";
import { useProjectsStore } from "./projects";
import { useHintsStore } from "./hints";
import type { HintId } from "../lib/shortcuts/hints";
import {
  TOUR_STEPS,
  COVERED_HINTS,
  nextEligibleIndex,
  prevEligibleIndex,
  type TourStep,
  type TourCtx,
} from "../lib/tour";
import { LESSONS, TOUR_LESSON_ID, type Lesson } from "../lib/lessons";

/**
 * Live state for the guided overlay, which runs the lessons of
 * `lib/lessons.ts` — the quick tour and the tour of other machines among them.
 * The step catalogs and selection logic are pure (`lib/tour.ts` /
 * `lib/lessons.ts`); this store only holds which sequence is running and
 * where, plus the thin action that persists the terminal `tour_completed` flag
 * through `useSettingsStore` (the single writer of `settings.json`) when the
 * quick tour ends. Session-only otherwise — the active step is never persisted.
 *
 * Mounted only by `AppShell` (not the detached-window `DetachedApp` branch), so
 * the overlay never appears in popped-out subwindows. Mirrors `stores/hints.ts`.
 */
interface TourStore {
  /** True while the overlay is on screen. */
  active: boolean;
  /** Index into `steps` of the step currently shown (valid while active). */
  index: number;
  /** The sequence currently running (the running lesson's steps). */
  steps: TourStep[];
  /** Settings flag to set true on finish, or null for replayable lessons. */
  persistKey: "tour_completed" | null;
  /** Begin the quick-tour lesson (`TOUR_LESSON_ID`). */
  start: () => void;
  /** Begin a lesson. Only one marked `completesOnboarding` persists anything. */
  startLesson: (lesson: Pick<Lesson, "steps" | "completesOnboarding">) => void;
  /** Advance to the next eligible step, or finish past the end. */
  next: () => void;
  /** Step back to the previous eligible step (no-op at the first). */
  prev: () => void;
  /** Leave early (Skip / Esc): same persistence as finishing. */
  skip: () => void;
  /** Complete: record it (main tour only) and stop the hints it taught. */
  finish: () => void;
}

/** Snapshot the bits of app state the per-step `when` predicates read. */
function ctx(): TourCtx {
  const s = useProjectsStore.getState();
  return { projectCount: s.projects.length, activeId: s.activeId };
}

/** Mark `tour_completed` and stop the hints the quick tour covered from
 *  re-firing the moment it closes. Other lessons don't persist. */
function persistDone() {
  void useSettingsStore.getState().updateSettings({ tour_completed: true });
  const hints = useHintsStore.getState();
  for (const id of COVERED_HINTS) hints.markSeen(id as HintId);
}

export const useTourStore = create<TourStore>((set, get) => {
  // Clear any on-screen contextual hint (without marking it seen) so the two
  // overlays never paint at once, then open at the first eligible step.
  const begin = (steps: TourStep[], persistKey: "tour_completed" | null) => {
    useHintsStore.setState({ active: null });
    const first = nextEligibleIndex(steps, ctx(), 0);
    if (first >= steps.length) return; // nothing eligible — don't open empty
    set({ active: true, index: first, steps, persistKey });
  };

  return {
    active: false,
    index: 0,
    steps: TOUR_STEPS,
    persistKey: null,

    start: () => {
      const tour = LESSONS.find((l) => l.id === TOUR_LESSON_ID);
      if (tour) get().startLesson(tour);
    },

    startLesson: (lesson) => begin(lesson.steps, lesson.completesOnboarding ? "tour_completed" : null),

    next: () => {
      const { steps, index } = get();
      const nextIdx = nextEligibleIndex(steps, ctx(), index + 1);
      if (nextIdx >= steps.length) {
        get().finish();
        return;
      }
      set({ index: nextIdx });
    },

    prev: () => {
      const { steps, index } = get();
      const prevIdx = prevEligibleIndex(steps, ctx(), index - 1);
      if (prevIdx < 0) return;
      set({ index: prevIdx });
    },

    skip: () => {
      if (get().persistKey === "tour_completed") persistDone();
      set({ active: false });
    },

    finish: () => {
      if (get().persistKey === "tour_completed") persistDone();
      set({ active: false });
    },
  };
});
