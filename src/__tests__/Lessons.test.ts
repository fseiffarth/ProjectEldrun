import { describe, expect, it } from "vitest";
import { LESSON_CATEGORIES, LESSONS } from "../lib/lessons";
import { REWARD_KEYS, isInteractive, rewardKey, taskClickSelector } from "../lib/tour";
import { translate } from "../lib/i18n";

const t = (key: Parameters<typeof translate>[1]) => translate("en", key);

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
      "yaml-viewer",
      "pdf-viewer",
      "tex-workspace",
      "deck-presenter",
      "run-python",
      "file-search",
      "browser",
      "printing",
      "calendar",
      "todo-board",
      "mail",
      "usage-recap",
      // Agents & models
      "install-agent",
      "local-model",
      "add-local-model",
      "skills-library",
      // Advanced
      "project-boxes",
      "docker-sandbox",
      "vm-project",
      "add-ssh-project",
      "ssh-via-openvpn",
      "vpn-tunnel",
      "extend-to-remote",
      "compute-machines",
      "persistent-sessions",
      "hpc-pipeline",
      "mobile",
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
      expect(t(lesson.titleKey).length).toBeGreaterThan(0);
      expect(t(lesson.blurbKey).length).toBeGreaterThan(0);
      expect(lesson.steps.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("gives every step a unique id (within its lesson), valid placement, and copy", () => {
    for (const lesson of LESSONS) {
      const stepIds = lesson.steps.map((s) => s.id);
      expect(new Set(stepIds).size).toBe(stepIds.length);
      for (const step of lesson.steps) {
        expect(PLACEMENTS.has(step.placement)).toBe(true);
        expect(t(step.titleKey).length).toBeGreaterThan(0);
        expect(t(step.bodyKey).length).toBeGreaterThan(0);
        // anchor is either null (centered card) or a non-empty selector.
        expect(step.anchor === null || step.anchor.length > 0).toBe(true);
      }
    }
  });
});

describe("lesson tasks (the interactive half)", () => {
  it("gives every lesson at least one thing to actually do", () => {
    for (const lesson of LESSONS) {
      expect(lesson.steps.some(isInteractive)).toBe(true);
    }
  });

  it("gives every task a prompt and a hint in real copy", () => {
    for (const lesson of LESSONS) {
      for (const step of lesson.steps) {
        if (!step.task) continue;
        expect(t(step.task.promptKey).length).toBeGreaterThan(0);
        // The prompt key must actually resolve, not fall through to itself.
        expect(t(step.task.promptKey)).not.toBe(step.task.promptKey);
        // A hint is what keeps a task from being a wall: every one has one.
        expect(step.task.hintKey).toBeDefined();
        expect(t(step.task.hintKey!)).not.toBe(step.task.hintKey);
      }
    }
  });

  it("gives every task a signal that can fire", () => {
    for (const lesson of LESSONS) {
      for (const step of lesson.steps) {
        const task = step.task;
        if (!task) continue;
        // Either it watches for something, or it falls back to clicking the
        // step's own anchor — and then that anchor has to exist, or the task
        // could never be solved at all.
        const watches = task.appear || task.grow || task.event || task.click;
        expect(watches != null || taskClickSelector(step) != null).toBe(true);
        for (const sel of [task.click, task.appear, task.grow]) {
          if (sel != null) expect(sel.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("falls back to the anchor only when the task names no other signal", () => {
    const anchored = LESSONS.flatMap((l) => l.steps).find(
      (s) => s.task && !s.task.click && !s.task.appear && !s.task.grow && !s.task.event,
    );
    expect(anchored).toBeDefined();
    expect(taskClickSelector(anchored!)).toBe(anchored!.anchor);
    const watched = LESSONS.flatMap((l) => l.steps).find((s) => s.task?.appear);
    expect(taskClickSelector(watched!)).toBeNull();
    // A narrated step has nothing to click for.
    const narrated = LESSONS.flatMap((l) => l.steps).find((s) => !s.task);
    expect(taskClickSelector(narrated!)).toBeNull();
  });

  it("rewards each step with real praise, cycling deterministically", () => {
    for (const key of REWARD_KEYS) expect(t(key)).not.toBe(key);
    expect(rewardKey(0)).toBe(REWARD_KEYS[0]);
    expect(rewardKey(REWARD_KEYS.length)).toBe(REWARD_KEYS[0]);
    expect(rewardKey(1)).toBe(rewardKey(1 + REWARD_KEYS.length));
    // Step numbers are 1-based, but a stray 0 or a negative must not throw.
    expect(REWARD_KEYS).toContain(rewardKey(-3));
  });
});
