import { describe, expect, it } from "vitest";
import {
  buildPromptChart,
  futureTimeAt,
  groupPromptPast,
  promptChartDropAction,
  queueOrderTimes,
  snapPromptTime,
  type PromptChartStrand,
} from "../lib/agentPromptChart";

const now = new Date(2026, 8, 4, 12, 2, 0);
const strand: PromptChartStrand = {
  id: "s1", label: "Claude", scheduleTargetId: "target-1", sessionId: "session-1", agent: "claude",
  schedules: [
    { id: "scheduled", enabled: true, message: "Later", rule: { type: "once", at: "2026-09-04T13:00" } },
    { id: "queued", enabled: true, message: "Waiting", rule: { type: "once", at: "2026-09-04T12:00" } },
  ],
};

describe("prompt chart model", () => {
  it("derives draft, chained, scheduled, queued and sent cards", () => {
    const cards = buildPromptChart({
      now,
      strands: [strand],
      prompts: [
        { id: "draft", message: "Draft", created_at: "x", updated_at: "x" },
        { id: "chain", message: "Next", created_at: "x", updated_at: "x" },
        { id: "scheduled", message: "Later", created_at: "x", updated_at: "x" },
      ],
      links: [{ id: "l", from: "draft", to: "chain", kind: "after", target: "target-1" }],
      history: [{ id: "sent", message: "Done", created_at: "x", sent_at: "2026-09-04T11:00:00Z", tab_label: "Claude", session_id: "session-1", result: "delivered" }],
    });
    expect(new Set(cards.map((card) => card.state))).toEqual(new Set(["draft", "chained", "scheduled", "queued", "sent"]));
    expect(cards.find((card) => card.state === "scheduled")?.id).toBe("scheduled");
  });

  it("joins a collected prompt to a rule by normalized text", () => {
    const cards = buildPromptChart({
      now, strands: [{ ...strand, schedules: [{ id: "rule", enabled: true, message: "Same text", rule: { type: "daily", time: "13:00" } }] }], links: [], history: [],
      prompts: [{ id: "prompt", message: "Same text\r\n", created_at: "x", updated_at: "x" }],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ state: "scheduled", id: "prompt" });
  });

  it("snaps the future band to five minutes and maps drops", () => {
    expect(local(snapPromptTime(new Date(2026, 8, 4, 12, 7)))).toBe("12:05");
    expect(local(futureTimeAt(50, 100, now, 1))).toBe("12:30");
    const draft = buildPromptChart({ now, strands: [{ ...strand, schedules: [] }], prompts: [{ id: "p", message: "x", created_at: "x", updated_at: "x" }], history: [], links: [] })[0];
    expect(promptChartDropAction(draft, { kind: "strand", targetId: "target-1", now: true })).toEqual({ type: "send", targetId: "target-1" });
    expect(promptChartDropAction(draft, { kind: "strand", targetId: "target-1", at: new Date(2026, 8, 4, 14, 3) })).toEqual({ type: "schedule", targetId: "target-1", at: "2026-09-04T14:05" });
  });

  it("rewrites a queue into chronological minutes inside the catch-up window", () => {
    expect(queueOrderTimes(["b", "a", "c"], now)).toEqual({ b: "2026-09-04T12:00", a: "2026-09-04T12:01", c: "2026-09-04T12:02" });
  });

  it("groups past cards ordinally", () => {
    const cards = buildPromptChart({ now, strands: [strand], prompts: [], links: [], history: [
      { id: "a", message: "A", created_at: "x", sent_at: "2026-09-04T09:00:00", tab_label: "Claude", result: "delivered" },
      { id: "b", message: "B", created_at: "x", sent_at: "2026-09-03T09:00:00", tab_label: "Claude", result: "failed" },
    ] });
    expect(groupPromptPast(cards, now)).toHaveLength(2);
  });
});

function local(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
