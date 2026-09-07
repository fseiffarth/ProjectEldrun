import { useAgentPromptsStore, type SentAgentPrompt } from "../stores/agentPrompts";
import type { TabEntry } from "../stores/tabs";

/**
 * Prompts typed straight into an agent's terminal, adopted into the prompt
 * history so the prompt chart shows them beside the ones Eldrun sent.
 *
 * Eldrun sees a prompt go by only when it sends one itself (the composer, a
 * schedule): keystrokes into the terminal reach the PTY, the TUI's input box
 * edits them, and what was finally submitted is known to the agent alone —
 * and written to its transcript. `stores/agentModels` reads that transcript's
 * last prompt when a turn starts, and hands a *changed* one here. A prompt
 * Eldrun sent is already on the history (the composer archives at send time,
 * the scheduler records at delivery, both before the agent's first output
 * flips the tab busy), so the newest history row for the tab is compared
 * first and a match is left alone rather than recorded twice.
 *
 * The transcript's text is one folded line, cut at the backend's bound, so a
 * long typed prompt is recorded as its opening; the tab holds the whole of it.
 */

/** Whitespace folded the way the backend folds a transcript prompt
 * (`agent_session::clean_prompt_text`), so the two texts compare. */
export function foldPrompt(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(" ");
}

/** The tab's newest history row: its session first, its label as the
 * fallback for a tab that had no session id when the row was written. */
function newestFor(history: readonly SentAgentPrompt[], tab: TabEntry): SentAgentPrompt | undefined {
  let newest: SentAgentPrompt | undefined;
  for (const row of history) {
    const mine = (tab.sessionId && row.session_id === tab.sessionId) || row.tab_label === tab.label;
    if (!mine) continue;
    if (!newest || row.sent_at > newest.sent_at) newest = row;
  }
  return newest;
}

/** Whether `prompt` (a transcript's folded, possibly cut line) is the tab's
 * newest recorded prompt already — i.e. Eldrun sent it. */
export function alreadyRecorded(history: readonly SentAgentPrompt[], prompt: string, tab: TabEntry): boolean {
  const newest = newestFor(history, tab);
  if (!newest) return false;
  const recorded = foldPrompt(newest.message);
  const seen = foldPrompt(prompt);
  return seen.endsWith("…") ? recorded.startsWith(seen.slice(0, -1)) : recorded === seen;
}

/** Record `prompt` as delivered to `tab` unless it is already the tab's
 * newest history row. Never throws: a prompt the history cannot take is
 * still shown in the Agents view. */
export async function adoptTypedPrompt(scope: string, tab: TabEntry, prompt: string): Promise<void> {
  const store = useAgentPromptsStore.getState();
  const history = store.historyByProject[scope] ?? await store.loadHistory(scope).catch(() => [] as SentAgentPrompt[]);
  if (alreadyRecorded(history, prompt, tab)) return;
  await store
    .record(scope, {
      id: crypto.randomUUID(),
      message: prompt,
      sent: { tabLabel: tab.label, sessionId: tab.sessionId, agent: tab.cmd, result: "delivered" },
    })
    .catch(() => []);
}
