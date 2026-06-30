import { HINTS, HOW_TO_START_STEPS, FOCUS_MODE_TIP, type HintCtx } from "./hints";

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
  title: string;
  body: string;
  /** Eligible only while this holds for the current context (defaults to
   *  always). Ineligible steps are skipped by the Back/Next navigation. */
  when?: (ctx: TourCtx) => boolean;
  /** Optional side-effect run by `TourHost` when this step becomes active, e.g.
   *  to reveal a panel so the step's anchor exists to spotlight. Kept off the
   *  pure selectors — only the host calls it. */
  prepare?: () => void;
}

/** Body copy for a contextual hint, by id — so the tour reuses the exact hint
 *  prose instead of re-typing it (single source of truth, per `hints.ts`). */
function hintBody(id: string): string {
  return HINTS.find((h) => h.id === id)?.body ?? "";
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "root-terminal",
    anchor: '[aria-label="Root terminal"]',
    placement: "bottom",
    title: "Use the root terminal",
    body: HOW_TO_START_STEPS[0].body,
  },
  {
    id: "create-project",
    anchor: '[data-hint-anchor="add-project"]',
    placement: "bottom",
    title: "Create or import a project",
    body: hintBody("create-project"),
  },
  {
    id: "remote-projects",
    anchor: null,
    placement: "bottom",
    title: "Work on remote machines",
    body: "In the New/Import dialog, flip \"Remote (SSH) project\" to host a project on another machine — Eldrun runs it over SSH/SFTP (agent tabs, files, and git on the remote; no local mount). If the host sits behind a VPN, enable \"Connect via OpenVPN\" to bring up the tunnel first, then connect SSH through it. The Lessons menu has a step-by-step \"SSH project via OpenVPN\" walkthrough.",
  },
  {
    id: "switch-projects",
    anchor: ".project-pills-region",
    placement: "bottom",
    title: "Switch between projects",
    body: "Each open project is a pill here. Click to switch; drag to reorder, or drop one onto another to group them into a box.",
    // Nothing to point at until at least one project is open.
    when: (c) => c.projectCount > 0,
  },
  {
    id: "add-tab",
    anchor: '[data-hint-anchor="tab-add"]',
    placement: "bottom",
    title: "Add agents and split tabs",
    body: hintBody("add-tab"),
  },
  {
    id: "file-tree",
    anchor: '[data-hint-anchor="file-tree-edge"]',
    placement: "left",
    title: "Find your files",
    body: hintBody("file-tree"),
  },
  {
    id: "global-apps",
    anchor: '[aria-label="Global apps"]',
    placement: "bottom",
    title: "Launch your tools",
    body: "Open your editor, browser, or other tools from here. Right-click a slot to set which app it launches.",
  },
  {
    id: "time-tracking",
    anchor: ".app-timer-btn",
    placement: "bottom",
    title: "Track your time",
    body: "Eldrun logs how long you work in each project. Click to pause, or right-click for the activity view.",
  },
  {
    id: "settings-focus",
    anchor: '[data-hint-anchor="settings"]',
    placement: "bottom",
    title: "Settings and focus mode",
    body: `Theme, default agent, Git, and shortcuts live behind ⚙ — which also reopens this tour and the Feature Guide. ${FOCUS_MODE_TIP}`,
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
