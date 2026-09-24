import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AgentFenceMark } from "../lib/agents/agentFence";

/** Per-project fence marker for the pills, fed by one shared poll in
 *  ProjectSwitcher (one `agent_fence_marks` call for every pill). */
interface AgentFenceMarksStore {
  /** Absent until probed, and after a failed probe: no marker, never a guess. */
  byId: Record<string, AgentFenceMark>;
  refresh: (projectIds: string[]) => Promise<void>;
}

function sameMark(a: AgentFenceMark | undefined, b: AgentFenceMark | undefined): boolean {
  return a?.policy_off === b?.policy_off && a?.live_unfenced === b?.live_unfenced;
}

export const useAgentFenceMarksStore = create<AgentFenceMarksStore>((set) => ({
  byId: {},
  refresh: async (projectIds) => {
    if (projectIds.length === 0) return;
    let marks: Record<string, AgentFenceMark>;
    try {
      marks =
        (await invoke<Record<string, AgentFenceMark> | null>("agent_fence_marks", { projectIds })) ??
        {};
    } catch {
      // A running window whose backend predates the command answers nothing.
      marks = {};
    }
    set((s) => {
      const changed =
        Object.keys(s.byId).length !== Object.keys(marks).length ||
        Object.entries(marks).some(([id, m]) => !sameMark(s.byId[id], m));
      return changed ? { byId: marks } : s;
    });
  },
}));
