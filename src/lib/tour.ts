import { focusModeTip, type HintCtx } from "./hints";
import type { TranslationKey } from "./i18n";

/**
 * The guided walkthroughs: ordered, index-driven sequences of spotlight steps
 * that dim the screen and highlight one real control at a time.
 *
 * There are two. `TOUR_STEPS` — "Take a tour" — stays on this machine: root
 * terminal → projects → tabs → files and viewers → models → mail/calendar →
 * apps → time → settings. `ADVANCED_TOUR_STEPS` is the opt-in second pass over
 * everything that reaches another machine (SSH projects, tunnels, compute
 * hosts, containers/VMs, sessions, phone), which used to be one overloaded
 * "work on remote machines" step in the middle of the first-run tour.
 *
 * This is the deliberate bridge between the static first-run `HowToStart` modal
 * and the passive contextual `HINTS`: it reuses the same anchor-selector model
 * (`HintDef.anchor`/`placement`) and shares copy with the existing onboarding
 * strings wherever both surfaces say the same thing, so the four onboarding
 * surfaces (modal, tour, hints, Feature Guide) never drift. Selection logic
 * here is pure and unit-tested (`TourSelection`); `TourHost` owns the impure
 * DOM measurement, timing, and event wiring.
 *
 * Anchors are selectors against live chrome, so they rot silently when the
 * header moves: a step whose anchor is gone degrades to a centered card rather
 * than failing loudly. Re-check them when you move a button.
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
    // The pill's own button, not an aria-label: the label is translated, so a
    // text selector only matched in English.
    anchor: ".root-pill-main",
    placement: "bottom",
    titleKey: "howToStart.step1Title",
    bodyKey: "tour.rootTerminalBody",
  },
  {
    id: "create-project",
    anchor: '[data-hint-anchor="add-project"]',
    placement: "bottom",
    titleKey: "howToStart.step2Title",
    bodyKey: "hint.createProjectBody",
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
    id: "arrange-tabs",
    anchor: ".tab-bar",
    placement: "bottom",
    titleKey: "tour.arrangeTabsTitle",
    bodyKey: "tour.arrangeTabsBody",
  },
  {
    id: "file-tree",
    anchor: '[data-hint-anchor="file-tree-edge"]',
    placement: "left",
    titleKey: "tour.fileTreeTitle",
    bodyKey: "hint.fileTreeBody",
  },
  {
    id: "viewers",
    anchor: '[data-hint-anchor="file-tree-edge"]',
    placement: "left",
    titleKey: "tour.viewersTitle",
    bodyKey: "tour.viewersBody",
  },
  {
    id: "local-models",
    anchor: ".local-model-btn",
    placement: "bottom",
    titleKey: "tour.localModelsTitle",
    bodyKey: "tour.localModelsBody",
  },
  {
    id: "mail-calendar",
    // Mail/calendar/to-dos each hide until switched on in Settings, so this
    // step points at whichever of the three is in the header and falls back to
    // a centered card when none is — its copy covers all three either way.
    anchor: ".mail-indicator-btn, .calendar-indicator-btn, .todo-indicator-btn",
    placement: "bottom",
    titleKey: "tour.mailCalendarTitle",
    bodyKey: "tour.mailCalendarBody",
  },
  {
    id: "global-apps",
    anchor: '[data-hint-anchor="global-apps"]',
    placement: "bottom",
    titleKey: "tour.globalAppsTitle",
    bodyKey: "tour.globalAppsBody",
  },
  {
    id: "time-tracking",
    // The timer readout lives inside the clock's hover menu now, so the clock
    // button is what's on screen to point at.
    anchor: ".clock-menu-btn",
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

/**
 * The second, opt-in walkthrough: everything that reaches past this computer —
 * SSH projects, tunnels, extra compute machines, containers/VMs, long-running
 * sessions, and the phone. Split out of the main tour deliberately: a first-run
 * user working locally has no use for any of it, and one dense "work on remote
 * machines" step could never carry the subject either. Started from the same
 * ⚙ menu and Settings row (`eldrun:start-advanced-tour`), replayable, and
 * nothing about it is persisted — only the main tour sets `tour_completed`.
 */
export const ADVANCED_TOUR_STEPS: TourStep[] = [
  {
    id: "advanced-intro",
    anchor: null,
    placement: "bottom",
    titleKey: "tour.advanced.introTitle",
    bodyKey: "tour.advanced.introBody",
  },
  {
    id: "remote-projects",
    anchor: '[data-hint-anchor="add-project"]',
    placement: "bottom",
    titleKey: "tour.remoteProjectsTitle",
    bodyKey: "tour.remoteProjectsBody",
  },
  {
    id: "extend-to-remote",
    anchor: null,
    placement: "bottom",
    titleKey: "tour.advanced.extendTitle",
    bodyKey: "tour.advanced.extendBody",
  },
  {
    id: "vpn",
    anchor: ".vpn-indicator-btn",
    placement: "bottom",
    titleKey: "tour.advanced.vpnTitle",
    bodyKey: "tour.advanced.vpnBody",
  },
  {
    id: "compute-machines",
    anchor: ".machines-indicator-btn",
    placement: "bottom",
    titleKey: "tour.advanced.machinesTitle",
    bodyKey: "tour.advanced.machinesBody",
  },
  {
    id: "persistent-sessions",
    anchor: null,
    placement: "bottom",
    titleKey: "tour.advanced.sessionsTitle",
    bodyKey: "tour.advanced.sessionsBody",
  },
  {
    id: "isolation",
    anchor: null,
    placement: "bottom",
    titleKey: "tour.advanced.isolationTitle",
    bodyKey: "tour.advanced.isolationBody",
  },
  {
    id: "mobile",
    anchor: ".mobile-indicator-btn",
    placement: "bottom",
    titleKey: "tour.advanced.mobileTitle",
    bodyKey: "tour.advanced.mobileBody",
  },
  {
    id: "advanced-outro",
    anchor: '[data-hint-anchor="settings"]',
    placement: "bottom",
    titleKey: "tour.advanced.outroTitle",
    bodyKey: "tour.advanced.outroBody",
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
