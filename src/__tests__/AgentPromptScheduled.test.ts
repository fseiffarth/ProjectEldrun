/**
 * Marking a collected prompt that already went to scheduling. "Schedule…"
 * leaves the prompt in the list, so the list itself has to say a rule exists —
 * and stop saying it the moment the rule stops being one.
 */
import { describe, expect, it } from "vitest";
import { promptScheduleKey, scheduledPromptMarks } from "../lib/agentPromptScheduled";
import type { ScheduledAgentPrompt } from "../lib/agentSchedule";

const now = new Date("2026-09-02T10:00:00");

function rule(over: Partial<ScheduledAgentPrompt> = {}): ScheduledAgentPrompt {
  return {
    id: "s1",
    enabled: true,
    message: "Run the tests",
    rule: { type: "daily", time: "09:00" },
    ...over,
  };
}

describe("scheduledPromptMarks", () => {
  const prompts = [
    { id: "p1", message: "Run the tests" },
    { id: "p2", message: "Write the changelog" },
  ];

  it("marks only the prompt whose text a tab has a rule for", () => {
    const marks = scheduledPromptMarks(prompts, [{ label: "Claude", schedules: [rule()] }], now);
    expect(Object.keys(marks)).toEqual(["p1"]);
    expect(marks.p1.tabs).toEqual(["Claude"]);
    expect(marks.p1.count).toBe(1);
    expect(marks.p1.next).toBeTruthy();
  });

  it("names every tab once and takes the soonest occurrence across them", () => {
    const marks = scheduledPromptMarks(prompts, [
      { label: "Claude", schedules: [rule({ rule: { type: "daily", time: "23:00" } }), rule({ id: "s2" })] },
      { label: "Codex", schedules: [rule({ id: "s3", rule: { type: "once", at: "2026-09-02T11:00" } })] },
    ], now);
    expect(marks.p1.tabs).toEqual(["Claude", "Codex"]);
    expect(marks.p1.count).toBe(3);
    // 11:00 today beats 23:00 today and tomorrow's 09:00.
    expect(marks.p1.next?.getHours()).toBe(11);
  });

  it("marks a prompt whose rules are all disabled, with nothing armed", () => {
    const marks = scheduledPromptMarks(prompts, [
      { label: "Claude", schedules: [rule({ enabled: false })] },
    ], now);
    expect(marks.p1.count).toBe(1);
    expect(marks.p1.next).toBeNull();
  });

  it("ignores a finished one-time rule — that is a receipt, not a plan", () => {
    const marks = scheduledPromptMarks(prompts, [
      {
        label: "Claude",
        schedules: [rule({
          rule: { type: "once", at: "2026-09-02T09:00" },
          last: { occurrence: "2026-09-02T09:00", result: "delivered", at: "2026-09-02T09:00:10Z" },
        })],
      },
    ], now);
    expect(marks).toEqual({});
  });

  it("matches the text the schedule stores, not the raw draft", () => {
    expect(promptScheduleKey("Run the tests   \n")).toBe("Run the tests");
    const marks = scheduledPromptMarks([{ id: "p1", message: "Run the tests  " }], [
      { label: "Claude", schedules: [rule()] },
    ], now);
    expect(marks.p1).toBeTruthy();
  });

  it("never matches on a message that sanitizes away", () => {
    const marks = scheduledPromptMarks([{ id: "p1", message: "   " }], [
      { label: "Claude", schedules: [rule({ message: "" })] },
    ], now);
    expect(marks).toEqual({});
  });
});
