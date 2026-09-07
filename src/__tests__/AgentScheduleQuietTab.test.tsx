/**
 * A prompt sent at an agent tab has to reach it whether or not anyone is
 * looking at that tab.
 *
 * Both regressions here are the same shape — a gate that reads "nothing has
 * happened yet" as "something is happening right now", and so never opens:
 *
 *  - The delivery settle gate treated a PTY with NO recorded output as one that
 *    had produced output this instant, so a tab whose whole TUI arrived as a
 *    restored snapshot (nothing streamed since) was never deliverable at all.
 *  - The blame wait after a delivery blocks the next one, so two prompts cannot
 *    overlap. A delivery that never produced output (the agent exited, the CLI
 *    swallowed the paste) held that block for the life of the window, and every
 *    later "Send to this tab" silently did nothing.
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/terminalInput", () => ({
  writePtyInput: vi.fn(() => Promise.resolve()),
}));

import { AgentScheduleHost } from "../components/layout/AgentScheduleHost";
import { writePtyInput } from "../lib/terminalInput";
import {
  _clearScheduledAgentInputsForTest,
  registerScheduledAgentInput,
} from "../lib/scheduledAgentInput";
import { useActivityStore } from "../stores/activity";
import { useAgentPromptsStore } from "../stores/agentPrompts";
import { useAgentSchedulesStore } from "../stores/agentSchedules";
import { useTabsStore, type TabEntry } from "../stores/tabs";

const invokeMock = vi.mocked(invoke);
const writeMock = vi.mocked(writePtyInput);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

const agent: TabEntry = {
  key: "agent-1",
  label: "Claude",
  cmd: "claude",
  cwd: "/project",
  kind: "agent",
  sessionId: "session-1",
  scheduleTargetId: "target-1",
};

/** A "Send to this tab": a one-time rule at a minute that has just passed. */
function sendNow(id: string, message: string) {
  return { id, enabled: true, message, rule: { type: "once", at: "2026-09-01T08:59" } };
}

function delivered(): string[] {
  return writeMock.mock.calls.map(([, bytes]) => decode(bytes));
}

/** Let the host's async delivery run: its writes are chained through short
 *  timers, so one advance is not enough to reach the last of them. */
async function settle(): Promise<void> {
  for (let step = 0; step < 20; step += 1) await vi.advanceTimersByTimeAsync(100);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T09:00:30"));
  invokeMock.mockReset();
  writeMock.mockReset();
  writeMock.mockResolvedValue(undefined);
  _clearScheduledAgentInputsForTest();
  useAgentSchedulesStore.setState({ byTarget: {}, loading: {} });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, loading: {} });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useTabsStore.setState({
    scope: "p",
    tabsByScope: { p: [agent] },
    layoutByScope: { p: null },
    focusedGroupByScope: { p: null },
    detachedGroupsByScope: {},
    hiddenGroupsByScope: {},
    pendingRespawnByScope: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("delivering to a tab nobody is watching", () => {
  it("sends to a ready tab that has produced no output this session", async () => {
    invokeMock.mockImplementation((command) =>
      Promise.resolve(command === "agent_schedules_list"
        ? [sendNow("prompt-1", "check the build")]
        : command === "agent_schedule_claim"
          ? true
          : []),
    );
    registerScheduledAgentInput("target-1", {
      ptyId: "p:agent-1",
      ready: () => true,
      bracketedPaste: () => false,
      recordAuthorizedInput: () => {},
    });

    await act(async () => {
      render(<AgentScheduleHost />);
    });
    await act(async () => { await settle(); });

    expect(delivered().join("")).toContain("check the build");
  });

  it("gives up on the blame wait rather than blocking every later prompt", async () => {
    let schedules = [sendNow("prompt-1", "first prompt")];
    invokeMock.mockImplementation((command) =>
      Promise.resolve(command === "agent_schedules_list"
        ? schedules
        : command === "agent_schedule_claim"
          ? true
          : []),
    );
    registerScheduledAgentInput("target-1", {
      ptyId: "p:agent-1",
      ready: () => true,
      bracketedPaste: () => false,
      recordAuthorizedInput: () => {},
    });

    await act(async () => {
      render(<AgentScheduleHost />);
    });
    await act(async () => { await settle(); });
    expect(delivered().join("")).toContain("first prompt");

    // The tab produced nothing at all in reply, so the blame wait never
    // resolves on its own. A second prompt aimed at the same tab must still go.
    writeMock.mockClear();
    schedules = [sendNow("prompt-2", "second prompt")];
    useAgentSchedulesStore.setState({ byTarget: {} });
    await act(async () => { await vi.advanceTimersByTimeAsync(11 * 60_000); });
    await act(async () => { await settle(); });

    expect(delivered().join("")).toContain("second prompt");
  });
});
