import { create } from "zustand";
import { splitPtyId } from "./activity";

/**
 * Per-tab agent task summary, captured from the terminal title an agent CLI sets
 * via OSC 0/2 ("set window title") — the same signal a native terminal shows in
 * its tab. Claude Code, Codex and friends update this as they work, so it reads
 * as a short "what is this agent doing" summary, surfaced in the tab hover card.
 *
 * Kept in its own store (not `activity`): titles are event-driven and unrelated
 * to activity's interval-recomputed busy maps, so a dedicated store keeps the
 * hover card the only thing that re-renders on a title change.
 */

interface AgentTaskStore {
  /** Bare tab key → the latest terminal title that tab's PTY set. */
  titleByTab: Record<string, string>;
  /** Record a terminal title for a PTY (`ptyId` is the composed `<scope>:<key>`).
   *  Trims, ignores empty titles, and only writes when the value changed. */
  setTabTitle: (ptyId: string, title: string) => void;
  /** Forget a tab's title (called when its PTY is torn down). */
  clearTabTitle: (tabKey: string) => void;
}

export const useAgentTaskStore = create<AgentTaskStore>((set, get) => ({
  titleByTab: {},

  setTabTitle: (ptyId, title) => {
    const parts = splitPtyId(ptyId);
    if (!parts) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    if (get().titleByTab[parts.key] === trimmed) return;
    set((s) => ({ titleByTab: { ...s.titleByTab, [parts.key]: trimmed } }));
  },

  clearTabTitle: (tabKey) => {
    if (!(tabKey in get().titleByTab)) return;
    set((s) => {
      const next = { ...s.titleByTab };
      delete next[tabKey];
      return { titleByTab: next };
    });
  },
}));
