/**
 * The Agents view of the Files / Git / Apps / Agents row: every agent tab of
 * the scope (and only that scope) with its schedule summary, plus the scope's
 * collected prompts. "Send now" must write a one-time schedule at the current
 * minute against the chosen tab's schedule target, through the same command
 * the dialog uses.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import { AgentSchedulesView } from "../components/agents/AgentSchedulesView";
import { useAgentPromptsStore } from "../stores/agentPrompts";
import { useAgentSchedulesStore } from "../stores/agentSchedules";
import { useTabsStore, type TabEntry } from "../stores/tabs";

const agent: TabEntry = {
  key: "agent-1",
  label: "Claude",
  cmd: "claude",
  cwd: "/project",
  kind: "agent",
  sessionId: "session-abc",
  scheduleTargetId: "target-1",
};
const shell: TabEntry = { key: "shell-1", label: "Shell", cmd: "bash", cwd: "/project", kind: "shell" };
const foreign: TabEntry = { ...agent, key: "agent-2", label: "Other project", scheduleTargetId: "target-2" };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "agent_prompts_list") {
      return [{ id: "prompt-1", message: "Run the tests", created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:00:00Z" }];
    }
    if (command === "agent_schedule_upsert" || command === "agent_schedules_list") return [];
    if (command === "agent_prompt_upsert" || command === "agent_prompt_delete") return [];
    if (command === "agent_prompt_archive" || command === "agent_prompt_history_list") return [];
    return [];
  });
  useAgentSchedulesStore.setState({ byTarget: {}, loading: {} });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, loading: {} });
  useTabsStore.setState((state) => ({
    ...state,
    tabsByScope: { p: [agent, shell], q: [foreign] },
  }));
});

describe("AgentSchedulesView", () => {
  it("lists the scope's agent tabs only and loads their schedules", async () => {
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    const rows = screen.getAllByTestId("agent-prompts-tab");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Claude");
    expect(screen.queryByText("Other project")).toBeNull();
    expect(vi.mocked(invoke).mock.calls.some(([command, args]) =>
      command === "agent_schedules_list" && (args as { scheduleTargetId: string }).scheduleTargetId === "target-1")).toBe(true);
    expect(vi.mocked(invoke).mock.calls.some(([, args]) =>
      (args as { scheduleTargetId?: string })?.scheduleTargetId === "target-2")).toBe(false);
  });

  it("sends a collected prompt as a one-time schedule at the current minute on the target tab", async () => {
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    expect(await screen.findByText("Run the tests")).toBeTruthy();
    // The target is chosen in the row, at the moment of the send — there is no
    // view-wide target dropdown any more.
    await act(async () => {
      fireEvent.click(screen.getByText("Send now"));
    });
    expect(screen.getByText("Send to which tab?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Claude/ }));
    });
    const upsert = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_schedule_upsert");
    expect(upsert).toBeTruthy();
    const args = upsert![1] as { projectId: string; scheduleTargetId: string; schedule: { message: string; rule: { type: string; at: string } } };
    expect(args.projectId).toBe("p");
    expect(args.scheduleTargetId).toBe("target-1");
    expect(args.schedule.message).toBe("Run the tests");
    expect(args.schedule.rule.type).toBe("once");
    expect(args.schedule.rule.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(screen.getByText(/Queued for Claude/)).toBeTruthy();
    // Sending retires the prompt to the history, with the session it went to.
    const archive = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_prompt_archive");
    expect(archive).toBeTruthy();
    const sent = (archive![1] as {
      promptId: string;
      sent: { tab_label: string; session_id: string | null; agent: string | null };
    });
    expect(sent.promptId).toBe("prompt-1");
    expect(sent.sent.tab_label).toBe("Claude");
    expect(sent.sent.session_id).toBe("session-abc");
    expect(sent.sent.agent).toBe("claude");
    // The queued schedule carries the prompt's own id, so the delivery the
    // scheduler records later lands on this row instead of adding a second.
    expect((upsert![1] as { schedule: { id: string } }).schedule.id).toBe("prompt-1");
  });

  it("submits the composer's prefix chips and model pick ahead of the prompt", async () => {
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "/clear" }));
      fireEvent.change(screen.getByLabelText("Ask Claude…"), { target: { value: "check the build" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Send to this tab"));
    });
    const upsert = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_schedule_upsert");
    const schedule = (upsert![1] as { schedule: { message: string; preface?: string[] } }).schedule;
    expect(schedule.message).toBe("check the build");
    expect(schedule.preface).toEqual(["/clear"]);
  });

  it("collects a new prompt for the scope", async () => {
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Summarise the diff" } });
      fireEvent.click(screen.getByText("Add prompt"));
    });
    const upsert = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_prompt_upsert");
    expect(upsert).toBeTruthy();
    expect((upsert![1] as { projectId: string; prompt: { message: string } }).projectId).toBe("p");
    expect((upsert![1] as { prompt: { message: string } }).prompt.message).toBe("Summarise the diff");
  });

  /**
   * The Sent prompts list is where a scheduled delivery ends up: what happened
   * to it, the prompt, the tab and agent it went to, the session that took it,
   * and both times — when it was due and when it actually went.
   */
  it("shows a scheduled delivery with its outcome, agent, session and times", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "agent_prompts_list") return [];
      if (command === "agent_prompt_history_list") {
        return [
          {
            id: "rule-1@2026-09-02T09:00",
            message: "Morning standup",
            created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
            sent_at: new Date(Date.now() - 60_000).toISOString(),
            tab_label: "Claude",
            session_id: "session-abcdef123456",
            agent: "claude",
            result: "delivered",
            scheduled_for: "2026-09-02T09:00",
            preface: ["/clear"],
          },
          {
            id: "prompt-9",
            message: "Waiting one",
            created_at: new Date().toISOString(),
            sent_at: new Date().toISOString(),
            tab_label: "Claude",
          },
        ];
      }
      return [];
    });
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });

    const rows = await screen.findAllByTestId("agent-prompts-sent");
    // Newest first: the queued one was sent last.
    expect(rows[0].textContent).toContain("Queued");
    const delivered = rows[1];
    expect(delivered.textContent).toContain("Delivered");
    expect(delivered.textContent).toContain("Morning standup");
    expect(delivered.textContent).toContain("claude");
    // The whole id, not a prefix: it is what gets pasted into `--resume`.
    expect(delivered.textContent).toContain("session session-abcdef123456");
    expect(delivered.textContent).toContain("/clear");
    expect(delivered.textContent).toMatch(/was due .*9:00|was due .*09:00/);
    expect(delivered.textContent).toContain("collected 3 days ago");
  });

  it("copies a sent prompt's whole session id from the row", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "agent_prompt_history_list") {
        return [
          {
            id: "rule-1@2026-09-02T09:00",
            message: "Morning standup",
            created_at: new Date().toISOString(),
            sent_at: new Date().toISOString(),
            tab_label: "Claude",
            session_id: "session-abcdef123456",
            agent: "claude",
            result: "delivered",
          },
        ];
      }
      return [];
    });
    await act(async () => {
      render(<AgentSchedulesView scope="p" active />);
    });

    const copy = await screen.findByLabelText("Copy this session id");
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(writeText).toHaveBeenCalledWith("session-abcdef123456");
  });
});
