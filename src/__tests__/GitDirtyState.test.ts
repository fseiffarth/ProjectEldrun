import { describe, it, expect } from "vitest";
import { gitDirtyState } from "../stores/gitDirty";

const status = (over: Partial<{ staged: number; unstaged: number; untracked: number; is_repo: boolean }>) => ({
  staged: 0,
  unstaged: 0,
  untracked: 0,
  has_remote: false,
  is_repo: true,
  ...over,
});

describe("gitDirtyState", () => {
  it("reports clean for a non-repo regardless of counts", () => {
    expect(gitDirtyState(status({ is_repo: false, untracked: 5, staged: 2 }), 3)).toBe("clean");
  });

  it("reports clean when nothing is pending", () => {
    expect(gitDirtyState(status({}), 0)).toBe("clean");
  });

  it("reports dirty for untracked or unstaged working-tree changes", () => {
    expect(gitDirtyState(status({ untracked: 1 }), 0)).toBe("dirty");
    expect(gitDirtyState(status({ unstaged: 1 }), 0)).toBe("dirty");
  });

  it("reports staged when only staged changes exist", () => {
    expect(gitDirtyState(status({ staged: 2 }), 0)).toBe("staged");
  });

  it("reports unpushed when only local commits are ahead", () => {
    expect(gitDirtyState(status({}), 4)).toBe("unpushed");
  });

  it("prioritizes dirty over staged over unpushed", () => {
    expect(gitDirtyState(status({ untracked: 1, staged: 1 }), 2)).toBe("dirty");
    expect(gitDirtyState(status({ staged: 1 }), 2)).toBe("staged");
  });
});
