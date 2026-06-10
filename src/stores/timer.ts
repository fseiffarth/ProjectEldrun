import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export const APP_TIMER_ID = "__eldrun__";

interface TimerStore {
  paused: boolean;
  appStartedAt: number | null;
  appCommittedSecs: number;
  projectStartedAt: number | null;
  projectCommittedSecs: number;
  activeProjectId: string | null;

  /** Call once after projects are loaded. */
  init: (projectId: string | null) => Promise<void>;
  /** Pause both app + project timers (flush to backend) or resume them. */
  toggle: () => Promise<void>;
  /** Flush the old project, load committed secs for the new one, restart timer. */
  setProject: (newId: string | null) => Promise<void>;
  /** Flush elapsed (uncommitted) time to the backend without changing state. */
  flush: () => Promise<void>;
  /** Live app-usage seconds today (committed + current interval). */
  getAppSecs: () => number;
  /** Live project seconds today (committed + current interval). */
  getProjectSecs: () => number;
}

export const useTimerStore = create<TimerStore>((set, get) => ({
  paused: false,
  appStartedAt: null,
  appCommittedSecs: 0,
  projectStartedAt: null,
  projectCommittedSecs: 0,
  activeProjectId: null,

  init: async (projectId) => {
    const now = Date.now();
    const [appSecs, projSecs] = await Promise.all([
      invoke<number>("get_time_today", { projectId: APP_TIMER_ID }).catch(() => 0),
      projectId
        ? invoke<number>("get_time_today", { projectId }).catch(() => 0)
        : Promise.resolve(0),
    ]);
    set({
      paused: false,
      appStartedAt: now,
      appCommittedSecs: appSecs,
      projectStartedAt: now,
      projectCommittedSecs: projSecs,
      activeProjectId: projectId,
    });
  },

  toggle: async () => {
    const s = get();
    const now = Date.now();
    if (!s.paused) {
      const appElapsed = s.appStartedAt != null ? (now - s.appStartedAt) / 1000 : 0;
      const projElapsed =
        s.projectStartedAt != null && s.activeProjectId
          ? (now - s.projectStartedAt) / 1000
          : 0;
      await Promise.all([
        invoke("timer_flush_app", { secs: appElapsed }).catch(() => {}),
        s.activeProjectId && projElapsed > 0
          ? invoke("timer_flush_project", {
              projectId: s.activeProjectId,
              secs: projElapsed,
            }).catch(() => {})
          : Promise.resolve(),
      ]);
      set({
        paused: true,
        appStartedAt: null,
        appCommittedSecs: s.appCommittedSecs + appElapsed,
        projectStartedAt: null,
        projectCommittedSecs: s.projectCommittedSecs + projElapsed,
      });
    } else {
      set({ paused: false, appStartedAt: Date.now(), projectStartedAt: Date.now() });
    }
  },

  setProject: async (newId) => {
    const s = get();
    const now = Date.now();
    if (s.activeProjectId && !s.paused && s.projectStartedAt != null) {
      const elapsed = (now - s.projectStartedAt) / 1000;
      if (elapsed > 0) {
        await invoke("timer_flush_project", {
          projectId: s.activeProjectId,
          secs: elapsed,
        }).catch(() => {});
      }
    }
    const newCommitted = newId
      ? await invoke<number>("get_time_today", { projectId: newId }).catch(() => 0)
      : 0;
    set({
      activeProjectId: newId,
      projectCommittedSecs: newCommitted,
      projectStartedAt: s.paused ? null : now,
    });
  },

  flush: async () => {
    const s = get();
    const now = Date.now();
    // Never attribute more seconds to today than have actually elapsed since
    // UTC midnight. This prevents overnight gaps (app started yesterday, first
    // flush fires today) from bloating today's total.
    const todayStartMs = Math.floor(now / 86400000) * 86400000;
    const appElapsed = !s.paused && s.appStartedAt != null
      ? Math.min((now - s.appStartedAt) / 1000, (now - todayStartMs) / 1000) : 0;
    const projElapsed = !s.paused && s.projectStartedAt != null && s.activeProjectId
      ? Math.min((now - s.projectStartedAt) / 1000, (now - todayStartMs) / 1000) : 0;
    await Promise.all([
      appElapsed > 0
        ? invoke("timer_flush_app", { secs: appElapsed }).catch(() => {})
        : Promise.resolve(),
      projElapsed > 0 && s.activeProjectId
        ? invoke("timer_flush_project", { projectId: s.activeProjectId, secs: projElapsed }).catch(() => {})
        : Promise.resolve(),
    ]);
    // Reload committed secs from the backend so day-boundary crossings are
    // handled correctly (in-memory accumulation would carry yesterday's total
    // into today once Eldrun runs past midnight).
    if (!s.paused) {
      const [newAppSecs, newProjSecs] = await Promise.all([
        invoke<number>("get_time_today", { projectId: APP_TIMER_ID }).catch(
          () => s.appCommittedSecs + appElapsed,
        ),
        s.activeProjectId
          ? invoke<number>("get_time_today", { projectId: s.activeProjectId }).catch(
              () => s.projectCommittedSecs + projElapsed,
            )
          : Promise.resolve(s.projectCommittedSecs + projElapsed),
      ]);
      set({
        appStartedAt: now,
        appCommittedSecs: newAppSecs,
        projectStartedAt: now,
        projectCommittedSecs: newProjSecs,
      });
    }
  },

  getAppSecs: () => {
    const s = get();
    const elapsed =
      !s.paused && s.appStartedAt != null ? (Date.now() - s.appStartedAt) / 1000 : 0;
    return s.appCommittedSecs + elapsed;
  },

  getProjectSecs: () => {
    const s = get();
    const elapsed =
      !s.paused && s.projectStartedAt != null
        ? (Date.now() - s.projectStartedAt) / 1000
        : 0;
    return s.projectCommittedSecs + elapsed;
  },
}));
