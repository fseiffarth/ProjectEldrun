/**
 * The order the Agents views (desktop `AgentSchedulesView`, phone `Activity`)
 * list agent tabs in. Shared so the two cannot disagree about what "last
 * working" means: the laptop and the phone show the same tabs, and a reader
 * who switches between them should find them in the same places.
 *
 * - `lastWorking`: a tab working right now first, then by the last time it was
 *   seen working, most recent first. The default — it answers "what has been
 *   happening" without a click.
 * - `lastDone`: by the last turn each agent finished, most recent first. The
 *   triage order: the newest finished answer is the one to read next.
 * - `native`: the order the list arrived in — the tab bar's on the desktop, the
 *   sidecar's (waiting first, finished last) on the phone.
 *
 * Ties (and tabs with no reading — one restored this session that has not
 * worked yet) keep their arrival order, so a sort is a stable reordering and a
 * tab with nothing to say sinks to the bottom rather than jumping around.
 */
export type AgentSort = "lastWorking" | "lastDone" | "native";

export const AGENT_SORTS: readonly AgentSort[] = ["lastWorking", "lastDone", "native"];
export const DEFAULT_AGENT_SORT: AgentSort = "lastWorking";

export interface AgentSortKeys {
  /** Producing output right now — outranks any timestamp for `lastWorking`. */
  working: boolean;
  /** ms epoch of the tab's last output while working, if seen this session. */
  workingAt?: number;
  /** ms epoch of the tab's last finished turn, if seen this session. */
  doneAt?: number;
}

export function isAgentSort(value: unknown): value is AgentSort {
  return typeof value === "string" && (AGENT_SORTS as readonly string[]).includes(value);
}

export function sortAgentTabs<T>(tabs: readonly T[], sort: AgentSort, keysOf: (tab: T) => AgentSortKeys): T[] {
  if (sort === "native") return [...tabs];
  const rank = (tab: T): number => {
    const keys = keysOf(tab);
    if (sort === "lastWorking") {
      if (keys.working) return Number.POSITIVE_INFINITY;
      return keys.workingAt ?? Number.NEGATIVE_INFINITY;
    }
    return keys.doneAt ?? Number.NEGATIVE_INFINITY;
  };
  return tabs
    .map((tab, index) => ({ tab, index, rank: rank(tab) }))
    .sort((a, b) => {
      // Two infinities subtract to NaN, which is the tie the index settles.
      const byRank = b.rank - a.rank;
      return Number.isNaN(byRank) || byRank === 0 ? a.index - b.index : byRank;
    })
    .map((entry) => entry.tab);
}
