import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { shortModelName } from "../lib/agentModel";
import { splitPtyId } from "../lib/ptyId";
import { useActivityStore } from "./activity";
import { useTabsStore, type TabEntry } from "./tabs";

/**
 * Which model each agent tab last answered with, keyed by composed PTY id.
 *
 * The backend reads it from the agent's own transcript (`agent_tab_model`,
 * `services::agent_session::agent_session_model`) — the CLIs tell their hooks
 * nothing about the model, and Eldrun passes no model flag, so the transcript
 * is the one honest source. It is re-read whenever a tab finishes a turn (the
 * activity store's `lastDoneByTab` edge — the only moment the answer can
 * change), and on demand from the views that show it, throttled so a 30-second
 * tick and a 5-second phone poll cost one tail read between them.
 */
const REFRESH_FLOOR_MS = 10_000;
const askedAt: Record<string, number> = {};

interface AgentModelsStore {
  /** Composed PTY id → display label (`lib/agentModel.shortModelName`). Absent
   *  when the transcript names no model yet or the agent keeps none. */
  byTab: Record<string, string>;
  /** Re-read one tab's model. `force` skips the throttle (a turn just ended). */
  refresh: (scope: string, tab: TabEntry, force?: boolean) => Promise<void>;
}

export function isModelTaggedTab(tab: TabEntry): boolean {
  return (tab.kind === "agent" || tab.kind === "local_agent") && !!tab.sessionId;
}

export const useAgentModelsStore = create<AgentModelsStore>((set, get) => ({
  byTab: {},
  refresh: async (scope, tab, force = false) => {
    if (!isModelTaggedTab(tab)) return;
    const ptyId = `${scope}:${tab.key}`;
    const now = Date.now();
    const asked = askedAt[ptyId];
    if (!force && asked !== undefined && now - asked < REFRESH_FLOOR_MS) return;
    askedAt[ptyId] = now;
    let raw: unknown;
    try {
      raw = await invoke("agent_tab_model", {
        agent: tab.cmd,
        projectId: scope === "root" ? null : scope,
        sessionId: tab.sessionId,
      });
    } catch {
      return;
    }
    const label = typeof raw === "string" && raw.trim() ? shortModelName(raw) : "";
    if ((get().byTab[ptyId] ?? "") === label) return;
    set((state) => {
      const byTab = { ...state.byTab };
      if (label) byTab[ptyId] = label;
      else delete byTab[ptyId];
      return { byTab };
    });
  },
}));

// A finished turn is the one moment the tag can have changed (a `/model` mid-
// session shows up in the next answer), so that edge re-reads it for both the
// Agents view and the phone at once, without either polling for it.
useActivityStore.subscribe((state, prev) => {
  if (state.lastDoneByTab === prev.lastDoneByTab) return;
  const { tabsByScope } = useTabsStore.getState();
  for (const [ptyId, at] of Object.entries(state.lastDoneByTab)) {
    if (prev.lastDoneByTab[ptyId] === at) continue;
    const parts = splitPtyId(ptyId);
    const tab = parts && tabsByScope[parts.scope]?.find((entry) => entry.key === parts.key);
    if (tab) void useAgentModelsStore.getState().refresh(parts.scope, tab, true);
  }
});
