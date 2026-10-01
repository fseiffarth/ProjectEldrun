import type { TranslationKey } from "../i18n";
import type { SessionTranscript } from "../../../mobile-web/src/api";
import type { TabEntry } from "../../stores/tabs";

/**
 * The desktop agent pane's Reader: the phone's Focus Reader — the agent's
 * stored conversation as chat bubbles, read off the CLI's own transcript by
 * `agent_tab_transcript` (`services::agent_transcript`) — drawn over the
 * pane's terminal, which keeps running underneath. Optional per tab: the
 * terminal stays the default, and the last choice is remembered per agent
 * CLI, as the phone remembers its view.
 */

export type { SessionTranscript };

/** The agents whose transcript the backend reads; any other family answers
 * `unsupported` there. The phone bridge's list (`MobileBridgeHost`). */
const READER_AGENTS = new Set(["claude", "codex", "opencode"]);

/** Whether `tab` can be shown as a Reader: an agent tab whose CLI keeps a
 * transcript Eldrun reads. A local-model tab keeps none. */
export function readerOffered(tab: Pick<TabEntry, "kind" | "cmd"> | undefined): boolean {
  return !!tab && tab.kind === "agent" && READER_AGENTS.has(tab.cmd);
}

/** How many turns a read asks for first, and how many more each "earlier". */
export const READER_STEP = 60;

/** The `agent_tab_transcript` arguments for `tab` in `scope` — the phone
 * bridge's resolution: OpenCode's session is the newest one of the folder the
 * tab runs in, begun since it launched unless it was restored with
 * `--continue`. Null for a tab with no session id yet (the agent's hook has
 * not recorded one): there is no transcript to name. `subagent` is the handle
 * on one of its `agent` entries, whose own conversation is read instead. */
export function readerRequest(
  scope: string,
  tab: Pick<TabEntry, "cmd" | "sessionId" | "launchedAt" | "args" | "cwd">,
  cwd: string | undefined,
  version: string | undefined,
  limit: number,
  subagent?: string,
): Record<string, unknown> | null {
  if (!tab.sessionId) return null;
  return {
    agent: tab.cmd,
    projectId: scope === "root" ? null : scope,
    tabDir: tab.cwd || cwd || null,
    since: tab.launchedAt && !tab.args?.includes("--continue") ? tab.launchedAt : null,
    sessionId: tab.sessionId,
    subagent: subagent ?? null,
    version: version ?? null,
    limit,
  };
}

/** Why the stored session is not shown, for the Reader's empty state. */
export function readerReasonKey(transcript: SessionTranscript | null): TranslationKey {
  if (!transcript) return "terminal.reader.loading";
  switch (transcript.reason) {
    case "unsupported": return "terminal.reader.unsupported";
    case "no_session": return "terminal.reader.noSession";
    case "no_transcript": return "terminal.reader.missing";
    default: return "terminal.reader.unreadable";
  }
}

/** A fresh read merged over the last one: `unchanged` keeps what is shown. */
export function mergeTranscript(previous: SessionTranscript | null, next: SessionTranscript): SessionTranscript {
  return next.unchanged && previous ? previous : next;
}

const STORAGE_KEY = "eldrun.agentReader.byAgent";
/** The one window-wide choice that briefly replaced the per-CLI one: a CLI
 * without its own choice yet starts from it. */
const SHARED_KEY = "eldrun.agentReader.open";

function readChoices(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** The view the user last picked for this agent CLI's tabs: true for the
 * Reader. Unset (or unreadable storage) is the terminal. */
export function rememberedReader(agent: string): boolean {
  const chosen = readChoices()[agent];
  if (typeof chosen === "boolean") return chosen;
  try {
    return localStorage.getItem(SHARED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Every CLI's remembered view, for the store's start. */
export function rememberedReaders(): Record<string, boolean> {
  return Object.fromEntries([...READER_AGENTS].map((agent) => [agent, rememberedReader(agent)]));
}

export function rememberReader(agent: string, on: boolean): void {
  try {
    const choices = readChoices();
    choices[agent] = on;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // A convenience only: without storage every tab opens on its terminal.
  }
}
