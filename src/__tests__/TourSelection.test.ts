import { describe, expect, it } from "vitest";
import {
  TOUR_STEPS,
  isStepEligible,
  nextEligibleIndex,
  prevEligibleIndex,
  type TourCtx,
} from "../lib/tour";

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
    const from = idx("switch-projects") + 1;
    expect(nextEligibleIndex(TOUR_STEPS, empty, from)).toBe(idx("add-tab"));
  });

  it("returns steps.length when it runs off the end (finish signal)", () => {
    expect(nextEligibleIndex(TOUR_STEPS, active, TOUR_STEPS.length)).toBe(TOUR_STEPS.length);
  });
});

describe("prevEligibleIndex", () => {
  it("walks back over an ineligible step", () => {
    const from = idx("add-tab") - 1; // sits on switch-projects
    expect(prevEligibleIndex(TOUR_STEPS, empty, from)).toBe(idx("remote-projects"));
  });

  it("returns -1 before the first step", () => {
    expect(prevEligibleIndex(TOUR_STEPS, active, -1)).toBe(-1);
  });
});
