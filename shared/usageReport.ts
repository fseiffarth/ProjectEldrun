/**
 * Reads the usage panel an agent CLI prints, so a reader can show it as bars
 * rather than as a paragraph — and can say *when* a full window rolls over.
 *
 * Shared because both surfaces need the same reading: the phone's status sheet
 * draws the bars (`mobile-web/src/screens/StatusSheet.tsx`), and the desktop's
 * per-tab auto-continue arms itself off the reset time
 * (`components/layout/AgentContinueHost.tsx`). One parser, so a panel that
 * reads one way on the phone cannot read another way on the laptop.
 *
 * The text comes from the desktop exactly as the CLI printed it
 * (`services::agent_usage`), and this is the *only* place that pretends to know
 * its shape. That shape belongs to somebody else's CLI and can change in any
 * release, so every rule here is a positive match on a line that already looks
 * like a readout: a line nothing claims is passed through as a note, and a panel
 * nothing claimed at all is reported as `unparsed` — at which point the sheet
 * shows the raw block, which is still the whole answer. Nothing is ever
 * invented, and no figure is dropped without appearing somewhere.
 *
 * The shapes matched are Claude Code's, read off a real `/usage` run:
 *
 *     Current session: 71% used · resets 6:20pm
 *     Current week (all models): 38% used · resets Mon 9am
 *     Current week (Fable): 12% used
 *     Last 24h: 41 requests · 6 sessions
 */

/** One window with a percentage — drawn as a labelled bar. */
export interface UsageMeter {
  label: string;
  /** 0–100, clamped. */
  percent: number;
  /** When the window rolls over, in the CLI's own words ("6:20pm", "Mon 9am"). */
  resets?: string;
}

/** A readout with no percentage in it ("Last 24h" → "41 requests · 6 sessions"),
 * or any line the parser could not claim. Rendered as a plain row. */
export interface UsageNote {
  label?: string;
  value: string;
}

export interface UsageReport {
  meters: UsageMeter[];
  notes: UsageNote[];
  /** True when no line looked like a readout at all — the formatted view then
   * says so and points at the raw text rather than showing an empty panel. */
  unparsed: boolean;
}

/** `71% used`, `45.2 % used`, or a bare `71%` when the line already said what it
 * is about. The `used` suffix is optional because Gemini omits the word and
 * Claude may reword it; the percentage itself is the thing being matched. The
 * sign is captured so a negative figure is clamped to an empty bar rather than
 * silently becoming a positive one. */
const PERCENT = /(-?\d{1,3}(?:\.\d+)?)\s?%/u;

/** `resets 6:20pm`, `resets Mon 9am`, `Resets: tomorrow 09:00`. Stops at a
 * separator so a trailing segment does not end up inside the time. */
const RESETS = /\bresets\b:?\s*([^·•|,;]+)/iu;

/** `Label: value`, where the label is short enough to be one — not a sentence
 * that happens to contain a colon. */
const LABELLED = /^([^:]{1,48}):\s*(.+)$/u;

/** Separators the CLIs put between facts on one line. */
const SEGMENTS = /\s+[·•|]\s+/u;

/** The characters a box-drawn panel's frame is made of. Stripped from the ends
 * of a line, and a line that is *only* frame is skipped — a corner piece is not
 * a readout, and passing one through as a note is how a tidy panel ends up with
 * two empty rows around it. */
const FRAME_EDGE = /^[\s│|╎┃┆┊┌┐└┘├┤╭╮╰╯╠╣║]+|[\s│|╎┃┆┊┌┐└┘├┤╭╮╰╯╠╣║]+$/gu;
const FRAME_ONLY = /^[─━═╌┄┈╍\-=_·.\s]*$/u;

function clampPercent(text: string): number {
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Strip a trailing `used`/`used.` from the value half so a bar's own label does
 * not repeat the word the bar already means. */
function tidyLabel(label: string): string {
  return label.replace(/\s+/gu, " ").trim();
}

/**
 * Parse one usage panel. Never throws and never returns a figure the text did
 * not contain: an unrecognized panel comes back with `unparsed` set and its
 * lines kept as notes, so the reader loses nothing the CLI said.
 */
export function parseUsageReport(raw: string): UsageReport {
  const meters: UsageMeter[] = [];
  const notes: UsageNote[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    // Panels are often drawn inside a box; the frame is not content.
    const text = line.replace(FRAME_EDGE, "").trim();
    if (!text || FRAME_ONLY.test(text)) continue;
    const labelled = LABELLED.exec(text);
    const label = labelled ? tidyLabel(labelled[1]) : undefined;
    const body = labelled ? labelled[2].trim() : text;
    const percent = PERCENT.exec(body);
    if (percent && label) {
      const resets = RESETS.exec(body);
      meters.push({
        label,
        percent: clampPercent(percent[1]),
        resets: resets ? tidyLabel(resets[1]) : undefined,
      });
      continue;
    }
    // A percentage with nothing naming it is still a fact, but it is not a bar:
    // an unlabelled meter would be a bar the reader cannot attribute.
    notes.push({ label, value: body });
  }
  return { meters, notes, unparsed: meters.length === 0 };
}

/** The segments of a note's value, for rendering "41 requests · 6 sessions" as
 * separate chips instead of one run-on string. */
export function noteParts(value: string): string[] {
  return value.split(SEGMENTS).map((part) => part.trim()).filter(Boolean);
}

/* ── When a window rolls over ──────────────────────────────────────────────── */

/**
 * The CLI writes a reset as a wall-clock phrase, not an instant: `6:20pm` for
 * the session window, `Mon 9am` for the weekly one. Turning that into a real
 * time is the only place in this file that adds information the text does not
 * literally contain, so it is deliberately narrow — it recognizes the shapes
 * Claude Code prints and answers `null` for anything else. A caller that needs
 * an instant (auto-continue) then says it cannot read the panel, which is the
 * truth, rather than arming itself off a guess.
 */
const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/** `6:20pm`, `9am`, `9 AM`, `18:20`, `09:00`. Either a `:mm` or a meridiem is
 *  REQUIRED — a bare number in a date phrase (`Feb 3`) is a day, not an hour,
 *  and reading it as one is how a rollover ends up eight hours out. Without a
 *  meridiem the figure is 24-hour, which is what `18:20` and `09:00` mean. */
const CLOCK = /(?:^|[\s,])(\d{1,2})(?::(\d{2})\s*(am|pm)?|\s*(am|pm))(?=$|[\s,.])/iu;

/** A phrase naming a calendar date rather than a weekday. Nothing here parses
 *  one, so it is refused outright: placing `Feb 3, 9am` on the next 9am that
 *  comes round would be a wrong instant stated confidently. */
const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/iu;

const DAY_WORD = /\b(today|tomorrow|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/iu;

function atLocal(base: Date, dayOffset: number, hour: number, minute: number): Date {
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + dayOffset,
    hour,
    minute,
    0,
    0,
  );
}

/**
 * The instant a `resets …` phrase names, read against `now` in the reader's own
 * timezone — the CLI printed it in local wall-clock, and this is the same clock.
 *
 * Rules, in the order they apply:
 *  - a weekday (`Mon 9am`) is the NEXT such weekday at that time; today counts
 *    only while the time is still ahead;
 *  - `tomorrow` / `today` mean what they say (a `today` time already past comes
 *    back in the past, which the caller reads as a stale panel — inventing
 *    tomorrow there would arm a continue a day late);
 *  - a bare time (`6:20pm`) is the next occurrence of that time, rolling to
 *    tomorrow once it has passed today. A session window is hours long, so its
 *    next occurrence is always the one meant.
 */
export function resolveResetAt(text: string, now: Date): Date | null {
  if (MONTH.test(text)) return null;
  const clock = CLOCK.exec(text);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = clock[2] === undefined ? 0 : Number(clock[2]);
  const meridiem = (clock[3] ?? clock[4])?.toLowerCase();
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }

  const day = DAY_WORD.exec(text)?.[1]?.toLowerCase();
  if (day === "today") return atLocal(now, 0, hour, minute);
  if (day === "tomorrow") return atLocal(now, 1, hour, minute);
  if (day !== undefined) {
    const weekday = WEEKDAYS[day];
    if (weekday === undefined) return null;
    const offset = (weekday - now.getDay() + 7) % 7;
    const candidate = atLocal(now, offset, hour, minute);
    return candidate.getTime() > now.getTime() ? candidate : atLocal(now, offset + 7, hour, minute);
  }

  const today = atLocal(now, 0, hour, minute);
  return today.getTime() > now.getTime() ? today : atLocal(now, 1, hour, minute);
}

/** One window's rollover: the meter it came from, the CLI's own words, and the
 *  instant those words resolve to. */
export interface UsageReset {
  label: string;
  resets: string;
  at: Date;
}

/**
 * The soonest rollover the panel names, or `null` when it names none this
 * reader can place in time.
 *
 * "Soonest" and not "the exhausted one": a caller waiting on quota wants the
 * next moment anything frees up, and a window that is not the binding one
 * simply comes round again on the following pass. Resets already in the past
 * are dropped — they belong to a panel read before the rollover, and treating
 * one as due would fire immediately and then again at the real reset.
 */
export function nextUsageReset(report: UsageReport, now: Date): UsageReset | null {
  let best: UsageReset | null = null;
  for (const meter of report.meters) {
    if (!meter.resets) continue;
    const at = resolveResetAt(meter.resets, now);
    if (!at || at.getTime() <= now.getTime()) continue;
    if (!best || at.getTime() < best.at.getTime()) {
      best = { label: meter.label, resets: meter.resets, at };
    }
  }
  return best;
}
