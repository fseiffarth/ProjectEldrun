import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { PromptChart } from "../components/agents/PromptChart";
import { useAgentPromptsStore } from "../stores/agentPrompts";
import { useAgentSchedulesStore } from "../stores/agentSchedules";
import { useSettingsStore } from "../stores/settings";
import type { TabEntry } from "../stores/tabs";

const tab: TabEntry = { key: "a", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", scheduleTargetId: "t", sessionId: "s" };
const NOW = new Date(2026, 8, 4, 12, 2, 0);
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const WRITES = ["agent_prompt_upsert", "agent_schedule_upsert", "agent_schedule_delete", "agent_prompt_history_clear", "agent_prompt_archive"];

let history: Record<string, unknown>[] = [];

/** Press at y 10, cross the threshold, end at `toY`. */
async function lift(card: Element, toY: number) {
  fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 20 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: toY });
  await act(async () => { fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: toY }); });
}

const itemOf = (card: Element) => card.closest<HTMLElement>(".agent-prompt-timeline-item")!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  history = [{ id: "sent", message: "Already sent", created_at: "x", sent_at: ago(1), tab_label: "Claude", session_id: "s", result: "delivered" }];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => (command === "agent_prompt_history_list" ? history : []));
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  useSettingsStore.setState({ settings: null, loaded: true });
  useAgentSchedulesStore.setState({ byTarget: {}, loading: {} });
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PromptChart sent-card lift", () => {
  it("moves a sent card down its lane only, writes nothing, and does not toggle it open", async () => {
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    const card = await screen.findByTestId("prompt-chart-card-sent");
    const item = itemOf(card);
    const left = item.style.left;
    expect(item.style.top).toBe("8px");

    await lift(card, 70);
    expect(itemOf(card).style.top).toBe("68px");
    // The pointer went sideways too; the instant stays put.
    expect(itemOf(card).style.left).toBe(left);
    // The click the release produces is the drag's, not a toggle.
    fireEvent.click(card);
    expect(card.querySelector(".agent-prompt-card-expanded")).toBeNull();
    // The body grows to hold a card lifted below the lanes.
    await lift(card, 400);
    expect(parseFloat(screen.getByTestId("prompt-timeline-body").style.height)).toBeGreaterThanOrEqual(458 + 120);

    const commands = vi.mocked(invoke).mock.calls.map(([command]) => command);
    for (const write of WRITES) expect(commands).not.toContain(write);
  });

  it("stops a session card at the body's top, and brings it back down without a dead zone", async () => {
    history = [
      { id: "h1", message: "First ask", created_at: "x", sent_at: ago(120), tab_label: "Claude", session_id: "s", result: "delivered" },
      { id: "h2", message: "Second ask", created_at: "x", sent_at: ago(60), tab_label: "Claude", session_id: "s", result: "delivered" },
    ];
    await act(async () => { render(<PromptChart scope="p" active tabs={[tab]} />); });
    const session = await screen.findByTestId("prompt-chart-session");

    await lift(session, -500);
    expect(itemOf(session).style.top).toBe("0px");
    await lift(session, 30);
    expect(itemOf(session).style.top).toBe("20px");
  });
});
