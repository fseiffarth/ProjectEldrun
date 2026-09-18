import type { TranscriptEntry } from "../api";

/**
 * A prompt the composer sent, shown in the session chat the moment it leaves
 * the phone. A bubble never changes once shown: this one takes its place
 * after whatever the session held when it was sent — so the answers to it
 * come below it — and it keeps that place and those words. When the agent's
 * own record of the prompt arrives, the record is the one hidden, not the
 * bubble; a prompt typed while the agent works is recorded only once the
 * agent takes it in, often after more of its messages, and swapping the
 * bubble for the record would move it. What is held lives as long as the
 * view: reopened, the chat is simply the session's record.
 */
export interface PendingPrompt {
  id: number;
  text: string;
  /** How many prompts with the same words the session held when it was
   * sent — a repeated "continue" is not taken for its own arrival. */
  seen: number;
  /** The newest record time the session held then (the desktop's clock, as
   * written): the bubble's place, and what tells its record from an older
   * copy of the same words after older turns left the window the phone
   * reads. */
  after?: string;
}

/** At most this many are held; the oldest goes first. */
export const MAX_PENDING = 50;

/** Words as the session and the composer both carry them: the record trims
 * and drops control characters, a paste may rewrap. */
function words(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isCopy(entry: TranscriptEntry, text: string): boolean {
  return entry.kind === "prompt" && words(entry.text) === words(text);
}

/** The pending prompt for `text`, sent against `entries`. */
export function pendingPrompt(id: number, text: string, entries: readonly TranscriptEntry[]): PendingPrompt {
  const stamps = entries.map((entry) => entry.at).filter((at): at is string => !!at);
  return {
    id,
    text: text.trim(),
    seen: entries.filter((entry) => isCopy(entry, text)).length,
    after: stamps.length ? stamps.reduce((a, b) => (b > a ? b : a)) : undefined,
  };
}

/** Where `prompt`'s own record sits in `entries`, or -1 while it has not
 * arrived: a copy stamped after it was sent, or one more copy than it saw.
 * RFC 3339 stamps from one writer order as strings. */
function recordOf(prompt: PendingPrompt, entries: readonly TranscriptEntry[]): number {
  const copies = entries.flatMap((entry, index) => (isCopy(entry, prompt.text) ? [index] : []));
  const after = prompt.after;
  const stamped = after === undefined ? undefined : copies.find((index) => (entries[index].at ?? "") > after);
  if (stamped !== undefined) return stamped;
  return copies.length > prompt.seen ? copies[copies.length - 1] : -1;
}

/**
 * The session's entries as the chat shows them: each held prompt in its
 * place, its record — once there — left out. A held prompt is an ordinary
 * prompt entry stamped with its place's time, so the chat keys it, and
 * places the agent's files around it, the way it does a recorded one.
 */
export function withPending(entries: readonly TranscriptEntry[], pending: readonly PendingPrompt[]): TranscriptEntry[] {
  if (pending.length === 0) return entries as TranscriptEntry[];
  const shown = [...entries];
  for (const prompt of pending) {
    const record = recordOf(prompt, shown);
    if (record >= 0) shown.splice(record, 1);
  }
  for (const prompt of pending) {
    // After the last entry at or before the send — an entry without a stamp
    // stands at the one before it (as `placeOutbox` reads them), and an
    // earlier held prompt carries the same stamp, so two sent in a row keep
    // their order. Nothing stamped to go by: the end.
    let slot = shown.length;
    const after = prompt.after;
    if (after !== undefined) {
      slot = 0;
      let time: string | undefined;
      shown.forEach((entry, index) => {
        time = entry.at ?? time;
        if (time !== undefined && time <= after) slot = index + 1;
      });
    }
    shown.splice(slot, 0, { kind: "prompt", text: prompt.text, at: after });
  }
  return shown;
}
