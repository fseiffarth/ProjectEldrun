/**
 * The schedule store's guarded writes (`expectExistingOn` / `expectUndelivered`)
 * and `queuePromptForTab`'s refusal to reuse a recurring rule's id.
 *
 * A guard key must reach the backend only when a caller sets it: the phone and
 * every plain create send the shape a backend predating the guard accepts. And
 * a send-now under a prompt id that a recurring rule on the same tab already
 * carries would have the backend replace that rule by id — turning a daily rule
 * into one delivery the scheduler then retires.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import type { ScheduledAgentPrompt } from "../lib/agentSchedule";
import { queuePromptForTab } from "../stores/agentPrompts";
import { SCHEDULE_BUSY_ERROR, SCHEDULE_GONE_ERROR, useAgentSchedulesStore } from "../stores/agentSchedules";

const invokeMock = vi.mocked(invoke);
const once: ScheduledAgentPrompt = { id: "prompt-1", enabled: true, message: "go", rule: { type: "once", at: "2026-09-04T13:00" } };
const daily: ScheduledAgentPrompt = { id: "prompt-1", enabled: true, message: "go", rule: { type: "daily", time: "08:00" } };

const argsOf = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

function listing(schedules: ScheduledAgentPrompt[]) {
  invokeMock.mockImplementation((command: string) =>
    Promise.resolve(command === "agent_schedules_list" ? schedules : []));
}

beforeEach(() => {
  invokeMock.mockReset();
  listing([]);
  useAgentSchedulesStore.setState({ byTarget: {}, loading: {} });
});

describe("guarded schedule writes", () => {
  it("sends the guard keys only when they are set", async () => {
    const store = useAgentSchedulesStore.getState();
    await store.upsert("p", "t1", once);
    await store.upsert("p", "t1", once, {});
    await store.upsert("p", "t2", once, { expectExistingOn: "t1" });
    expect(argsOf("agent_schedule_upsert")).toEqual([
      { projectId: "p", scheduleTargetId: "t1", schedule: once },
      { projectId: "p", scheduleTargetId: "t1", schedule: once },
      { projectId: "p", scheduleTargetId: "t2", schedule: once, expectExistingOn: "t1" },
    ]);
    await store.remove("p", "t1", "prompt-1");
    await store.remove("p", "t1", "prompt-1", { expectUndelivered: false });
    await store.remove("p", "t1", "prompt-1", { expectUndelivered: true });
    expect(argsOf("agent_schedule_delete")).toEqual([
      { projectId: "p", scheduleTargetId: "t1", scheduleId: "prompt-1" },
      { projectId: "p", scheduleTargetId: "t1", scheduleId: "prompt-1" },
      { projectId: "p", scheduleTargetId: "t1", scheduleId: "prompt-1", expectUndelivered: true },
    ]);
  });

  it("rejects with the backend's own sentinel", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === "agent_schedule_upsert" ? Promise.reject(SCHEDULE_GONE_ERROR)
        : command === "agent_schedule_delete" ? Promise.reject(SCHEDULE_BUSY_ERROR)
          : Promise.resolve([]));
    const store = useAgentSchedulesStore.getState();
    await expect(store.upsert("p", "t1", once, { expectExistingOn: "t1" })).rejects.toBe("schedule_gone");
    await expect(store.remove("p", "t1", "prompt-1", { expectUndelivered: true })).rejects.toBe("schedule_busy");
  });
});

describe("queueing a prompt for a tab", () => {
  it("mints a fresh id rather than overwrite a recurring rule carrying the requested one", async () => {
    listing([daily]);
    const { id } = await queuePromptForTab("p", "t1", "go", { id: "prompt-1", now: new Date(2026, 8, 4, 12, 2) });
    const [write] = argsOf("agent_schedule_upsert") as { schedule: ScheduledAgentPrompt }[];
    expect(write.schedule.id).not.toBe("prompt-1");
    expect(write.schedule.id).toBe(id);
    expect(write.schedule.rule.type).toBe("once");
  });

  it("keeps the requested id when it names a one-time rule or nothing", async () => {
    listing([once]);
    expect((await queuePromptForTab("p", "t1", "go", { id: "prompt-1" })).id).toBe("prompt-1");
    listing([{ ...daily, id: "other" }]);
    expect((await queuePromptForTab("p", "t1", "go", { id: "prompt-1" })).id).toBe("prompt-1");
    expect((argsOf("agent_schedule_upsert") as { schedule: ScheduledAgentPrompt }[]).map((args) => args.schedule.id))
      .toEqual(["prompt-1", "prompt-1"]);
  });

  it("checks the list it just read, not a cache that knows nothing yet", async () => {
    // The cache says the tab is empty; the backend's list says otherwise.
    useAgentSchedulesStore.setState({ byTarget: {} });
    listing([daily]);
    await queuePromptForTab("p", "t1", "go", { id: "prompt-1" });
    expect((argsOf("agent_schedule_upsert")[0] as { schedule: ScheduledAgentPrompt }).schedule.id).not.toBe("prompt-1");
  });
});
