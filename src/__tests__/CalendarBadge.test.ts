import { describe, expect, it } from "vitest";
import { eventsLeftToday, occurrencesToday, occurrenceStale } from "../stores/calendar";
import type { Calendar, CalendarEvent } from "../types";

/**
 * The header calendar button's badge (`stores/calendar`'s `eventsLeftToday`).
 *
 * The number is *derived*, not acknowledged — nothing marks an event "seen" — so
 * every case here is really the same question asked at different clock times:
 * given these events and this moment, what is still ahead of the user today?
 */

const CALENDARS: Calendar[] = [
  { id: "work", name: "Work", color: "#f00", visible: true, readonly: false },
  { id: "hidden", name: "Hidden", color: "#0f0", visible: false, readonly: false },
];

function ev(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    calendar_id: "work",
    start: "2026-07-08T09:00",
    end: "2026-07-08T10:00",
    all_day: false,
    title: "standup",
    ...over,
  };
}

/** 2026-07-08 is a Wednesday. Local time, matching the store's civil stamps. */
const at = (hhmm: string) => new Date(`2026-07-08T${hhmm}:00`);

describe("eventsLeftToday", () => {
  it("counts an event that has not started", () => {
    expect(eventsLeftToday([ev()], CALENDARS, at("08:00"))).toBe(1);
  });

  it("still counts one the user is currently sitting in", () => {
    // "Left" is not-yet-ENDED, not not-yet-started: a meeting from 09:00 to
    // 17:00 must not vanish from the count at 09:01.
    expect(eventsLeftToday([ev()], CALENDARS, at("09:30"))).toBe(1);
  });

  it("drops one that has ended", () => {
    expect(eventsLeftToday([ev()], CALENDARS, at("10:30"))).toBe(0);
  });

  it("empties itself by the end of the day", () => {
    const day = [
      ev({ id: "a", start: "2026-07-08T09:00", end: "2026-07-08T10:00" }),
      ev({ id: "b", start: "2026-07-08T13:00", end: "2026-07-08T14:00" }),
      ev({ id: "c", start: "2026-07-08T16:00", end: "2026-07-08T17:00" }),
    ];
    expect(eventsLeftToday(day, CALENDARS, at("08:00"))).toBe(3);
    expect(eventsLeftToday(day, CALENDARS, at("13:30"))).toBe(2);
    expect(eventsLeftToday(day, CALENDARS, at("23:00"))).toBe(0);
  });

  it("counts an all-day event for the whole day", () => {
    const allDay = ev({ start: "2026-07-08", end: "2026-07-08", all_day: true });
    expect(eventsLeftToday([allDay], CALENDARS, at("01:00"))).toBe(1);
    expect(eventsLeftToday([allDay], CALENDARS, at("23:59"))).toBe(1);
  });

  it("ignores other days", () => {
    const tomorrow = ev({ start: "2026-07-09T09:00", end: "2026-07-09T10:00" });
    const yesterday = ev({ id: "y", start: "2026-07-07T09:00", end: "2026-07-07T10:00" });
    expect(eventsLeftToday([tomorrow, yesterday], CALENDARS, at("08:00"))).toBe(0);
  });

  it("ignores a hidden calendar", () => {
    // A badge that counted what no view will show would send the user looking
    // for events they cannot find.
    expect(eventsLeftToday([ev({ calendar_id: "hidden" })], CALENDARS, at("08:00"))).toBe(0);
  });

  it("counts each occurrence of a recurring event once", () => {
    const daily = ev({ rrule: { freq: "daily", interval: 1 } });
    expect(eventsLeftToday([daily], CALENDARS, at("08:00"))).toBe(1);
    expect(eventsLeftToday([daily], CALENDARS, at("11:00"))).toBe(0);
  });

  it("is zero with nothing scheduled", () => {
    expect(eventsLeftToday([], CALENDARS, at("08:00"))).toBe(0);
  });
});

/**
 * The header list's *hiding* rule, one step past the badge's: a finished
 * occurrence is dimmed while it is recent and dropped once it is an hour old.
 * The two rules are read against each other, so the cases here are the boundary
 * ones — a row must never leave the list while it is still being counted.
 */
describe("occurrenceStale", () => {
  const only = (now: Date) => occurrencesToday([ev()], CALENDARS, now)[0];

  it("keeps one that has not started", () => {
    expect(occurrenceStale(only(at("08:00")), at("08:00"))).toBe(false);
  });

  it("keeps one still running", () => {
    expect(occurrenceStale(only(at("09:30")), at("09:30"))).toBe(false);
  });

  it("keeps one that has just ended", () => {
    // The hour after a meeting is exactly when a dimmed row is still an answer.
    expect(occurrenceStale(only(at("10:05")), at("10:05"))).toBe(false);
  });

  it("keeps one at the grace boundary", () => {
    expect(occurrenceStale(only(at("10:59")), at("10:59"))).toBe(false);
  });

  it("drops one an hour past its end", () => {
    expect(occurrenceStale(only(at("11:00")), at("11:00"))).toBe(true);
    expect(occurrenceStale(only(at("16:00")), at("16:00"))).toBe(true);
  });

  it("never drops an all-day event", () => {
    // It has no hour to be an hour past, and it runs to the end of the day.
    const allDay = ev({ start: "2026-07-08", end: "2026-07-08", all_day: true });
    const occ = occurrencesToday([allDay], CALENDARS, at("23:00"))[0];
    expect(occurrenceStale(occ, at("23:00"))).toBe(false);
  });

  it("never drops what the badge is still counting", () => {
    const day = [
      ev({ id: "a", start: "2026-07-08T09:00", end: "2026-07-08T10:00" }),
      ev({ id: "b", start: "2026-07-08T13:00", end: "2026-07-08T14:00" }),
      ev({ id: "c", start: "2026-07-08T16:00", end: "2026-07-08T17:00" }),
    ];
    for (const hhmm of ["08:00", "09:30", "10:30", "13:30", "16:59", "23:00"]) {
      const now = at(hhmm);
      const shown = occurrencesToday(day, CALENDARS, now).filter((o) => !occurrenceStale(o, now));
      expect(shown.length).toBeGreaterThanOrEqual(eventsLeftToday(day, CALENDARS, now));
    }
  });
});
