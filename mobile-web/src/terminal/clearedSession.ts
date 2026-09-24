import type { TranscriptEntry } from "../api";

/**
 * Where the conversation stood when the phone sent `/clear`: its last record,
 * and which copy of it that was. Codex starts the new chat at once but writes
 * no rollout — and reports no session id — until its first prompt, so the
 * stored session the phone reads stays the cleared one until then. While that
 * record is still in what the desktop answers, everything up to it is the
 * conversation just cleared; once it is gone, the new session is the one read.
 */
export interface ClearMark {
  anchor: TranscriptEntry;
  seen: number;
}

function same(a: TranscriptEntry, b: TranscriptEntry): boolean {
  return a.kind === b.kind && a.text === b.text && a.at === b.at;
}

/** The mark for a clear sent against `entries`; none for an empty session. */
export function clearMark(entries: readonly TranscriptEntry[]): ClearMark | null {
  const anchor = entries[entries.length - 1];
  if (!anchor) return null;
  return { anchor, seen: entries.filter((entry) => same(entry, anchor)).length };
}

/** The records of `entries` past the mark — what belongs to the new chat —
 * or `null` when the mark is not there: another session is being read, and
 * all of it is shown. */
export function afterClear(entries: readonly TranscriptEntry[], mark: ClearMark | null): TranscriptEntry[] | null {
  if (!mark) return null;
  let seen = 0;
  const index = entries.findIndex((entry) => same(entry, mark.anchor) && ++seen === mark.seen);
  return index < 0 ? null : entries.slice(index + 1);
}
