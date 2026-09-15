/**
 * Deterministic project-category colours (`lib/categoryColor`). The same tag
 * must read as the same colour everywhere, whatever its spelling, and the
 * label set must be cleaned the same way before persisting and when offering
 * toggle chips.
 */
import { describe, expect, it } from "vitest";

import {
  categoryColor,
  cleanCategories,
  normalizeCategory,
  primaryCategoryColor,
  projectCategories,
} from "../lib/categoryColor";

describe("normalizeCategory / cleanCategories", () => {
  it("trims and collapses inner whitespace", () => {
    expect(normalizeCategory("  client   x \t")).toBe("client x");
    expect(normalizeCategory("   ")).toBe("");
  });

  it("dedupes case-insensitively with the first spelling winning, drops blanks, keeps order", () => {
    expect(cleanCategories(["Work", "research", "WORK", "", "  ", "Research ", "client x"])).toEqual([
      "Work",
      "research",
      "client x",
    ]);
    expect(cleanCategories(new Set(["a", "A"]))).toEqual(["a"]);
    expect(cleanCategories([])).toEqual([]);
  });
});

describe("projectCategories", () => {
  it("reads only string entries from an array-shaped field and nothing from anything else", () => {
    expect(projectCategories({ categories: ["work", 3, null, " work", "lab"] })).toEqual(["work", "lab"]);
    expect(projectCategories({ categories: "work" })).toEqual([]);
    expect(projectCategories({})).toEqual([]);
  });
});

describe("categoryColor", () => {
  it("is a legible HSL colour with a hue on the wheel", () => {
    const m = categoryColor("work").match(/^hsl\((\d+) 62% 58%\)$/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(360);
  });

  it("is stable across spellings of one tag", () => {
    expect(categoryColor("work")).toBe(categoryColor("Work"));
    expect(categoryColor("work")).toBe(categoryColor("  work "));
    expect(categoryColor("client x")).toBe(categoryColor("client   x"));
  });

  it("spreads different tags to different hues", () => {
    const colours = new Set(["work", "research", "client-x", "teaching", "admin"].map(categoryColor));
    expect(colours.size).toBe(5);
  });

  it("gives the primary colour from the first tag, or null with no tags", () => {
    expect(primaryCategoryColor([])).toBeNull();
    expect(primaryCategoryColor(["research", "work"])).toBe(categoryColor("research"));
  });
});
