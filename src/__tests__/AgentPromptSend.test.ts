/**
 * "Send now" for a collected prompt is a one-time schedule at the current
 * minute — the scheduler's own verdict must read it as due-and-waiting, never
 * as future or missed — and a tab at its cap makes room only by dropping
 * finished one-time entries, oldest first.
 */
import { describe, expect, it } from "vitest";
import {
  buildSendNowSchedule,
  deliveryRecordId,
  schedulesToPruneForSend,
  sendNowRule,
} from "../lib/agentPromptSend";
import { scheduleVerdict, type ScheduledAgentPrompt } from "../lib/agentSchedule";

const now = new Date(2026, 8, 2, 14, 37, 42);

function once(id: string, lastAt?: string): ScheduledAgentPrompt {
  return {
    id,
    enabled: true,
    message: "x",
    rule: { type: "once", at: "2026-09-01T09:00" },
    last: lastAt ? { occurrence: "2026-09-01T09:00", result: "delivered", at: lastAt } : undefined,
  };
}

describe("send-now schedules", () => {
  it("lands on the current minute and is immediately due", () => {
    expect(sendNowRule(now)).toEqual({ type: "once", at: "2026-09-02T14:37" });
    const schedule = buildSendNowSchedule("Continue\r\n  ", now, "id-1");
    expect(schedule.message).toBe("Continue");
    expect(scheduleVerdict(schedule, now)).toMatchObject({ kind: "wait" });
    // Still due well inside the hour, missed after it.
    expect(scheduleVerdict(schedule, new Date(now.getTime() + 50 * 60_000)).kind).toBe("wait");
    expect(scheduleVerdict(schedule, new Date(now.getTime() + 61 * 60_000)).kind).toBe("missed");
  });

  it("refuses an empty message", () => {
    expect(() => buildSendNowSchedule("   ", now, "id")).toThrow();
  });

  it("prunes finished one-time schedules, oldest first, only when the tab is full", () => {
    expect(schedulesToPruneForSend([once("a", "2026-09-01T09:00:00Z")], 32)).toEqual([]);
    const full = [
      once("armed"),
      { ...once("daily"), rule: { type: "daily", time: "09:00" } } as ScheduledAgentPrompt,
      once("old", "2026-08-01T09:00:00Z"),
      once("new", "2026-09-01T09:00:00Z"),
    ];
    expect(schedulesToPruneForSend(full, 4)).toEqual(["old"]);
    expect(schedulesToPruneForSend(full, 3)).toEqual(["old", "new"]);
    // Nothing finished to drop: the send goes ahead and the backend's cap decides.
    expect(schedulesToPruneForSend([once("armed"), once("armed-2")], 2)).toEqual([]);
  });

  /**
   * The id a delivery is recorded under is what keeps one prompt one row.
   * `sendCollectedPrompt` gives the one-time rule the collected prompt's id, so
   * the delivery lands on the row that prompt already wrote; a recurring rule
   * has to write one row per run instead.
   */
  it("records a one-time run on the prompt's own row and a recurring one per occurrence", () => {
    expect(deliveryRecordId(once("prompt-1"), "2026-09-01T09:00")).toBe("prompt-1");
    const daily = { ...once("rule-1"), rule: { type: "daily", time: "09:00" } } as ScheduledAgentPrompt;
    expect(deliveryRecordId(daily, "2026-09-01T09:00")).toBe("rule-1@2026-09-01T09:00");
    expect(deliveryRecordId(daily, "2026-09-02T09:00")).not.toBe(
      deliveryRecordId(daily, "2026-09-01T09:00"),
    );
  });
});
