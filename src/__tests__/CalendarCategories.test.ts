/**
 * Event categories (`lib/calendar/calendarCategories`): the palette lives in code so an
 * imported ICS with an unknown `CATEGORIES:` still round-trips — it renders in
 * its calendar's colour instead of gaining a swatch.
 */
import { describe, expect, it } from "vitest";

import { CATEGORIES, categoryFor, categoryLabel, eventColor } from "../lib/calendar/calendarCategories";

describe("CATEGORIES", () => {
  it("has unique keys, each with its own theme token", () => {
    const keys = CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of CATEGORIES) {
      expect(c.color).toBe(`var(--cal-cat-${c.key})`);
      expect(c.labelKey).toBe(`category.${c.key}`);
    }
  });
});

describe("categoryFor", () => {
  it("resolves a known key and null for unset or unknown", () => {
    expect(categoryFor("meeting")?.label).toBe("Meeting");
    expect(categoryFor(undefined)).toBeNull();
    expect(categoryFor("")).toBeNull();
    expect(categoryFor("Meeting")).toBeNull(); // keys are exact — an ICS value is stored verbatim
    expect(categoryFor("thunderbird-custom")).toBeNull();
  });
});

describe("eventColor", () => {
  it("uses the category's colour when known, the calendar's otherwise", () => {
    expect(eventColor("work", "#abc")).toBe("var(--cal-cat-work)");
    expect(eventColor("unknown", "#abc")).toBe("#abc");
    expect(eventColor(undefined, "#abc")).toBe("#abc");
  });
});

describe("categoryLabel", () => {
  it("resolves through the translator by labelKey", () => {
    const t = (key: string) => `t:${key}`;
    expect(categoryLabel(CATEGORIES[0], t)).toBe("t:category.work");
  });
});
