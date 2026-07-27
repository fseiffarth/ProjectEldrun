import { describe, expect, it } from "vitest";
import {
  addDays,
  addMinutes,
  addMonths,
  addYears,
  allDayEndToLastDay,
  dateRange,
  lastDayToAllDayEnd,
  daysBetween,
  daySlice,
  formatTime,
  isMultiDay,
  layoutOverlaps,
  minutesBetween,
  minutesIntoDay,
  monthGrid,
  normalizeSpan,
  parseStamp,
  spanCoversDate,
  spanDates,
  startOfWeek,
  weekdayOf,
  weekDates,
  MINUTES_PER_DAY,
} from "../lib/calendarTime";

describe("parseStamp", () => {
  it("parses a bare date as date-only", () => {
    expect(parseStamp("2026-07-08")).toEqual({
      year: 2026, month: 7, day: 8, hour: 0, minute: 0, dateOnly: true,
    });
  });

  it("parses a timed stamp", () => {
    expect(parseStamp("2026-07-08T09:30")).toEqual({
      year: 2026, month: 7, day: 8, hour: 9, minute: 30, dateOnly: false,
    });
  });

  it("rejects garbage and impossible dates", () => {
    expect(parseStamp("nope")).toBeNull();
    expect(parseStamp("2026-13-01")).toBeNull();
    expect(parseStamp("2026-02-30")).toBeNull();
    expect(parseStamp("2026-07-08T25:00")).toBeNull();
  });

  it("accepts Feb 29 only in a leap year", () => {
    expect(parseStamp("2024-02-29")).not.toBeNull();
    expect(parseStamp("2026-02-29")).toBeNull();
  });
});

describe("addDays", () => {
  it("rolls month and year boundaries", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles leap February", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("preserves the time part of a timed stamp", () => {
    expect(addDays("2026-07-08T09:30", 1)).toBe("2026-07-09T09:30");
  });

  it("keeps a bare date bare", () => {
    expect(addDays("2026-07-08", 1)).toBe("2026-07-09");
  });

  it("survives a DST spring-forward boundary", () => {
    // In most northern-hemisphere zones the clocks jump in late March. Stepping a
    // day across it must still advance exactly one calendar day (the noon anchor).
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
    // ...and in the US zones, mid-March.
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
  });

  it("survives a DST fall-back boundary", () => {
    expect(addDays("2026-10-24", 1)).toBe("2026-10-25");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
  });

  it("leaves garbage alone", () => {
    expect(addDays("nope", 1)).toBe("nope");
  });
});

describe("addMonths / addYears", () => {
  it("clamps the day to the target month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2026-03-31", 1)).toBe("2026-04-30");
  });

  it("rolls across a year", () => {
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });

  it("preserves the time part", () => {
    expect(addMonths("2026-01-15T08:45", 1)).toBe("2026-02-15T08:45");
  });

  it("clamps Feb 29 in a common year", () => {
    expect(addYears("2024-02-29", 1)).toBe("2025-02-28");
    expect(addYears("2024-02-29", 4)).toBe("2028-02-29");
  });
});

describe("addMinutes", () => {
  it("rolls across midnight in both directions", () => {
    expect(addMinutes("2026-07-08T23:30", 60)).toBe("2026-07-09T00:30");
    expect(addMinutes("2026-07-08T00:15", -30)).toBe("2026-07-07T23:45");
    expect(addMinutes("2026-12-31T23:00", 120)).toBe("2027-01-01T01:00");
  });

  it("passes a date-only stamp through untouched", () => {
    expect(addMinutes("2026-07-08", 60)).toBe("2026-07-08");
  });
});

describe("durations", () => {
  it("counts whole days between dates", () => {
    expect(daysBetween("2026-07-08", "2026-07-09")).toBe(1);
    expect(daysBetween("2026-07-08", "2026-07-08")).toBe(0);
    expect(daysBetween("2026-07-09", "2026-07-08")).toBe(-1);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
  });

  it("counts days across a DST boundary without rounding off", () => {
    // A naive (b-a)/86400000 without rounding returns 0.958… or 1.041… here.
    expect(daysBetween("2026-03-28", "2026-03-29")).toBe(1);
    expect(daysBetween("2026-10-24", "2026-10-25")).toBe(1);
  });

  it("counts minutes across a day boundary", () => {
    expect(minutesBetween("2026-07-08T09:00", "2026-07-08T10:30")).toBe(90);
    expect(minutesBetween("2026-07-08T23:00", "2026-07-09T01:00")).toBe(120);
  });

  it("reports minutes into the day", () => {
    expect(minutesIntoDay("2026-07-08T09:30")).toBe(570);
    expect(minutesIntoDay("2026-07-08")).toBe(0);
  });
});

describe("weeks and grids", () => {
  it("finds the week start for both conventions", () => {
    // 2026-07-08 is a Wednesday.
    expect(weekdayOf("2026-07-08")).toBe(3);
    expect(startOfWeek("2026-07-08", 0)).toBe("2026-07-05"); // Sunday
    expect(startOfWeek("2026-07-08", 1)).toBe("2026-07-06"); // Monday
  });

  it("keeps a day that IS the week start put", () => {
    expect(startOfWeek("2026-07-05", 0)).toBe("2026-07-05");
    expect(startOfWeek("2026-07-06", 1)).toBe("2026-07-06");
  });

  it("puts Sunday at the END of a Monday-start week", () => {
    // The classic off-by-one: Sunday (dow 0) with weekStart 1 belongs to the week
    // that began the PREVIOUS Monday, not the one starting tomorrow.
    expect(startOfWeek("2026-07-12", 1)).toBe("2026-07-06");
    const week = weekDates("2026-07-12", 1);
    expect(week[week.length - 1]).toBe("2026-07-12");
  });

  it("builds a 7-day week", () => {
    expect(weekDates("2026-07-08", 1)).toEqual([
      "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09",
      "2026-07-10", "2026-07-11", "2026-07-12",
    ]);
  });

  it("builds a 6-week month grid that brackets the month", () => {
    const grid = monthGrid(2026, 7, 0);
    expect(grid).toHaveLength(6);
    expect(grid[0]).toHaveLength(7);
    // July 2026 starts on a Wednesday, so a Sunday-start grid opens on Jun 28.
    expect(grid[0][0]).toBe("2026-06-28");
    expect(grid.flat()).toContain("2026-07-01");
    expect(grid.flat()).toContain("2026-07-31");
  });

  it("honours a custom week count for the multiweek view", () => {
    expect(monthGrid(2026, 7, 1, 2)).toHaveLength(2);
  });

  it("yields consecutive dates in a range", () => {
    expect(dateRange("2026-07-30", 3)).toEqual(["2026-07-30", "2026-07-31", "2026-08-01"]);
  });
});

describe("normalizeSpan", () => {
  it("gives a timed event with a missing end a minimum length", () => {
    expect(normalizeSpan({ start: "2026-07-08T09:00", end: "", allDay: false }))
      .toEqual({ start: "2026-07-08T09:00", end: "2026-07-08T09:15", allDay: false });
  });

  it("repairs an end that precedes its start", () => {
    const s = normalizeSpan({
      start: "2026-07-08T09:00", end: "2026-07-08T08:00", allDay: false,
    });
    expect(s.end).toBe("2026-07-08T09:15");
  });

  it("gives an all-day event with a bad end its single day back", () => {
    expect(normalizeSpan({ start: "2026-07-08", end: "", allDay: true }))
      .toEqual({ start: "2026-07-08", end: "2026-07-09", allDay: true });
  });

  it("leaves a well-formed span alone", () => {
    const span = { start: "2026-07-08T09:00", end: "2026-07-08T10:00", allDay: false };
    expect(normalizeSpan(span)).toEqual(span);
  });
});

describe("span coverage (exclusive ends)", () => {
  const allDayOneDay = { start: "2026-07-08", end: "2026-07-09", allDay: true };
  const allDayThreeDay = { start: "2026-07-08", end: "2026-07-11", allDay: true };
  const timed = { start: "2026-07-08T09:00", end: "2026-07-08T10:00", allDay: false };

  it("covers exactly its one day for a single all-day event", () => {
    expect(spanCoversDate(allDayOneDay, "2026-07-08")).toBe(true);
    // The exclusive end day is NOT covered.
    expect(spanCoversDate(allDayOneDay, "2026-07-09")).toBe(false);
    expect(spanCoversDate(allDayOneDay, "2026-07-07")).toBe(false);
    expect(spanDates(allDayOneDay)).toEqual(["2026-07-08"]);
    expect(isMultiDay(allDayOneDay)).toBe(false);
  });

  it("covers every day of a multi-day all-day event but not the end day", () => {
    expect(spanDates(allDayThreeDay)).toEqual(["2026-07-08", "2026-07-09", "2026-07-10"]);
    expect(spanCoversDate(allDayThreeDay, "2026-07-11")).toBe(false);
    expect(isMultiDay(allDayThreeDay)).toBe(true);
  });

  it("covers a single day for a timed event", () => {
    expect(spanDates(timed)).toEqual(["2026-07-08"]);
    expect(isMultiDay(timed)).toBe(false);
  });

  it("does not let a timed event ending at midnight claim the next day", () => {
    // 22:00 → 00:00 is a Wednesday event, not a Wednesday+Thursday one.
    const overnight = { start: "2026-07-08T22:00", end: "2026-07-09T00:00", allDay: false };
    expect(spanDates(overnight)).toEqual(["2026-07-08"]);
    expect(spanCoversDate(overnight, "2026-07-09")).toBe(false);
  });

  it("spans both days for a timed event crossing midnight", () => {
    const overnight = { start: "2026-07-08T22:00", end: "2026-07-09T02:00", allDay: false };
    expect(spanDates(overnight)).toEqual(["2026-07-08", "2026-07-09"]);
    expect(isMultiDay(overnight)).toBe(true);
  });
});

describe("daySlice", () => {
  it("slices a same-day timed event to its own extent", () => {
    expect(daySlice({ start: "2026-07-08T09:00", end: "2026-07-08T10:30", allDay: false }, "2026-07-08"))
      .toEqual({ startMin: 540, endMin: 630 });
  });

  it("clips a midnight-crossing event to each day", () => {
    const overnight = { start: "2026-07-08T22:00", end: "2026-07-09T02:00", allDay: false };
    expect(daySlice(overnight, "2026-07-08")).toEqual({ startMin: 1320, endMin: MINUTES_PER_DAY });
    expect(daySlice(overnight, "2026-07-09")).toEqual({ startMin: 0, endMin: 120 });
  });

  it("fills the whole of a middle day of a long event", () => {
    const long = { start: "2026-07-08T22:00", end: "2026-07-11T02:00", allDay: false };
    expect(daySlice(long, "2026-07-09")).toEqual({ startMin: 0, endMin: MINUTES_PER_DAY });
    expect(daySlice(long, "2026-07-10")).toEqual({ startMin: 0, endMin: MINUTES_PER_DAY });
  });

  it("returns null for a day the event does not touch", () => {
    expect(daySlice({ start: "2026-07-08T09:00", end: "2026-07-08T10:00", allDay: false }, "2026-07-09"))
      .toBeNull();
  });
});

describe("all-day end conversion (picker ↔ storage)", () => {
  it("shows the stored exclusive end as the inclusive last day", () => {
    // Stored 2026-07-09 (exclusive) is a one-day event ON the 8th.
    expect(allDayEndToLastDay("2026-07-09")).toBe("2026-07-08");
    // A three-day block: stored end 07-11 → last day shown is the 10th.
    expect(allDayEndToLastDay("2026-07-11")).toBe("2026-07-10");
  });

  it("stores the picker's last day as the exclusive end", () => {
    expect(lastDayToAllDayEnd("2026-07-08")).toBe("2026-07-09");
    expect(lastDayToAllDayEnd("2026-07-10")).toBe("2026-07-11");
  });

  it("round-trips in both directions", () => {
    for (const stored of ["2026-07-09", "2026-03-01", "2027-01-01"]) {
      expect(lastDayToAllDayEnd(allDayEndToLastDay(stored))).toBe(stored);
    }
    for (const shown of ["2026-07-08", "2026-02-28", "2026-12-31"]) {
      expect(allDayEndToLastDay(lastDayToAllDayEnd(shown))).toBe(shown);
    }
  });

  it("a same-day all-day event never ends before it starts", () => {
    // The regression: a new-event draft whose end was fed through the wrong
    // direction landed the end a DAY BEFORE the start, and the save was rejected.
    const start = "2026-07-08";
    const lastDay = start; // "ends on" the same day it starts
    expect(lastDayToAllDayEnd(lastDay) > start).toBe(true);
  });

  it("tolerates a timed stamp by using its date half", () => {
    expect(allDayEndToLastDay("2026-07-09T10:00")).toBe("2026-07-08");
    expect(lastDayToAllDayEnd("2026-07-08T10:00")).toBe("2026-07-09");
  });

  it("leaves garbage alone", () => {
    expect(allDayEndToLastDay("")).toBe("");
    expect(lastDayToAllDayEnd("nope")).toBe("nope");
  });
});

describe("layoutOverlaps", () => {
  it("gives a lone event the full width", () => {
    expect(layoutOverlaps([{ startMin: 540, endMin: 600 }]))
      .toEqual([{ left: 0, width: 1, column: 0, columns: 1 }]);
  });

  it("gives two non-overlapping events the full width each", () => {
    const out = layoutOverlaps([
      { startMin: 540, endMin: 600 },
      { startMin: 600, endMin: 660 },
    ]);
    expect(out[0].width).toBe(1);
    expect(out[1].width).toBe(1);
  });

  it("splits two overlapping events in half", () => {
    const out = layoutOverlaps([
      { startMin: 540, endMin: 660 },
      { startMin: 600, endMin: 720 },
    ]);
    expect(out[0]).toEqual({ left: 0, width: 0.5, column: 0, columns: 2 });
    expect(out[1]).toEqual({ left: 0.5, width: 0.5, column: 1, columns: 2 });
  });

  it("splits three mutually overlapping events into thirds", () => {
    const out = layoutOverlaps([
      { startMin: 540, endMin: 700 },
      { startMin: 560, endMin: 700 },
      { startMin: 580, endMin: 700 },
    ]);
    expect(out.map((p) => p.columns)).toEqual([3, 3, 3]);
    expect(out.map((p) => p.column)).toEqual([0, 1, 2]);
  });

  it("reuses a freed column within a cluster", () => {
    // A runs 9-12; B 9-10; C 10-11. B and C never overlap, so C takes the column
    // B vacated — the cluster needs 2 columns, not 3.
    const [a, b, c] = layoutOverlaps([
      { startMin: 540, endMin: 720 },
      { startMin: 540, endMin: 600 },
      { startMin: 600, endMin: 660 },
    ]);
    expect([a, b, c].every((p) => p.columns === 2)).toBe(true);
    expect(b.column).not.toBe(a.column); // B overlaps A → must be beside it
    expect(c.column).toBe(b.column); // C reuses the column B freed
  });

  it("keeps separate clusters independent", () => {
    // Two overlap in the morning; one sits alone in the afternoon and keeps 100%.
    const out = layoutOverlaps([
      { startMin: 540, endMin: 660 },
      { startMin: 600, endMin: 720 },
      { startMin: 900, endMin: 960 },
    ]);
    expect(out[0].columns).toBe(2);
    expect(out[1].columns).toBe(2);
    expect(out[2]).toEqual({ left: 0, width: 1, column: 0, columns: 1 });
  });

  it("treats touching events as non-overlapping", () => {
    // 9-10 and 10-11 share only an instant; they should not be split.
    const out = layoutOverlaps([
      { startMin: 540, endMin: 600 },
      { startMin: 600, endMin: 660 },
    ]);
    expect(out.every((p) => p.columns === 1)).toBe(true);
  });

  it("returns placements aligned with the input order, not sorted order", () => {
    // Input is deliberately out of chronological order.
    const out = layoutOverlaps([
      { startMin: 600, endMin: 720 },
      { startMin: 540, endMin: 660 },
    ]);
    // The 09:00 event (index 1) must be the one in column 0.
    expect(out[1].column).toBe(0);
    expect(out[0].column).toBe(1);
  });

  it("handles an empty list", () => {
    expect(layoutOverlaps([])).toEqual([]);
  });
});

describe("formatTime", () => {
  it("passes 24h through", () => {
    expect(formatTime("09:00", true)).toBe("09:00");
    expect(formatTime("17:30", true)).toBe("17:30");
  });

  it("converts to 12h with a suffix", () => {
    expect(formatTime("09:00", false)).toBe("9:00 AM");
    expect(formatTime("17:30", false)).toBe("5:30 PM");
  });

  it("renders both noon and midnight as 12", () => {
    expect(formatTime("00:00", false)).toBe("12:00 AM");
    expect(formatTime("12:00", false)).toBe("12:00 PM");
  });
});
