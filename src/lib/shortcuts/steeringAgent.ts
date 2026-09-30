/**
 * Steering's agent keys on the tab level — the desktop half of the phone
 * composer's Clear / Plan / Goal chips, acting on the focused pane's active
 * agent tab.
 *
 *  - Clear submits `/clear` the way a scheduled prefix command goes in
 *    (`submitScheduledAgentCommand`), and offers "Undo clear" as a typed one
 *    does (`noteTypedClear`). Every agent CLI Eldrun launches reads `/clear` as
 *    a new conversation (see the phone's `NEW_CONVERSATION_COMMAND`).
 *  - Plan / Goal only lead the tab's prompt with the command — the user writes
 *    the rest and submits it themselves, as with the chips. They are typed
 *    through the xterm (`Terminal.input`), so the pane's own input bookkeeping
 *    sees them like any keystroke; Ctrl-A first puts them at the start of a
 *    draft already there. Offered only to the CLIs that document them
 *    (`agentDraftPrefixes`).
 *
 * Eldrun chooses nothing here: each key types what the user could have typed
 * into the agent's own CLI (AGENTS.md, agent authority).
 */
import { agentDraftPrefixes, agentFamily } from "../../../shared/agentComposer";
import { submitScheduledAgentCommand, submitScheduledAgentMessage } from "../agents/scheduledAgentInput";
import { terminalFor } from "../terminal/terminalRegistry";
import { useActivityStore } from "../../stores/activity";
import { agentTabLabel } from "../../stores/agents/agentModels";
import { noteTypedClear } from "../../stores/agents/agentClearUndo";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { SteeringBaseLevel } from "../../stores/keyboardSteering";

/** What the Clear key types. */
const NEW_CONVERSATION_COMMAND = "/clear";
/** Ctrl-A: the start of the agent's input line. */
const LINE_START = "\u0001";

export type SteeringAgentCommand = "/plan" | "/goal";

/** Which agent keys the tab takes: none for a tab that is not an agent. */
export interface SteeringAgentOffer {
  clear: boolean;
  plan: boolean;
  goal: boolean;
  prompt: boolean;
}

const NONE: SteeringAgentOffer = { clear: false, plan: false, goal: false, prompt: false };

function isAgentTab(tab: TabEntry | null | undefined): tab is TabEntry {
  return !!tab && (tab.kind === "agent" || tab.kind === "local_agent");
}

export function steeringAgentOffer(tab: TabEntry | null | undefined): SteeringAgentOffer {
  if (!isAgentTab(tab)) return NONE;
  const prefixes = agentDraftPrefixes(agentFamily(agentTabLabel(tab)));
  return { clear: true, plan: prefixes.includes("/plan"), goal: prefixes.includes("/goal"), prompt: true };
}

/** The active tab of the active scope — the one the focused pane shows. */
export function steeringActiveTab(): { scope: string; tab: TabEntry } | null {
  const s = useTabsStore.getState();
  const tab = s.activeKey ? s.tabs.find((t) => t.key === s.activeKey) : undefined;
  return tab ? { scope: s.scope, tab } : null;
}

/**
 * `/clear` into the tab. False when it did not go in: not an agent tab, the
 * pane not ready for input, or Codex at work (it answers "disabled while a task
 * is in progress" and keeps the conversation, so no undo is offered either).
 */
export async function clearAgentTab(scope: string, tab: TabEntry): Promise<boolean> {
  if (!steeringAgentOffer(tab).clear || !tab.scheduleTargetId) return false;
  const ptyId = `${scope}:${tab.key}`;
  if (agentFamily(agentTabLabel(tab)) === "codex" && useActivityStore.getState().busyByTab[ptyId]) return false;
  try {
    await submitScheduledAgentCommand(tab.scheduleTargetId, NEW_CONVERSATION_COMMAND);
  } catch {
    return false;
  }
  noteTypedClear(ptyId);
  return true;
}

/**
 * Lead the tab's prompt with `/plan ` or `/goal ` and give its terminal the
 * keyboard. False when the tab's CLI does not take the command or its terminal
 * is not in this window.
 */
export function leadAgentPrompt(scope: string, tab: TabEntry, command: SteeringAgentCommand): boolean {
  const offer = steeringAgentOffer(tab);
  if (!(command === "/plan" ? offer.plan : offer.goal)) return false;
  const term = terminalFor(`${scope}:${tab.key}`);
  if (!term) return false;
  term.focus();
  term.input(`${LINE_START}${command} `, true);
  return true;
}

/** What `requestSteeringPrompt` sends: the tab the text goes to, the steering
 *  level to come back to, and whether a prompt box answered. */
export interface SteeringPromptDetail {
  scope: string;
  tab: TabEntry;
  level: SteeringBaseLevel;
  handled: boolean;
}

/** Window event the `SteeringPromptOverlay` answers by opening its text box. */
export const STEERING_PROMPT_EVENT = "eldrun:steering-prompt";

/** Ask the prompt box to open for `tab`; false when the tab is not an agent or
 *  no box is mounted. */
export function requestSteeringPrompt(scope: string, tab: TabEntry, level: SteeringBaseLevel): boolean {
  if (!steeringAgentOffer(tab).prompt) return false;
  const detail: SteeringPromptDetail = { scope, tab, level, handled: false };
  window.dispatchEvent(new CustomEvent<SteeringPromptDetail>(STEERING_PROMPT_EVENT, { detail }));
  return detail.handled;
}

/**
 * Submit `text` into the agent tab as one prompt. Throws when it did not go in
 * (no schedule binding, the pane not ready for input, nothing left after
 * sanitizing) — the box keeps the text and shows why.
 */
export async function sendSteeringPrompt(tab: TabEntry, text: string): Promise<void> {
  if (!steeringAgentOffer(tab).prompt || !tab.scheduleTargetId) throw new Error("not an agent tab");
  await submitScheduledAgentMessage(tab.scheduleTargetId, text);
}
