/**
 * Groups the reading view's lines into the turns of a conversation, so an
 * agent tab reads like a chat: the agent's output on the left, the prompts
 * the user submitted on the right.
 *
 * This is the one place Focus reads a *shape* out of session text, and it is
 * kept to the single shape every agent TUI shares. When a prompt is submitted,
 * the TUI echoes it back into the transcript with its own input marker in
 * front — `> fix the tests` in Claude Code and Gemini CLI / Qwen Code (whose
 * box frame `readableScreen` has already stripped), `› fix the tests` in
 * Codex — at the left edge, with the lines of a multi-line prompt indented
 * under it. Nothing else the TUIs print starts a line that way: answers open
 * with `⏺`, `•` or `✦` and indent their continuation, tool calls with `⎿`,
 * and a quoted `>` inside an answer sits indented under its bullet. The one
 * look-alike — a select dialog's `❯ 1. Yes` row — is excluded by its number,
 * and the live input box at the bottom of the screen never reaches here:
 * `inputFrameStart` cuts it off first.
 *
 * Everything that is not a prompt echo is the agent's turn, verbatim. A turn
 * is a grouping for layout only: the lines keep their keys, their text and
 * the styles the program emitted, and Copy still copies the transcript as it
 * was printed, marker included.
 */

import type { ReadableLine, ReadableSpan } from "./readableScreen";

export interface ChatTurn {
  /** The key of the turn's first line — stable across frames the same way. */
  key: string;
  role: "user" | "agent";
  /** The lines as printed. */
  lines: readonly ReadableLine[];
  /** A user turn's lines with the echo marker and its indent removed — what
   * the bubble shows. Absent on an agent turn. */
  prompt?: readonly ReadableLine[];
}

/** The echoed prompt: the input marker at the left edge (at most one space
 * of frame padding before it), a space, then text. A bare marker is an empty
 * input box, not a prompt. */
const PROMPT_ECHO = /^ ?[>›❯] (?=\S)/u;
/** A numbered dialog row (`❯ 1. Yes`) — a question, never a prompt. */
const OPTION_ROW = /^ ?[>›❯] \d{1,2}[.)] /u;
/** Every TUI indents the further lines of a multi-line prompt under the
 * marker; an unindented line is the agent's again. */
const CONTINUATION = /^\s+\S/u;
/** Columns the marker and its space occupy — what the indent lines up with. */
const MARKER_WIDTH = 2;

/** Whether `line` is the start of an echoed prompt. */
export function isPromptEcho(line: { text: string }): boolean {
  return PROMPT_ECHO.test(line.text) && !OPTION_ROW.test(line.text);
}

/** A copy of `spans` with the first `count` characters removed. */
function dropLeading(spans: readonly ReadableSpan[], count: number): ReadableSpan[] {
  const out: ReadableSpan[] = [];
  let remaining = count;
  for (const span of spans) {
    if (remaining >= span.text.length) {
      remaining -= span.text.length;
      continue;
    }
    out.push(remaining > 0 ? { ...span, text: span.text.slice(remaining) } : span);
    remaining = 0;
  }
  return out;
}

/** The prompt's own words: the marker (and any frame padding before it) off
 * the first line, up to the marker's width of indent off the rest. */
function unmark(lines: readonly ReadableLine[]): ReadableLine[] {
  return lines.map((line, index) => {
    const lead = index === 0
      ? (PROMPT_ECHO.exec(line.text)?.[0].length ?? 0)
      : Math.min(MARKER_WIDTH, line.text.length - line.text.trimStart().length);
    if (lead === 0) return line;
    return { key: line.key, text: line.text.slice(lead), spans: dropLeading(line.spans, lead) };
  });
}

function trimBlank(lines: ReadableLine[]): ReadableLine[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].text === "") start += 1;
  while (end > start && lines[end - 1].text === "") end -= 1;
  return lines.slice(start, end);
}

/**
 * Splits `lines` into alternating agent and user turns, in order. The blank
 * rows a TUI leaves around a prompt echo are the seam between turns, not
 * content, and are dropped there; blanks inside an agent turn stay its
 * paragraph breaks.
 */
export function chatTurns(lines: readonly ReadableLine[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let agent: ReadableLine[] = [];
  const flushAgent = () => {
    const kept = trimBlank(agent);
    if (kept.length > 0) turns.push({ key: kept[0].key, role: "agent", lines: kept });
    agent = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!isPromptEcho(line)) {
      agent.push(line);
      index += 1;
      continue;
    }
    flushAgent();
    const prompt = [line];
    index += 1;
    while (index < lines.length && CONTINUATION.test(lines[index].text)) {
      prompt.push(lines[index]);
      index += 1;
    }
    turns.push({ key: line.key, role: "user", lines: prompt, prompt: unmark(prompt) });
  }
  flushAgent();
  return turns;
}
