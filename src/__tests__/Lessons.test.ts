import { describe, expect, it } from "vitest";
import { LESSONS } from "../lib/lessons";

const PLACEMENTS = new Set(["top", "bottom", "left", "right"]);

describe("LESSONS catalog", () => {
  it("covers the requested lessons with unique ids", () => {
    const ids = LESSONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "add-project",
      "import-project",
      "add-ssh-project",
      "add-tab",
      "install-agent",
      "local-model",
      "native-viewer",
      "arrange-tabs",
    ]);
  });

  it("gives every lesson a title, blurb, and at least three steps", () => {
    for (const lesson of LESSONS) {
      expect(lesson.title.length).toBeGreaterThan(0);
      expect(lesson.blurb.length).toBeGreaterThan(0);
      expect(lesson.steps.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("gives every step a unique id (within its lesson), valid placement, and copy", () => {
    for (const lesson of LESSONS) {
      const stepIds = lesson.steps.map((s) => s.id);
      expect(new Set(stepIds).size).toBe(stepIds.length);
      for (const step of lesson.steps) {
        expect(PLACEMENTS.has(step.placement)).toBe(true);
        expect(step.title.length).toBeGreaterThan(0);
        expect(step.body.length).toBeGreaterThan(0);
        // anchor is either null (centered card) or a non-empty selector.
        expect(step.anchor === null || step.anchor.length > 0).toBe(true);
      }
    }
  });
});
