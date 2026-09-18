import type { TranscriptEntry } from "../api";

/**
 * One bubble of the stored-session chat: a prompt, or one message the agent
 * wrote. A bubble never changes once shown — the next thing the agent writes
 * is the next bubble — so each record is one bubble, never text appended to
 * the one before it.
 */
export interface TranscriptTurn {
  /** Stable across polls: the record's own time, not its position. The
   * desktop sends the newest N records and drops the oldest as new ones come,
   * so a position-based key re-keyed — and re-mounted — every bubble on every
   * new record, which is what made the chat jump while the agent worked. */
  key: string;
  kind: "prompt" | "answer";
  text: string;
  /** Some of the text was bounded by the desktop. */
  cut: boolean;
  /** The record's index in `entries`, which is where the files sent after it are placed. */
  index: number;
}

export function transcriptTurns(entries: readonly TranscriptEntry[]): TranscriptTurn[] {
  const seen = new Map<string, number>();
  return entries.map((entry, index) => {
    // A record without a time falls back to its position; two records that
    // share one stay apart by a count.
    const base = entry.at ? `${entry.kind}:${entry.at}` : `${entry.kind}#${index}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return {
      key: count === 0 ? base : `${base}~${count}`,
      kind: entry.kind,
      text: entry.text,
      cut: entry.cut === true,
      index,
    };
  });
}
