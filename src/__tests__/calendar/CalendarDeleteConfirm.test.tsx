/**
 * The sidebar's × on a calendar deletes every event and task filed under it, so
 * it asks first — and what it removed stays on hand for an "Undo" that puts the
 * calendar back under its old id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { CalendarPane } from "../../components/calendar/CalendarPane";
import { useCalendarStore } from "../../stores/calendar/calendar";
import type { Calendar, CalendarEvent } from "../../types";

const HOME: Calendar = { id: "home", name: "Home", color: "#3366cc", visible: true, readonly: false };
const WORK: Calendar = { id: "work", name: "Work", color: "#cc6633", visible: true, readonly: false };
const MEETING: CalendarEvent = {
  id: "e1",
  calendar_id: "work",
  start: "2026-09-18T09:00",
  end: "2026-09-18T10:00",
  all_day: false,
  title: "Standup",
};

const calls = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd);

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "restore_calendar") {
      return { calendars: [HOME, args.calendar], events: args.events, tasks: args.tasks };
    }
    return null;
  });
  useCalendarStore.setState({ calendars: [HOME, WORK], events: [MEETING], tasks: [], loaded: true });
});

afterEach(cleanup);

function clickDelete() {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".cal-list-del");
  // One × per calendar, in sidebar order: the second is Work's.
  fireEvent.click(buttons[1]);
}

describe("deleting a calendar from the sidebar", () => {
  it("asks first, and cancelling deletes nothing", async () => {
    render(<CalendarPane />);
    clickDelete();

    expect(await screen.findByText(/Delete the calendar “Work”\?/)).toBeTruthy();
    expect(screen.getByText(/1 events and 0 tasks/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(calls("delete_calendar")).toHaveLength(0);
    expect(useCalendarStore.getState().calendars).toHaveLength(2);
  });

  it("deletes on confirm and undo restores the calendar with its events", async () => {
    render(<CalendarPane />);
    clickDelete();
    fireEvent.click(await screen.findByRole("button", { name: "Delete calendar" }));

    await waitFor(() => expect(calls("delete_calendar")).toHaveLength(1));
    await waitFor(() => expect(useCalendarStore.getState().events).toHaveLength(0));

    fireEvent.click(await screen.findByRole("button", { name: /Undo/ }));
    await waitFor(() => expect(calls("restore_calendar")).toHaveLength(1));
    expect(calls("restore_calendar")[0][1]).toEqual({ calendar: WORK, events: [MEETING], tasks: [] });
    await waitFor(() => expect(useCalendarStore.getState().calendars.map((c) => c.id)).toEqual(["home", "work"]));
    expect(screen.queryByText(/Deleted the calendar/)).toBeNull();
  });
});
