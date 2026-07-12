/**
 * iCalendar (RFC 5545) import/export — the subset Eldrun's model actually holds.
 *
 * Parsing lives here, in tested TypeScript, rather than in Rust: the backend
 * stays a dumb store, and the format's real complexity (line folding, escaping,
 * the DTSTART/DTEND value-type dance) is all string work that is far cheaper to
 * unit-test on this side.
 *
 * **Times are read and written as local wall-clock**, matching the rest of the
 * calendar. A `Z`-suffixed (UTC) timestamp in an imported file is converted to
 * local time on the way in; everything is written back as floating local time.
 * `VTIMEZONE` blocks are ignored — a `TZID` we do not understand would otherwise
 * silently shift an event, and dropping to floating local is the honest failure.
 *
 * Supported: VEVENT, VTODO, VALARM (display, minute-offset triggers), RRULE
 * (FREQ/INTERVAL/BYDAY/BYMONTHDAY/UNTIL/COUNT), EXDATE, CATEGORIES, LOCATION,
 * DESCRIPTION, SUMMARY, STATUS, PRIORITY, PERCENT-COMPLETE, COMPLETED.
 */

import type {
  Alarm,
  CalendarEvent,
  CalendarTask,
  EventStatus,
  Freq,
  Rrule,
} from "../types";
import { addDays, datePart, parseStamp } from "./calendarTime";

const ICS_WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// ── Line handling ───────────────────────────────────────────────────────────

/**
 * Unfold the content lines. RFC 5545 wraps long lines by inserting CRLF followed
 * by a single space or tab, which must be stitched back before anything is parsed.
 */
export function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out.filter((l) => l.trim() !== "");
}

/** Fold a content line at 75 octets, per RFC 5545. */
export function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    parts.push(" " + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  if (rest) parts.push(" " + rest);
  return parts.join("\r\n");
}

/** Escape a TEXT value: backslash, semicolon, comma and newline are special. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Reverse `escapeText`. */
export function unescapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\" && i + 1 < value.length) {
      const next = value[++i];
      if (next === "n" || next === "N") out += "\n";
      else out += next; // \\ \; \, and anything else → the literal char
    } else {
      out += value[i];
    }
  }
  return out;
}

/** One parsed content line: `NAME;PARAM=X:VALUE`. */
interface Line {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Split a content line, honouring quoted parameter values (which may hold `:`). */
export function parseLine(line: string): Line | null {
  let colon = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = head.split(";");
  const name = segments[0].toUpperCase();

  const params: Record<string, string> = {};
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

// ── Date/time values ────────────────────────────────────────────────────────

/**
 * An ICS DATE or DATE-TIME → a local stamp.
 *
 * `20260708`         → `"2026-07-08"`      (a date; all-day)
 * `20260708T090000`  → `"2026-07-08T09:00"` (floating local)
 * `20260708T070000Z` → converted from UTC into local time
 */
export function parseIcsDate(value: string): { stamp: string; dateOnly: boolean } | null {
  const v = value.trim();

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return { stamp: `${y}-${m}-${d}`, dateOnly: true };
  }

  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!dt) return null;
  const [, y, mo, d, h, mi, , z] = dt;

  if (z) {
    // UTC → local. This is the one place an epoch conversion is correct: the
    // source really is an absolute instant.
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
    const local = new Date(utc);
    const p = (n: number) => String(n).padStart(2, "0");
    return {
      stamp: `${local.getFullYear()}-${p(local.getMonth() + 1)}-${p(local.getDate())}T${p(local.getHours())}:${p(local.getMinutes())}`,
      dateOnly: false,
    };
  }

  return { stamp: `${y}-${mo}-${d}T${h}:${mi}`, dateOnly: false };
}

/** A local stamp → an ICS DATE (all-day) or floating DATE-TIME. */
export function formatIcsDate(stamp: string, allDay: boolean): string {
  const c = parseStamp(stamp);
  if (!c) return stamp;
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${String(c.year).padStart(4, "0")}${p(c.month)}${p(c.day)}`;
  if (allDay) return date;
  return `${date}T${p(c.hour)}${p(c.minute)}00`;
}

/** A UTC stamp for DTSTAMP, which must be absolute. */
function icsNowUtc(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`
  );
}

// ── RRULE ───────────────────────────────────────────────────────────────────

/** `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=10` → an `Rrule`. */
export function parseRrule(value: string): Rrule | null {
  const parts: Record<string, string> = {};
  for (const chunk of value.split(";")) {
    const eq = chunk.indexOf("=");
    if (eq > 0) parts[chunk.slice(0, eq).toUpperCase()] = chunk.slice(eq + 1);
  }

  const freqRaw = (parts.FREQ ?? "").toUpperCase();
  const freq = (
    { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" } as const
  )[freqRaw as "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"];
  // An unsupported FREQ (SECONDLY/MINUTELY/HOURLY) is dropped rather than guessed
  // at — the event still imports, just without its rule.
  if (!freq) return null;

  const rule: Rrule = { freq: freq as Freq, interval: Number(parts.INTERVAL) || 1 };

  if (parts.BYDAY) {
    const days = parts.BYDAY.split(",")
      // Strip any ordinal prefix ("2MO" = the 2nd Monday); the ordinal itself is
      // beyond what the model holds, so it degrades to a plain weekday.
      .map((d) => ICS_WEEKDAYS.indexOf(d.trim().toUpperCase().replace(/^[+-]?\d+/, "")))
      .filter((i) => i >= 0);
    if (days.length) rule.byweekday = days;
  }

  if (parts.BYMONTHDAY) {
    const day = Number(parts.BYMONTHDAY.split(",")[0]);
    if (day >= 1 && day <= 31) rule.bymonthday = day;
  }

  if (parts.COUNT) {
    const n = Number(parts.COUNT);
    if (n > 0) rule.count = n;
  }

  if (parts.UNTIL) {
    const until = parseIcsDate(parts.UNTIL);
    if (until) rule.until = datePart(until.stamp);
  }

  return rule;
}

/** An `Rrule` → an RRULE value. */
export function formatRrule(rule: Rrule): string {
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if (rule.interval && rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byweekday?.length) {
    parts.push(`BYDAY=${rule.byweekday.map((d) => ICS_WEEKDAYS[d]).join(",")}`);
  }
  if (rule.bymonthday) parts.push(`BYMONTHDAY=${rule.bymonthday}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${formatIcsDate(rule.until, true)}`);
  return parts.join(";");
}

// ── Alarms ──────────────────────────────────────────────────────────────────

/**
 * A VALARM TRIGGER duration → minutes *before* the start.
 *
 * `-PT15M` → 15, `-PT1H` → 60, `-P1D` → 1440, `PT0S` → 0. A positive trigger
 * (after the start) comes back negative, which is exactly how `Alarm` stores it.
 */
export function parseTrigger(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, sign, d, h, min, s] = m;
  const total =
    (Number(d) || 0) * 1440 +
    (Number(h) || 0) * 60 +
    (Number(min) || 0) +
    Math.round((Number(s) || 0) / 60);
  // A negative duration fires BEFORE the start → a positive minutes_before.
  const minutes = sign === "-" ? total : -total;
  // Negating zero yields -0, which is === 0 but not Object.is-equal to it and
  // would serialize as "-0". Normalize it away.
  return minutes === 0 ? 0 : minutes;
}

/** Minutes-before → a TRIGGER duration. */
export function formatTrigger(minutesBefore: number): string {
  const sign = minutesBefore >= 0 ? "-" : "";
  const abs = Math.abs(minutesBefore);
  if (abs === 0) return "PT0S";
  const days = Math.floor(abs / 1440);
  const hours = Math.floor((abs % 1440) / 60);
  const mins = abs % 60;
  let out = sign + "P";
  if (days) out += `${days}D`;
  if (hours || mins) {
    out += "T";
    if (hours) out += `${hours}H`;
    if (mins) out += `${mins}M`;
  }
  return out;
}

// ── Parse ───────────────────────────────────────────────────────────────────

export interface ParsedIcs {
  events: Omit<CalendarEvent, "id" | "calendar_id">[];
  tasks: Omit<CalendarTask, "id" | "calendar_id">[];
  /** Components that could not be understood, for a "skipped N" report. */
  skipped: number;
}

const STATUSES: Record<string, EventStatus> = {
  CONFIRMED: "confirmed",
  TENTATIVE: "tentative",
  CANCELLED: "cancelled",
};

/**
 * Parse an .ics file into events and tasks.
 *
 * Unknown components (VTIMEZONE, VFREEBUSY, VJOURNAL) and unparseable ones are
 * skipped and counted, never guessed at — a partial import that reports what it
 * dropped beats one that invents data.
 */
export function parseIcs(text: string): ParsedIcs {
  const lines = unfold(text);
  const events: ParsedIcs["events"] = [];
  const tasks: ParsedIcs["tasks"] = [];
  let skipped = 0;

  // The component stack; only VEVENT/VTODO (and a VALARM inside one) are entered.
  let mode: "none" | "event" | "todo" = "none";
  let inAlarm = false;
  let cur: Record<string, Line[]> = {};
  let alarms: Alarm[] = [];
  let alarmTrigger: number | null = null;

  const reset = () => {
    cur = {};
    alarms = [];
    inAlarm = false;
    alarmTrigger = null;
  };

  const first = (name: string): Line | undefined => cur[name]?.[0];
  const val = (name: string): string =>
    first(name) ? unescapeText(first(name)!.value) : "";

  for (const raw of lines) {
    const line = parseLine(raw);
    if (!line) continue;

    if (line.name === "BEGIN") {
      const comp = line.value.toUpperCase();
      if (comp === "VEVENT") {
        mode = "event";
        reset();
      } else if (comp === "VTODO") {
        mode = "todo";
        reset();
      } else if (comp === "VALARM" && mode !== "none") {
        inAlarm = true;
        alarmTrigger = null;
      }
      continue;
    }

    if (line.name === "END") {
      const comp = line.value.toUpperCase();

      if (comp === "VALARM" && inAlarm) {
        if (alarmTrigger !== null) alarms.push({ minutes_before: alarmTrigger });
        inAlarm = false;
        continue;
      }

      if (comp === "VEVENT" && mode === "event") {
        const event = buildEvent(cur, alarms, val);
        if (event) events.push(event);
        else skipped++;
        mode = "none";
        reset();
        continue;
      }

      if (comp === "VTODO" && mode === "todo") {
        const task = buildTask(cur, alarms, val);
        if (task) tasks.push(task);
        else skipped++;
        mode = "none";
        reset();
        continue;
      }
      continue;
    }

    if (mode === "none") continue;

    if (inAlarm) {
      if (line.name === "TRIGGER") alarmTrigger = parseTrigger(line.value);
      continue;
    }

    (cur[line.name] ??= []).push(line);
  }

  return { events, tasks, skipped };
}

function buildEvent(
  cur: Record<string, Line[]>,
  alarms: Alarm[],
  val: (n: string) => string,
): Omit<CalendarEvent, "id" | "calendar_id"> | null {
  const dtstart = cur.DTSTART?.[0];
  if (!dtstart) return null;
  const start = parseIcsDate(dtstart.value);
  if (!start) return null;

  const allDay =
    start.dateOnly || (dtstart.params.VALUE ?? "").toUpperCase() === "DATE";

  // DTEND is exclusive in ICS, exactly as we store it. A missing DTEND means a
  // DURATION or a default: an all-day event is one day, a timed one an hour.
  let end: string;
  const dtend = cur.DTEND?.[0];
  const parsedEnd = dtend ? parseIcsDate(dtend.value) : null;
  if (parsedEnd) {
    end = parsedEnd.stamp;
  } else if (allDay) {
    end = addDays(start.stamp, 1);
  } else {
    const c = parseStamp(start.stamp)!;
    const mins = c.hour * 60 + c.minute + 60;
    const p = (n: number) => String(n).padStart(2, "0");
    end = `${addDays(datePart(start.stamp), Math.floor(mins / 1440))}T${p(Math.floor((mins % 1440) / 60))}:${p(mins % 60)}`;
  }

  const exdates: string[] = [];
  for (const line of cur.EXDATE ?? []) {
    for (const piece of line.value.split(",")) {
      const d = parseIcsDate(piece);
      if (d) exdates.push(d.stamp);
    }
  }

  const rruleLine = cur.RRULE?.[0];
  const rrule = rruleLine ? parseRrule(rruleLine.value) : null;

  return {
    start: start.stamp,
    end,
    all_day: allDay,
    title: val("SUMMARY"),
    location: val("LOCATION"),
    notes: val("DESCRIPTION"),
    // ICS allows several categories; the model holds one, so the first wins.
    category: (val("CATEGORIES").split(",")[0] ?? "").trim().toLowerCase(),
    status: STATUSES[val("STATUS").toUpperCase()] ?? "",
    rrule,
    exdates,
    overrides: [],
    alarms,
  };
}

function buildTask(
  cur: Record<string, Line[]>,
  alarms: Alarm[],
  val: (n: string) => string,
): Omit<CalendarTask, "id" | "calendar_id"> | null {
  const summary = val("SUMMARY");
  if (!summary) return null;

  const due = cur.DUE?.[0] ? parseIcsDate(cur.DUE[0].value) : null;
  const start = cur.DTSTART?.[0] ? parseIcsDate(cur.DTSTART[0].value) : null;
  const completed = cur.COMPLETED?.[0] ? parseIcsDate(cur.COMPLETED[0].value) : null;

  const percentRaw = Number(val("PERCENT-COMPLETE"));
  const status = val("STATUS").toUpperCase();
  const percent = Number.isFinite(percentRaw)
    ? Math.max(0, Math.min(100, percentRaw))
    : status === "COMPLETED"
      ? 100
      : 0;

  const priorityRaw = Number(val("PRIORITY"));

  return {
    title: summary,
    notes: val("DESCRIPTION"),
    due: due?.stamp ?? null,
    start: start?.stamp ?? null,
    priority: Number.isFinite(priorityRaw) ? Math.max(0, Math.min(9, priorityRaw)) : 0,
    // A COMPLETED stamp means done, whatever PERCENT-COMPLETE claims.
    percent: completed ? 100 : percent,
    completed: completed?.stamp ?? (status === "COMPLETED" ? datePart(new Date().toISOString()) : null),
    category: (val("CATEGORIES").split(",")[0] ?? "").trim().toLowerCase(),
    alarms,
  };
}

// ── Serialize ───────────────────────────────────────────────────────────────

/**
 * Write events and tasks as an .ics file.
 *
 * `now` is injected rather than read from the clock so the output is
 * deterministic and the round-trip is testable.
 */
export function serializeIcs(
  events: CalendarEvent[],
  tasks: CalendarTask[] = [],
  now: Date = new Date(),
): string {
  const stamp = icsNowUtc(now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Eldrun//Calendar//EN",
    "CALSCALE:GREGORIAN",
  ];

  const push = (name: string, value: string) => lines.push(fold(`${name}:${value}`));

  for (const e of events) {
    lines.push("BEGIN:VEVENT");
    push("UID", `${e.id}@eldrun`);
    push("DTSTAMP", stamp);
    lines.push(
      fold(
        e.all_day
          ? `DTSTART;VALUE=DATE:${formatIcsDate(e.start, true)}`
          : `DTSTART:${formatIcsDate(e.start, false)}`,
      ),
    );
    lines.push(
      fold(
        e.all_day
          ? `DTEND;VALUE=DATE:${formatIcsDate(e.end, true)}`
          : `DTEND:${formatIcsDate(e.end, false)}`,
      ),
    );
    push("SUMMARY", escapeText(e.title));
    if (e.location) push("LOCATION", escapeText(e.location));
    if (e.notes) push("DESCRIPTION", escapeText(e.notes));
    if (e.category) push("CATEGORIES", escapeText(e.category));
    if (e.status) push("STATUS", e.status.toUpperCase());
    if (e.rrule) push("RRULE", formatRrule(e.rrule));
    for (const ex of e.exdates ?? []) {
      lines.push(
        fold(
          e.all_day
            ? `EXDATE;VALUE=DATE:${formatIcsDate(ex, true)}`
            : `EXDATE:${formatIcsDate(ex, false)}`,
        ),
      );
    }
    for (const alarm of e.alarms ?? []) {
      lines.push("BEGIN:VALARM");
      push("ACTION", "DISPLAY");
      push("DESCRIPTION", escapeText(e.title));
      push("TRIGGER", formatTrigger(alarm.minutes_before));
      lines.push("END:VALARM");
    }
    lines.push("END:VEVENT");
  }

  for (const t of tasks) {
    lines.push("BEGIN:VTODO");
    push("UID", `${t.id}@eldrun`);
    push("DTSTAMP", stamp);
    push("SUMMARY", escapeText(t.title));
    if (t.notes) push("DESCRIPTION", escapeText(t.notes));
    if (t.start) push("DTSTART", formatIcsDate(t.start, !t.start.includes("T")));
    if (t.due) push("DUE", formatIcsDate(t.due, !t.due.includes("T")));
    if (t.priority) push("PRIORITY", String(t.priority));
    if (t.percent) push("PERCENT-COMPLETE", String(t.percent));
    if (t.percent >= 100) push("STATUS", "COMPLETED");
    if (t.completed) push("COMPLETED", formatIcsDate(t.completed, false));
    if (t.category) push("CATEGORIES", escapeText(t.category));
    for (const alarm of t.alarms ?? []) {
      lines.push("BEGIN:VALARM");
      push("ACTION", "DISPLAY");
      push("DESCRIPTION", escapeText(t.title));
      push("TRIGGER", formatTrigger(alarm.minutes_before));
      lines.push("END:VALARM");
    }
    lines.push("END:VTODO");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
