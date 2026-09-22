import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { screenModelTag, shortModelName } from "../../lib/agents/agentModel";
import { AGENT_ITEMS } from "../../components/tabs/newTabItems";
import { adoptTranscriptPrompts, adoptTypedPrompt, type TranscriptPrompt } from "../../lib/agents/prompt/adopt";
import { lastPromptEcho } from "../../lib/agents/prompt/echo";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { splitPtyId } from "../../lib/terminal/ptyId";
import { useActivityStore } from "../activity";
import { isDetachedWindow } from "../detachedContext";
import { useTabsStore, type TabEntry } from "../tabs";

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
 * (`lib/agents/prompt/echo`) — the same parse the phone's Focus chat does. They
 * are re-read whenever a tab starts a turn (the activity store's `busyByTab` edge
 * — a prompt was just submitted) and whenever it finishes one (`lastDoneByTab`
 * — the only moment the model can change), and on demand from the views that
 * show them, throttled so a 30-second tick and a 5-second phone poll cost one
 * tail read between them. A prompt that *changed* at a turn's start was
 * submitted by a route Eldrun did not see — typed into the terminal — and is
 * adopted into the prompt history (`lib/agents/prompt/adopt`), which is what the
 * prompt chart draws; one Eldrun sent itself is already there and is not
 * recorded twice.
 */
const REFRESH_FLOOR_MS = 10_000;
const askedAt: Record<string, number> = {};

/** The floor is module state, so resetting the store between two tests still
 * leaves the next read of a tab refused. */
export function clearAgentModelFloorForTest(): void {
  for (const key of Object.keys(askedAt)) delete askedAt[key];
}

interface AgentModelsStore {
  /** Composed PTY id → display label (`lib/agents/agentModel.shortModelName`). Absent
   *  when the transcript names no model yet or the agent keeps none. What the
   *  views show is `agentTabModelTag` below, which puts the pane's own status
   *  line in front of this. */
  byTab: Record<string, string>;
  /** Composed PTY id → the last prompt the tab was given, one cleaned line,
   *  however it was submitted. Absent when the transcript holds none Eldrun
   *  can read. */
  promptByTab: Record<string, string>;
  /** Composed PTY id → the same tail the prompt above is the end of, oldest
   *  first, each with the transcript's own time. The phone's project overview
   *  draws the whole list under an agent card, so it is kept rather than
   *  reduced to its last entry — and it comes from the read that already
   *  happens, not a second one. Absent for an agent whose transcript Eldrun
   *  cannot read: the screen-echo fallback yields one line with no time, which
   *  belongs in `promptByTab` alone. */
  recentByTab: Record<string, TranscriptPrompt[]>;
  /** Re-read one tab's model and last prompt. `force` skips the throttle (a
   *  turn just started or ended); `turnStarted` says the read is the one at a
   *  turn's start, where a changed prompt is a typed one to adopt. */
  refresh: (scope: string, tab: TabEntry, force?: boolean, turnStarted?: boolean) => Promise<void>;
}

export function isModelTaggedTab(tab: TabEntry): boolean {
  return (tab.kind === "agent" || tab.kind === "local_agent") && !!tab.sessionId;
}

/** The CLI's own name for the agent a tab runs — what the shared screen
 * parsers scope their family rules by (OpenCode's mini frame, Antigravity's
 * footer). The registry's label for the binary, or the tab's own name for a
 * custom command the registry has never heard of, which is the rule the
 * sidecar publishes to the phone as `agent_label` (`discovery::agent_label_of`)
 * — so both sides read one screen the same way. */
export function agentTabLabel(tab: TabEntry): string {
  return AGENT_ITEMS.find((item) => item.cmd === tab.cmd)?.label ?? tab.label;
}

/**
 * The model tag one agent tab wears, for every surface that shows one: the
 * Agents view here and the phone's tab cards through the mobile bridge.
 *
 * The pane's own status line comes first — the model in the words the session
 * prints, with the reasoning effort beside it where it prints one
 * (`lib/agents/agentModel.screenModelTag`), which is exactly what the phone's
 * Focus chip reads off the same screen. Behind it stands `byTab`, the
 * transcript's model id shortened: the transcript names the model of the last
 * *answer*, so a `/model` switch is invisible there until the next one, and it
 * names it as an API id rather than in the session's own words. A tab whose
 * pane this window does not hold — popped out, or never mounted — has no
 * screen to read and is tagged from the transcript alone.
 *
 * Read at display time rather than stored: the screen can change without a
 * turn, which is precisely the case the transcript misses, and both callers
 * re-render (or re-poll) often enough to follow it.
 */
export function agentTabModelTag(
  scope: string,
  tab: TabEntry,
  byTab: Record<string, string>,
): string | undefined {
  const ptyId = `${scope}:${tab.key}`;
  const term = terminalFor(ptyId);
  const shown = term && screenModelTag(term.buffer.active, agentTabLabel(tab));
  return shown || byTab[ptyId];
}

/** Prompts only ever arrive at the end of the tail (and fall off its front),
 * so length plus the newest entry settles whether a read brought news. */
function sameRecent(a: TranscriptPrompt[] | undefined, b: TranscriptPrompt[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const left = a[a.length - 1];
  const right = b[b.length - 1];
  return !left || !right || (left.text === right.text && left.at === right.at);
}

export const useAgentModelsStore = create<AgentModelsStore>((set, get) => ({
  byTab: {},
  promptByTab: {},
  recentByTab: {},
  refresh: async (scope, tab, force = false, turnStarted = false) => {
    if (!isModelTaggedTab(tab)) return;
    const ptyId = `${scope}:${tab.key}`;
    const now = Date.now();
    const asked = askedAt[ptyId];
    if (!force && asked !== undefined && now - asked < REFRESH_FLOOR_MS) return;
    askedAt[ptyId] = now;
    const args = { agent: tab.cmd, projectId: scope === "root" ? null : scope, sessionId: tab.sessionId };
    // Reads of the same tail; a failure of one must not cost the others.
    const [model, recent] = await Promise.all([
      invoke("agent_tab_model", args).catch(() => null),
      invoke("agent_tab_recent_prompts", args).catch(() => null),
    ]);
    // A backend predating the recent-prompts read answers with a rejection;
    // then the last prompt alone is read, and adopted the old way below. An
    // empty list still asks for the last prompt: one whose record carries no
    // timestamp is not in the timed list, and the line beside the tab still
    // has something to say.
    const timed = Array.isArray(recent) ? (recent as TranscriptPrompt[]) : null;
    const prompt = timed?.length
      ? timed[timed.length - 1].text
      : await invoke("agent_tab_last_prompt", args).catch(() => null);
    const label = typeof model === "string" && model.trim() ? shortModelName(model) : "";
    let text = typeof prompt === "string" ? prompt.trim() : "";
    if (!text) {
      const term = terminalFor(ptyId);
      if (term) text = lastPromptEcho(term.buffer.active) ?? "";
    }
    // One window records: a popout's own copy of this store sees the same
    // edge, and the history's dedupe is only against rows already written.
    // With timestamps every missing prompt is adopted at its own time —
    // messages sent mid-turn and the first prompt after a launch included.
    if (timed?.length && !isDetachedWindow()) void adoptTranscriptPrompts(scope, tab, timed);
    const known = get().promptByTab[ptyId];
    const knownRecent = get().recentByTab[ptyId];
    // A backend predating the recent-prompts read (`timed === null`) leaves the
    // list as it stands rather than clearing it: it has nothing to say about
    // the tail, and an empty list would be read as "nothing was ever asked".
    const nextRecent = timed ?? knownRecent;
    if (
      (get().byTab[ptyId] ?? "") === label
      && (known ?? "") === text
      && sameRecent(knownRecent, nextRecent)
    ) return;
    // Without them, a prompt this store had never read (first read of a
    // restored tab) is a baseline, not news: only a change from a known one
    // is a submission.
    if (!timed && turnStarted && text && known !== undefined && known !== text && !isDetachedWindow()) void adoptTypedPrompt(scope, tab, text);
    set((state) => {
      const byTab = { ...state.byTab };
      if (label) byTab[ptyId] = label;
      else delete byTab[ptyId];
      const promptByTab = { ...state.promptByTab };
      if (text) promptByTab[ptyId] = text;
      else delete promptByTab[ptyId];
      const recentByTab = { ...state.recentByTab };
      if (nextRecent?.length) recentByTab[ptyId] = nextRecent;
      else delete recentByTab[ptyId];
      return { byTab, promptByTab, recentByTab };
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
