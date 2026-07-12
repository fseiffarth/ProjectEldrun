/**
 * Recurrence expansion — turning stored events into the occurrences a view draws.
 *
 * Every view asks for a *window* (the visible month/week/day) and gets back the
 * occurrences falling inside it. A non-recurring event yields exactly one; a
 * recurring one yields as many as the window holds. Expansion is always
 * window-bounded, which is what makes an endless rule (no `until`, no `count`)
 * safe to store and cheap to draw.
 *
 * Two escape hatches let a single occurrence break from its master, matching what
 * "this event only" means in every desktop calendar:
 *   - `exdates` — occurrence starts that were deleted from the series.
 *   - `overrides` — occurrence starts whose fields were edited.
 * Both are keyed by the occurrence's *original, rule-generated* start, so an
 * override that moves the occurrence to another day still matches on the next
 * expansion.
 *
 * Pure — no React, no Tauri. Unit-tested in `src/__tests__/Recurrence.test.ts`.
 */

import type { CalendarEvent, EventStatus, Occurrence, Rrule } from "../types";
import {
  addDays,
  addMonths,
  addYears,
  datePart,
  daysInMonth,
  minutesBetween,
  addMinutes,
  normalizeSpan,
  parseStamp,
  spanCoversDate,
  weekdayOf,
} from "./calendarTime";

/**
 * Hard ceiling on occurrences generated for one event in one window. A window is
 * at most a month or two of a daily rule, so this is far above any legitimate
 * need; it exists so a corrupt rule (interval 0 handled, but e.g. a `count` of a
 * billion) can never hang the render loop.
 */
const MAX_OCCURRENCES = 2000;

/** Build the single occurrence a non-recurring event represents. */
function baseOccurrence(event: CalendarEvent, occurrenceStart: string, start: string, end: string): Occurrence {
  return {
    eventId: event.id,
    occurrenceStart,
    start,
    end,
    allDay: event.all_day,
    title: event.title,
    location: event.location ?? "",
    notes: event.notes ?? "",
    category: event.category ?? "",
    status: (event.status ?? "") as EventStatus | "",
    calendarId: event.calendar_id,
    recurring: !!event.rrule,
    alarms: event.alarms ?? [],
  };
}

/**
 * Step a start stamp to the next candidate under `rule`.
 *
 * Weekly rules with `byweekday` are handled by the caller (which walks day by day
 * within a week); this advances the *period*.
 */
function stepPeriod(stamp: string, rule: Rrule): string {
  const interval = Math.max(1, rule.interval || 1);
  switch (rule.freq) {
    case "daily":
      return addDays(stamp, interval);
    case "weekly":
      return addDays(stamp, 7 * interval);
    case "monthly":
      return addMonths(stamp, interval);
    case "yearly":
      return addYears(stamp, interval);
    default:
      return addDays(stamp, interval);
  }
}

/**
 * The rule-generated starts of `event`, from its own start until either the rule
 * ends or the generated start passes `windowEnd`.
 *
 * Generation runs forward from the master's start rather than jumping straight to
 * the window — `count`-limited rules and `bymonthday` clamping both depend on the
 * ordinal position, so occurrence N cannot be computed without walking there.
 * Windows are small and rules are cheap, so the cost is irrelevant in practice.
 */
function generateStarts(event: CalendarEvent, windowEnd: string): string[] {
  const rule = event.rrule;
  const first = event.start;
  if (!rule || !parseStamp(first)) return parseStamp(first) ? [first] : [];

  const interval = Math.max(1, rule.interval || 1);
  const until = rule.until ? datePart(rule.until) : null;
  const count = rule.count && rule.count > 0 ? rule.count : null;

  const starts: string[] = [];
  const stop = (candidate: string) => {
    if (until && datePart(candidate) > until) return true;
    if (datePart(candidate) > datePart(windowEnd)) return true;
    if (count !== null && starts.length >= count) return true;
    return starts.length >= MAX_OCCURRENCES;
  };

  // Weekly + byweekday: each period is a week, and within it the rule fires on
  // each selected weekday. Anchor to the week the master starts in.
  if (rule.freq === "weekly" && rule.byweekday && rule.byweekday.length > 0) {
    const days = [...new Set(rule.byweekday)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
    if (days.length === 0) return [first];

    const time = event.all_day ? "" : (first.split("T")[1] ?? "");
    const firstDow = weekdayOf(first);
    // Sunday-anchored start of the master's week; weekday d in week k is
    // weekStart + 7k + d, which reproduces the master itself when d === firstDow.
    let weekStart = addDays(datePart(first), -firstDow);

    for (;;) {
      for (const d of days) {
        const date = addDays(weekStart, d);
        // Never emit before the master's own start.
        if (date < datePart(first)) continue;
        const candidate = time ? `${date}T${time}` : date;
        if (stop(candidate)) return starts;
        starts.push(candidate);
      }
      weekStart = addDays(weekStart, 7 * interval);
      if (datePart(weekStart) > datePart(windowEnd)) return starts;
      if (until && datePart(weekStart) > until) return starts;
      if (count !== null && starts.length >= count) return starts;
      if (starts.length >= MAX_OCCURRENCES) return starts;
    }
  }

  // Monthly + bymonthday: pin the day of month, skipping months too short to hold
  // it (Jan 31 monthly does NOT fire in February — the iCalendar behaviour, and
  // the one users expect: a "31st of the month" event simply has no February).
  if (rule.freq === "monthly" && rule.bymonthday) {
    const day = rule.bymonthday;
    const time = event.all_day ? "" : (first.split("T")[1] ?? "");
    const c = parseStamp(first);
    if (!c) return [];
    let year = c.year;
    let month = c.month;

    for (;;) {
      if (day <= daysInMonth(year, month)) {
        const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        if (date >= datePart(first)) {
          const candidate = time ? `${date}T${time}` : date;
          if (stop(candidate)) return starts;
          starts.push(candidate);
        }
      }
      month += interval;
      while (month > 12) {
        month -= 12;
        year += 1;
      }
      const probe = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
      if (probe > datePart(windowEnd)) return starts;
      if (until && probe > until) return starts;
      if (count !== null && starts.length >= count) return starts;
      if (starts.length >= MAX_OCCURRENCES) return starts;
    }
  }

  // Plain daily / weekly / monthly / yearly: step the period from the master.
  let cur = first;
  for (;;) {
    if (stop(cur)) return starts;
    starts.push(cur);
    cur = stepPeriod(cur, rule);
  }
}

/**
 * Expand `event` into the occurrences overlapping `[windowStart, windowEnd)`.
 *
 * The window is compared by *date*, and an occurrence is kept if any part of it
 * falls inside — so a multi-day event that began before the window still shows on
 * the days it covers. Deleted occurrences (`exdates`) are dropped and edited ones
 * (`overrides`) have their fields applied, both keyed by the rule-generated start.
 */
export function expandEvent(
  event: CalendarEvent,
  windowStart: string,
  windowEnd: string,
): Occurrence[] {
  if (!parseStamp(event.start)) return [];

  const exdates = new Set(event.exdates ?? []);
  const overrides = new Map((event.overrides ?? []).map((o) => [o.occurrence_start, o]));

  // A recurring event's occurrences never start before the master, but a
  // long-running one may still cover the window's first days, so generation runs
  // to windowEnd and the window filter below decides what is visible.
  const starts = generateStarts(event, windowEnd);

  // Duration is taken from the master and carried to every occurrence, so moving
  // the master's end lengthens the whole series (what an unqualified edit means).
  const master = normalizeSpan({ start: event.start, end: event.end, allDay: event.all_day });
  const durationMin = event.all_day ? 0 : minutesBetween(master.start, master.end);
  const durationDays = event.all_day
    ? Math.max(1, Math.round(
        (new Date(datePart(master.end)).getTime() - new Date(datePart(master.start)).getTime()) / 86_400_000,
      ))
    : 0;

  const out: Occurrence[] = [];

  for (const occurrenceStart of starts) {
    if (exdates.has(occurrenceStart)) continue;

    let start = occurrenceStart;
    let end = event.all_day
      ? addDays(datePart(occurrenceStart), durationDays)
      : addMinutes(occurrenceStart, durationMin);

    const occ = baseOccurrence(event, occurrenceStart, start, end);

    const ov = overrides.get(occurrenceStart);
    if (ov) {
      if (ov.start) {
        start = ov.start;
        // An override that moves the start but not the end keeps the duration.
        end = event.all_day
          ? addDays(datePart(start), durationDays)
          : addMinutes(start, durationMin);
        occ.start = start;
        occ.end = end;
      }
      if (ov.end) occ.end = ov.end;
      if (ov.title != null) occ.title = ov.title;
      if (ov.location != null) occ.location = ov.location;
      if (ov.notes != null) occ.notes = ov.notes;
    }

    // Keep it only if it actually shows in the window. `spanCoversDate` is the
    // same predicate the views use, so what survives here is exactly what draws.
    const span = { start: occ.start, end: occ.end, allDay: occ.allDay };
    let visible = false;
    for (let d = datePart(windowStart); d < datePart(windowEnd); d = addDays(d, 1)) {
      if (spanCoversDate(span, d)) {
        visible = true;
        break;
      }
    }
    if (visible) out.push(occ);
  }

  return out;
}

/**
 * Expand every event into the occurrences visible in `[windowStart, windowEnd)`,
 * sorted for display: all-day events first (they render as bars above the grid),
 * then by start.
 *
 * `visibleCalendars` — when given — drops occurrences whose calendar is unchecked
 * in the sidebar.
 */
export function expandEvents(
  events: CalendarEvent[],
  windowStart: string,
  windowEnd: string,
  visibleCalendars?: Set<string>,
): Occurrence[] {
  const out: Occurrence[] = [];
  for (const event of events) {
    if (visibleCalendars && !visibleCalendars.has(event.calendar_id)) continue;
    out.push(...expandEvent(event, windowStart, windowEnd));
  }
  return sortOccurrences(out);
}

/** All-day first, then chronological, then by title so the order is stable. */
export function sortOccurrences(occurrences: Occurrence[]): Occurrence[] {
  return [...occurrences].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

/** The occurrences of a given day, in display order. */
export function occurrencesOn(occurrences: Occurrence[], date: string): Occurrence[] {
  return occurrences.filter((o) =>
    spanCoversDate({ start: o.start, end: o.end, allDay: o.allDay }, date),
  );
}

// ── Editing a series ────────────────────────────────────────────────────────

/**
 * Delete one occurrence of a series ("this event only") by excluding its
 * rule-generated start. Returns the updated master.
 */
export function excludeOccurrence(event: CalendarEvent, occurrenceStart: string): CalendarEvent {
  const exdates = new Set(event.exdates ?? []);
  exdates.add(occurrenceStart);
  return {
    ...event,
    exdates: [...exdates].sort(),
    // An override for a now-deleted occurrence is dead weight.
    overrides: (event.overrides ?? []).filter((o) => o.occurrence_start !== occurrenceStart),
  };
}

/**
 * Edit one occurrence of a series ("this event only"), leaving the rest alone.
 * `changes` are the fields that differ from the master. Returns the updated master.
 */
export function overrideOccurrence(
  event: CalendarEvent,
  occurrenceStart: string,
  changes: Partial<Pick<Occurrence, "start" | "end" | "title" | "location" | "notes">>,
): CalendarEvent {
  const rest = (event.overrides ?? []).filter((o) => o.occurrence_start !== occurrenceStart);
  const existing = (event.overrides ?? []).find((o) => o.occurrence_start === occurrenceStart);
  return {
    ...event,
    overrides: [
      ...rest,
      {
        ...existing,
        occurrence_start: occurrenceStart,
        ...changes,
      },
    ].sort((a, b) => a.occurrence_start.localeCompare(b.occurrence_start)),
  };
}

/** Whether an event actually repeats. */
export function isRecurring(event: CalendarEvent): boolean {
  return !!event.rrule;
}

/** A short human summary of a rule, for the event list and the editor. */
export function describeRrule(rule: Rrule | null | undefined): string {
  if (!rule) return "Does not repeat";
  const n = Math.max(1, rule.interval || 1);
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  let base: string;
  switch (rule.freq) {
    case "daily":
      base = n === 1 ? "Daily" : `Every ${n} days`;
      break;
    case "weekly": {
      const days = (rule.byweekday ?? []).filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
      const on = days.length ? ` on ${days.map((d) => WEEKDAYS[d]).join(", ")}` : "";
      base = (n === 1 ? "Weekly" : `Every ${n} weeks`) + on;
      break;
    }
    case "monthly":
      base = (n === 1 ? "Monthly" : `Every ${n} months`) +
        (rule.bymonthday ? ` on day ${rule.bymonthday}` : "");
      break;
    case "yearly":
      base = n === 1 ? "Yearly" : `Every ${n} years`;
      break;
    default:
      base = "Repeats";
  }

  if (rule.count) return `${base}, ${rule.count} times`;
  if (rule.until) return `${base}, until ${rule.until}`;
  return base;
}
