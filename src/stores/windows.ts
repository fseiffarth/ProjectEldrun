import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export interface TrackedWindow {
  id: string;
  exec: string;
  file: string | null;
  pid: number;
  project_id: string | null;
  role: string | null;
  opened_at: number;
  window_id: number | null;
}

interface WindowsStore {
  windows: TrackedWindow[];
  refresh: (projectId?: string) => Promise<void>;
  launch: (exec: string, file?: string, projectId?: string) => Promise<TrackedWindow>;
  untrack: (id: string) => Promise<void>;
  openFile: (path: string, handler?: string, projectId?: string | null) => Promise<void>;
}

export const useWindowsStore = create<WindowsStore>((set) => ({
  windows: [],

  refresh: async (projectId) => {
    const windows = await invoke<TrackedWindow[]>("list_tracked_windows", {
      projectId: projectId ?? null,
    });
    set({ windows });
  },

  launch: async (exec, file, projectId) => {
    const win = await invoke<TrackedWindow>("launch_app", {
      exec,
      file: file ?? null,
      projectId: projectId ?? null,
      role: null,
    });
    set((s) => ({ windows: [...s.windows, win] }));
    return win;
  },

  untrack: async (id) => {
    await invoke("untrack_window", { id });
    set((s) => ({ windows: s.windows.filter((w) => w.id !== id) }));
  },

  openFile: async (path, handler, projectId) => {
    await invoke("open_file", {
      path,
      handler: handler ?? null,
      projectId: projectId ?? null,
    });
  },
}));
