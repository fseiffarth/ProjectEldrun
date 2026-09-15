import { describe, expect, it } from "vitest";
import {
  buildPromptChart,
  queueOrderTimes,
  rowOnStrand,
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
    expect(cards.find((card) => card.state === "chained")?.chainLink).toMatchObject({ id: "l", target: "target-1" });
  });

  it("aims a draft at the tab it names, unless that tab is gone", () => {
    const cards = buildPromptChart({
      now, strands: [strand], links: [], history: [],
      prompts: [
        { id: "aimed", message: "Aimed", created_at: "x", updated_at: "x", target: "target-1" },
        { id: "stale", message: "Stale", created_at: "x", updated_at: "x", target: "target-gone" },
      ],
    });
    expect(cards.find((card) => card.id === "aimed")).toMatchObject({ state: "draft", targetId: "target-1", strandId: "drafts" });
    expect(cards.find((card) => card.id === "aimed")?.autoTags).toContain("agent:claude");
    expect(cards.find((card) => card.id === "stale")?.targetId).toBeUndefined();
  });

  it("joins a collected prompt to a rule by normalized text", () => {
    const cards = buildPromptChart({
      now, strands: [{ ...strand, schedules: [{ id: "rule", enabled: true, message: "Same text", rule: { type: "daily", time: "13:00" } }] }], links: [], history: [],
      prompts: [{ id: "prompt", message: "Same text\r\n", created_at: "x", updated_at: "x" }],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ state: "scheduled", id: "prompt" });
  });

  it("keeps a tab's rows on its strand across a /clear, as separate sessions", () => {
    // The tab's launch id is `launch`; after a `/clear` the backend files rows
    // under the new live id `cleared` with `tab_id` still `launch`.
    const live: PromptChartStrand = { id: "s1", label: "Claude", scheduleTargetId: "target-1", sessionId: "launch", tabId: "launch", agent: "claude", schedules: [] };
    const row = (id: string, session: string, tab_id?: string, tab_label = "Claude") => ({
      id, message: id, created_at: "x", sent_at: `2026-09-04T1${id.length}:00:00Z`, tab_label, session_id: session, tab_id, result: "delivered" as const,
    });
    const history = [
      row("a", "launch"),                 // before the tab id was recorded
      row("bb", "cleared", "launch"),     // after /clear
      row("ccc", "gone", "other-launch", "Codex"),
    ];
    const cards = buildPromptChart({ now, strands: [live], prompts: [], links: [], history });
    expect(cards.map((card) => [card.id, card.strandId])).toEqual([
      ["a", "s1"], ["bb", "s1"], ["ccc", "closed:other-launch"],
    ]);
    expect(rowOnStrand(live, history[1])).toBe(true);
    // A closed strand stands for the gone TAB: both of its sessions land on it.
    const closed: PromptChartStrand = { id: "closed:other-launch", label: "Codex", sessionId: "gone", tabId: "other-launch", closed: true, schedules: [] };
    expect(rowOnStrand(closed, row("d", "gone-too", "other-launch", "Renamed"))).toBe(true);
    expect(rowOnStrand(closed, row("e", "gone-too", "third-launch", "Renamed"))).toBe(false);
  });

  it("snaps to five minutes", () => {
    expect(local(snapPromptTime(new Date(2026, 8, 4, 12, 7)))).toBe("12:05");
  });

  it("rewrites a queue into chronological minutes inside the catch-up window", () => {
    expect(queueOrderTimes(["b", "a", "c"], now)).toEqual({ b: "2026-09-04T12:00", a: "2026-09-04T12:01", c: "2026-09-04T12:02" });
  });
});

function local(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
