/**
 * Locks the usage store's write path.
 *
 * Counters are accumulated in memory and flushed in batches, so the invariants
 * that matter are: one `usage_bump` per scope (not per event), fractional seconds
 * survive as whole seconds (the backend store is u64-typed — a float would fail
 * to deserialize and lose the batch), a drained batch is never re-sent, and a tab
 * counts as "used" once a day however often it is prompted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import {
  _pendingUsageForTest,
  _resetUsageForTest,
  bumpUsage,
  flushUsage,
  markAgentActive,
} from "../stores/usage";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined as never);
  _resetUsageForTest();
});

/** The metrics payload `usage_bump` was called with for a scope. */
function payloadFor(scope: string): Record<string, number> | undefined {
  const call = invokeMock.mock.calls.find(
    (c) => c[0] === "usage_bump" && (c[1] as { projectId: string }).projectId === scope,
  );
  return call ? (call[1] as { metrics: Record<string, number> }).metrics : undefined;
}

describe("bumpUsage", () => {
  it("accumulates repeated bumps rather than sending each one", () => {
    bumpUsage("p1", "shell.command");
    bumpUsage("p1", "shell.command");
    bumpUsage("p1", "shell.command");
    expect(_pendingUsageForTest()["p1"]["shell.command"]).toBe(3);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps scopes separate", () => {
    bumpUsage("p1", "tab.opened");
    bumpUsage("p2", "tab.opened");
    expect(_pendingUsageForTest()["p1"]["tab.opened"]).toBe(1);
    expect(_pendingUsageForTest()["p2"]["tab.opened"]).toBe(1);
  });

  it("ignores non-positive and non-finite amounts", () => {
    bumpUsage("p1", "agent.worked_s", 0);
    bumpUsage("p1", "agent.worked_s", -5);
    bumpUsage("p1", "agent.worked_s", NaN);
    bumpUsage("", "tab.opened");
    expect(_pendingUsageForTest()).toEqual({});
  });
});

describe("flushUsage", () => {
  it("sends one usage_bump per scope", async () => {
    bumpUsage("p1", "shell.command", 2);
    bumpUsage("p1", "tab.opened");
    bumpUsage("p2", "tab.opened");
    await flushUsage();

    const bumps = invokeMock.mock.calls.filter((c) => c[0] === "usage_bump");
    expect(bumps).toHaveLength(2);
    expect(payloadFor("p1")).toEqual({ "shell.command": 2, "tab.opened": 1 });
    expect(payloadFor("p2")).toEqual({ "tab.opened": 1 });
  });

  it("clears the batch so a second flush re-sends nothing", async () => {
    bumpUsage("p1", "tab.opened");
    await flushUsage();
    invokeMock.mockClear();

    await flushUsage();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does nothing when there is nothing pending", async () => {
    await flushUsage();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rounds fractional seconds to integers", async () => {
    // Agent working time arrives as a sub-second slice per activity tick. The
    // backend counter is u64: a float would fail to deserialize and drop the
    // whole batch, and flooring each slice on arrival would round every one to 0.
    bumpUsage("p1", "agent.worked_s", 0.4);
    bumpUsage("p1", "agent.worked_s", 0.4);
    bumpUsage("p1", "agent.worked_s", 0.4);
    await flushUsage();

    const metrics = payloadFor("p1")!;
    expect(metrics["agent.worked_s"]).toBe(1); // 1.2 → 1
    expect(Number.isInteger(metrics["agent.worked_s"])).toBe(true);
  });

  it("drops a counter that rounds to zero instead of sending a no-op", async () => {
    bumpUsage("p1", "agent.worked_s", 0.2);
    bumpUsage("p1", "tab.opened", 1);
    await flushUsage();

    const metrics = payloadFor("p1")!;
    expect(metrics["agent.worked_s"]).toBeUndefined();
    expect(metrics["tab.opened"]).toBe(1);
  });

  it("does not send a scope whose every counter rounded away", async () => {
    bumpUsage("p1", "agent.worked_s", 0.1);
    await flushUsage();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("survives a failing invoke without throwing", async () => {
    invokeMock.mockRejectedValue(new Error("backend down") as never);
    bumpUsage("p1", "tab.opened");
    await expect(flushUsage()).resolves.toBeUndefined();
  });
});

describe("markAgentActive", () => {
  it("counts a tab once however many times it is prompted", () => {
    expect(markAgentActive("p1", "p1:agent-1", "agent.active.claude")).toBe(true);
    expect(markAgentActive("p1", "p1:agent-1", "agent.active.claude")).toBe(false);
    expect(markAgentActive("p1", "p1:agent-1", "agent.active.claude")).toBe(false);
    expect(_pendingUsageForTest()["p1"]["agent.active.claude"]).toBe(1);
  });

  it("counts two different tabs separately", () => {
    markAgentActive("p1", "p1:agent-1", "agent.active.claude");
    markAgentActive("p1", "p1:agent-2", "agent.active.claude");
    expect(_pendingUsageForTest()["p1"]["agent.active.claude"]).toBe(2);
  });
});
