import { describe, expect, it } from "vitest";
import {
  alarmKey,
  alarmTime,
  alarmWindow,
  describeLead,
  dueAlarms,
  snooze,
  wokenSnoozes,
} from "../lib/alarms";
import type { Occurrence } from "../types";

function occ(over: Partial<Occurrence> = {}): Occurrence {
  return {
    eventId: "e1",
    occurrenceStart: "2026-07-08T09:00",
    start: "2026-07-08T09:00",
    end: "2026-07-08T10:00",
    allDay: false,
    title: "standup",
    location: "",
    notes: "",
    category: "",
    status: "confirmed",
    calendarId: "default",
    recurring: false,
    alarms: [{ minutes_before: 15 }],
    ...over,
  };
}

/** A local Date at the given civil moment (the calendar is wall-clock). */
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi);

describe("alarmTime", () => {
  it("subtracts the offset from a timed start", () => {
    expect(alarmTime(occ(), 15)).toBe("2026-07-08T08:45");
    expect(alarmTime(occ(), 60)).toBe("2026-07-08T08:00");
    expect(alarmTime(occ(), 1440)).toBe("2026-07-07T09:00");
  });

  it("anchors an all-day event's reminders to 09:00, not midnight", () => {
    // A "1 day before" on a birthday should arrive the previous morning, not at
    // 00:00 the previous night.
    const birthday = occ({ start: "2026-07-08", end: "2026-07-09", allDay: true });
    expect(alarmTime(birthday, 1440)).toBe("2026-07-07T09:00");
    expect(alarmTime(birthday, 0)).toBe("2026-07-08T09:00");
  });

  it("handles a zero offset (at the time of the event)", () => {
    expect(alarmTime(occ(), 0)).toBe("2026-07-08T09:00");
  });
});

describe("dueAlarms", () => {
  const none = new Set<string>();

  it("does not fire before its time", () => {
    // 08:44 — one minute early.
    expect(dueAlarms([occ()], none, at(2026, 7, 8, 8, 44))).toHaveLength(0);
  });

  it("fires once its time arrives", () => {
    const due = dueAlarms([occ()], none, at(2026, 7, 8, 8, 45));
    expect(due).toHaveLength(1);
    expect(due[0].title).toBe("standup");
    expect(due[0].minutesBefore).toBe(15);
  });

  it("fires a reminder that came due while the app was closed", () => {
    // The reminder was due at 08:45; the app only opened at 09:30.
    expect(dueAlarms([occ()], none, at(2026, 7, 8, 9, 30))).toHaveLength(1);
  });

  it("does not fire a stale reminder from days ago", () => {
    // Well past the grace window — showing this now would be noise.
    expect(dueAlarms([occ()], none, at(2026, 7, 20, 9, 0))).toHaveLength(0);
  });

  it("respects a custom grace window", () => {
    // 2h late, with a 1h grace → suppressed.
    expect(dueAlarms([occ()], none, at(2026, 7, 8, 10, 45), 60)).toHaveLength(0);
    // ...and with a 3h grace → shown.
    expect(dueAlarms([occ()], none, at(2026, 7, 8, 10, 45), 180)).toHaveLength(1);
  });

  it("NEVER re-fires an alarm already fired", () => {
    const fired = new Set([alarmKey("e1", "2026-07-08T09:00", 15)]);
    expect(dueAlarms([occ()], fired, at(2026, 7, 8, 8, 45))).toHaveLength(0);
  });

  it("fires each of an event's several reminders independently", () => {
    const e = occ({ alarms: [{ minutes_before: 15 }, { minutes_before: 1440 }] });
    // The day-before reminder is due; the 15-minute one is not.
    const early = dueAlarms([e], none, at(2026, 7, 7, 9, 0));
    expect(early.map((a) => a.minutesBefore)).toEqual([1440]);

    // By 08:45 on the day, only the 15-minute one is still unfired.
    const fired = new Set([alarmKey("e1", "2026-07-08T09:00", 1440)]);
    const late = dueAlarms([e], fired, at(2026, 7, 8, 8, 45));
    expect(late.map((a) => a.minutesBefore)).toEqual([15]);
  });

  it("keys each occurrence of a series separately", () => {
    // Two occurrences of the same recurring event; dismissing Wednesday's must not
    // dismiss Thursday's.
    const wed = occ({ occurrenceStart: "2026-07-08T09:00", start: "2026-07-08T09:00", recurring: true });
    const thu = occ({ occurrenceStart: "2026-07-09T09:00", start: "2026-07-09T09:00", recurring: true });
    const fired = new Set([alarmKey("e1", "2026-07-08T09:00", 15)]);

    const due = dueAlarms([wed, thu], fired, at(2026, 7, 9, 8, 45));
    expect(due).toHaveLength(1);
    expect(due[0].occurrenceStart).toBe("2026-07-09T09:00");
  });

  it("ignores occurrences with no reminders", () => {
    expect(dueAlarms([occ({ alarms: [] })], none, at(2026, 7, 8, 9, 0))).toHaveLength(0);
  });

  it("sorts the most imminent first", () => {
    const a = occ({ eventId: "a", start: "2026-07-08T14:00", occurrenceStart: "2026-07-08T14:00" });
    const b = occ({ eventId: "b", start: "2026-07-08T10:00", occurrenceStart: "2026-07-08T10:00" });
    const due = dueAlarms([a, b], none, at(2026, 7, 8, 13, 50));
    expect(due.map((x) => x.eventId)).toEqual(["b", "a"]);
  });
});

describe("alarmKey", () => {
  it("distinguishes event, occurrence and offset", () => {
    expect(alarmKey("e1", "2026-07-08T09:00", 15)).not.toBe(alarmKey("e2", "2026-07-08T09:00", 15));
    expect(alarmKey("e1", "2026-07-08T09:00", 15)).not.toBe(alarmKey("e1", "2026-07-09T09:00", 15));
    expect(alarmKey("e1", "2026-07-08T09:00", 15)).not.toBe(alarmKey("e1", "2026-07-08T09:00", 30));
  });

  it("is stable for the same alarm", () => {
    expect(alarmKey("e1", "2026-07-08T09:00", 15)).toBe(alarmKey("e1", "2026-07-08T09:00", 15));
  });
});

describe("alarmWindow", () => {
  it("reaches back a day, to catch a reminder missed while closed", () => {
    const w = alarmWindow([{ alarms: [{ minutes_before: 15 }] }], at(2026, 7, 8, 12, 0));
    expect(w.start).toBe("2026-07-07");
  });

  it("reaches forward far enough to see the longest lead time", () => {
    // A "1 day before" reminder needs tomorrow's events in view.
    const w = alarmWindow([{ alarms: [{ minutes_before: 1440 }] }], at(2026, 7, 8, 12, 0));
    expect(w.end >= "2026-07-11").toBe(true);
  });

  it("copes with no reminders at all", () => {
    const w = alarmWindow([], at(2026, 7, 8, 12, 0));
    expect(w.start).toBe("2026-07-07");
    expect(w.end > w.start).toBe(true);
  });
});

describe("snooze", () => {
  it("comes back after the snooze period", () => {
    const alarm = dueAlarms([occ()], new Set(), at(2026, 7, 8, 8, 45))[0];
    const s = snooze(alarm, 5, at(2026, 7, 8, 8, 45));
    expect(s.at).toBe("2026-07-08T08:50");

    // Not yet.
    expect(wokenSnoozes([s], at(2026, 7, 8, 8, 49))).toHaveLength(0);
    // Now.
    expect(wokenSnoozes([s], at(2026, 7, 8, 8, 50))).toHaveLength(1);
  });

  it("carries the alarm through, so it can be re-shown", () => {
    const alarm = dueAlarms([occ()], new Set(), at(2026, 7, 8, 8, 45))[0];
    const s = snooze(alarm, 5, at(2026, 7, 8, 8, 45));
    expect(wokenSnoozes([s], at(2026, 7, 8, 9, 0))[0].alarm.title).toBe("standup");
  });

  it("snoozing to tomorrow rolls the date", () => {
    const alarm = dueAlarms([occ()], new Set(), at(2026, 7, 8, 8, 45))[0];
    const s = snooze(alarm, 24 * 60, at(2026, 7, 8, 23, 30));
    expect(s.at).toBe("2026-07-09T23:30");
  });
});

describe("describeLead", () => {
  it("describes the common offsets", () => {
    expect(describeLead(0)).toBe("now");
    expect(describeLead(1)).toBe("in 1 minute");
    expect(describeLead(15)).toBe("in 15 minutes");
    expect(describeLead(60)).toBe("in 1 hour");
    expect(describeLead(120)).toBe("in 2 hours");
    expect(describeLead(1440)).toBe("in 1 day");
  });

  it("describes an offset AFTER the start", () => {
    expect(describeLead(-15)).toBe("15 minutes ago");
  });
});
