import { resolveResetAt, type UsageReport } from "../../../shared/usageReport";

/**
 * Where an agent's own rate-limit windows roll over, as marks on the prompt
 * chart's time axis. Pure: the panel is read by `agent_usage` (the client-side
 * `claude -p "/usage"` run, no quota spent) and parsed by `shared/usageReport`,
 * whose `resolveResetAt` is the only thing that places a phrase in time — so
 * the chart's lines and auto-continue's arming cannot disagree about when a
 * window turns over.
 *
 * Two kinds of window, and they extend differently:
 *  - the **session** (5-hour) window marks only its next reset. The window
 *    after it starts at the next prompt, not on a clock, so any further line
 *    would be a guess.
 *  - the **weekly** window is a fixed weekly clock, so its reset repeats every
 *    seven days across the whole visible range, past weeks included — which is
 *    what lets a Week or Month view say which prompts fell in which window.
 *
 * A meter this module cannot classify (no `session`/`week` in its label) is
 * left off the axis rather than drawn as an unnamed line.
 */

export type UsageWindowKind = "session" | "week";

export interface UsageResetMark {
  key: string;
  agent: string;
  kind: UsageWindowKind;
  at: Date;
  /** The meters that roll over at this instant (`Current week (all models)`,
   *  `Current week (Fable)` usually share one). */
  labels: string[];
  /** The fullest of those meters, 0–100. */
  percent: number;
  /** The CLI's own words for the reset. */
  resets: string;
}

export function usageWindowKind(label: string): UsageWindowKind | null {
  if (/\bsession\b|\b5\s*-?\s*h(?:ours?|r)?\b/iu.test(label)) return "session";
  if (/\bweek(?:ly)?\b/iu.test(label)) return "week";
  return null;
}

/** `at` moved by whole local days, keeping the wall clock across a DST change. */
function shiftDays(at: Date, days: number): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + days, at.getHours(), at.getMinutes(), 0, 0);
}

/** Every reset of one meter inside `[from, to)`. */
function instantsFor(kind: UsageWindowKind, next: Date, from: Date, to: Date): Date[] {
  if (kind === "session") return next >= from && next < to ? [next] : [];
  const out: Date[] = [];
  // Step back to the first weekly reset at or after `from`, then walk forward.
  const weeksBack = Math.max(0, Math.floor((next.getTime() - from.getTime()) / (7 * 86_400_000)));
  let at = shiftDays(next, -7 * weeksBack);
  while (at >= from) at = shiftDays(at, -7);
  while (at < from) at = shiftDays(at, 7);
  for (; at < to; at = shiftDays(at, 7)) out.push(at);
  return out;
}

export function usageResetMarks(agent: string, report: UsageReport, now: Date, from: Date, to: Date): UsageResetMark[] {
  const marks = new Map<string, UsageResetMark>();
  for (const meter of report.meters) {
    if (!meter.resets) continue;
    const kind = usageWindowKind(meter.label);
    if (!kind) continue;
    const next = resolveResetAt(meter.resets, now);
    if (!next || next.getTime() <= now.getTime()) continue;
    for (const at of instantsFor(kind, next, from, to)) {
      const key = `${agent}:${kind}:${at.getTime()}`;
      const mark = marks.get(key);
      if (mark) {
        if (!mark.labels.includes(meter.label)) mark.labels.push(meter.label);
        mark.percent = Math.max(mark.percent, meter.percent);
      } else {
        marks.set(key, { key, agent, kind, at, labels: [meter.label], percent: meter.percent, resets: meter.resets });
      }
    }
  }
  return [...marks.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
}
