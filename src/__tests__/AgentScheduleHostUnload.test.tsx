/**
 * A stopped project keeps its schedules. `deactivateProject` unloads the whole
 * in-memory scope (`unloadScope`) while the saved layout — and with it every
 * `scheduleTargetId` — stays on disk and restores on the next activation. The
 * host's tab diff used to read that as "every agent tab closed" and deleted the
 * project's schedules; only a tab vanishing from a scope that still exists is a
 * close.
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { AgentScheduleHost } from "../components/layout/AgentScheduleHost";
import { useAgentSchedulesStore } from "../stores/agentSchedules";
import { useTabsStore, type TabEntry } from "../stores/tabs";

const invokeMock = vi.mocked(invoke);

const agent: TabEntry = {
  key: "agent-1",
  label: "Claude",
  cmd: "claude",
  cwd: "/project",
  kind: "agent",
  sessionId: "session-1",
  scheduleTargetId: "target-1",
};

const deleteCalls = () =>
  invokeMock.mock.calls.filter(([command]) => command === "agent_schedules_delete_target");

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve([]));
  useAgentSchedulesStore.setState({ byTarget: {}, loading: {} });
  useTabsStore.setState({
    scope: "other",
    tabsByScope: { other: [], p: [agent] },
    layoutByScope: { other: null, p: null },
    focusedGroupByScope: { other: null, p: null },
    detachedGroupsByScope: {},
    hiddenGroupsByScope: {},
    pendingRespawnByScope: {},
  });
});

describe("AgentScheduleHost bindings across a project stop", () => {
  it("keeps a stopped project's schedules and deletes a closed tab's", async () => {
    await act(async () => {
      render(<AgentScheduleHost />);
    });
    expect(deleteCalls()).toHaveLength(0);

    // Stop the project: the scope key disappears, the layout stays on disk.
    await act(async () => {
      await useTabsStore.getState().unloadScope("p");
    });
    expect(useTabsStore.getState().tabsByScope.p).toBeUndefined();
    expect(deleteCalls()).toHaveLength(0);

    // Activate it again: the same binding comes back and is simply reloaded.
    await act(async () => {
      useTabsStore.setState((state) => ({ tabsByScope: { ...state.tabsByScope, p: [agent] } }));
    });
    expect(deleteCalls()).toHaveLength(0);

    // Closing the tab itself (scope still present) is what deletes.
    await act(async () => {
      useTabsStore.setState((state) => ({ tabsByScope: { ...state.tabsByScope, p: [] } }));
    });
    expect(deleteCalls()).toHaveLength(1);
    expect(deleteCalls()[0][1]).toEqual({ projectId: "p", scheduleTargetId: "target-1" });
  });
});
