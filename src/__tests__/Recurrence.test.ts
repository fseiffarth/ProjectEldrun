import { describe, expect, it } from "vitest";
import {
  describeRrule,
  excludeOccurrence,
  expandEvent,
  expandEvents,
  occurrencesOn,
  overrideOccurrence,
} from "../lib/recurrence";
import type { CalendarEvent, Rrule } from "../types";

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    calendar_id: "default",
    start: "2026-07-08T09:00",
    end: "2026-07-08T10:00",
    all_day: false,
    title: "standup",
    ...over,
  };
}

function rule(over: Partial<Rrule> = {}): Rrule {
  return { freq: "daily", interval: 1, ...over };
}

/** The rule-generated starts, which is what exdates/overrides key on. */
const starts = (e: CalendarEvent, a: string, b: string) =>
  expandEvent(e, a, b).map((o) => o.occurrenceStart);

describe("non-recurring events", () => {
  it("yields exactly one occurrence inside the window", () => {
    const out = expandEvent(event(), "2026-07-01", "2026-08-01");
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe("2026-07-08T09:00");
    expect(out[0].end).toBe("2026-07-08T10:00");
    expect(out[0].recurring).toBe(false);
  });

  it("yields nothing outside the window", () => {
    expect(expandEvent(event(), "2026-09-01", "2026-10-01")).toHaveLength(0);
  });

  it("still shows a multi-day event that STARTED before the window", () => {
    // A conference running Jun 29 - Jul 3; the July window must still see it.
    const conf = event({ start: "2026-06-29", end: "2026-07-04", all_day: true });
    const out = expandEvent(conf, "2026-07-01", "2026-08-01");
    expect(out).toHaveLength(1);
  });

  it("drops a garbage start rather than throwing", () => {
    expect(expandEvent(event({ start: "nope" }), "2026-07-01", "2026-08-01")).toEqual([]);
  });
});

describe("daily recurrence", () => {
  it("fires every day", () => {
    const e = event({ rrule: rule() });
    expect(starts(e, "2026-07-08", "2026-07-12")).toEqual([
      "2026-07-08T09:00", "2026-07-09T09:00", "2026-07-10T09:00", "2026-07-11T09:00",
    ]);
  });

  it("honours an interval", () => {
    const e = event({ rrule: rule({ interval: 3 }) });
    expect(starts(e, "2026-07-08", "2026-07-18")).toEqual([
      "2026-07-08T09:00", "2026-07-11T09:00", "2026-07-14T09:00", "2026-07-17T09:00",
    ]);
  });

  it("treats a 0 interval as 1 instead of looping forever", () => {
    const e = event({ rrule: rule({ interval: 0 }) });
    expect(starts(e, "2026-07-08", "2026-07-11")).toHaveLength(3);
  });

  it("carries the master's duration to every occurrence", () => {
    const e = event({ end: "2026-07-08T09:30", rrule: rule() });
    const out = expandEvent(e, "2026-07-08", "2026-07-10");
    expect(out[1].start).toBe("2026-07-09T09:00");
    expect(out[1].end).toBe("2026-07-09T09:30");
  });

  it("never fires before the master's own start", () => {
    const e = event({ rrule: rule() });
    // Window opens a week early; the series still begins on the 8th.
    expect(starts(e, "2026-07-01", "2026-07-10")[0]).toBe("2026-07-08T09:00");
  });

  it("crosses a DST boundary without dropping or duplicating a day", () => {
    const e = event({ start: "2026-03-27T09:00", end: "2026-03-27T10:00", rrule: rule() });
    expect(starts(e, "2026-03-27", "2026-03-31")).toEqual([
      "2026-03-27T09:00", "2026-03-28T09:00", "2026-03-29T09:00", "2026-03-30T09:00",
    ]);
  });
});

describe("weekly recurrence", () => {
  it("fires on the master's weekday when no byweekday is given", () => {
    // 2026-07-08 is a Wednesday.
    const e = event({ rrule: rule({ freq: "weekly" }) });
    expect(starts(e, "2026-07-08", "2026-08-01")).toEqual([
      "2026-07-08T09:00", "2026-07-15T09:00", "2026-07-22T09:00", "2026-07-29T09:00",
    ]);
  });

  it("fires on each selected weekday", () => {
    // Mon (1) and Fri (5), starting Wed Jul 8 → Fri 10, Mon 13, Fri 17...
    const e = event({ rrule: rule({ freq: "weekly", byweekday: [1, 5] }) });
    expect(starts(e, "2026-07-08", "2026-07-20")).toEqual([
      "2026-07-10T09:00", "2026-07-13T09:00", "2026-07-17T09:00",
    ]);
  });

  it("includes the master's own weekday when it is selected", () => {
    // Wed (3) is the master's weekday, so the master itself is occurrence one.
    const e = event({ rrule: rule({ freq: "weekly", byweekday: [3, 5] }) });
    expect(starts(e, "2026-07-08", "2026-07-18")).toEqual([
      "2026-07-08T09:00", "2026-07-10T09:00", "2026-07-15T09:00", "2026-07-17T09:00",
    ]);
  });

  it("skips whole weeks with an interval", () => {
    const e = event({ rrule: rule({ freq: "weekly", byweekday: [3], interval: 2 }) });
    expect(starts(e, "2026-07-08", "2026-08-06")).toEqual([
      "2026-07-08T09:00", "2026-07-22T09:00", "2026-08-05T09:00",
    ]);
  });
});

describe("monthly recurrence", () => {
  it("fires on the master's day of month", () => {
    const e = event({ rrule: rule({ freq: "monthly" }) });
    expect(starts(e, "2026-07-08", "2026-11-01")).toEqual([
      "2026-07-08T09:00", "2026-08-08T09:00", "2026-09-08T09:00", "2026-10-08T09:00",
    ]);
  });

  it("clamps a 31st master into shorter months when stepping", () => {
    // Without bymonthday, stepping uses addMonths, which clamps.
    const e = event({ start: "2026-01-31T09:00", end: "2026-01-31T10:00", rrule: rule({ freq: "monthly" }) });
    const got = starts(e, "2026-01-01", "2026-04-01");
    expect(got).toContain("2026-01-31T09:00");
    expect(got).toContain("2026-02-28T09:00");
  });

  it("SKIPS months too short for an explicit bymonthday", () => {
    // "the 31st of the month" simply has no February — the iCalendar behaviour.
    const e = event({ start: "2026-01-31T09:00", end: "2026-01-31T10:00",
      rrule: rule({ freq: "monthly", bymonthday: 31 }) });
    const got = starts(e, "2026-01-01", "2026-05-01");
    expect(got).toEqual(["2026-01-31T09:00", "2026-03-31T09:00"]);
    expect(got.some((s) => s.startsWith("2026-02"))).toBe(false);
    expect(got.some((s) => s.startsWith("2026-04"))).toBe(false); // April has 30
  });

  it("honours bymonthday with an interval", () => {
    const e = event({ start: "2026-01-15T09:00", end: "2026-01-15T10:00",
      rrule: rule({ freq: "monthly", bymonthday: 15, interval: 2 }) });
    expect(starts(e, "2026-01-01", "2026-06-01")).toEqual([
      "2026-01-15T09:00", "2026-03-15T09:00", "2026-05-15T09:00",
    ]);
  });
});

describe("yearly recurrence", () => {
  it("fires once a year", () => {
    const e = event({ rrule: rule({ freq: "yearly" }) });
    expect(starts(e, "2026-01-01", "2029-01-01")).toEqual([
      "2026-07-08T09:00", "2027-07-08T09:00", "2028-07-08T09:00",
    ]);
  });

  it("clamps a Feb 29 master into common years", () => {
    const e = event({ start: "2024-02-29T09:00", end: "2024-02-29T10:00", rrule: rule({ freq: "yearly" }) });
    const got = starts(e, "2024-01-01", "2026-06-01");
    expect(got).toContain("2024-02-29T09:00");
    expect(got).toContain("2025-02-28T09:00");
  });
});

describe("rule ends", () => {
  it("stops after `count` occurrences", () => {
    const e = event({ rrule: rule({ count: 3 }) });
    expect(starts(e, "2026-07-08", "2026-08-01")).toEqual([
      "2026-07-08T09:00", "2026-07-09T09:00", "2026-07-10T09:00",
    ]);
  });

  it("stops after `until`, inclusive of that date", () => {
    const e = event({ rrule: rule({ until: "2026-07-10" }) });
    expect(starts(e, "2026-07-08", "2026-08-01")).toEqual([
      "2026-07-08T09:00", "2026-07-09T09:00", "2026-07-10T09:00",
    ]);
  });

  it("counts occurrences from the series start, not the window start", () => {
    // count:3 means 3 occurrences EVER. A window opening on the 10th must show
    // only the third one, not three fresh ones.
    const e = event({ rrule: rule({ count: 3 }) });
    const out = expandEvent(e, "2026-07-10", "2026-08-01");
    expect(out.map((o) => o.occurrenceStart)).toEqual(["2026-07-10T09:00"]);
  });

  it("an endless rule is bounded by the window, not by memory", () => {
    const e = event({ rrule: rule() });
    const out = expandEvent(e, "2026-07-08", "2026-07-15");
    expect(out).toHaveLength(7);
  });
});

describe("exdates — 'this event only' delete", () => {
  it("drops the excluded occurrence and keeps the rest", () => {
    const e = event({ rrule: rule(), exdates: ["2026-07-09T09:00"] });
    expect(starts(e, "2026-07-08", "2026-07-12")).toEqual([
      "2026-07-08T09:00", "2026-07-10T09:00", "2026-07-11T09:00",
    ]);
  });

  it("excludeOccurrence adds the exdate", () => {
    const e = excludeOccurrence(event({ rrule: rule() }), "2026-07-09T09:00");
    expect(e.exdates).toEqual(["2026-07-09T09:00"]);
    expect(starts(e, "2026-07-08", "2026-07-11")).toEqual([
      "2026-07-08T09:00", "2026-07-10T09:00",
    ]);
  });

  it("excluding an occurrence discards its now-dead override", () => {
    let e = overrideOccurrence(event({ rrule: rule() }), "2026-07-09T09:00", { title: "moved" });
    e = excludeOccurrence(e, "2026-07-09T09:00");
    expect(e.overrides).toEqual([]);
  });
});

describe("overrides — 'this event only' edit", () => {
  it("applies an edited title to just that occurrence", () => {
    const e = overrideOccurrence(event({ rrule: rule() }), "2026-07-09T09:00", { title: "retro" });
    const out = expandEvent(e, "2026-07-08", "2026-07-11");
    expect(out.map((o) => o.title)).toEqual(["standup", "retro", "standup"]);
  });

  it("moves just that occurrence, keeping its duration", () => {
    const e = overrideOccurrence(event({ rrule: rule() }), "2026-07-09T09:00", {
      start: "2026-07-09T14:00",
    });
    const out = expandEvent(e, "2026-07-08", "2026-07-11");
    const moved = out.find((o) => o.occurrenceStart === "2026-07-09T09:00")!;
    expect(moved.start).toBe("2026-07-09T14:00");
    expect(moved.end).toBe("2026-07-09T15:00"); // the master's 1h duration
  });

  it("keys on the ORIGINAL start, so a moved occurrence still matches", () => {
    // The override moved it to the 14:00 slot, but its key stays the 09:00 one it
    // was generated at — otherwise the next expansion would lose the edit.
    const e = overrideOccurrence(event({ rrule: rule() }), "2026-07-09T09:00", {
      start: "2026-07-09T14:00", title: "moved",
    });
    const again = expandEvent(e, "2026-07-08", "2026-07-11");
    const moved = again.find((o) => o.start === "2026-07-09T14:00")!;
    expect(moved.title).toBe("moved");
    expect(moved.occurrenceStart).toBe("2026-07-09T09:00");
  });

  it("re-overriding the same occurrence replaces, not duplicates", () => {
    let e = overrideOccurrence(event({ rrule: rule() }), "2026-07-09T09:00", { title: "a" });
    e = overrideOccurrence(e, "2026-07-09T09:00", { title: "b" });
    expect(e.overrides).toHaveLength(1);
    expect(e.overrides![0].title).toBe("b");
  });

  it("an override leaves the other occurrences untouched", () => {
    const e = overrideOccurrence(event({ rrule: rule() }), "2026-07-09T09:00", {
      start: "2026-07-09T14:00",
    });
    const out = expandEvent(e, "2026-07-08", "2026-07-11");
    expect(out.find((o) => o.occurrenceStart === "2026-07-10T09:00")!.start).toBe("2026-07-10T09:00");
  });
});

describe("all-day recurrence", () => {
  it("keeps the exclusive end one day out", () => {
    const e = event({ start: "2026-07-08", end: "2026-07-09", all_day: true, rrule: rule() });
    const out = expandEvent(e, "2026-07-08", "2026-07-11");
    expect(out[0]).toMatchObject({ start: "2026-07-08", end: "2026-07-09", allDay: true });
    expect(out[1]).toMatchObject({ start: "2026-07-09", end: "2026-07-10" });
  });

  it("carries a multi-day span to each occurrence", () => {
    // A 3-day all-day block repeating weekly.
    const e = event({ start: "2026-07-08", end: "2026-07-11", all_day: true,
      rrule: rule({ freq: "weekly" }) });
    const out = expandEvent(e, "2026-07-08", "2026-07-20");
    expect(out[0]).toMatchObject({ start: "2026-07-08", end: "2026-07-11" });
    expect(out[1]).toMatchObject({ start: "2026-07-15", end: "2026-07-18" });
  });
});

describe("expandEvents", () => {
  it("sorts all-day first, then chronologically", () => {
    const out = expandEvents(
      [
        event({ id: "b", start: "2026-07-08T14:00", end: "2026-07-08T15:00", title: "late" }),
        event({ id: "a", start: "2026-07-08T09:00", end: "2026-07-08T10:00", title: "early" }),
        event({ id: "c", start: "2026-07-08", end: "2026-07-09", all_day: true, title: "allday" }),
      ],
      "2026-07-08",
      "2026-07-09",
    );
    expect(out.map((o) => o.title)).toEqual(["allday", "early", "late"]);
  });

  it("drops events on hidden calendars", () => {
    const out = expandEvents(
      [
        event({ id: "a", calendar_id: "default", title: "shown" }),
        event({ id: "b", calendar_id: "work", title: "hidden" }),
      ],
      "2026-07-08",
      "2026-07-09",
      new Set(["default"]),
    );
    expect(out.map((o) => o.title)).toEqual(["shown"]);
  });

  it("finds the occurrences of a given day", () => {
    const occ = expandEvents([event({ rrule: rule() })], "2026-07-08", "2026-07-12");
    expect(occurrencesOn(occ, "2026-07-10")).toHaveLength(1);
    expect(occurrencesOn(occ, "2026-07-20")).toHaveLength(0);
  });
});

describe("describeRrule", () => {
  it("describes the common rules", () => {
    expect(describeRrule(null)).toBe("Does not repeat");
    expect(describeRrule(rule())).toBe("Daily");
    expect(describeRrule(rule({ interval: 3 }))).toBe("Every 3 days");
    expect(describeRrule(rule({ freq: "weekly", byweekday: [1, 5] })))
      .toBe("Weekly on Monday, Friday");
    expect(describeRrule(rule({ freq: "monthly", bymonthday: 15 }))).toBe("Monthly on day 15");
    expect(describeRrule(rule({ freq: "yearly" }))).toBe("Yearly");
  });

  it("appends the rule's end", () => {
    expect(describeRrule(rule({ count: 5 }))).toBe("Daily, 5 times");
    expect(describeRrule(rule({ until: "2026-12-31" }))).toBe("Daily, until 2026-12-31");
  });
});
