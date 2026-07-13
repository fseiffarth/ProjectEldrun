/**
 * Locks the bucket → calendar-window folding behind the usage recap.
 *
 * The store buckets by UTC ("YYYY-MM-DD" / "YYYY-MM-DDTHH"), so every window has
 * to be computed in UTC too — a local-time fold would silently misfile the hours
 * around midnight. The ISO-week boundary is the case that breaks naive
 * implementations (a Sunday belongs to the week that started the *previous*
 * Monday), and `breakdown`'s namespace exclusion is what keeps a local model from
 * being counted twice.
 */
import { describe, expect, it } from "vitest";
import {
  addCounters,
  breakdown,
  countersForPeriod,
  dayKey,
  hourKey,
  isoWeekKeys,
  periodKeys,
  sumCounters,
  totalOf,
  type Counters,
} from "../lib/usageRollup";

// 2026-07-13 is a Monday; 2026-07-19 the Sunday that closes the same ISO week.
const MONDAY = Date.UTC(2026, 6, 13, 12, 0, 0);
const SUNDAY = Date.UTC(2026, 6, 19, 23, 30, 0);

describe("bucket keys", () => {
  it("derives UTC day and hour keys", () => {
    expect(dayKey(MONDAY)).toBe("2026-07-13");
    expect(hourKey(MONDAY)).toBe("2026-07-13T12");
  });

  it("keeps the day key as the hour key's prefix", () => {
    // The backend folds an hour bucket into a day by taking its first ten chars;
    // if these two ever disagreed every counter would be misfiled.
    expect(hourKey(MONDAY).slice(0, 10)).toBe(dayKey(MONDAY));
  });
});

describe("isoWeekKeys", () => {
  it("returns Monday through Sunday for a mid-week day", () => {
    expect(isoWeekKeys(MONDAY)).toEqual([
      "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16",
      "2026-07-17", "2026-07-18", "2026-07-19",
    ]);
  });

  it("puts a Sunday in the week that began the previous Monday", () => {
    // The trap: getUTCDay() is 0 on Sunday, so a naive `now - day*86400e3` would
    // roll Sunday forward into the NEXT week and report an empty one.
    expect(isoWeekKeys(SUNDAY)[0]).toBe("2026-07-13");
    expect(isoWeekKeys(SUNDAY)).toEqual(isoWeekKeys(MONDAY));
  });
});

describe("periodKeys", () => {
  it("day is just that date", () => {
    expect(periodKeys("day", MONDAY)).toEqual(["2026-07-13"]);
  });

  it("week is the calendar ISO week, not a rolling seven days", () => {
    expect(periodKeys("week", MONDAY)).toEqual(isoWeekKeys(MONDAY));
  });

  it("month spans every day of the calendar month", () => {
    const keys = periodKeys("month", MONDAY);
    expect(keys).toHaveLength(31); // July
    expect(keys[0]).toBe("2026-07-01");
    expect(keys[30]).toBe("2026-07-31");
  });

  it("month handles a short month without spilling into the next", () => {
    const feb = Date.UTC(2026, 1, 15);
    const keys = periodKeys("month", feb);
    expect(keys).toHaveLength(28); // 2026 is not a leap year
    expect(keys[27]).toBe("2026-02-28");
  });

  it("month handles a leap February", () => {
    expect(periodKeys("month", Date.UTC(2024, 1, 15))).toHaveLength(29);
  });
});

describe("counter folding", () => {
  const days: Record<string, Counters> = {
    "2026-07-13": { "agent.prompt.claude": 10, "shell.command": 4 },
    "2026-07-15": { "agent.prompt.claude": 5, "agent.prompt.codex": 2 },
    // Previous month — must never leak into July's windows.
    "2026-06-30": { "agent.prompt.claude": 999 },
  };

  it("sums the buckets of a period and ignores the rest", () => {
    const week = countersForPeriod({ days }, "week", MONDAY);
    expect(week["agent.prompt.claude"]).toBe(15);
    expect(week["agent.prompt.codex"]).toBe(2);
    expect(week["shell.command"]).toBe(4);
  });

  it("does not leak an adjacent month into the month window", () => {
    const month = countersForPeriod({ days }, "month", MONDAY);
    expect(month["agent.prompt.claude"]).toBe(15); // not 1014
  });

  it("a day window sees only that day", () => {
    expect(countersForPeriod({ days }, "day", MONDAY)).toEqual({
      "agent.prompt.claude": 10,
      "shell.command": 4,
    });
  });

  it("absent buckets contribute nothing rather than throwing", () => {
    expect(sumCounters(undefined, ["2026-07-13"])).toEqual({});
    expect(sumCounters(days, ["1999-01-01"])).toEqual({});
  });

  it("addCounters merges in place", () => {
    const into: Counters = { a: 1 };
    addCounters(into, { a: 2, b: 3 });
    addCounters(into, undefined);
    expect(into).toEqual({ a: 3, b: 3 });
  });
});

describe("breakdown", () => {
  const counters: Counters = {
    "agent.tab.claude": 2,
    "agent.tab.codex": 1,
    "agent.tab.local.qwen3:8b": 3,
    "agent.tab.local.llama3.1:8b": 1,
    "shell.command": 40,
  };

  it("splits an open-ended namespace by its leaf", () => {
    expect(breakdown(counters, "agent.tab.local")).toEqual({
      "qwen3:8b": 3,
      "llama3.1:8b": 1,
    });
  });

  it("keeps a model name containing dots intact", () => {
    // A leaf may legitimately contain dots, so "does the leaf have a dot" is NOT
    // a usable test for "is this a deeper namespace".
    expect(breakdown(counters, "agent.tab.local")["llama3.1:8b"]).toBe(1);
  });

  it("excludes a deeper namespace so local models are not double-counted", () => {
    // Without the exclusion, agent.tab would also fold in every agent.tab.local.*
    // key — reporting each local tab both as its model and as an agent.
    expect(breakdown(counters, "agent.tab", ["agent.tab.local"])).toEqual({
      claude: 2,
      codex: 1,
    });
  });

  it("ignores keys outside the prefix", () => {
    expect(breakdown(counters, "agent.tab", ["agent.tab.local"])["shell.command"]).toBeUndefined();
  });

  it("totalOf sums a breakdown", () => {
    expect(totalOf(breakdown(counters, "agent.tab", ["agent.tab.local"]))).toBe(3);
    expect(totalOf({})).toBe(0);
  });
});
