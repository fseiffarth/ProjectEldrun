/**
 * The event editor's "Repeats on" choice for monthly/yearly rules, and a save
 * that leaves the rule alone keeping it — imported RRULE text included
 * (todo/group-x-caldav.md #2318).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { EventDialog } from "../components/calendar/EventDialog";
import { parseRrule } from "../lib/calendar/ics";
import type { Calendar, CalendarEvent, Rrule } from "../types";

afterEach(cleanup);

const calendars: Calendar[] = [{ id: "c1", name: "Work", color: "#36c", visible: true, readonly: false }];

function open(start: string, rrule: Rrule) {
  const event: CalendarEvent = {
    id: "e1", calendar_id: "c1", start, end: `${start.slice(0, 11)}11:00`, all_day: false, title: "Sync", rrule,
  };
  const onSave = vi.fn();
  render(
    <EventDialog
      target={{ event, occurrence: null }}
      calendars={calendars}
      defaultCalendarId="c1"
      defaultReminderMinutes={0}
      onClose={vi.fn()}
      onSave={onSave}
      onDelete={vi.fn()}
    />,
  );
  const select = screen.getByDisplayValue(/on the|on day/) as HTMLSelectElement;
  const save = () => {
    fireEvent.click(screen.getByText("Save"));
    return onSave.mock.calls[0][0] as CalendarEvent;
  };
  return { event, select, save };
}

const labels = (select: HTMLSelectElement) => [...select.options].map((o) => o.text);

describe("EventDialog repeats-on", () => {
  it("offers the day or the numbered weekday, and keeps an untouched rule as it was", () => {
    const { event, select, save } = open("2026-09-08T10:00", { freq: "monthly", interval: 1, bynthweekday: [{ n: 2, day: 2 }] });
    expect(labels(select)).toEqual(["on day 8", "on the 2nd Tuesday"]);
    expect(select.value).toBe("nth");
    expect(save().rrule).toBe(event.rrule);
  });

  it("switches a numbered weekday back to the day of month", () => {
    const { select, save } = open("2026-09-08T10:00", { freq: "monthly", interval: 1, bynthweekday: [{ n: 2, day: 2 }] });
    fireEvent.change(select, { target: { value: "day" } });
    const rule = save().rrule!;
    expect(rule.bynthweekday).toBeUndefined();
    expect(rule.bymonthday).toBeNull();
  });

  it("offers 'last' in the month's last week instead of a 5th", () => {
    const { select, save } = open("2026-09-29T10:00", { freq: "monthly", interval: 1 });
    expect(labels(select)).toEqual(["on day 29", "on the last Tuesday"]);
    fireEvent.change(select, { target: { value: "last" } });
    expect(save().rrule!.bynthweekday).toEqual([{ n: -1, day: 2 }]);
  });

  it("keeps an imported rule it cannot draw, text and all", () => {
    const imported = parseRrule("FREQ=MONTHLY;BYDAY=1MO,3MO;BYHOUR=10")!;
    const { event, save } = open("2026-09-07T10:00", imported);
    const saved = save().rrule!;
    expect(saved).toBe(event.rrule);
    expect(saved.ics_value).toBe("FREQ=MONTHLY;BYDAY=1MO,3MO;BYHOUR=10");
  });
});
