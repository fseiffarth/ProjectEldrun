import type { TranscriptEntry } from "../api";

/** A subagent the Reader can open: the handle on its `agent` entry
 * (`getTranscript`'s `subagent`) and what that entry says about it. */
export interface SubagentRef {
  token: string;
  /** What it was sent to do, as its CLI titled it. */
  task: string;
  /** Its kind (`Explore`, a Codex role, an OpenCode agent). */
  role?: string;
  /** It had not reported back when its entry was read (`running`). */
  running?: boolean;
  /** It runs in the background (`background`). */
  background?: boolean;
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
    ? [{ token: entry.subagent, task: entry.text, role: entry.role, ...(entry.running ? { running: true } : {}), ...(entry.background ? { background: true } : {}) }]
    : []);
}

/** Whether a subagent the session's entry describes is at work: it has not
 * reported back, and — one the session waits on — the session is at work
 * (`sessionBusy`): a session that died mid-turn never records the result. A
 * background one works on after the session's turn is over, until its task
 * notification says it is done. */
export function subagentAtWork(ref: Pick<SubagentRef, "running" | "background">, sessionBusy: boolean): boolean {
  return ref.running === true && (sessionBusy || ref.background === true);
}

/** Whether the open subagent of `path` is still at work, by the session's
 * own `entries`, read live: its outermost subagent is at work
 * ([`subagentAtWork`]), and — one nested inside it, whose parent conversation
 * is not read again — had not reported back when it was opened. A subagent
 * that finished stays finished. */
export function openSubagentRunning(path: readonly SubagentStep[], entries: readonly TranscriptEntry[], sessionBusy: boolean): boolean {
  const outer = path[0];
  const open = path[path.length - 1];
  if (!outer || !open) return false;
  const outerRunning = entries.some((entry) => entry.kind === "agent" && entry.subagent === outer.token && subagentAtWork(entry, sessionBusy));
  return outerRunning && (path.length === 1 || open.running === true);
}

/** The name a working row gives the model a transcript names: a Claude id by
 * its family, as the session's own row says it (`claude-haiku-4-5-20251001`
 * → `Haiku`); any other id as it is (`gpt-5-codex`). */
export function workingModelName(model: string | undefined): string | undefined {
  const id = model?.trim();
  if (!id) return undefined;
  const family = /^claude-([a-z]+)-\d/.exec(id)?.[1];
  return family ? `${family[0].toUpperCase()}${family.slice(1)}` : id;
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
