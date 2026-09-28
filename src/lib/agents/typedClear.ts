/**
 * Whether the user just typed an agent CLI's new-conversation command into its
 * pane — the one way the window learns of a `/clear` from an agent whose hooks
 * say nothing (every CLI but Claude and Codex), for "Undo clear".
 *
 * Follows the line as typed: printable text and pastes add to it, Backspace
 * takes from it, and any other key (arrows, Tab completion, a Ctrl chord)
 * makes it unknown until the next Enter. So a command finished by completion
 * is missed rather than guessed at; one typed out in full is seen.
 */
const NEW_CONVERSATION = /^\/(clear|new|new-chat|reset)$/u;
/** Longer than any command above; a line past it can match none of them. */
const MAX_LINE = 32;

const lineByPty: Record<string, string | null> = {};

/** Feed one chunk of the user's input; true when its Enter submitted a
 * new-conversation command. */
export function noteTypedLine(ptyId: string, data: string): boolean {
  // Bracketed-paste markers carry no text; a paste is typing done at once.
  const text = data.replace(/\x1b\[20[01]~/gu, "");
  // `null` is a line that is no longer known (see above); absent is empty.
  let line: string | null = ptyId in lineByPty ? lineByPty[ptyId] : "";
  let cleared = false;
  if (text.includes("\x1b")) {
    lineByPty[ptyId] = null;
    return false;
  }
  for (const ch of text) {
    if (ch === "\r" || ch === "\n") {
      if (line !== null && NEW_CONVERSATION.test(line.trim())) cleared = true;
      line = "";
    } else if (line === null) {
      continue;
    } else if (ch === "\x7f" || ch === "\b") {
      line = line.slice(0, -1);
    } else if (ch < " ") {
      line = null;
    } else if (line.length < MAX_LINE) {
      line += ch;
    } else {
      line = null;
    }
  }
  lineByPty[ptyId] = line;
  return cleared;
}

/** Forget a pane's line (tab closed). */
export function forgetTypedLine(ptyId: string): void {
  delete lineByPty[ptyId];
}
