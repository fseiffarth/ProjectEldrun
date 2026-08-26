import { describe, expect, it } from "vitest";
import {
  ADVANCED_TOUR_STEPS,
  TOUR_STEPS,
  isStepEligible,
  nextEligibleIndex,
  prevEligibleIndex,
  type TourCtx,
} from "../lib/tour";
import { translate } from "../lib/i18n";

const empty: TourCtx = { projectCount: 0, activeId: null };
const active: TourCtx = { projectCount: 2, activeId: "p1" };

const idx = (id: string) => TOUR_STEPS.findIndex((s) => s.id === id);

describe("tour step eligibility", () => {
  it("hides the switch-projects step on an empty workspace", () => {
    const step = TOUR_STEPS[idx("switch-projects")];
    expect(isStepEligible(step, empty)).toBe(false);
    expect(isStepEligible(step, active)).toBe(true);
  });

  it("treats steps without a `when` predicate as always eligible", () => {
    const step = TOUR_STEPS[idx("root-terminal")];
    expect(isStepEligible(step, empty)).toBe(true);
    expect(isStepEligible(step, active)).toBe(true);
  });
});

describe("nextEligibleIndex", () => {
  it("starts at the first step when everything is eligible", () => {
    expect(nextEligibleIndex(TOUR_STEPS, active, 0)).toBe(0);
  });

  it("skips an ineligible step (no project ⇒ no switch-projects)", () => {
    const from = idx("switch-projects");
    expect(nextEligibleIndex(TOUR_STEPS, empty, from)).toBe(idx("add-tab"));
  });

  it("returns steps.length when it runs off the end (finish signal)", () => {
    expect(nextEligibleIndex(TOUR_STEPS, active, TOUR_STEPS.length)).toBe(TOUR_STEPS.length);
  });
});

describe("prevEligibleIndex", () => {
  it("walks back over an ineligible step", () => {
    const from = idx("add-tab") - 1; // sits on switch-projects
    expect(prevEligibleIndex(TOUR_STEPS, empty, from)).toBe(idx("create-project"));
  });

  it("returns -1 before the first step", () => {
    expect(prevEligibleIndex(TOUR_STEPS, active, -1)).toBe(-1);
  });
});

// The two tours are one catalog with one engine, so the invariants the host
// relies on — unique ids, translated copy, a usable anchor — hold for both.
describe("tour catalogs", () => {
  const t = (key: Parameters<typeof translate>[1]) => translate("en", key);

  for (const [name, steps] of [
    ["TOUR_STEPS", TOUR_STEPS],
    ["ADVANCED_TOUR_STEPS", ADVANCED_TOUR_STEPS],
  ] as const) {
    it(`${name}: unique ids, real copy, non-empty anchors`, () => {
      const ids = steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const step of steps) {
        expect(t(step.titleKey).length).toBeGreaterThan(0);
        expect(t(step.bodyKey).length).toBeGreaterThan(0);
        expect(step.anchor === null || step.anchor.length > 0).toBe(true);
      }
    });
  }

  // The reason the advanced tour exists: the main tour is what a first-run,
  // local user needs, and every remote-machine subject moved out of it.
  it("keeps remote-machine subjects out of the main tour", () => {
    const mainIds = new Set(TOUR_STEPS.map((s) => s.id));
    for (const step of ADVANCED_TOUR_STEPS) expect(mainIds.has(step.id)).toBe(false);
    expect(mainIds.has("remote-projects")).toBe(false);
    expect(ADVANCED_TOUR_STEPS.map((s) => s.id)).toContain("remote-projects");
  });

  // A step that can't be reached is dead copy: `begin()` opens at the first
  // eligible index and gives up if there is none, so the advanced tour — which
  // has no `when` predicates — must be fully reachable from an empty workspace.
  it("advanced tour runs end to end with no projects open", () => {
    let seen = 0;
    for (let i = nextEligibleIndex(ADVANCED_TOUR_STEPS, empty, 0); i < ADVANCED_TOUR_STEPS.length; ) {
      seen++;
      i = nextEligibleIndex(ADVANCED_TOUR_STEPS, empty, i + 1);
    }
    expect(seen).toBe(ADVANCED_TOUR_STEPS.length);
  });
});
