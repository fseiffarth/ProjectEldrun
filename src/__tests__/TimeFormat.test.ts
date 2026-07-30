import { describe, expect, it } from "vitest";

import { defaultUse24h, resolveUse24h } from "../lib/timeFormat";
import { formatStampTime, formatTime } from "../lib/calendarTime";

/**
 * The app-wide clock.
 *
 * Two questions, and the second is the one worth pinning: what a language
 * implies when nothing is set, and which of the three inputs wins when more than
 * one has an opinion.
 */

describe("defaultUse24h", () => {
  it("gives English AM/PM and everything else 24-hour", () => {
    expect(defaultUse24h("en")).toBe(false);
    expect(defaultUse24h("de")).toBe(true);
    expect(defaultUse24h("es")).toBe(true);
    expect(defaultUse24h("fr")).toBe(true);
    expect(defaultUse24h("it")).toBe(true);
  });
});

describe("resolveUse24h", () => {
  it("follows the language while nothing is set", () => {
    expect(resolveUse24h(undefined, undefined, "en")).toBe(false);
    expect(resolveUse24h(undefined, undefined, "de")).toBe(true);
    // `null` is the same statement as absent — it is what clearing a setting
    // leaves behind, and reading it as `false` would silently pick 12-hour.
    expect(resolveUse24h(null, null, "de")).toBe(true);
  });

  it("lets an explicit choice beat the language, in both directions", () => {
    // The half that a `?? false` read would get wrong: an English user who
    // deliberately turned 24-hour on, and a German one who turned it off.
    expect(resolveUse24h(true, undefined, "en")).toBe(true);
    expect(resolveUse24h(false, undefined, "de")).toBe(false);
  });

  it("carries the retired calendar-only key over, but never above a real choice", () => {
    expect(resolveUse24h(undefined, true, "en")).toBe(true);
    expect(resolveUse24h(false, true, "de")).toBe(false);
  });
});

describe("formatTime", () => {
  it("leaves a 24-hour clock alone", () => {
    expect(formatTime("09:00", true)).toBe("09:00");
    expect(formatTime("17:05", true)).toBe("17:05");
  });

  it("reads the whole day in AM/PM, including both noons", () => {
    expect(formatTime("00:00", false)).toBe("12:00 AM");
    expect(formatTime("09:05", false)).toBe("9:05 AM");
    expect(formatTime("12:00", false)).toBe("12:00 PM");
    expect(formatTime("17:30", false)).toBe("5:30 PM");
    expect(formatTime("23:59", false)).toBe("11:59 PM");
  });

  it("returns anything that is not a clock unchanged", () => {
    // The empty string is the common one: `timePart` gives it for every
    // date-only stamp, and the naive guard turned it into "12:undefined AM".
    expect(formatTime("", false)).toBe("");
    expect(formatTime("tomorrow", false)).toBe("tomorrow");
    expect(formatTime("31:00", false)).toBe("31:00");
  });

  it("gives a date-only stamp no clock at all", () => {
    expect(formatStampTime("2026-07-08", false)).toBe("");
    expect(formatStampTime("2026-07-08T17:00", false)).toBe("5:00 PM");
    expect(formatStampTime("2026-07-08T17:00", true)).toBe("17:00");
  });
});

