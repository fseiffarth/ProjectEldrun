/** Ctrl-A, Ctrl-K: put the agent's own line editor at the start of its line and
 * kill whatever is on it, so the phone composer is the sole text entry surface. */
export const AGENT_LINE_RESET = "\u0001\u000b";

/** Bracketed paste (DECSET 2004). The closing marker ends the pasted run
 * explicitly, so the carriage return after it is read as a submit even when it
 * arrives in the same chunk — which is what the trip from a phone does to
 * writes the composer deliberately spaced milliseconds apart. Without the
 * markers a Codex TUI reads `text CR` from one chunk as a single paste and
 * leaves the message sitting unsent in its own composer. */
export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";

/** The phone composer is a plain-text surface. A control byte in the draft
 * would close the paste early or be read as a keypress of its own, so only
 * newlines survive — not tabs, which an agent composer reads as "complete". */
function messageText(draft: string): string {
  return draft
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    // Trailing blank lines would otherwise open the agent's next turn with
    // empty lines; a phone keyboard adds them easily.
    .replace(/\s+$/, "");
}

/**
 * The writes that deliver one composed message to an agent's line editor.
 *
 * Split, never joined: a stdin chunk that opens with a control byte is read by
 * an agent TUI as that one keypress with the remainder dropped, so the line
 * reset needs a write of its own. The gaps between the writes are best-effort:
 * the phone spaces them, and the network is free to bunch them up again.
 *
 * With bracketed paste on, the draft rides inside the markers and the submit
 * cannot be absorbed into it, whatever the link did to the spacing. Without
 * them, an embedded newline goes out as `\n` (Ctrl-J), which agent composers
 * insert as a line break, while `\r` is what submits — that is what keeps a
 * multi-line phone draft one message instead of one message per line.
 */
export function agentInputWrites(draft: string, bracketedPaste = false): string[] {
  const text = messageText(draft);
  if (bracketedPaste) return [AGENT_LINE_RESET, `${PASTE_START}${text}${PASTE_END}`, "\r"];
  const lines = text.split("\n");
  const writes = [AGENT_LINE_RESET];
  lines.forEach((line, index) => {
    if (index) writes.push("\n");
    if (line) writes.push(line);
  });
  writes.push("\r");
  return writes;
}
