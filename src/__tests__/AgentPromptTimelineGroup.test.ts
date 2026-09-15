import { describe, expect, it } from "vitest";
import type { PromptChartCard } from "../lib/agentPromptChart";
import { timelineGroupDrop, timelineGroupMovable, timelineWindow } from "../lib/agentPromptTimeline";

const now = new Date(2026, 8, 4, 12, 2, 0);
const win = timelineWindow("day", "2026-09-04", 1);
const targets = ["t1", "t2"];

function card(over: Partial<PromptChartCard>): PromptChartCard {
  return {
    key: "k", id: "id", state: "draft", message: "m", tags: [], autoTags: [], strandId: "drafts", at: null, recurring: false, ...over,
  };
}

function rule(id: string, at: Date): PromptChartCard {
  return card({
    key: id, id, state: "scheduled", targetId: "t1", at,
    schedule: { id, enabled: true, message: "m", rule: { type: "once", at: "unused" } } as PromptChartCard["schedule"],
  });
}

const early = rule("a", new Date(2026, 8, 4, 12, 32));
const later = rule("b", new Date(2026, 8, 4, 13, 2));

describe("moving a selection along the axis", () => {
  it("carries only one-time rules with a minute of their own", () => {
    expect(timelineGroupMovable(early)).toBe(true);
    expect(timelineGroupMovable({ ...early, recurring: true })).toBe(false);
    expect(timelineGroupMovable(card({ state: "queued", schedule: early.schedule, at: now }))).toBe(false);
    expect(timelineGroupMovable(card({ state: "sent", at: now }))).toBe(false);
    expect(timelineGroupMovable(card({ state: "draft" }))).toBe(false);
  });

  it("keeps the members' spacing, each snapped to the grid", () => {
    const drops = timelineGroupDrop(early, [early, later], { kind: "time", at: new Date(2026, 8, 4, 18, 0) }, targets, win, now);
    expect(drops.map((entry) => [entry.card.id, entry.drop])).toEqual([
      ["a", { type: "retime", targetId: "t1", fromTargetId: "t1", at: "2026-09-04T18:00" }],
      ["b", { type: "retime", targetId: "t1", fromTargetId: "t1", at: "2026-09-04T18:30" }],
    ]);
  });

  it("refuses the whole drop when any member would land at or before now", () => {
    const drops = timelineGroupDrop(later, [later, early], { kind: "time", at: new Date(2026, 8, 4, 12, 10) }, targets, win, now);
    expect(drops.map((entry) => entry.drop.type)).toEqual(["none", "none"]);
  });

  it("sends or unschedules every member on the now band and the strip", () => {
    expect(timelineGroupDrop(early, [early, later], { kind: "now" }, targets, win, now).map((entry) => entry.drop))
      .toEqual([{ type: "send", targetId: "t1" }, { type: "send", targetId: "t1" }]);
    expect(timelineGroupDrop(early, [early, later], { kind: "strip" }, targets, win, now).map((entry) => entry.drop.type))
      .toEqual(["unschedule", "unschedule"]);
  });
});
