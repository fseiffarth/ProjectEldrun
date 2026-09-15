import { describe, expect, it } from "vitest";
import { buildPromptChart } from "../lib/agentPromptChart";
import { draftChainAnchors, draftSequence } from "../lib/agentPromptDrafts";
import { timelineItems, timelineWindow } from "../lib/agentPromptTimeline";
import type { PromptLink } from "../stores/agentPrompts";

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
  it("shows the entire sequence on the timeline with only its start scheduled", () => {
    const cards = buildPromptChart({ prompts: [...prompts].reverse(), links, history: [], now, strands: [{
      id: "strand:t", label: "Agent", scheduleTargetId: "t", schedules: [{
        id: "a", message: "a", enabled: true, rule: { type: "once", at: "2026-09-15T12:00" },
      }],
    }] });
    const anchors = draftChainAnchors(cards, now);
    expect([...anchors.keys()].sort()).toEqual(["a", "b", "c"]);
    const items = timelineItems(cards, timelineWindow("day", "2026-09-15", 0), now);
    expect(items.map((item) => item.card.id).sort()).toEqual(["a", "b", "c"]);
    expect(items.filter((item) => item.card.schedule)).toHaveLength(1);
    expect(cards.find((card) => card.id === "c")?.at).toBeNull();
  });
});
