import { create } from "zustand";
import { useSettingsStore } from "./settings";

/**
 * Mediates the one-time "agents on this computer run with your full rights"
 * acceptance on a platform that has no agent fence (Windows).
 *
 * `pty_spawn` refuses every local agent tab there until
 * `agent_fence_platform_accepted` is written (`services::agent_fence::decide`,
 * `PlatformUnaccepted`); the refused tab asks here and retries. Unlike the HPC
 * guard this *is* remembered: it is a statement about the machine, not one
 * act, and a question asked on every tab would only be clicked through.
 *
 * Restoring a session opens several agent tabs at once, so concurrent asks
 * coalesce onto one open prompt and share its answer — N tabs, one question.
 */

interface UnfencedPlatformState {
  /** Every tab waiting on the open prompt; empty means nothing is asked. */
  waiting: Array<(accepted: boolean) => void>;
  /** How many `UnfencedPlatformDialog`s are mounted in THIS window. With none,
   *  a request is refused at once rather than parked on a Promise nobody can
   *  resolve (the lesson of the HPC guard, #233). */
  hosts: number;
  /** Ask. Resolves `true` once the user accepted and the setting is saved,
   *  `false` on cancel, on a failed save, or at once with no dialog mounted. */
  request: () => Promise<boolean>;
  /** The user accepted: persist, then release every waiting tab. */
  accept: () => Promise<void>;
  /** Back out: no tab starts. */
  cancel: () => void;
  /** `UnfencedPlatformDialog` mount/unmount bookkeeping. */
  registerHost: () => () => void;
}

export const useUnfencedPlatformStore = create<UnfencedPlatformState>((set, get) => ({
  waiting: [],
  hosts: 0,

  request: () =>
    new Promise<boolean>((resolve) => {
      if (get().hosts === 0) {
        resolve(false);
        return;
      }
      set((s) => ({ waiting: [...s.waiting, resolve] }));
    }),

  registerHost: () => {
    set((s) => ({ hosts: s.hosts + 1 }));
    return () => set((s) => ({ hosts: Math.max(0, s.hosts - 1) }));
  },

  accept: async () => {
    const waiting = get().waiting;
    set({ waiting: [] });
    let accepted = false;
    try {
      await useSettingsStore.getState().updateSettings({ agent_fence_platform_accepted: true });
      accepted = true;
    } catch {
      // A save that failed leaves the backend refusing, so a retry would only
      // print the same refusal; report "no" and let the tab say so.
    }
    for (const resolve of waiting) resolve(accepted);
  },

  cancel: () => {
    const waiting = get().waiting;
    set({ waiting: [] });
    for (const resolve of waiting) resolve(false);
  },
}));
