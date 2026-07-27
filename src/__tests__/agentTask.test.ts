/**
 * Tests for the agentTask store: capturing a per-tab terminal title (the agent
 * task summary) from a composed `<scope>:<key>` PTY id.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useAgentTaskStore } from "../stores/agentTask";

describe("useAgentTaskStore", () => {
  beforeEach(() => {
    useAgentTaskStore.setState({ titleByTab: {} });
  });

  it("stores a title under the bare tab key from a composed pty id", () => {
    useAgentTaskStore.getState().setTabTitle("proj-1:t7", "Refactoring the parser");
    expect(useAgentTaskStore.getState().titleByTab).toEqual({
      t7: "Refactoring the parser",
    });
  });

  it("splits only on the first colon (keys may themselves contain colons)", () => {
    useAgentTaskStore.getState().setTabTitle("root:a:b", "hi");
    expect(useAgentTaskStore.getState().titleByTab["a:b"]).toBe("hi");
  });

  it("ignores a bare (colon-less) id", () => {
    useAgentTaskStore.getState().setTabTitle("nope", "x");
    expect(useAgentTaskStore.getState().titleByTab).toEqual({});
  });

  it("trims and ignores an empty/whitespace title", () => {
    useAgentTaskStore.getState().setTabTitle("s:t", "   spaced   ");
    useAgentTaskStore.getState().setTabTitle("s:u", "   ");
    expect(useAgentTaskStore.getState().titleByTab).toEqual({ t: "spaced" });
  });

  it("does not churn state when the title is unchanged", () => {
    const store = useAgentTaskStore.getState();
    store.setTabTitle("s:t", "same");
    const before = useAgentTaskStore.getState().titleByTab;
    store.setTabTitle("s:t", "same");
    expect(useAgentTaskStore.getState().titleByTab).toBe(before);
  });

  it("clears a tab's title", () => {
    const store = useAgentTaskStore.getState();
    store.setTabTitle("s:t", "gone soon");
    store.clearTabTitle("t");
    expect(useAgentTaskStore.getState().titleByTab).toEqual({});
  });
});
