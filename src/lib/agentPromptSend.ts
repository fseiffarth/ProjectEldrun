/**
 * "Send now" for a collected prompt is a **one-time schedule at the current
 * minute**, not a second write route into the PTY. That keeps every property
 * the scheduler already earns — the idle/decision gate, the atomic claim, the
 * receipt, the one-hour window — and makes the phone's send identical to the
 * desktop's, since the desktop computes "now" for both. The cost is that a
 * prompt aimed at a busy agent waits, and after an hour reads "missed"; that is
 * the documented behaviour of every due prompt, not a special case.
 *
 * Pure: `now` is an argument so the minute key and the pruning are testable.
 */
import {
  MAX_SCHEDULES_PER_TAB,
  localOccurrenceKey,
  normalizedSchedulePreface,
  normalizedScheduleMessage,
  type ScheduleRule,
  type ScheduledAgentPrompt,
} from "./agentSchedule";

export function sendNowRule(now: Date): ScheduleRule {
  return { type: "once", at: localOccurrenceKey(now) };
}

export function buildSendNowSchedule(
  message: string,
  now: Date,
  id: string,
  preface?: string[],
): ScheduledAgentPrompt {
  const clean = normalizedSchedulePreface(preface);
  return {
    id,
    enabled: true,
    message: normalizedScheduleMessage(message),
    // Omitted rather than set to `[]`, so a send with no prefix commands
    // serializes to exactly the shape it had before the composer existed.
    ...(clean ? { preface: clean } : {}),
    rule: sendNowRule(now),
  };
}

/** A one-time schedule with a recorded result can never fire again. */
export function isFinishedOneTime(schedule: ScheduledAgentPrompt): boolean {
  return schedule.rule.type === "once" && !!schedule.last;
}

/**
 * The history id one delivery is written under.
 *
 * A one-time schedule IS the prompt: `sendCollectedPrompt` gives the rule the
 * collected prompt's own id, so recording under it turns that prompt's "queued"
 * row into a delivered one instead of listing the same text twice. A recurring
 * rule keeps firing, so each occurrence is its own row — the id carries the
 * occurrence, which also makes a re-record of the same run idempotent.
 */
export function deliveryRecordId(
  schedule: Pick<ScheduledAgentPrompt, "id" | "rule">,
  occurrence: string,
): string {
  return schedule.rule.type === "once" ? schedule.id : `${schedule.id}@${occurrence}`;
}

/**
 * Ids to delete before adding one more schedule to a tab at its cap: the
 * oldest finished one-time entries, and only as many as needed. Recurring
 * rules and anything still armed are never touched — the cap is the user's to
 * resolve in the dialog then, and the send fails with the backend's message.
 */
export function schedulesToPruneForSend(
  schedules: ScheduledAgentPrompt[],
  max: number = MAX_SCHEDULES_PER_TAB,
): string[] {
  const room = max - schedules.length;
  if (room > 0) return [];
  return schedules
    .filter(isFinishedOneTime)
    .sort((a, b) => (a.last?.at ?? "").localeCompare(b.last?.at ?? ""))
    .slice(0, 1 - room)
    .map((schedule) => schedule.id);
}
