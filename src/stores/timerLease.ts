import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/**
 * The single-client timer lease (headless owner plan, H2, interim).
 *
 * Scheduled prompts, auto-continue, the warm-up cron, calendar alarms and the
 * CalDAV sync are still fired by hosts in this window. Two Tabtivity processes on
 * one state dir would each fire them, so a host ticks only while this window
 * holds the lease the backend grants to one client at a time
 * (`services::timer_lease`). The lease is renewed by heartbeat and expires on
 * its own, so a window that died hands over within the backend's TTL.
 *
 * Optimistic by default: a window assumes it holds the lease until the
 * backend says another one does — a backend without the command (an older
 * binary under a hot-reloaded `src/`) behaves exactly as before.
 */

/** This window's identity for the lease: fresh per page load, never persisted. */
export const TIMER_LEASE_CLIENT = crypto.randomUUID();

/** Well inside the backend's 30 s TTL. */
export const HEARTBEAT_MS = 10_000;

export interface TimerLeaseState {
  held: boolean;
  /** Who holds it when this window does not. */
  holder?: string;
}

interface TimerLeaseStore extends TimerLeaseState {
  /** One heartbeat: ask the backend, record the answer. */
  probe: () => Promise<void>;
  /** Hand the lease back on the way out. */
  release: () => Promise<void>;
}

function isUnknownCommand(error: unknown): boolean {
  return /(?:command\b.*\bnot found|unknown command|not allowed)/i.test(String(error));
}

export const useTimerLeaseStore = create<TimerLeaseStore>((set) => ({
  held: true,
  holder: undefined,

  probe: async () => {
    try {
      const state = await invoke<{ held: boolean; holder?: string } | undefined>("timer_lease_acquire", {
        clientId: TIMER_LEASE_CLIENT,
      });
      if (!state) return;
      set({ held: state.held, holder: state.held ? undefined : state.holder });
    } catch (error) {
      // No lease command: the old single-process world, where this window
      // fires its timers. Any other failure keeps the last answer.
      if (isUnknownCommand(error)) set({ held: true, holder: undefined });
    }
  },

  release: async () => {
    try {
      await invoke("timer_lease_release", { clientId: TIMER_LEASE_CLIENT });
    } catch {
      // Best effort: the TTL hands it over anyway.
    }
  },
}));

/** Whether a timer host in this window may fire right now. */
export function holdsTimerLease(): boolean {
  return useTimerLeaseStore.getState().held;
}
