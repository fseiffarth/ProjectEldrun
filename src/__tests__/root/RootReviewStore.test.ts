import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { useRootReviewStore, type RootProposal } from "../../stores/rootReview";

const proposal = (over: Partial<RootProposal> = {}): RootProposal => ({
  id: "p", tab: "root:a", tool: "todo_update", args: {}, created: "0", rows: [], calendars: [],
  tainted: false, status: "pending", undo: false, digest: "seen", closed: false, ...over,
});
const initial = useRootReviewStore.getState();
beforeEach(() => {
  vi.clearAllMocks();
  useRootReviewStore.setState({ ...initial, proposals: [proposal()], count: 1, error: null, busy: false });
});

describe("deciding on a stale digest", () => {
  it("refreshes to what the backend now holds and surfaces the backend's error", async () => {
    const fresh = proposal({ digest: "fresh", status: "conflicted" });
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "root_mcp_review_apply") {
        expect(args).toEqual({ id: "p", digest: "seen" });
        throw new Error("Proposal changed; refresh the review");
      }
      if (command === "root_mcp_review_list") return [fresh];
      if (command === "root_mcp_import_list") return [];
      return undefined;
    });
    await useRootReviewStore.getState().decide(proposal(), "apply");
    const state = useRootReviewStore.getState();
    expect(invoke).toHaveBeenCalledWith("root_mcp_review_list");
    expect(state.proposals[0].digest).toBe("fresh");
    expect(state.proposals[0].status).toBe("conflicted");
    expect(state.count).toBe(0);
    expect(state.error).toContain("Proposal changed; refresh the review");
    expect(state.busy).toBe(false);
    // The next decision goes out with the refreshed digest, and a success
    // clears the error.
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "root_mcp_review_reject") { expect(args).toEqual({ id: "p", digest: "fresh" }); return undefined; }
      if (command === "root_mcp_review_list") return [proposal({ digest: "fresh", status: "rejected" })];
      if (command === "root_mcp_import_list") return [];
      return undefined;
    });
    await useRootReviewStore.getState().decide(useRootReviewStore.getState().proposals[0], "reject");
    expect(useRootReviewStore.getState().error).toBeNull();
    expect(useRootReviewStore.getState().proposals[0].status).toBe("rejected");
  });

  it("keeps the error when the refresh after a failed decision fails too, and ignores a second click while busy", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "root_mcp_review_undo") throw new Error("Proposal cannot be decided in this state");
      if (command === "root_mcp_review_list") throw new Error("MCP proposal log exceeds its size limit");
      return [];
    });
    const first = useRootReviewStore.getState().decide(proposal(), "undo");
    await useRootReviewStore.getState().decide(proposal(), "undo");
    await first;
    expect(invoke.mock.calls.filter(([c]) => c === "root_mcp_review_undo").length).toBe(1);
    expect(useRootReviewStore.getState().error).toContain("Proposal cannot be decided in this state");
  });
});
