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
});
