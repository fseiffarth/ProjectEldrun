/**
 * Tests for the running-task indicator data source (#9, Group D):
 * - notePtyOutput marks a PTY's scope busy for the duration of the window
 * - busy state clears once output goes stale
 * - only scopes whose tabs produced recent output are flagged
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  useActivityStore,
  notePtyOutput,
  _clearPtyActivityForTest,
} from "../stores/activity";
import { useTabsStore } from "../stores/tabs";

function seedTabs() {
  // Two project scopes, each with one PTY tab whose key doubles as the PTY id.
  useTabsStore.setState({
    tabsByScope: {
      "proj-a": [
        { key: "agent-1", label: "a", cmd: "claude", cwd: "/a", kind: "agent" },
      ],
      "proj-b": [
        { key: "shell-1", label: "b", cmd: "", cwd: "/b", kind: "shell" },
      ],
    },
  });
}

describe("activity store running indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    seedTabs();
    _clearPtyActivityForTest();
    useActivityStore.setState({ busyByScope: {}, busyByTab: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flags the scope of a PTY that just emitted output", () => {
    notePtyOutput("agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByScope["proj-a"]).toBe(true);
    expect(useActivityStore.getState().busyByScope["proj-b"]).toBeUndefined();
  });

  it("clears busy once output is older than the window", () => {
    notePtyOutput("agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByScope["proj-a"]).toBe(true);

    vi.advanceTimersByTime(1000); // > BUSY_WINDOW_MS (800)
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByScope["proj-a"] ?? false).toBe(false);
  });

  it("does not flag a scope whose PTYs have been silent", () => {
    notePtyOutput("shell-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByScope["proj-b"]).toBe(true);
    expect(useActivityStore.getState().busyByScope["proj-a"] ?? false).toBe(false);
  });

  it("flags the individual tab that emitted output and clears when stale", () => {
    notePtyOutput("agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByTab["agent-1"]).toBe(true);
    expect(useActivityStore.getState().busyByTab["shell-1"]).toBeUndefined();

    vi.advanceTimersByTime(1000); // > BUSY_WINDOW_MS (800)
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByTab["agent-1"] ?? false).toBe(false);
  });
});
