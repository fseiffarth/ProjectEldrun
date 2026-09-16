/**
 * Where the files the agent sent (`eldrun-send`, the project's
 * `.eldrun/outbox/`) sit in the Focus chat, so a picture reads as a message
 * the agent posted rather than a strip above the composer.
 *
 * The stored session carries a time on its turns (`TranscriptEntry.at`) and
 * every file carries its mtime, so a file goes after the last turn written at
 * or before it — the answer that said "here is the plot" is the one above the
 * plot. A turn without a time takes the time of the turn before it. A file
 * older than every shown turn belongs to a turn that is not shown when the
 * answer was truncated, and is left out until "Show earlier turns" reaches
 * it; when nothing was truncated it opens the chat.
 *
 * The screen carries no times at all — a terminal row has none, and a guess
 * from printed text is what Focus never does — so on the screen the files
 * close the chat, oldest first.
 */

import type { OutboxFile, TranscriptEntry } from "../api";

export interface OutboxPlacement {
  /** Files that open the chat, before the first shown turn. */
  before: OutboxFile[];
  /** Files after the entry at each index; an index with none is absent. */
  after: Map<number, OutboxFile[]>;
}

/** Oldest first, name as the tie-break so equal mtimes keep one order. */
export function oldestFirst(files: readonly OutboxFile[]): OutboxFile[] {
  return [...files].sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
}

/** Unix seconds of an entry's `at`, or `null` when it has none or it does not parse. */
function entrySeconds(entry: TranscriptEntry): number | null {
  if (!entry.at) return null;
  const ms = Date.parse(entry.at);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** Places `files` among the stored session's `entries`. */
export function placeOutbox(entries: readonly TranscriptEntry[], files: readonly OutboxFile[], truncated: boolean): OutboxPlacement {
  const placement: OutboxPlacement = { before: [], after: new Map() };
  if (files.length === 0) return placement;
  // The time each entry stands at: its own, or the last one seen before it.
  let last: number | null = null;
  const times = entries.map((entry) => (last = entrySeconds(entry) ?? last));
  const timed = times.some((time) => time !== null);
  for (const file of oldestFirst(files)) {
    let index = -1;
    if (timed) {
      for (let i = 0; i < times.length; i += 1) {
        const time = times[i];
        if (time !== null && time <= file.modified) index = i;
      }
    } else {
      index = entries.length - 1;
    }
    if (index < 0) {
      if (!truncated || entries.length === 0) placement.before.push(file);
      continue;
    }
    const list = placement.after.get(index);
    if (list) list.push(file);
    else placement.after.set(index, [file]);
  }
  return placement;
}
