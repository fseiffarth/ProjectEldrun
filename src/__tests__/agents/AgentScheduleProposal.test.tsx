import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentScheduleProposal } from "../../components/agents/AgentScheduleProposal";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import type { ScheduledAgentPrompt } from "../../lib/agents/agentSchedule";

const approve = vi.fn().mockResolvedValue([]);
const dismiss = vi.fn().mockResolvedValue(undefined);
const row: ScheduledAgentPrompt = {
  id: "agent-a", enabled: false, message: "Continue the tests",
  rule: { type: "once", at: "2026-09-21T09:00" },
  origin: { by: "agent", session: "spawn-a", at: "2026-09-20T12:00:00Z", from_delivery: "previous" },
};
beforeEach(() => {
  vi.clearAllMocks();
  useAgentSchedulesStore.setState({ upsert: approve, remove: dismiss });
});
it("approval preserves attribution and uses the existing guarded enable path", async () => {
  render(<AgentScheduleProposal projectId="p" targetId="t" schedule={row} />);
  expect(screen.getByText("Proposed by agent")).toBeTruthy();
  expect(screen.getByText("Following delivery previous")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Approve" })); });
  expect(approve).toHaveBeenCalledWith("p", "t", { ...row, enabled: true }, { expectExistingOn: "t" });
});
it("dismissal deletes only the displayed schedule and shows backend refusals", async () => {
  dismiss.mockRejectedValueOnce(new Error("schedule_busy"));
  render(<AgentScheduleProposal projectId="p" targetId="t" schedule={row} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss" })); });
  expect(dismiss).toHaveBeenCalledWith("p", "t", "agent-a", { expectUndelivered: true });
  expect(screen.getByRole("alert").textContent).toContain("schedule_busy");
});
it("approved rows retain attribution without proposal actions; user rows have neither", () => {
  const view = render(<AgentScheduleProposal projectId="p" targetId="t" schedule={{ ...row, enabled: true }} />);
  expect(screen.getByText("Agent-authored")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  view.rerender(<AgentScheduleProposal projectId="p" targetId="t" schedule={{ ...row, origin: undefined }} />);
  expect(screen.queryByText("Agent-authored")).toBeNull();
});
