import { describe, expect, it } from "vitest";
import { buildPromptChart } from "../lib/agents/prompt/chart";
import { draftSequence } from "../lib/agents/prompt/drafts";
import { timelineItems, timelineWindow } from "../lib/agents/prompt/timeline";
import type { PromptLink } from "../stores/agents/agentPrompts";

const now = new Date(2026, 8, 15, 10);
const prompts = ["a", "b", "c", "other"].map((id) => ({ id, message: id, created_at: "x", updated_at: "x" }));
const links: PromptLink[] = [{ id: "ab", from: "a", to: "b", kind: "after" }, { id: "bc", from: "b", to: "c", kind: "after", preface: ["/clear"] }];
const build = (edges = links) => buildPromptChart({ prompts, links: edges, history: [], strands: [], now });

describe("draft sequences", () => {
  it("finds the start from any member, without carrying Related cards", () => {
    const edges: PromptLink[] = [...links, { id: "related", from: "c", to: "other", kind: "related" }];
    for (const id of ["a", "b", "c"]) expect(draftSequence(id, build(edges), edges)?.map((card) => card.id)).toEqual(["a", "b", "c"]);
  });
  it("refuses cycles and multiple predecessors without choosing an arbitrary start", () => {
    for (const extra of [
      { id: "cycle", from: "c", to: "a", kind: "after" as const },
      { id: "join", from: "other", to: "b", kind: "after" as const },
    ]) {
      const edges = [...links, extra];
      expect(draftSequence("b", build(edges), edges)).toBeNull();
    }
  });
  it("puts only the scheduled start on the timeline; the chained members keep no minute", () => {
    const cards = buildPromptChart({ prompts: [...prompts].reverse(), links, history: [], now, strands: [{
      id: "strand:t", label: "Agent", scheduleTargetId: "t", schedules: [{
        id: "a", message: "a", enabled: true, rule: { type: "once", at: "2026-09-15T12:00" },
      }],
    }] });
    const items = timelineItems(cards, timelineWindow("day", "2026-09-15", 0), now);
    // A chained card goes when its source's turn has finished, not at the
    // source's minute, so it is never drawn at that minute.
    expect(items.map((item) => item.card.id)).toEqual(["a"]);
    expect(cards.filter((card) => card.state === "chained").map((card) => card.id)).toEqual(["c", "b"]);
    for (const id of ["b", "c"]) expect(cards.find((card) => card.id === id)?.at).toBeNull();
  });
});
