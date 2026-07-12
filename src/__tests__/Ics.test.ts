import { describe, expect, it } from "vitest";
import {
  escapeText,
  fold,
  formatIcsDate,
  formatRrule,
  formatTrigger,
  parseIcs,
  parseIcsDate,
  parseLine,
  parseRrule,
  parseTrigger,
  serializeIcs,
  unescapeText,
  unfold,
} from "../lib/ics";
import type { CalendarEvent, CalendarTask } from "../types";

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

const AT = new Date(Date.UTC(2026, 6, 1, 12, 0, 0));

describe("line folding", () => {
  it("stitches a folded line back together", () => {
    const text = "SUMMARY:a very long\r\n  continuation\r\nLOCATION:room";
    expect(unfold(text)).toEqual(["SUMMARY:a very long continuation", "LOCATION:room"]);
  });

  it("unfolds a tab continuation too", () => {
    expect(unfold("SUMMARY:one\r\n\ttwo")).toEqual(["SUMMARY:onetwo"]);
  });

  it("folds a long line at 75 octets", () => {
    const long = "DESCRIPTION:" + "x".repeat(200);
    const folded = fold(long);
    expect(folded).toContain("\r\n ");
    // Round-trip: folding then unfolding gives the original back.
    expect(unfold(folded)).toEqual([long]);
  });

  it("leaves a short line alone", () => {
    expect(fold("SUMMARY:hi")).toBe("SUMMARY:hi");
  });

  it("drops blank lines", () => {
    expect(unfold("A:1\r\n\r\nB:2")).toEqual(["A:1", "B:2"]);
  });
});

describe("escaping", () => {
  it("escapes the special characters", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });

  it("round-trips", () => {
    const s = "Meeting, room 2; \\ the \"big\" one\nsecond line";
    expect(unescapeText(escapeText(s))).toBe(s);
  });

  it("unescapes \\n and \\N alike", () => {
    expect(unescapeText("a\\nb")).toBe("a\nb");
    expect(unescapeText("a\\Nb")).toBe("a\nb");
  });
});

describe("parseLine", () => {
  it("splits name, params and value", () => {
    expect(parseLine("DTSTART;VALUE=DATE:20260708")).toEqual({
      name: "DTSTART",
      params: { VALUE: "DATE" },
      value: "20260708",
    });
  });

  it("does not split on a colon inside a quoted param", () => {
    const line = parseLine('X-A;CN="a:b":value');
    expect(line?.params.CN).toBe("a:b");
    expect(line?.value).toBe("value");
  });

  it("keeps colons in the value", () => {
    expect(parseLine("DESCRIPTION:see http://x.test")?.value).toBe("see http://x.test");
  });

  it("returns null for a line with no colon", () => {
    expect(parseLine("GARBAGE")).toBeNull();
  });
});

describe("dates", () => {
  it("parses a DATE as all-day", () => {
    expect(parseIcsDate("20260708")).toEqual({ stamp: "2026-07-08", dateOnly: true });
  });

  it("parses a floating DATE-TIME", () => {
    expect(parseIcsDate("20260708T090000")).toEqual({
      stamp: "2026-07-08T09:00",
      dateOnly: false,
    });
  });

  it("converts a UTC DATE-TIME into local time", () => {
    // Whatever the runner's zone, the parsed local stamp must denote the same
    // instant as the UTC input.
    const parsed = parseIcsDate("20260708T120000Z")!;
    const asLocal = new Date(
      Number(parsed.stamp.slice(0, 4)),
      Number(parsed.stamp.slice(5, 7)) - 1,
      Number(parsed.stamp.slice(8, 10)),
      Number(parsed.stamp.slice(11, 13)),
      Number(parsed.stamp.slice(14, 16)),
    );
    expect(asLocal.getTime()).toBe(Date.UTC(2026, 6, 8, 12, 0));
  });

  it("rejects garbage", () => {
    expect(parseIcsDate("nope")).toBeNull();
  });

  it("formats both forms", () => {
    expect(formatIcsDate("2026-07-08", true)).toBe("20260708");
    expect(formatIcsDate("2026-07-08T09:05", false)).toBe("20260708T090500");
  });
});

describe("RRULE", () => {
  it("parses the common rules", () => {
    expect(parseRrule("FREQ=DAILY")).toMatchObject({ freq: "daily", interval: 1 });
    expect(parseRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR")).toMatchObject({
      freq: "weekly", interval: 2, byweekday: [1, 5],
    });
    expect(parseRrule("FREQ=MONTHLY;BYMONTHDAY=15")).toMatchObject({
      freq: "monthly", bymonthday: 15,
    });
    expect(parseRrule("FREQ=DAILY;COUNT=5")).toMatchObject({ count: 5 });
    expect(parseRrule("FREQ=DAILY;UNTIL=20261231")).toMatchObject({ until: "2026-12-31" });
  });

  it("strips an ordinal BYDAY prefix down to the weekday", () => {
    // "2MO" (the 2nd Monday) degrades to plain Monday — the model holds no ordinal.
    expect(parseRrule("FREQ=MONTHLY;BYDAY=2MO")).toMatchObject({ byweekday: [1] });
    expect(parseRrule("FREQ=MONTHLY;BYDAY=-1FR")).toMatchObject({ byweekday: [5] });
  });

  it("drops an unsupported FREQ rather than guessing", () => {
    expect(parseRrule("FREQ=HOURLY;INTERVAL=2")).toBeNull();
    expect(parseRrule("INTERVAL=2")).toBeNull();
  });

  it("formats a rule", () => {
    expect(formatRrule({ freq: "weekly", interval: 2, byweekday: [1, 5] }))
      .toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR");
    expect(formatRrule({ freq: "daily", interval: 1 })).toBe("FREQ=DAILY");
    expect(formatRrule({ freq: "daily", interval: 1, count: 3 })).toBe("FREQ=DAILY;COUNT=3");
    expect(formatRrule({ freq: "daily", interval: 1, until: "2026-12-31" }))
      .toBe("FREQ=DAILY;UNTIL=20261231");
  });

  it("round-trips", () => {
    const rule = { freq: "weekly" as const, interval: 3, byweekday: [1, 3], count: 8 };
    expect(parseRrule(formatRrule(rule))).toMatchObject(rule);
  });
});

describe("VALARM triggers", () => {
  it("parses a negative duration as minutes BEFORE", () => {
    expect(parseTrigger("-PT15M")).toBe(15);
    expect(parseTrigger("-PT1H")).toBe(60);
    expect(parseTrigger("-P1D")).toBe(1440);
    expect(parseTrigger("-PT1H30M")).toBe(90);
  });

  it("parses a positive duration as negative minutes-before (i.e. after the start)", () => {
    expect(parseTrigger("PT15M")).toBe(-15);
  });

  it("parses a zero trigger", () => {
    expect(parseTrigger("PT0S")).toBe(0);
  });

  it("formats", () => {
    expect(formatTrigger(15)).toBe("-PT15M");
    expect(formatTrigger(60)).toBe("-PT1H");
    expect(formatTrigger(1440)).toBe("-P1D");
    expect(formatTrigger(90)).toBe("-PT1H30M");
    expect(formatTrigger(0)).toBe("PT0S");
  });

  it("round-trips", () => {
    for (const m of [0, 5, 15, 30, 60, 90, 1440]) {
      expect(parseTrigger(formatTrigger(m))).toBe(m);
    }
  });
});

describe("parseIcs", () => {
  it("parses a timed VEVENT", () => {
    const { events } = parseIcs(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:1",
        "DTSTART:20260708T090000",
        "DTEND:20260708T100000",
        "SUMMARY:standup",
        "LOCATION:room 2",
        "DESCRIPTION:daily sync",
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      start: "2026-07-08T09:00",
      end: "2026-07-08T10:00",
      all_day: false,
      title: "standup",
      location: "room 2",
      notes: "daily sync",
      status: "confirmed",
    });
  });

  it("parses an all-day VEVENT, keeping the exclusive end", () => {
    const { events } = parseIcs(
      [
        "BEGIN:VEVENT",
        "DTSTART;VALUE=DATE:20260708",
        "DTEND;VALUE=DATE:20260709",
        "SUMMARY:holiday",
        "END:VEVENT",
      ].join("\r\n"),
    );
    expect(events[0]).toMatchObject({
      start: "2026-07-08", end: "2026-07-09", all_day: true,
    });
  });

  it("defaults a missing DTEND", () => {
    const timed = parseIcs("BEGIN:VEVENT\r\nDTSTART:20260708T090000\r\nSUMMARY:x\r\nEND:VEVENT");
    expect(timed.events[0].end).toBe("2026-07-08T10:00"); // +1h

    const allDay = parseIcs("BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260708\r\nSUMMARY:x\r\nEND:VEVENT");
    expect(allDay.events[0].end).toBe("2026-07-09"); // +1 day
  });

  it("parses RRULE, EXDATE and VALARM", () => {
    const { events } = parseIcs(
      [
        "BEGIN:VEVENT",
        "DTSTART:20260708T090000",
        "DTEND:20260708T093000",
        "SUMMARY:standup",
        "RRULE:FREQ=DAILY;COUNT=10",
        "EXDATE:20260710T090000",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:-PT15M",
        "END:VALARM",
        "END:VEVENT",
      ].join("\r\n"),
    );
    expect(events[0].rrule).toMatchObject({ freq: "daily", count: 10 });
    expect(events[0].exdates).toEqual(["2026-07-10T09:00"]);
    expect(events[0].alarms).toEqual([{ minutes_before: 15 }]);
  });

  it("parses several EXDATEs on one line", () => {
    const { events } = parseIcs(
      [
        "BEGIN:VEVENT",
        "DTSTART:20260708T090000",
        "SUMMARY:x",
        "EXDATE:20260710T090000,20260711T090000",
        "END:VEVENT",
      ].join("\r\n"),
    );
    expect(events[0].exdates).toEqual(["2026-07-10T09:00", "2026-07-11T09:00"]);
  });

  it("parses a VTODO", () => {
    const { tasks } = parseIcs(
      [
        "BEGIN:VTODO",
        "SUMMARY:write the plan",
        "DUE;VALUE=DATE:20260710",
        "PRIORITY:1",
        "PERCENT-COMPLETE:50",
        "END:VTODO",
      ].join("\r\n"),
    );
    expect(tasks[0]).toMatchObject({
      title: "write the plan", due: "2026-07-10", priority: 1, percent: 50,
    });
  });

  it("treats a COMPLETED VTODO as done", () => {
    const { tasks } = parseIcs(
      [
        "BEGIN:VTODO",
        "SUMMARY:done thing",
        "STATUS:COMPLETED",
        "COMPLETED:20260709T120000",
        "END:VTODO",
      ].join("\r\n"),
    );
    expect(tasks[0].percent).toBe(100);
    expect(tasks[0].completed).toBe("2026-07-09T12:00");
  });

  it("skips unsupported components instead of importing junk", () => {
    const { events, tasks, skipped } = parseIcs(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VTIMEZONE",
        "TZID:Europe/Berlin",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        "DTSTART:20260708T090000",
        "SUMMARY:real",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(events).toHaveLength(1);
    expect(tasks).toHaveLength(0);
    expect(skipped).toBe(0);
  });

  it("counts a VEVENT with no DTSTART as skipped", () => {
    const { events, skipped } = parseIcs("BEGIN:VEVENT\r\nSUMMARY:no start\r\nEND:VEVENT");
    expect(events).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("handles CRLF, LF and folded input alike", () => {
    const lf = parseIcs("BEGIN:VEVENT\nDTSTART:20260708T090000\nSUMMARY:x\nEND:VEVENT");
    expect(lf.events).toHaveLength(1);
  });

  it("unescapes text values", () => {
    const { events } = parseIcs(
      "BEGIN:VEVENT\r\nDTSTART:20260708T090000\r\nSUMMARY:Lunch\\, then talk\r\nEND:VEVENT",
    );
    expect(events[0].title).toBe("Lunch, then talk");
  });

  it("parses multiple events", () => {
    const { events } = parseIcs(
      [
        "BEGIN:VEVENT", "DTSTART:20260708T090000", "SUMMARY:a", "END:VEVENT",
        "BEGIN:VEVENT", "DTSTART:20260709T090000", "SUMMARY:b", "END:VEVENT",
      ].join("\r\n"),
    );
    expect(events.map((e) => e.title)).toEqual(["a", "b"]);
  });
});

describe("serializeIcs", () => {
  it("writes a well-formed calendar", () => {
    const out = serializeIcs([event()], [], AT);
    expect(out).toContain("BEGIN:VCALENDAR");
    expect(out).toContain("VERSION:2.0");
    expect(out).toContain("BEGIN:VEVENT");
    expect(out).toContain("DTSTART:20260708T090000");
    expect(out).toContain("DTEND:20260708T100000");
    expect(out).toContain("SUMMARY:standup");
    expect(out).toContain("END:VCALENDAR");
    expect(out.endsWith("\r\n")).toBe(true);
  });

  it("marks an all-day event with VALUE=DATE", () => {
    const out = serializeIcs(
      [event({ start: "2026-07-08", end: "2026-07-09", all_day: true })], [], AT,
    );
    expect(out).toContain("DTSTART;VALUE=DATE:20260708");
    expect(out).toContain("DTEND;VALUE=DATE:20260709");
  });

  it("writes alarms as VALARM blocks", () => {
    const out = serializeIcs([event({ alarms: [{ minutes_before: 15 }] })], [], AT);
    expect(out).toContain("BEGIN:VALARM");
    expect(out).toContain("TRIGGER:-PT15M");
    expect(out).toContain("ACTION:DISPLAY");
  });

  it("escapes text on the way out", () => {
    const out = serializeIcs([event({ title: "Lunch, then talk" })], [], AT);
    expect(out).toContain("SUMMARY:Lunch\\, then talk");
  });

  it("writes a VTODO", () => {
    const task: CalendarTask = {
      id: "t1", calendar_id: "default", title: "write plan",
      due: "2026-07-10", priority: 1, percent: 100, completed: "2026-07-09T12:00",
    };
    const out = serializeIcs([], [task], AT);
    expect(out).toContain("BEGIN:VTODO");
    expect(out).toContain("SUMMARY:write plan");
    expect(out).toContain("DUE:20260710");
    expect(out).toContain("PRIORITY:1");
    expect(out).toContain("STATUS:COMPLETED");
  });
});

describe("round-trip", () => {
  it("survives a full event unchanged", () => {
    const original = event({
      start: "2026-07-08T09:00",
      end: "2026-07-08T09:30",
      title: "Lunch, then talk",
      location: "room 2; upstairs",
      notes: "line one\nline two",
      category: "work",
      status: "tentative",
      rrule: { freq: "weekly", interval: 2, byweekday: [1, 5], count: 6 },
      exdates: ["2026-07-20T09:00"],
      alarms: [{ minutes_before: 15 }, { minutes_before: 1440 }],
    });

    const { events } = parseIcs(serializeIcs([original], [], AT));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      start: original.start,
      end: original.end,
      all_day: false,
      title: original.title,
      location: original.location,
      notes: original.notes,
      category: original.category,
      status: original.status,
      exdates: original.exdates,
      alarms: original.alarms,
    });
    expect(events[0].rrule).toMatchObject(original.rrule!);
  });

  it("survives an all-day multi-day event", () => {
    const original = event({
      start: "2026-07-08", end: "2026-07-11", all_day: true, title: "conference",
    });
    const { events } = parseIcs(serializeIcs([original], [], AT));
    expect(events[0]).toMatchObject({
      start: "2026-07-08", end: "2026-07-11", all_day: true, title: "conference",
    });
  });

  it("survives a long line that has to be folded", () => {
    const original = event({ notes: "x".repeat(300) });
    const { events } = parseIcs(serializeIcs([original], [], AT));
    expect(events[0].notes).toBe("x".repeat(300));
  });

  it("survives a task", () => {
    const task: CalendarTask = {
      id: "t1", calendar_id: "default", title: "write plan", notes: "the whole thing",
      due: "2026-07-10", start: null, priority: 1, percent: 50, completed: null,
      category: "work", alarms: [{ minutes_before: 60 }],
    };
    const { tasks } = parseIcs(serializeIcs([], [task], AT));
    expect(tasks[0]).toMatchObject({
      title: "write plan", notes: "the whole thing", due: "2026-07-10",
      priority: 1, percent: 50, category: "work", alarms: [{ minutes_before: 60 }],
    });
  });
});
