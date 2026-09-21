/** Ctrl-A, Ctrl-K: move to the start of the agent composer and remove its draft. */
export const AGENT_LINE_RESET = "\u0001\u000b";

/** DECSET 2004 bracketed-paste markers. */
export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";

/** Maximum UTF-8 payload accepted by the scheduled-prompt store. */
export const MAX_AGENT_MESSAGE_BYTES = 16 * 1024;

const ENCODER = new TextEncoder();

/**
 * Sanitize text before it becomes terminal input. Newlines are preserved, while
 * every other C0/DEL byte is removed so a stored message cannot smuggle a key
 * press or close its own bracketed-paste run.
 */
export function sanitizeAgentMessage(draft: string): string {
  const text = draft
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\s+$/, "");
  if (!text.trim()) return "";
  return text;
}

/** UTF-8 byte length, used for the cross-language 16 KiB bound. */
export function agentMessageBytes(message: string): number {
  return ENCODER.encode(message).byteLength;
}

const CLAUDE_AGENT = /claude/iu;

/**
 * Whether a message submitted to an agent goes in inside bracketed-paste
 * markers. `agent` is whatever names the family where this is asked: the
 * phone's tab label, the desktop's launch command.
 *
 * Claude Code turns every bracketed paste — one short line too — into a
 * `[Pasted text]` block and hands the model `<pasted_content>` instead of the
 * user's own words, so its messages are typed and the submit rides the write
 * gap. The other families keep the markers where the pane has the mode on:
 * they are what stops Codex reading a coalesced `text CR` as one paste.
 *
 * Both deliveries ask this, and for a while only the phone's did — a prompt
 * filed or chained from the desktop went in bracketed and reached the model
 * quoted as something pasted from elsewhere rather than as the question
 * (2026-09-20).
 */
export function bracketsAgentMessage(agent: string | undefined, paneBracketed: boolean): boolean {
  return paneBracketed && !(agent !== undefined && CLAUDE_AGENT.test(agent));
}

/**
 * The distinct writes that safely replace an agent composer draft and submit a
 * single message. Keep these split: some TUIs discard the remainder of a stdin
 * chunk that starts with a control key, and some absorb a CR into pasted text.
 */
export function agentInputWrites(draft: string, bracketedPaste = false): string[] {
  const text = sanitizeAgentMessage(draft);
  if (!text) return [];
  if (bracketedPaste) return [AGENT_LINE_RESET, `${PASTE_START}${text}${PASTE_END}`, "\r"];
  const writes = [AGENT_LINE_RESET];
  text.split("\n").forEach((line, index) => {
    if (index) writes.push("\n");
    if (line) writes.push(line);
  });
  writes.push("\r");
  return writes;
}
