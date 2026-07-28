import { describe, expect, it } from "vitest";

import { todosDueCount, todosOverdue } from "../lib/todoBoard";
import type { Calendar, CalendarTask } from "../types";

/**
 * The header ☑ button's badge.
 *
 * Like the calendar's, the number is *derived* — nothing marks a card "seen" —
 * so every case here is the same question at a different moment: given these
 * cards and this day, what does today actually demand?
 */

const CALENDARS: Calendar[] = [
  { id: "work", name: "Work", color: "#f00", visible: true, readonly: false },
  { id: "hidden", name: "Hidden", color: "#0f0", visible: false, readonly: false },
];

function task(over: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id: "t",
    calendar_id: "work",
    title: "t",
    priority: 0,
    percent: 0,
    ...over,
  };
}

/** 2026-07-08 is a Wednesday; the store's stamps are local civil time. */
const at = (hhmm: string) => new Date(`2026-07-08T${hhmm}:00`);

describe("todosDueCount", () => {
  it("counts a card due today", () => {
    expect(todosDueCount([task({ due: "2026-07-08" })], CALENDARS, at("09:00"))).toBe(1);
  });

  it("counts an overdue card", () => {
    expect(todosDueCount([task({ due: "2026-07-01" })], CALENDARS, at("09:00"))).toBe(1);
  });

  it("does not count one due tomorrow", () => {
    expect(todosDueCount([task({ due: "2026-07-09" })], CALENDARS, at("09:00"))).toBe(0);
  });

  it("does not count an undated card", () => {
    // A someday is not something today demands — and counting them would pin the
    // badge at a number that never falls, which is how a badge gets ignored.
    expect(todosDueCount([task()], CALENDARS, at("09:00"))).toBe(0);
  });

  it("does not count a completed card", () => {
    expect(
      todosDueCount([task({ due: "2026-07-08", percent: 100 })], CALENDARS, at("09:00")),
    ).toBe(0);
  });

  it("ignores cards on a hidden calendar", () => {
    // A badge counting what no view shows sends the user hunting for cards they
    // cannot find.
    expect(
      todosDueCount(
        [task({ calendar_id: "hidden", due: "2026-07-08" })],
        CALENDARS,
        at("09:00"),
      ),
    ).toBe(0);
  });

  it("falls to zero as the day's cards are ticked", () => {
    const tasks = [task({ id: "a", due: "2026-07-08" }), task({ id: "b", due: "2026-07-08" })];
    expect(todosDueCount(tasks, CALENDARS, at("09:00"))).toBe(2);
    tasks[0].percent = 100;
    expect(todosDueCount(tasks, CALENDARS, at("09:00"))).toBe(1);
  });

  it("rolls over at midnight without the cards changing", () => {
    // The clock half of the badge — which is why the indicator ticks once a
    // minute rather than only re-rendering on a store change.
    const tasks = [task({ due: "2026-07-09" })];
    expect(todosDueCount(tasks, CALENDARS, at("23:59"))).toBe(0);
    expect(todosDueCount(tasks, CALENDARS, new Date("2026-07-09T00:01:00"))).toBe(1);
  });
});

describe("todosOverdue", () => {
  it("is true only for a genuinely late card", () => {
    expect(todosOverdue([task({ due: "2026-07-08" })], CALENDARS, at("09:00"))).toBe(false);
    expect(todosOverdue([task({ due: "2026-07-07" })], CALENDARS, at("09:00"))).toBe(true);
  });

  it("ignores completed and hidden cards", () => {
    expect(
      todosOverdue([task({ due: "2026-07-01", percent: 100 })], CALENDARS, at("09:00")),
    ).toBe(false);
    expect(
      todosOverdue(
        [task({ calendar_id: "hidden", due: "2026-07-01" })],
        CALENDARS,
        at("09:00"),
      ),
    ).toBe(false);
  });
});
