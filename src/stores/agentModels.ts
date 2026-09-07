import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { shortModelName } from "../lib/agentModel";
import { adoptTypedPrompt } from "../lib/agentPromptAdopt";
import { lastPromptEcho } from "../lib/agentPromptEcho";
import { terminalFor } from "../lib/terminalRegistry";
import { splitPtyId } from "../lib/ptyId";
import { useActivityStore } from "./activity";
import { isDetachedWindow } from "./detachedContext";
import { useTabsStore, type TabEntry } from "./tabs";

/**
 * Which model each agent tab last answered with, and the last prompt it was
 * given, keyed by composed PTY id.
 *
 * The backend reads both from the agent's own transcript (`agent_tab_model` /
 * `agent_tab_last_prompt`, `services::agent_session`) — the CLIs tell their
 * hooks nothing about the model, Eldrun passes no model flag, and a prompt
 * typed into the terminal never passes through Eldrun as a prompt (keystrokes
 * reach the PTY, the TUI's input box edits them, only the agent knows what was
 * submitted), so the transcript is the one honest source for both. An agent
 * whose transcript Eldrun cannot read (Gemini, Qwen, Codex on a release that
 * keeps no messages) falls back to the prompt echoed on the pane's own screen
 * (`lib/agentPromptEcho`) — the same parse the phone's Focus chat does. They
 * are re-read whenever a tab starts a turn (the activity store's `busyByTab` edge
 * — a prompt was just submitted) and whenever it finishes one (`lastDoneByTab`
 * — the only moment the model can change), and on demand from the views that
 * show them, throttled so a 30-second tick and a 5-second phone poll cost one
 * tail read between them. A prompt that *changed* at a turn's start was
 * submitted by a route Eldrun did not see — typed into the terminal — and is
 * adopted into the prompt history (`lib/agentPromptAdopt`), which is what the
 * prompt chart draws; one Eldrun sent itself is already there and is not
 * recorded twice.
 */
const REFRESH_FLOOR_MS = 10_000;
const askedAt: Record<string, number> = {};

interface AgentModelsStore {
  /** Composed PTY id → display label (`lib/agentModel.shortModelName`). Absent
   *  when the transcript names no model yet or the agent keeps none. */
  byTab: Record<string, string>;
  /** Composed PTY id → the last prompt the tab was given, one cleaned line,
   *  however it was submitted. Absent when the transcript holds none Eldrun
   *  can read. */
  promptByTab: Record<string, string>;
  /** Re-read one tab's model and last prompt. `force` skips the throttle (a
   *  turn just started or ended); `turnStarted` says the read is the one at a
   *  turn's start, where a changed prompt is a typed one to adopt. */
  refresh: (scope: string, tab: TabEntry, force?: boolean, turnStarted?: boolean) => Promise<void>;
}

export function isModelTaggedTab(tab: TabEntry): boolean {
  return (tab.kind === "agent" || tab.kind === "local_agent") && !!tab.sessionId;
}

export const useAgentModelsStore = create<AgentModelsStore>((set, get) => ({
  byTab: {},
  promptByTab: {},
  refresh: async (scope, tab, force = false, turnStarted = false) => {
    if (!isModelTaggedTab(tab)) return;
    const ptyId = `${scope}:${tab.key}`;
    const now = Date.now();
    const asked = askedAt[ptyId];
    if (!force && asked !== undefined && now - asked < REFRESH_FLOOR_MS) return;
    askedAt[ptyId] = now;
    const args = { agent: tab.cmd, projectId: scope === "root" ? null : scope, sessionId: tab.sessionId };
    // Two reads of the same tail; a failure of one must not cost the other.
    const [model, prompt] = await Promise.all([
      invoke("agent_tab_model", args).catch(() => null),
      invoke("agent_tab_last_prompt", args).catch(() => null),
    ]);
    const label = typeof model === "string" && model.trim() ? shortModelName(model) : "";
    let text = typeof prompt === "string" ? prompt.trim() : "";
    if (!text) {
      const term = terminalFor(ptyId);
      if (term) text = lastPromptEcho(term.buffer.active) ?? "";
    }
    const known = get().promptByTab[ptyId];
    if ((get().byTab[ptyId] ?? "") === label && (known ?? "") === text) return;
    // A prompt this store had never read (first read of a restored tab) is a
    // baseline, not news: only a change from a known one is a submission.
    // One window records: a popout's own copy of this store sees the same
    // edge, and the history's dedupe is only against rows already written.
    if (turnStarted && text && known !== undefined && known !== text && !isDetachedWindow()) void adoptTypedPrompt(scope, tab, text);
    set((state) => {
      const byTab = { ...state.byTab };
      if (label) byTab[ptyId] = label;
      else delete byTab[ptyId];
      const promptByTab = { ...state.promptByTab };
      if (text) promptByTab[ptyId] = text;
      else delete promptByTab[ptyId];
      return { byTab, promptByTab };
    });
  },
}));

/** How long after a tab turns busy the transcript is read a second time: the
 * agent writes the prompt before its first output, but the two are separate
 * writers, and a read that lands between them must not lose the prompt. */
const TURN_START_RECHECK_MS = 2_500;

function refreshTab(ptyId: string, turnStarted = false): void {
  const parts = splitPtyId(ptyId);
  const tab = parts && useTabsStore.getState().tabsByScope[parts.scope]?.find((entry) => entry.key === parts.key);
  if (tab) void useAgentModelsStore.getState().refresh(parts.scope, tab, true, turnStarted);
}

// A finished turn is the one moment the tag can have changed (a `/model` mid-
// session shows up in the next answer), and a turn *starting* is the moment
// a prompt was submitted — by whichever route — so both edges re-read for
// the Agents view and the phone at once, without either polling for them.
useActivityStore.subscribe((state, prev) => {
  if (state.lastDoneByTab !== prev.lastDoneByTab) {
    for (const [ptyId, at] of Object.entries(state.lastDoneByTab)) {
      if (prev.lastDoneByTab[ptyId] !== at) refreshTab(ptyId);
    }
  }
  if (state.busyByTab !== prev.busyByTab) {
    for (const [ptyId, busy] of Object.entries(state.busyByTab)) {
      if (busy && !prev.busyByTab[ptyId]) {
        refreshTab(ptyId, true);
        setTimeout(() => refreshTab(ptyId, true), TURN_START_RECHECK_MS);
      }
    }
  }
});
