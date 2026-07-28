import { describe, expect, it } from "vitest";

import { agendaWindow, occurrencePast, selectUrgentMail } from "../lib/todoBoard";
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
