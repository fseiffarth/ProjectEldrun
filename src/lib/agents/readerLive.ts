import { agentWork, type WorkFacts } from "../../../mobile-web/src/terminal/agentBusy";
import { isPromptEcho } from "../../../mobile-web/src/terminal/chatTurns";
import { readableScreen, type ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import { questionParts } from "../../../mobile-web/src/terminal/questionParts";
import {
  readSelectPrompt,
  selectKeys,
  selectSignature,
  type QuestionTab,
  type SelectOption,
  type SelectPrompt,
} from "../../../mobile-web/src/terminal/selectPrompt";
import { inputFrameStart } from "../../../mobile-web/src/terminal/statusLine";

/**
 * What the desktop Reader (`TerminalReaderView`) reads off the pane's live
 * screen, which the stored transcript cannot carry: a choice the session is
 * waiting on (a permission prompt, a question, a picker) and whether the agent
 * is working right now. The phone's Focus reads the same two things the same
 * way (`mobile-web/src/screens/Terminal.tsx`: `liveTail`, `liveQuestion`,
 * `sessionWork`) — this is that reading over the xterm buffer, so a beginner
 * can answer and stop the agent without leaving the chat.
 */
export interface ReaderLive {
  /** The dialog on screen, when one is recognized (`readSelectPrompt`). */
  question: SelectPrompt | null;
  /** Its own question — the text right above its rows, with the TUI's word
   * wrap undone (`questionParts`): one entry per paragraph or kept break. */
  ask: string[];
  /** What it was drawn onto: a permission dialog's file or diff, as drawn.
   * Empty for an agent's own question — its message above is already the
   * conversation's last turn. */
  context: string[];
  /** An agent's own question's headers (Claude Code's tab row), as chips. */
  tabs: QuestionTab[];
  /** Identifies the dialog step, so one answer is not sent twice. */
  signature: string;
  /** The busy row's facts while the agent works; null when idle or asking. */
  working: WorkFacts | null;
}

export const NO_LIVE: ReaderLive = { question: null, ask: [], context: [], tabs: [], signature: "", working: null };

/** Reads `buffer` (the pane's active xterm buffer) for `agentLabel`'s TUI. */
export function readReaderLive(buffer: ReadableBufferLike, agentLabel: string): ReaderLive {
  const { lines } = readableScreen(buffer);
  // The input box and the rows under it are the TUI's frame, not output; the
  // tail after the last echoed prompt is what the session draws now.
  const screen = lines.slice(0, inputFrameStart(lines, agentLabel));
  let start = 0;
  screen.forEach((line, index) => { if (isPromptEcho(line, agentLabel)) start = index + 1; });
  const tail = screen.slice(start);
  const question = tail.length > 0 ? readSelectPrompt(tail, agentLabel) : null;
  if (question) {
    const parts = questionParts(tail, question);
    return {
      question,
      ask: parts.ask.map((line) => line.text.trimEnd()),
      context: parts.tabs.length > 0 ? [] : parts.context.map((line) => line.text.trimEnd()),
      tabs: parts.tabs,
      signature: selectSignature(question),
      working: null,
    };
  }
  return { ...NO_LIVE, working: agentWork(lines) };
}

function tabsKey(tabs: readonly QuestionTab[]): string {
  return tabs.map((tab) => `${tab.answered ? "✓" : "☐"}${tab.label}`).join("\n");
}

/** Whether two readings would draw the same: the Reader re-renders only then. */
export function sameReaderLive(a: ReaderLive, b: ReaderLive): boolean {
  return a.signature === b.signature
    && a.ask.join("\n") === b.ask.join("\n")
    && a.context.join("\n") === b.context.join("\n")
    && tabsKey(a.tabs) === tabsKey(b.tabs)
    && (a.working === null) === (b.working === null)
    && a.working?.elapsed === b.working?.elapsed
    && a.working?.tokens === b.working?.tokens;
}

/** The keystrokes that answer `question` with `option`: arrows from the
 * highlighted row, then Enter — what the phone sends for a tapped row. */
export function answerKeys(question: SelectPrompt, option: SelectOption): string[] {
  return selectKeys(question.current, option.index);
}

/** Esc: the key Claude Code, Codex and OpenCode stop a running turn with. */
export const STOP_KEY = "\u001b";
