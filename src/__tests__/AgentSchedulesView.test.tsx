import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));

import { AgentSchedulesView } from "../components/agents/AgentSchedulesView";
import { useActivityStore } from "../stores/activity";
import { useAgentPromptsStore } from "../stores/agentPrompts";
import { useAgentSchedulesStore } from "../stores/agentSchedules";
import { useTabsStore, type TabEntry } from "../stores/tabs";

const agent: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/project", kind: "agent", sessionId: "session-abc", scheduleTargetId: "target-1" };
const shell: TabEntry = { key: "shell", label: "Shell", cmd: "bash", cwd: "/project", kind: "shell" };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "agent_prompts_list") return [{ id: "draft", message: "Run the tests", tags: ["tests"], created_at: "x", updated_at: "x" }];
    if (command === "agent_prompt_history_list" || command === "agent_prompt_links_list" || command === "agent_schedules_list") return [];
    return [];
  });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useAgentSchedulesStore.setState({ byTarget: {}, loading: {} });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  useTabsStore.setState((state) => ({ ...state, scope: "p", tabsByScope: { p: [agent, shell] } }));
});

describe("AgentSchedulesView order and model tag", () => {
  const second: TabEntry = { key: "agent-2", label: "Codex", cmd: "codex", cwd: "/project", kind: "agent", sessionId: "session-def", scheduleTargetId: "target-2" };
  const names = () => screen.getAllByTestId("agent-prompts-tab").map((row) => row.querySelector(".agent-prompts-tab-name")?.textContent);

  beforeEach(() => {
    localStorage.removeItem("eldrun.agentsSort");
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [agent, second, shell] } }));
  });

  it("lists the most recently working tab first by default, and tags each with the model it last answered with", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "agent_tab_model") return (args as { agent: string }).agent === "claude" ? "claude-opus-4-1-20250805" : null;
      return [];
    });
    useActivityStore.setState({ lastWorkingByTab: { "p:agent-1": 1_000, "p:agent-2": 2_000 }, lastDoneByTab: { "p:agent-1": 3_000, "p:agent-2": 500 } });
    await act(async () => { render(<AgentSchedulesView scope="p" active />); });
    expect(names()).toEqual(["Codex", "Claude"]);
    expect((await screen.findByTestId("agent-model")).textContent).toBe("opus-4-1");
    expect(screen.getAllByTestId("agent-model")).toHaveLength(1);
    const modelCall = vi.mocked(invoke).mock.calls.find(([name, args]) => name === "agent_tab_model" && (args as { agent: string }).agent === "claude");
    expect(modelCall?.[1]).toMatchObject({ agent: "claude", projectId: "p", sessionId: "session-abc" });
  });

  it("a working tab outranks every timestamp, and the choice of order is remembered", async () => {
    useActivityStore.setState({ busyByTab: { "p:agent-1": true }, lastWorkingByTab: { "p:agent-2": 2_000 }, lastDoneByTab: { "p:agent-1": 100, "p:agent-2": 900 } });
    await act(async () => { render(<AgentSchedulesView scope="p" active />); });
    expect(names()).toEqual(["Claude", "Codex"]);
    fireEvent.click(screen.getByRole("button", { name: /Last working/ }));
    fireEvent.click(screen.getByRole("option", { name: "Last done" }));
    expect(names()).toEqual(["Codex", "Claude"]);
    expect(localStorage.getItem("eldrun.agentsSort")).toBe("lastDone");
    fireEvent.click(screen.getByRole("button", { name: /Last done/ }));
    fireEvent.click(screen.getByRole("option", { name: "Tab order" }));
    expect(names()).toEqual(["Claude", "Codex"]);
    const [claudeTimes, codexTimes] = screen.getAllByTestId("agent-tab-times").map((node) => node.textContent ?? "");
    expect(claudeTimes.startsWith("working now · finished ")).toBe(true);
    expect(codexTimes.startsWith("worked ")).toBe(true);
    expect(codexTimes).toContain(" · finished ");
  });
});

describe("AgentSchedulesView prompt chart", () => {
  it("keeps only the scope's agent tabs and replaces the three lists with one chart", async () => {
    await act(async () => { render(<AgentSchedulesView scope="p" active />); });
    expect(screen.getAllByTestId("agent-prompts-tab")).toHaveLength(1);
    expect(await screen.findByText("Prompt chart")).toBeTruthy();
    expect(screen.queryByText("Collected prompts")).toBeNull();
    expect(screen.queryByText("Scheduled prompts")).toBeNull();
    expect(screen.queryByText("Sent prompts")).toBeNull();
    expect((await screen.findByTestId("prompt-chart-card-draft")).textContent).toContain("Run the tests");
  });

  it("keeps the per-tab composer and its prefix send path", async () => {
    await act(async () => { render(<AgentSchedulesView scope="p" active />); });
    fireEvent.click(screen.getByRole("button", { name: "Prompt" }));
    fireEvent.click(screen.getByRole("button", { name: "/clear" }));
    fireEvent.change(screen.getByLabelText("Ask Claude…"), { target: { value: "Check it" } });
    await act(async () => { fireEvent.click(screen.getByText("Send to this tab")); });
    const call = vi.mocked(invoke).mock.calls.find(([name]) => name === "agent_schedule_upsert");
    expect((call?.[1] as { schedule: { message: string; preface: string[] } }).schedule).toMatchObject({ message: "Check it", preface: ["/clear"] });
  });

  it("collects a new draft through the chart toolbar", async () => {
    await act(async () => { render(<AgentSchedulesView scope="p" active />); });
    fireEvent.click(screen.getByRole("button", { name: "New draft" }));
    fireEvent.change(screen.getByLabelText("Write a prompt to keep for later…"), { target: { value: "Summarise the diff" } });
    await act(async () => { fireEvent.click(screen.getByText("Add prompt")); });
    const call = vi.mocked(invoke).mock.calls.find(([name]) => name === "agent_prompt_upsert");
    expect((call?.[1] as { prompt: { message: string } }).prompt.message).toBe("Summarise the diff");
  });

  it("dims a non-match and can hide it", async () => {
    await act(async () => { render(<AgentSchedulesView scope="p" active />); });
    const card = await screen.findByTestId("prompt-chart-card-draft");
    fireEvent.change(screen.getByLabelText("Search every prompt or #tag…"), { target: { value: "nothing" } });
    expect(card.className).toContain("is-dimmed");
    fireEvent.click(screen.getByRole("button", { name: "Hide others" }));
    expect(screen.queryByTestId("prompt-chart-card-draft")).toBeNull();
  });

  it("shows queued prompts in the strand rather than the tab row", async () => {
    const queued = { id: "q", enabled: true, message: "Wait for idle", rule: { type: "once", at: "2026-09-04T00:00" } };
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "agent_schedules_list") return [queued];
      if (command === "agent_prompts_list" || command === "agent_prompt_history_list" || command === "agent_prompt_links_list") return [];
      return [];
    });
    await act(async () => { render(<AgentSchedulesView scope="p" active />); });
    const strand = document.querySelector('[data-strand="strand:target-1"]')!;
    expect(within(strand as HTMLElement).getByText("Wait for idle")).toBeTruthy();
  });
});
