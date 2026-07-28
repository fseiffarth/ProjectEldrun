import { describe, expect, it } from "vitest";

import { daysLate, todosDueCount, todosOverdue, urgentTodos } from "../lib/todoBoard";
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

/**
 * The badge's explanation — the header's hover list.
 *
 * Every case here is really one question: can a row appear that the badge did
 * not count, or a counted card fail to appear? The two are read against each
 * other on the same button, so a disagreement between them is the whole bug.
 */
describe("urgentTodos", () => {
  it("splits overdue, today and tomorrow", () => {
    const out = urgentTodos(
      [
        task({ id: "late", due: "2026-07-01" }),
        task({ id: "now", due: "2026-07-08" }),
        task({ id: "next", due: "2026-07-09" }),
      ],
      CALENDARS,
      at("09:00"),
    );
    expect(out.overdue.map((t) => t.id)).toEqual(["late"]);
    expect(out.today.map((t) => t.id)).toEqual(["now"]);
    expect(out.tomorrow.map((t) => t.id)).toEqual(["next"]);
  });

  it("shows nothing the badge would not have counted", () => {
    // Same three filters as `todosDueCount`: open, visible, dated. A row for a
    // card the number ignores is how the two surfaces start disagreeing.
    const out = urgentTodos(
      [
        task({ id: "done", due: "2026-07-08", percent: 100 }),
        task({ id: "hidden", calendar_id: "hidden", due: "2026-07-08" }),
        task({ id: "someday" }),
      ],
      CALENDARS,
      at("09:00"),
    );
    expect(out.overdue).toEqual([]);
    expect(out.today).toEqual([]);
    expect(out.tomorrow).toEqual([]);
  });

  it("orders a section by date, then priority, then title", () => {
    const out = urgentTodos(
      [
        task({ id: "b", title: "b", due: "2026-07-08", priority: 5 }),
        task({ id: "a", title: "a", due: "2026-07-08", priority: 5 }),
        task({ id: "high", title: "z", due: "2026-07-08", priority: 1 }),
        // Priority 0 is *unset*, so it sorts after an explicit low — not ahead
        // of a high, which a plain numeric compare would do.
        task({ id: "unset", title: "a", due: "2026-07-08", priority: 0 }),
        task({ id: "low", title: "a", due: "2026-07-08", priority: 9 }),
      ],
      CALENDARS,
      at("09:00"),
    );
    expect(out.today.map((t) => t.id)).toEqual(["high", "a", "b", "low", "unset"]);
  });

  it("orders overdue oldest first", () => {
    const out = urgentTodos(
      [task({ id: "y", due: "2026-07-07" }), task({ id: "old", due: "2026-06-20" })],
      CALENDARS,
      at("09:00"),
    );
    expect(out.overdue.map((t) => t.id)).toEqual(["old", "y"]);
  });
});

describe("daysLate", () => {
  it("counts whole days, and never negatively", () => {
    expect(daysLate(task({ due: "2026-07-05" }), at("09:00"))).toBe(3);
    expect(daysLate(task({ due: "2026-07-08" }), at("09:00"))).toBe(0);
    expect(daysLate(task({ due: "2026-07-20" }), at("09:00"))).toBe(0);
    expect(daysLate(task(), at("09:00"))).toBe(0);
  });
});
