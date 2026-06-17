import { create } from "zustand";
import { useTabsStore } from "./tabs";

/// A scope (project) counts as "running" while any of its PTYs has emitted
/// output within this window. Short enough to clear quickly when a task ends,
/// long enough to bridge the gaps in bursty agent/terminal output.
const BUSY_WINDOW_MS = 800;

// Last terminal-output timestamp per PTY id. Kept outside the store: it churns
// on every output batch (~60/s) and nothing renders off it directly — only the
// derived `busyByScope` map, recomputed on an interval, drives the UI.
const lastOutputByPty: Record<string, number> = {};

/** Record that a PTY produced output just now. Cheap; safe to call often. */
export function notePtyOutput(ptyId: string) {
  lastOutputByPty[ptyId] = Date.now();
}

/** Test-only: forget all recorded PTY activity so cases start isolated. */
export function _clearPtyActivityForTest() {
  for (const k of Object.keys(lastOutputByPty)) delete lastOutputByPty[k];
}

interface ActivityStore {
  /** project scope ("root" or project id) → has a running task right now. */
  busyByScope: Record<string, boolean>;
  /** Recompute `busyByScope` from recent PTY output. Call on an interval. */
  recompute: () => void;
}

export const useActivityStore = create<ActivityStore>((set, get) => ({
  busyByScope: {},

  recompute: () => {
    const now = Date.now();
    const { tabsByScope } = useTabsStore.getState();
    const prev = get().busyByScope;
    const next: Record<string, boolean> = {};
    let changed = false;

    for (const [scope, tabs] of Object.entries(tabsByScope)) {
      const busy = tabs.some((t) => {
        const ts = lastOutputByPty[t.key];
        return ts !== undefined && now - ts < BUSY_WINDOW_MS;
      });
      if (busy) next[scope] = true;
      if ((prev[scope] ?? false) !== busy) changed = true;
    }
    // A scope that was busy and is now gone/idle also counts as a change.
    for (const scope of Object.keys(prev)) {
      if (!(scope in next) && prev[scope]) changed = true;
    }

    if (changed) set({ busyByScope: next });
  },
}));
