import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { ScheduledAgentPrompt } from "../lib/agentSchedule";
import { useProjectsStore } from "./projects";
import { ROOT_SCOPE, useTabsStore } from "./tabs";

/**
 * A schedule is only as durable as the tab binding it hangs off. The target id
 * is minted in memory when a layout written before schedules existed is
 * restored, and the layout otherwise reaches disk only when a tab is added,
 * closed or moved — so a schedule saved against a freshly minted id, followed
 * by a quit with no tab change, came back orphaned and was swept at the next
 * launch. Writing the scope after every schedule write pins the binding.
 */
export function persistScheduleBinding(projectId: string): Promise<void> {
  const localFile = projectId === ROOT_SCOPE
    ? ""
    : useProjectsStore.getState().projects.find((project) => project.id === projectId)?.local_file ?? "";
  return useTabsStore.getState().persistScope(projectId, localFile).catch(() => {});
}

export function scheduleCacheKey(projectId: string, scheduleTargetId: string): string {
  return `${projectId}\u0000${scheduleTargetId}`;
}

interface AgentSchedulesStore {
  byTarget: Record<string, ScheduledAgentPrompt[]>;
  loading: Record<string, boolean>;
  load: (projectId: string, scheduleTargetId: string) => Promise<ScheduledAgentPrompt[]>;
  upsert: (
    projectId: string,
    scheduleTargetId: string,
    schedule: ScheduledAgentPrompt,
  ) => Promise<ScheduledAgentPrompt[]>;
  remove: (projectId: string, scheduleTargetId: string, scheduleId: string) => Promise<void>;
  refreshLoaded: () => Promise<void>;
}

export const useAgentSchedulesStore = create<AgentSchedulesStore>((set, get) => ({
  byTarget: {},
  loading: {},

  load: async (projectId, scheduleTargetId) => {
    const key = scheduleCacheKey(projectId, scheduleTargetId);
    set((state) => ({ loading: { ...state.loading, [key]: true } }));
    try {
      const schedules = await invoke<ScheduledAgentPrompt[]>("agent_schedules_list", {
        projectId,
        scheduleTargetId,
      });
      set((state) => ({ byTarget: { ...state.byTarget, [key]: schedules } }));
      return schedules;
    } finally {
      set((state) => ({ loading: { ...state.loading, [key]: false } }));
    }
  },

  upsert: async (projectId, scheduleTargetId, schedule) => {
    const schedules = await invoke<ScheduledAgentPrompt[]>("agent_schedule_upsert", {
      projectId,
      scheduleTargetId,
      schedule,
    });
    const key = scheduleCacheKey(projectId, scheduleTargetId);
    set((state) => ({ byTarget: { ...state.byTarget, [key]: schedules } }));
    void persistScheduleBinding(projectId);
    return schedules;
  },

  remove: async (projectId, scheduleTargetId, scheduleId) => {
    await invoke("agent_schedule_delete", { projectId, scheduleTargetId, scheduleId });
    const key = scheduleCacheKey(projectId, scheduleTargetId);
    set((state) => ({
      byTarget: {
        ...state.byTarget,
        [key]: (state.byTarget[key] ?? []).filter((item) => item.id !== scheduleId),
      },
    }));
  },

  refreshLoaded: async () => {
    const keys = Object.keys(get().byTarget);
    await Promise.all(keys.map((key) => {
      const [projectId, scheduleTargetId] = key.split("\u0000");
      return get().load(projectId, scheduleTargetId).catch(() => []);
    }));
  },
}));
