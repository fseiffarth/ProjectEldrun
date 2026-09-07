import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));

import { alreadyRecorded, foldPrompt } from "../lib/agentPromptAdopt";
import { useActivityStore } from "../stores/activity";
import { useAgentModelsStore } from "../stores/agentModels";
import { useAgentPromptsStore, type SentAgentPrompt } from "../stores/agentPrompts";
import { useTabsStore, type TabEntry } from "../stores/tabs";

const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "session-abc", scheduleTargetId: "target-1" };
const row = (message: string, sent_at: string, extra: Partial<SentAgentPrompt> = {}): SentAgentPrompt =>
  ({ id: sent_at, message, created_at: sent_at, sent_at, tab_label: "Claude", session_id: "session-abc", ...extra });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("adopting a prompt typed into the terminal", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(invoke).mockReset();
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useActivityStore.setState({ busyByTab: {}, lastDoneByTab: {} });
    useAgentModelsStore.setState({ byTab: {}, promptByTab: {} });
    useAgentPromptsStore.setState({ byProject: {}, historyByProject: {}, linksByProject: {}, loading: {} });
  });

  it("a prompt Eldrun sent is the tab's newest history row and is not recorded again", () => {
    const history = [row("fix the tests", "2026-09-07T10:00:00Z"), row("write\n  docs", "2026-09-07T11:00:00Z")];
    expect(alreadyRecorded(history, "write docs", tab)).toBe(true);
    expect(alreadyRecorded(history, "fix the tests", tab)).toBe(false);
    // A long prompt reaches here cut, and still matches its own opening.
    expect(alreadyRecorded([row("a".repeat(400), "2026-09-07T12:00:00Z")], `${"a".repeat(300)}…`, tab)).toBe(true);
    // Another tab's rows say nothing about this one; a row from before the
    // tab had a session id is matched by label.
    expect(alreadyRecorded([row("write docs", "2026-09-07T13:00:00Z", { tab_label: "Codex", session_id: "other" })], "write docs", tab)).toBe(false);
    expect(alreadyRecorded([row("write docs", "2026-09-07T13:00:00Z", { session_id: undefined })], "write docs", tab)).toBe(true);
    expect(foldPrompt("  a \n\n b\tc ")).toBe("a b c");
  });

  it("records a prompt that changed at a turn's start, and neither the first read nor one Eldrun sent", async () => {
    let lastPrompt = "fix the tests";
    const recorded: unknown[] = [];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "agent_tab_model") return "claude-opus-4-1";
      if (command === "agent_tab_last_prompt") return lastPrompt;
      if (command === "agent_prompt_history_list") return [row("fix the tests", "2026-09-07T10:00:00Z")];
      if (command === "agent_prompt_record") { recorded.push(args); return []; }
      return [];
    });
    // First read: a baseline for a tab this store had never seen.
    useActivityStore.setState({ busyByTab: { "p:agent-1": true } });
    await flush(); await flush();
    expect(useAgentModelsStore.getState().promptByTab["p:agent-1"]).toBe("fix the tests");
    expect(recorded).toHaveLength(0);
    // The user types a new prompt into the terminal: the transcript changes
    // and the tab turns busy again.
    lastPrompt = "now the\n  docs";
    useActivityStore.setState({ busyByTab: {} });
    useActivityStore.setState({ busyByTab: { "p:agent-1": true } });
    await flush(); await flush(); await flush();
    expect(useAgentModelsStore.getState().promptByTab["p:agent-1"]).toBe("now the\n  docs");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ projectId: "p", entry: { message: "now the\n  docs", sent: { tab_label: "Claude", session_id: "session-abc", agent: "claude", result: "delivered" } } });
    // A prompt the composer sent is on the history before the turn starts.
    useAgentPromptsStore.setState({ historyByProject: { p: [row("now the docs", "2026-09-07T11:00:00Z"), row("from the composer", "2026-09-07T12:00:00Z")] } });
    lastPrompt = "from the composer";
    useActivityStore.setState({ busyByTab: {} });
    useActivityStore.setState({ busyByTab: { "p:agent-1": true } });
    await flush(); await flush(); await flush();
    expect(recorded).toHaveLength(1);
  });
});
