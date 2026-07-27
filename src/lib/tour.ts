import { focusModeTip, type HintCtx } from "./hints";
import type { TranslationKey } from "./i18n";

/**
 * The guided "Take a tour" walkthrough: an ordered, index-driven sequence of
 * spotlight steps that dims the screen and highlights one real control at a
 * time (root terminal → projects → tabs → files → apps → time → settings).
 *
 * This is the deliberate bridge between the static first-run `HowToStart` modal
 * and the passive contextual `HINTS`: it reuses the same anchor-selector model
 * (`HintDef.anchor`/`placement`) and pulls its copy from the existing onboarding
 * strings so the four onboarding surfaces (modal, tour, hints, Feature Guide)
 * never drift. Selection logic here is pure and unit-tested (`TourSelection`);
 * `TourHost` owns the impure DOM measurement, timing, and event wiring.
 */

/** The tour reuses the hint context (project count + active scope) for its
 *  per-step eligibility predicates, so a zero-project user skips project-only
 *  steps cleanly. */
export type TourCtx = HintCtx;

/** Bubble placement relative to the spotlight target. Widens `HintDef`'s
 *  top/bottom union with sides, which read better for the corner chrome the
 *  tour points at (root logo top-left, gear top-right, file-tree right edge). */
export type TourPlacement = "top" | "bottom" | "left" | "right";

export interface TourStep {
  /** Stable id; also the key used to mark the matching contextual hint seen so
   *  the tour doesn't end into a hint storm (see `COVERED_HINTS`). */
  id: string;
  /** `document.querySelector` selector for the element to spotlight, or null to
   *  render as a centered card. A step whose anchor is absent at runtime falls
   *  back to the centered-card path rather than blocking the tour. */
  anchor: string | null;
  placement: TourPlacement;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  /** Extra `t()` params a step's `bodyKey` needs beyond its own text — only
   *  "settings-focus" uses this, for its per-OS `{tip}` (see `focusModeTip` in
   *  `hints.ts`). Computed lazily so it only runs for the active step. */
  bodyParams?: (
    t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  ) => Record<string, string | number>;
  /** Eligible only while this holds for the current context (defaults to
   *  always). Ineligible steps are skipped by the Back/Next navigation. */
  when?: (ctx: TourCtx) => boolean;
  /** Optional side-effect run by `TourHost` when this step becomes active, e.g.
   *  to reveal a panel so the step's anchor exists to spotlight. Kept off the
   *  pure selectors — only the host calls it. */
  prepare?: () => void;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "root-terminal",
    anchor: '[aria-label="Root terminal"]',
    placement: "bottom",
    titleKey: "howToStart.step1Title",
    bodyKey: "howToStart.step1Body",
  },
  {
    id: "create-project",
    anchor: '[data-hint-anchor="add-project"]',
    placement: "bottom",
    titleKey: "howToStart.step2Title",
    bodyKey: "hint.createProjectBody",
  },
  {
    id: "remote-projects",
    anchor: null,
    placement: "bottom",
    titleKey: "tour.remoteProjectsTitle",
    bodyKey: "tour.remoteProjectsBody",
  },
  {
    id: "switch-projects",
    anchor: ".project-pills-region",
    placement: "bottom",
    titleKey: "tour.switchProjectsTitle",
    bodyKey: "tour.switchProjectsBody",
    // Nothing to point at until at least one project is open.
    when: (c) => c.projectCount > 0,
  },
  {
    id: "add-tab",
    anchor: '[data-hint-anchor="tab-add"]',
    placement: "bottom",
    titleKey: "tour.addTabTitle",
    bodyKey: "hint.addTabBody",
  },
  {
    id: "file-tree",
    anchor: '[data-hint-anchor="file-tree-edge"]',
    placement: "left",
    titleKey: "tour.fileTreeTitle",
    bodyKey: "hint.fileTreeBody",
  },
  {
    id: "global-apps",
    anchor: '[aria-label="Global apps"]',
    placement: "bottom",
    titleKey: "tour.globalAppsTitle",
    bodyKey: "tour.globalAppsBody",
  },
  {
    id: "time-tracking",
    anchor: ".app-timer-btn",
    placement: "bottom",
    titleKey: "tour.timeTrackingTitle",
    bodyKey: "tour.timeTrackingBody",
  },
  {
    id: "settings-focus",
    anchor: '[data-hint-anchor="settings"]',
    placement: "bottom",
    titleKey: "tour.settingsFocusTitle",
    bodyKey: "tour.settingsFocusBody",
    bodyParams: (t) => ({ tip: focusModeTip(t) }),
  },
];

/** Contextual-hint ids the tour teaches, marked seen on finish so they don't
 *  immediately re-fire once the overlay closes. */
export const COVERED_HINTS = ["create-project", "add-tab", "toggle-panels", "file-tree"] as const;

/** Whether a step applies to the given context (defaults to always-on). */
export function isStepEligible(step: TourStep, ctx: TourCtx): boolean {
  return step.when ? step.when(ctx) : true;
}

/** First index `>= from` whose step is eligible, or `steps.length` when none
 *  remain — the signal the tour has run off the end and should finish. */
export function nextEligibleIndex(steps: TourStep[], ctx: TourCtx, from: number): number {
  for (let i = Math.max(0, from); i < steps.length; i++) {
    if (isStepEligible(steps[i], ctx)) return i;
  }
  return steps.length;
}

/** Last index `<= from` whose step is eligible, or -1 when none precede it. */
export function prevEligibleIndex(steps: TourStep[], ctx: TourCtx, from: number): number {
  for (let i = Math.min(steps.length - 1, from); i >= 0; i--) {
    if (isStepEligible(steps[i], ctx)) return i;
  }
  return -1;
}
