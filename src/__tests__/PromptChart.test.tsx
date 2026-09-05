import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { PromptChart } from "../components/agents/PromptChart";
import { localOccurrenceKey } from "../lib/agentSchedule";
import { useAgentPromptsStore } from "../stores/agentPrompts";
import { useAgentSchedulesStore } from "../stores/agentSchedules";
import type { TabEntry } from "../stores/tabs";

const tab: TabEntry = { key: "a", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", scheduleTargetId: "t", sessionId: "s" };

beforeEach(() => {
  const now = new Date();
  const prompts = [
    { id: "draft", message: "Plain draft", created_at: "x", updated_at: "x" },
    { id: "chain", message: "Chain target", created_at: "x", updated_at: "x" },
    { id: "future", message: "Future", created_at: "x", updated_at: "x" },
  ];
  const history = [{ id: "sent", message: "Already sent", created_at: "x", sent_at: new Date(now.getTime() - 60_000).toISOString(), tab_label: "Claude", session_id: "s", result: "delivered" as const }];
  const links = [{ id: "l", from: "draft", to: "chain", kind: "after" as const, target: "t" }];
  const schedules = [
    { id: "future", enabled: true, message: "Future", rule: { type: "once" as const, at: localOccurrenceKey(new Date(now.getTime() + 30 * 60_000)) } },
    { id: "queued", enabled: true, message: "Waiting", rule: { type: "once" as const, at: localOccurrenceKey(new Date(now.getTime() - 60_000)) } },
  ];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "agent_prompts_list") return prompts;
    if (command === "agent_prompt_history_list") return history;
    if (command === "agent_prompt_links_list") return links;
    if (command === "agent_schedules_list" || command === "agent_schedule_upsert") return schedules;
    return [];
  });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  useAgentSchedulesStore.setState({ byTarget: { ["p\u0000t"]: schedules }, loading: {} });
});

describe("PromptChart", () => {
  it("renders all five derived states", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    for (const state of ["draft", "chained", "scheduled", "queued", "sent"]) {
      expect(await screen.findByTestId(`prompt-chart-card-${state}`)).toBeTruthy();
    }
  });

  it("offers keyboard retiming on an expanded one-time card", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    const scheduled = await screen.findByTestId("prompt-chart-card-scheduled");
    fireEvent.click(scheduled);
    await act(async () => { fireEvent.click(screen.getByText("+ 5 min later")); });
    const call = vi.mocked(invoke).mock.calls.find(([name]) => name === "agent_schedule_upsert");
    expect(call).toBeTruthy();
    expect((call?.[1] as { schedule: { rule: { type: string } } }).schedule.rule.type).toBe("once");
  });

  it("dims non-matches until hide others is enabled", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "Plain draft" } });
    expect(screen.getByText("Chain target").closest("article")?.classList.contains("is-dimmed")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Hide others" }));
    expect(screen.queryByText("Chain target")).toBeNull();
  });

  it("collects a new draft from the chart toolbar", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    fireEvent.click(screen.getByRole("button", { name: "New draft" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Write a prompt to keep for later…" }), {
      target: { value: "Inspect the release" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Tags" }), { target: { value: "release, careful work" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add prompt" })); });
    const upsert = vi.mocked(invoke).mock.calls.find(([name]) => name === "agent_prompt_upsert");
    expect(upsert?.[1]).toMatchObject({
      projectId: "p",
      prompt: { message: "Inspect the release", tags: ["release", "careful-work"] },
    });
  });
});
