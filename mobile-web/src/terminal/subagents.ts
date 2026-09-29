import type { TranscriptEntry } from "../api";

/** A subagent the Reader can open: the handle on its `agent` entry
 * (`getTranscript`'s `subagent`) and what that entry says about it. */
export interface SubagentRef {
  token: string;
  /** What it was sent to do, as its CLI titled it. */
  task: string;
  /** Its kind (`Explore`, a Codex role, an OpenCode agent). */
  role?: string;
}

/** One conversation the Reader has walked into from the stored session. */
export interface SubagentStep extends SubagentRef {
  /** The subagents of the conversation it was opened from, in order — what
   * the bar's ‹ › step through without going back up. */
  siblings: SubagentRef[];
  /** Where the conversation it was opened from was scrolled to, put back on
   * the way up. */
  scrollTop: number;
}

/** The subagents in `entries` that can be opened, in order. An entry without
 * a handle is one its CLI has not yet said where it lives; it cannot be
 * stepped to. */
export function subagentsIn(entries: readonly TranscriptEntry[]): SubagentRef[] {
  return entries.flatMap((entry) => entry.kind === "agent" && entry.subagent
    ? [{ token: entry.subagent, task: entry.text, role: entry.role }]
    : []);
}

/** `path` with `ref` opened from the conversation that holds `entries`,
 * scrolled to `scrollTop`. */
export function openSubagent(path: readonly SubagentStep[], ref: SubagentRef, entries: readonly TranscriptEntry[], scrollTop: number): SubagentStep[] {
  return [...path, { ...ref, siblings: subagentsIn(entries), scrollTop }];
}

/** Where the open subagent stands among its siblings: 0-based, and how many. */
export function siblingPosition(step: SubagentStep): { index: number; count: number } {
  return { index: step.siblings.findIndex((sibling) => sibling.token === step.token), count: step.siblings.length };
}

/** `path` with its open subagent swapped for the sibling `delta` away, or
 * `path` itself when there is none that far. Going back up still returns to
 * where the parent conversation was. */
export function stepSibling(path: readonly SubagentStep[], delta: number): readonly SubagentStep[] {
  const step = path[path.length - 1];
  if (!step) return path;
  const next = step.siblings[siblingPosition(step).index + delta];
  if (!next || siblingPosition(step).index < 0) return path;
  return [...path.slice(0, -1), { ...step, ...next }];
}
