import { describe, expect, it } from "vitest";

import {
  agendaWindow,
  occurrenceCardOf,
  occurrencePast,
  selectUrgentMail,
  taskFromMail,
  taskFromOccurrence,
} from "../lib/todoBoard";
import type { Calendar, CalendarEvent, CalendarTask } from "../types";
import type { MailHeader } from "../types/mail";

/**
 * The two rails: today's and tomorrow's appointments, and which marked mail is
 * still worth showing.
 */

const CALENDARS: Calendar[] = [
  { id: "work", name: "Work", color: "#f00", visible: true, readonly: false },
  { id: "hidden", name: "Hidden", color: "#0f0", visible: false, readonly: false },
];

function ev(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e",
    calendar_id: "work",
    start: "2026-07-08T09:00",
    end: "2026-07-08T10:00",
    all_day: false,
    title: "standup",
    ...over,
  };
}

const at = (hhmm: string) => new Date(`2026-07-08T${hhmm}:00`);

describe("agendaWindow", () => {
  it("splits today from tomorrow", () => {
    const out = agendaWindow(
      [ev({ id: "a" }), ev({ id: "b", start: "2026-07-09T09:00", end: "2026-07-09T10:00" })],
      CALENDARS,
      at("08:00"),
    );
    expect(out.today.map((o) => o.eventId)).toEqual(["a"]);
    expect(out.tomorrow.map((o) => o.eventId)).toEqual(["b"]);
  });

  it("excludes the day after tomorrow", () => {
    // The window is half-open, which is why the expansion asks for +2 days and
    // not +3.
    const out = agendaWindow(
      [ev({ start: "2026-07-10T09:00", end: "2026-07-10T10:00" })],
      CALENDARS,
      at("08:00"),
    );
    expect(out.today).toHaveLength(0);
    expect(out.tomorrow).toHaveLength(0);
  });

  it("excludes anything already over", () => {
    const out = agendaWindow(
      [ev({ start: "2026-07-07T09:00", end: "2026-07-07T10:00" })],
      CALENDARS,
      at("08:00"),
    );
    expect(out.today).toHaveLength(0);
  });

  it("shows a multi-day event under both days", () => {
    const out = agendaWindow(
      [ev({ start: "2026-07-07T09:00", end: "2026-07-10T17:00" })],
      CALENDARS,
      at("08:00"),
    );
    expect(out.today).toHaveLength(1);
    expect(out.tomorrow).toHaveLength(1);
  });

  it("skips a hidden calendar", () => {
    const out = agendaWindow([ev({ calendar_id: "hidden" })], CALENDARS, at("08:00"));
    expect(out.today).toHaveLength(0);
  });

  it("includes an all-day event on its day", () => {
    const out = agendaWindow(
      [ev({ all_day: true, start: "2026-07-08", end: "2026-07-09" })],
      CALENDARS,
      at("08:00"),
    );
    expect(out.today).toHaveLength(1);
  });
});

describe("occurrencePast", () => {
  it("is true once a timed occurrence has ended, never for an all-day one", () => {
    const out = agendaWindow([ev()], CALENDARS, at("08:00"));
    expect(occurrencePast(out.today[0], at("09:30"))).toBe(false);
    expect(occurrencePast(out.today[0], at("11:00"))).toBe(true);

    const allDay = agendaWindow(
      [ev({ all_day: true, start: "2026-07-08", end: "2026-07-09" })],
      CALENDARS,
      at("08:00"),
    );
    expect(occurrencePast(allDay.today[0], at("23:00"))).toBe(false);
  });
});

// ── The mail rail ──────────────────────────────────────────────────────────

function header(id: string, priority: "urgent" | "important"): MailHeader {
  return {
    id,
    account_id: "acct",
    folder_id: "inbox",
    uid: 1,
    subject: id,
    from: { name: "", address: "someone@example.com" },
    to: [],
    cc: [],
    date: "2026-07-08T09:00:00Z",
    seen: false,
    flagged: false,
    answered: false,
    has_attachments: false,
    size: 10,
    preview: "",
    priority,
  } as MailHeader;
}

function card(over: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id: "t",
    calendar_id: "work",
    title: "t",
    priority: 0,
    percent: 0,
    ...over,
  };
}

describe("selectUrgentMail", () => {
  const urgent = [header("u1", "urgent"), header("u2", "urgent")];
  const important = [header("i1", "important")];

  it("puts urgent before important, in the order the backend gave", () => {
    expect(selectUrgentMail(urgent, important, []).map((h) => h.id)).toEqual([
      "u1",
      "u2",
      "i1",
    ]);
  });

  it("drops a message that already has an open card", () => {
    // What makes "make a card" feel like it did something: the row leaves the
    // rail in the same gesture.
    const tasks = [card({ mail: { message_id: "u1" } })];
    expect(selectUrgentMail(urgent, important, tasks).map((h) => h.id)).toEqual(["u2", "i1"]);
  });

  it("brings a message back once its card is done", () => {
    const tasks = [card({ percent: 100, mail: { message_id: "u1" } })];
    expect(selectUrgentMail(urgent, important, tasks).map((h) => h.id)).toContain("u1");
  });

  it("respects the limit", () => {
    expect(selectUrgentMail(urgent, important, [], 2)).toHaveLength(2);
  });

  it("handles empty inputs", () => {
    expect(selectUrgentMail([], [], [])).toEqual([]);
  });
});

// ── Converting into a card ─────────────────────────────────────────────────

/**
 * The one thing these tests are really asserting: a mail card and an appointment
 * card are the SAME card, differing only in the object they record. Two rails
 * that each built their own record is how a board ends up with cards that land
 * in different columns and remember different things about where they came from.
 */
describe("the conversions", () => {
  const CONV = { calendarId: "work", columnId: "backlog", now: at("08:30") };
  const occ = () => agendaWindow([ev({ id: "e1" })], CALENDARS, at("08:00")).today[0];

  it("files both kinds in the board's first column, open and unranked", () => {
    const fromMail = taskFromMail(header("u1", "urgent"), CONV, "(no subject)");
    const fromEvent = taskFromOccurrence(occ(), CONV, "(untitled)");
    for (const made of [fromMail, fromEvent]) {
      expect(made.column).toBe("backlog");
      expect(made.calendar_id).toBe("work");
      expect(made.percent).toBe(0);
      expect(made.rank).toBeUndefined();
      expect(made.created).toBe("2026-07-08T08:30");
      expect(made.notes).toBeTruthy();
    }
  });

  it("records where the card came from, and only one of the two", () => {
    const fromMail = taskFromMail(header("u1", "urgent"), CONV, "(no subject)");
    expect(fromMail.mail?.message_id).toBe("u1");
    expect(fromMail.mail?.priority_at_convert).toBe("urgent");
    expect(fromMail.event).toBeUndefined();

    const fromEvent = taskFromOccurrence(occ(), CONV, "(untitled)");
    expect(fromEvent.event?.event_id).toBe("e1");
    expect(fromEvent.event?.occurrence_start).toBe("2026-07-08T09:00");
    expect(fromEvent.mail).toBeUndefined();
  });

  it("carries the mail's mark into the card's priority", () => {
    expect(taskFromMail(header("u1", "urgent"), CONV, "x").priority).toBe(1);
    expect(taskFromMail(header("i1", "important"), CONV, "x").priority).toBe(5);
  });

  it("falls back to the caller's title, never to an empty one", () => {
    const blank = { ...header("u1", "urgent"), subject: "" };
    expect(taskFromMail(blank, CONV, "(no subject)").title).toBe("(no subject)");
    const untitled = { ...occ(), title: "" };
    expect(taskFromOccurrence(untitled, CONV, "(untitled)").title).toBe("(untitled)");
  });

  it("carries a timed appointment's hour onto the card's due", () => {
    const made = taskFromOccurrence(occ(), CONV, "x");
    expect(made.due).toBe("2026-07-08T09:00");
    expect(made.start).toBe("2026-07-08T09:00");
    // A mail carries no date the card should inherit.
    expect(taskFromMail(header("u1", "urgent"), CONV, "x").due).toBeNull();
  });

  it("gives an all-day appointment a whole-day (timeless) due", () => {
    const allDay = { ...occ(), allDay: true, start: "2026-07-08", end: "2026-07-08" };
    expect(taskFromOccurrence(allDay, CONV, "x").due).toBe("2026-07-08");
  });
});

describe("occurrenceCardOf", () => {
  const window_ = () =>
    agendaWindow(
      [
        ev({
          id: "e1",
          rrule: { freq: "daily", interval: 1 },
        }),
      ],
      CALENDARS,
      at("08:00"),
    );

  it("finds an open card made from this occurrence", () => {
    const today = window_().today[0];
    const tasks = [
      card({ event: { event_id: "e1", occurrence_start: today.occurrenceStart } }),
    ];
    expect(occurrenceCardOf(today, tasks)?.id).toBe("t");
  });

  it("does not report tomorrow's instance as carded", () => {
    // One card per occurrence: a weekly meeting prepared for once is not
    // prepared for every week.
    const { today, tomorrow } = window_();
    const tasks = [
      card({ event: { event_id: "e1", occurrence_start: today[0].occurrenceStart } }),
    ];
    expect(occurrenceCardOf(tomorrow[0], tasks)).toBeNull();
  });

  it("ignores a completed card", () => {
    const today = window_().today[0];
    const tasks = [
      card({
        percent: 100,
        event: { event_id: "e1", occurrence_start: today.occurrenceStart },
      }),
    ];
    expect(occurrenceCardOf(today, tasks)).toBeNull();
  });
});
