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
  kind: "prompt" | "answer" | "agent";
  text: string;
  /** Some of the text was bounded by the desktop. */
  cut: boolean;
  /** The record's index in `entries`, which is where the files sent after it are placed. */
  index: number;
  /** A prompt that is a slash command, drawn as a divider (`slashCommand`). */
  command: SlashCommand | null;
  /** On a subagent (`agent`): the handle that opens its conversation, absent
   * until its CLI has recorded where that lives, and its kind. */
  subagent?: string;
  role?: string;
  /** A prompt sent from this phone the session has not recorded yet, by its
   * id; `failed` once the link lost it, `retrying` while a resend waits. */
  pending?: number;
  failed?: boolean;
  retrying?: boolean;
}

/** A slash command split into its name and what follows it. */
export interface SlashCommand {
  name: string;
  args: string;
}

/** A prompt that is a slash command (`/clear`, `/model opus`, `/goal …`,
 * `/plugin:skill x`) — steering the CLI, not words to the agent — so the
 * Reader draws it as a divider across the chat rather than a bubble. The name
 * must end at a space or the end, so a prompt opening with a path
 * (`/home/me/x is broken`) stays a bubble. */
export function slashCommand(text: string): SlashCommand | null {
  const match = /^(\/[A-Za-z][\w-]*(?::[\w-]+)*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1], args: match[2] ?? "" } : null;
}

/** Whether a command's arguments ride on the divider beside its name: a
 * one-word setting does (`/model opus`, `/effort high`); anything with words
 * — the text of a `/goal` or `/plan` — is the reader's own message and reads
 * as a prompt bubble under it. */
export function commandArgsInline(args: string): boolean {
  return args.length <= 24 && !/\s/.test(args);
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
      command: entry.kind === "prompt" ? slashCommand(entry.text) : null,
      ...(entry.kind === "agent" ? { subagent: entry.subagent, role: entry.role } : {}),
      ...(entry.pending !== undefined ? { pending: entry.pending, failed: entry.failed === true, retrying: entry.retrying === true } : {}),
    };
  });
}
