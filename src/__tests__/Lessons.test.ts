import { describe, expect, it } from "vitest";
import { LESSON_CATEGORIES, LESSONS } from "../lib/lessons";

const PLACEMENTS = new Set(["top", "bottom", "left", "right"]);

describe("LESSONS catalog", () => {
  it("covers the requested lessons with unique ids, ordered easy → hard", () => {
    const ids = LESSONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      // Basics
      "add-project",
      "import-project",
      "add-tab",
      "native-viewer",
      "arrange-tabs",
      // Agents & models
      "install-agent",
      "local-model",
      "add-local-model",
      // Advanced
      "project-boxes",
      "docker-sandbox",
      "add-ssh-project",
      "ssh-via-openvpn",
    ]);
  });

  it("uses known categories that stay contiguous in tier order", () => {
    // Every lesson's category is one of the declared tiers.
    for (const lesson of LESSONS) {
      expect(LESSON_CATEGORIES).toContain(lesson.category);
    }
    // Lessons are grouped: each category appears as a single contiguous run,
    // and the runs follow LESSON_CATEGORIES' easy → hard order.
    const seenOrder = LESSONS.map((l) => l.category).filter(
      (cat, i, arr) => i === 0 || arr[i - 1] !== cat,
    );
    expect(seenOrder).toEqual([...LESSON_CATEGORIES]);
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
