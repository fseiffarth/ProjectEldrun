import { create } from "zustand";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { DueAlarm, Snoozed } from "../lib/alarms";
import {
  alarmWindow,
  describeLead,
  dueAlarms,
  snooze as makeSnooze,
  wokenSnoozes,
} from "../lib/alarms";
import { expandEvents } from "../lib/recurrence";
import { formatStampTime } from "../lib/calendarTime";
import { useCalendarStore } from "./calendar";

/** How often the ticker looks for due reminders. */
const TICK_MS = 30_000;

/**
 * Where the "already fired" set is persisted.
 *
 * localStorage, not the calendar file: this is per-machine UI state, not calendar
 * data. Writing it into `calendar.json` would mean an exported .ics carried
 * "this user already dismissed this" — which is nobody else's business, and would
 * churn the file on every reminder.
 */
const FIRED_KEY = "eldrun.calendar.firedAlarms";

/** Cap on remembered keys, so the list cannot grow without bound. */
const MAX_FIRED = 500;

function loadFired(): Set<string> {
  try {
    const raw = localStorage.getItem(FIRED_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

function saveFired(fired: Set<string>) {
  try {
    // Keep the most recent; the oldest reminders will never come due again.
    const list = [...fired].slice(-MAX_FIRED);
    localStorage.setItem(FIRED_KEY, JSON.stringify(list));
  } catch {
    // A full/blocked localStorage must not take the reminder loop down; the cost
    // is only that an alarm may re-fire after a restart.
  }
}

interface AlarmStore {
  /** Reminders showing in the in-app popup right now. */
  active: DueAlarm[];
  /** Snoozed reminders, waiting to come back. */
  snoozed: Snoozed[];
  /** Keys of every reminder already shown — the fire-once guard. */
  fired: Set<string>;
  started: boolean;

  /** Begin the ticker. Idempotent. */
  start: () => void;
  stop: () => void;
  /** One scan. Exposed for tests and for an immediate check after an edit. */
  tick: (now?: Date) => Promise<void>;

  dismiss: (key: string) => void;
  dismissAll: () => void;
  snooze: (key: string, minutes: number) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Whether the OS has granted notification permission (asked once, lazily). */
let osPermission: boolean | null = null;

async function notifyOs(alarm: DueAlarm) {
  try {
    if (osPermission === null) {
      osPermission = await isPermissionGranted();
      if (!osPermission) osPermission = (await requestPermission()) === "granted";
    }
    if (!osPermission) return;

    const when = alarm.allDay
      ? "Today"
      : formatStampTime(alarm.start, true) || describeLead(alarm.minutesBefore);
    sendNotification({
      title: alarm.title || "Event",
      body: [when, alarm.location].filter(Boolean).join(" · "),
    });
  } catch {
    // No OS notification (permission denied, no daemon, headless CI). The in-app
    // popup still shows, so the reminder is not lost — this channel is additive.
  }
}

/**
 * The reminder engine.
 *
 * A single ticker scans the calendar for reminders that have come due and shows
 * each one **twice over**: an OS notification (which reaches the user when Eldrun
 * is not focused, or not even visible) and an in-app popup (which offers snooze
 * and dismiss). Both channels are driven from one fire-once record, so a reminder
 * cannot double-show or re-show after a restart.
 */
export const useAlarmStore = create<AlarmStore>((set, get) => ({
  active: [],
  snoozed: [],
  fired: loadFired(),
  started: false,

  start: () => {
    if (get().started) return;
    set({ started: true });
    void get().tick();
    timer = setInterval(() => void get().tick(), TICK_MS);
  },

  stop: () => {
    if (timer) clearInterval(timer);
    timer = null;
    set({ started: false });
  },

  tick: async (now = new Date()) => {
    const { events, loaded } = useCalendarStore.getState();
    if (!loaded) return;

    const { active, snoozed, fired } = get();

    // Snoozed reminders that have come back around.
    const woken = wokenSnoozes(snoozed, now);
    const stillSnoozed = snoozed.filter((s) => !woken.some((w) => w.key === s.key));

    // Expand only far enough to see every reminder that could be due.
    const window = alarmWindow(events, now);
    const occurrences = expandEvents(events, window.start, window.end);
    const due = dueAlarms(occurrences, fired, now);

    if (due.length === 0 && woken.length === 0) {
      if (stillSnoozed.length !== snoozed.length) set({ snoozed: stillSnoozed });
      return;
    }

    // Fresh reminders get both channels; a woken snooze is already known to the
    // user, so it only comes back to the popup.
    for (const alarm of due) void notifyOs(alarm);

    const nextFired = new Set(fired);
    for (const alarm of due) nextFired.add(alarm.key);
    saveFired(nextFired);

    const showing = [...active];
    for (const alarm of [...due, ...woken.map((w) => w.alarm)]) {
      if (!showing.some((a) => a.key === alarm.key)) showing.push(alarm);
    }

    set({ active: showing, snoozed: stillSnoozed, fired: nextFired });
  },

  dismiss: (key) => set((s) => ({ active: s.active.filter((a) => a.key !== key) })),

  dismissAll: () => set({ active: [] }),

  snooze: (key, minutes) =>
    set((s) => {
      const alarm = s.active.find((a) => a.key === key);
      if (!alarm) return s;
      return {
        active: s.active.filter((a) => a.key !== key),
        snoozed: [...s.snoozed.filter((x) => x.key !== key), makeSnooze(alarm, minutes)],
      };
    }),
}));
