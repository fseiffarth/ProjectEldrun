import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

function withoutScript(set: Set<string>, scriptPath: string): Set<string> {
  if (!set.has(scriptPath)) return set;
  const next = new Set(set);
  next.delete(scriptPath);
  return next;
}

interface ActivityStore {
  /** project scope ("root" or project id) → has a running task right now. */
  busyByScope: Record<string, boolean>;
  /** PTY/tab id → that individual tab is actively producing output right now.
   *  Drives the per-tab "working" animation in the tab bar. */
  busyByTab: Record<string, boolean>;
  /** Recompute `busyByScope`/`busyByTab` from recent PTY output. Call on an
   *  interval. */
  recompute: () => void;
  /** Absolute paths of `.sh` scripts currently running detached. The run_id
   *  used with the backend is the script's absolute path (see runScript). */
  runningScripts: Set<string>;
  /** Spawn a `.sh` script detached and track it so the run button can show a
   *  spinner until the backend emits `script-finished`. */
  runScript: (scriptPath: string, cwd: string) => void;
}

export const useActivityStore = create<ActivityStore>((set, get) => ({
  busyByScope: {},
  busyByTab: {},
  runningScripts: new Set(),

  runScript: (scriptPath, cwd) => {
    set((s) => ({ runningScripts: new Set(s.runningScripts).add(scriptPath) }));
    void invoke("run_script_detached", { scriptPath, cwd, runId: scriptPath })
      .catch(() => {
        set((s) => ({ runningScripts: withoutScript(s.runningScripts, scriptPath) }));
      });
  },

  recompute: () => {
    const now = Date.now();
    const { tabsByScope } = useTabsStore.getState();
    const prevScope = get().busyByScope;
    const prevTab = get().busyByTab;
    const nextScope: Record<string, boolean> = {};
    const nextTab: Record<string, boolean> = {};
    let changed = false;

    for (const [scope, tabs] of Object.entries(tabsByScope)) {
      let scopeBusy = false;
      for (const t of tabs) {
        const ts = lastOutputByPty[t.key];
        const tabBusy = ts !== undefined && now - ts < BUSY_WINDOW_MS;
        if (tabBusy) {
          nextTab[t.key] = true;
          scopeBusy = true;
        }
        if ((prevTab[t.key] ?? false) !== tabBusy) changed = true;
      }
      if (scopeBusy) nextScope[scope] = true;
      if ((prevScope[scope] ?? false) !== scopeBusy) changed = true;
    }
    // A scope/tab that was busy and is now gone or idle also counts as a change.
    for (const scope of Object.keys(prevScope)) {
      if (!(scope in nextScope) && prevScope[scope]) changed = true;
    }
    for (const tab of Object.keys(prevTab)) {
      if (!(tab in nextTab) && prevTab[tab]) changed = true;
    }

    if (changed) set({ busyByScope: nextScope, busyByTab: nextTab });
  },
}));

// App-lifetime listener: clears the run animation when a detached script
// finishes (run_id is the script's absolute path). Lives in the store rather
// than in FileTree so the run state survives right-panel hide/show, which
// unmounts the tree — see TODO group R #34. Guarded so non-Tauri contexts
// (e.g. unit tests, where the IPC bridge is absent) don't throw on import.
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  void listen<{ runId: string; success: boolean }>("script-finished", (e) => {
    useActivityStore.setState((s) => ({
      runningScripts: withoutScript(s.runningScripts, e.payload.runId),
    }));
  }).catch(() => {});
}
