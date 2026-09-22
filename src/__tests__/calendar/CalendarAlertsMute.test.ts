import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Calendar, CalendarEvent } from "../../types";

const sendNotification = vi.fn();
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  sendNotification: (...args: unknown[]) => sendNotification(...args),
}));

import { mutedCalendarIds } from "../../lib/calendar/alarms";
import { useAlarmStore } from "../../stores/calendar/alarms";
import { useCalendarStore } from "../../stores/calendar/calendar";

const cal = (id: string, over: Partial<Calendar> = {}): Calendar => ({
  id,
  name: id,
  color: "#4aa3df",
  visible: true,
  readonly: false,
  ...over,
});

const event = (id: string, calendarId: string): CalendarEvent => ({
  id,
  calendar_id: calendarId,
  start: "2026-07-08T09:00",
  end: "2026-07-08T10:00",
  all_day: false,
  title: id,
  alarms: [{ minutes_before: 15 }],
});

/** 08:50 — both fixtures' 15-minute reminders came due five minutes ago. */
const NOW = new Date(2026, 6, 8, 8, 50);

function seed(calendars: Calendar[]) {
  useCalendarStore.setState({
    loaded: true,
    calendars,
    events: [event("work-standup", "work"), event("home-dentist", "home")],
  });
}

beforeEach(() => {
  localStorage.clear();
  sendNotification.mockClear();
  useAlarmStore.setState({ active: [], snoozed: [], fired: new Set() });
});

describe("per-calendar alerts switch", () => {
  it("reads absent as on", () => {
    expect(mutedCalendarIds([cal("a"), cal("b", { alerts_off: false })]).size).toBe(0);
    expect([...mutedCalendarIds([cal("a"), cal("b", { alerts_off: true })])]).toEqual(["b"]);
  });

  it("shows and notifies only the calendars left on", async () => {
    seed([cal("work", { alerts_off: true }), cal("home")]);
    await useAlarmStore.getState().tick(NOW);
    await Promise.resolve();

    expect(useAlarmStore.getState().active.map((a) => a.eventId)).toEqual(["home-dentist"]);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("still reminds for a hidden calendar — hiding is not muting", async () => {
    seed([cal("work", { visible: false }), cal("home", { alerts_off: true })]);
    await useAlarmStore.getState().tick(NOW);

    expect(useAlarmStore.getState().active.map((a) => a.eventId)).toEqual(["work-standup"]);
  });

  it("does not replay a muted reminder when alerts come back on", async () => {
    seed([cal("work", { alerts_off: true }), cal("home", { alerts_off: true })]);
    await useAlarmStore.getState().tick(NOW);
    expect(useAlarmStore.getState().active).toHaveLength(0);

    seed([cal("work"), cal("home")]);
    await useAlarmStore.getState().tick(new Date(2026, 6, 8, 8, 51));
    expect(useAlarmStore.getState().active).toHaveLength(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("takes down a showing and a snoozed reminder once their calendar is muted", async () => {
    seed([cal("work"), cal("home")]);
    await useAlarmStore.getState().tick(NOW);
    const [first] = useAlarmStore.getState().active.filter((a) => a.calendarId === "home");
    useAlarmStore.getState().snooze(first.key, 1);

    seed([cal("work", { alerts_off: true }), cal("home", { alerts_off: true })]);
    await useAlarmStore.getState().tick(new Date(2026, 6, 8, 8, 52));

    expect(useAlarmStore.getState().active).toHaveLength(0);
    expect(useAlarmStore.getState().snoozed).toHaveLength(0);
  });
});
