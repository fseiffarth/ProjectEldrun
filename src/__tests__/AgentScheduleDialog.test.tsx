/**
 * Regression for the schedule dialog's first render. A target has no cache
 * entry until its backend load completes, and the empty fallback must remain a
 * stable external-store snapshot or React loops and unmounts the whole app.
 *
 * Plus the two things the dialog gained once it had users: a **status** column,
 * because a list of rules answers "when" and never "is this going to fire", and
 * a one-time instant entered in `common/DateTimeField` rather than the native
 * `<input type="datetime-local">` whose six engine-ordered segments were the
 * hardest thing in here to aim at.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve([])),
}));

import { invoke } from "@tauri-apps/api/core";
import { AgentScheduleDialog } from "../components/agents/AgentScheduleDialog";
import { useAgentSchedulesStore } from "../stores/agentSchedules";
import type { TabEntry } from "../stores/tabs";

const tab: TabEntry = {
  key: "agent-1",
  label: "Claude",
  cmd: "claude",
  cwd: "/project",
  kind: "agent",
  scheduleTargetId: "schedule-target-1",
};

beforeEach(() => {
  useAgentSchedulesStore.setState({ byTarget: {}, loading: {} });
});

describe("AgentScheduleDialog", () => {
  it("opens before the target's schedule cache has loaded", async () => {
    await act(async () => {
      render(<AgentScheduleDialog scope="project-1" tab={tab} onClose={() => {}} />);
    });

    expect(document.querySelector(".agent-schedule-dialog")).toBeTruthy();
  });

  it("states what each schedule is doing, and what the tab as a whole will do next", async () => {
    // Through the load the dialog itself runs: seeding the store alone proves
    // nothing, since that load lands afterwards and replaces the cache.
    vi.mocked(invoke).mockResolvedValueOnce([
      { id: "a", enabled: true, message: "Continue", rule: { type: "daily", time: "09:00" } },
      { id: "b", enabled: false, message: "Weekly review", rule: { type: "daily", time: "17:00" } },
    ]);
    await act(async () => {
      render(<AgentScheduleDialog scope="project-1" tab={tab} onClose={() => {}} />);
    });

    const pills = [...document.querySelectorAll(".agent-schedule-pill")].map((p) => p.textContent);
    expect(pills).toContain("Paused");
    // One of the two is off, so the board reads "1 of 2".
    expect(document.querySelector(".agent-schedule-summary-counts")?.textContent).toContain("1");
  });

  it("takes a one-time instant from the drawn calendar, not a native datetime input", async () => {
    let root!: ReturnType<typeof render>;
    await act(async () => {
      root = render(<AgentScheduleDialog scope="project-1" tab={tab} onClose={() => {}} />);
    });
    await act(async () => {
      fireEvent.change(root.getByDisplayValue("Daily"), { target: { value: "once" } });
    });

    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(document.querySelector(".datetime-field")).toBeTruthy();
    // The shortcuts are the reason it is easier: a common instant is one click.
    expect(document.querySelectorAll(".datetime-chip").length).toBeGreaterThan(0);
  });

  /**
   * A one-time rule that has run is a receipt, not a plan. It is retired to the
   * side panel's Sent prompts — with the tab, agent, session and both times —
   * and this menu keeps only what still has a future.
   */
  it("leaves finished one-time prompts out of a menu about the future", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      {
        id: "done",
        enabled: true,
        message: "Already delivered",
        rule: { type: "once", at: "2026-09-01T09:00" },
        last: { occurrence: "2026-09-01T09:00", result: "delivered", at: "2026-09-01T09:00:12Z" },
      },
      { id: "daily", enabled: true, message: "Every morning", rule: { type: "daily", time: "09:00" } },
    ]);
    await act(async () => {
      render(<AgentScheduleDialog scope="project-1" tab={tab} onClose={() => {}} />);
    });

    const rows = [...document.querySelectorAll(".agent-schedule-row")];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Every morning");
    expect(document.body.textContent).not.toContain("Already delivered");
    // The board counts what is left, not what already ran.
    expect(document.querySelector(".agent-schedule-summary-counts")?.textContent).toContain("1");
  });

  /**
   * A prompt that needs `/clear` and a model at 9:00 needs them every 9:00, so
   * the rule carries the composer's prefix commands and model pick — typed as
   * the agent's own slash commands ahead of the message.
   */
  it("saves the prefix commands and model the rule types before its prompt", async () => {
    await act(async () => {
      render(<AgentScheduleDialog scope="project-1" tab={tab} onClose={() => {}} />);
    });

    fireEvent.click(screen.getByRole("button", { name: "/clear" }));
    const trigger = [...document.querySelectorAll(".dropdown-trigger")].find((el) =>
      el.textContent?.includes("Leave unchanged"),
    );
    fireEvent.click(trigger!);
    fireEvent.click(screen.getByRole("option", { name: "opus" }));
    fireEvent.change(document.querySelector(".agent-schedule-form textarea")!, {
      target: { value: "Continue the refactor" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    const upsert = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_schedule_upsert");
    expect(upsert).toBeTruthy();
    // The model goes last: a `/clear` before it would drop the CLI back to its
    // default and silently undo the pick.
    expect((upsert![1] as { schedule: { preface?: string[] } }).schedule.preface)
      .toEqual(["/clear", "/model opus"]);
  });
});
