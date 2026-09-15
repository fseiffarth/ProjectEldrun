import { describe, expect, it } from "vitest";
import { edgeCommandChoices, nextAfter, prunePromptLinks, toggleEdgeCommand } from "../lib/agentPromptLinks";

const links = [
  { id: "l1", from: "source", to: "target", kind: "after" as const, target: "tab-1" },
  { id: "l2", from: "source", to: "gone", kind: "related" as const },
];
const draft = { id: "target", message: "Review it", created_at: "a", updated_at: "a" };

describe("prompt links", () => {
  it("prunes invalid and dangling endpoints", () => {
    expect(prunePromptLinks(links, ["source", "target"])).toEqual([links[0]]);
  });

  it("resolves one after hop for a live target, including recurring record ids", () => {
    const rows = nextAfter("source@2026-09-04T09:00", links, [draft], [
      { scheduleTargetId: "tab-1", label: "Codex" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ prompt: draft, stopped: null, strand: { label: "Codex" } });
  });

  it("keeps a closed target visible but refuses to nominate a strand", () => {
    expect(nextAfter("source", links, [draft], [])[0]).toMatchObject({ stopped: "closed", strand: undefined });
  });

  it("carries an edge's commands to the queued target and offers them as chips", () => {
    const withClear = [{ ...links[0], preface: ["/clear"] }];
    expect(nextAfter("source", withClear, [draft], [{ scheduleTargetId: "tab-1", label: "Codex" }])[0].link.preface).toEqual(["/clear"]);
    // A command the agent no longer offers stays a chip, so it can be switched off.
    expect(edgeCommandChoices(["/clear", "/compact"], ["/old"])).toEqual(["/clear", "/compact", "/old"]);
    expect(toggleEdgeCommand(["/clear", "/compact"], ["/compact"], "/clear")).toEqual(["/clear", "/compact"]);
    expect(toggleEdgeCommand(["/clear", "/compact"], ["/clear"], "/clear")).toEqual([]);
  });

  it("does not resolve a target that is no longer a draft", () => {
    expect(nextAfter("source", links, [], [{ scheduleTargetId: "tab-1", label: "Codex" }])).toEqual([]);
  });
});
