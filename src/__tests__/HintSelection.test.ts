import { describe, expect, it } from "vitest";
import { pickHint, type HintCtx } from "../lib/hints";

const empty: HintCtx = { projectCount: 0, activeId: null };
const active: HintCtx = { projectCount: 1, activeId: "p1" };

describe("pickHint", () => {
  it("offers create-project first on an empty workspace", () => {
    expect(pickHint(empty, new Set(), true)).toBe("create-project");
  });

  it("does not offer create-project once a project exists", () => {
    const picked = pickHint(active, new Set(), true);
    expect(picked).not.toBe("create-project");
    expect(picked).toBe("add-tab"); // highest-priority eligible with an active project
  });

  it("skips seen hints and falls through by priority", () => {
    expect(pickHint(active, new Set(["add-tab"]), true)).toBe("toggle-panels");
    expect(pickHint(active, new Set(["add-tab", "toggle-panels"]), true)).toBe("file-tree");
  });

  it("returns null when every eligible hint is seen", () => {
    const all = new Set(["create-project", "add-tab", "toggle-panels", "file-tree"]);
    expect(pickHint(active, all, true)).toBeNull();
  });

  it("returns null when hints are disabled", () => {
    expect(pickHint(empty, new Set(), false)).toBeNull();
  });

  it("nags about an untrusted Codex hook ahead of the onboarding hints", () => {
    // Situational and actionable, so it outranks add-tab (80) — but never the
    // empty-workspace prompt (100), which is the more urgent thing to do.
    const ctx: HintCtx = { ...active, codexHookNeedsTrust: true };
    expect(pickHint(ctx, new Set(), true)).toBe("codex-hook-trust");
    expect(pickHint({ ...empty, codexHookNeedsTrust: true }, new Set(), true)).toBe(
      "create-project",
    );
  });

  it("stays quiet about Codex when the hook is fine or unprobed", () => {
    // Absent (no Codex tab open) and false (hook trusted) both mean: say nothing.
    expect(pickHint(active, new Set(), true)).toBe("add-tab");
    expect(pickHint({ ...active, codexHookNeedsTrust: false }, new Set(), true)).toBe(
      "add-tab",
    );
  });
});
