import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export type TabKind = "agent" | "shell" | "root";

export interface TabEntry {
  key: string;
  label: string;
  cmd: string;
  args?: string[];
  cwd: string;
  kind: TabKind;
}

interface TabsStore {
  tabs: TabEntry[];
  activeKey: string | null;
  setActive: (key: string) => void;
  addTab: (tab: Omit<TabEntry, "key">) => TabEntry;
  removeTab: (key: string) => void;
  reorder: (from: number, to: number) => void;
  loadFromLayout: (
    layout: Array<{ key: string; label: string; cmd: string; cwd: string }>,
    defaultCwd: string,
  ) => void;
  saveLayout: (localFile: string) => Promise<void>;
}

let _keyCounter = 0;
function nextKey(prefix: string) {
  return `${prefix}-${++_keyCounter}`;
}

export const useTabsStore = create<TabsStore>((set, get) => ({
  tabs: [],
  activeKey: null,

  setActive: (key) => set({ activeKey: key }),

  addTab: (tab) => {
    const key = nextKey(tab.kind);
    const entry: TabEntry = { key, ...tab };
    set((s) => ({ tabs: [...s.tabs, entry], activeKey: key }));
    return entry;
  },

  removeTab: (key) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key !== key);
      const activeKey =
        s.activeKey === key
          ? tabs[tabs.length - 1]?.key ?? null
          : s.activeKey;
      return { tabs, activeKey };
    });
  },

  reorder: (from, to) => {
    set((s) => {
      const tabs = [...s.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      return { tabs };
    });
  },

  loadFromLayout: (layout, defaultCwd) => {
    const tabs: TabEntry[] = layout.map((t) => ({
      key: t.key,
      label: t.label,
      cmd: t.cmd,
      args: [],
      cwd: t.cwd || defaultCwd,
      kind: cmdToKind(t.cmd),
    }));
    set({ tabs, activeKey: tabs[0]?.key ?? null });
  },

  saveLayout: async (localFile) => {
    const { tabs } = get();
    // Load the current project.json and update tab_layout.
    try {
      const project = await invoke<Record<string, unknown>>("load_project", {
        localFile,
      });
      const tabLayout = tabs.map((t) => ({
        key: t.key,
        label: t.label,
        cmd: t.cmd,
        cwd: t.cwd,
      }));
      await invoke("save_project", {
        localFile,
        project: { ...project, tab_layout: tabLayout },
      });
    } catch {
      // Silently fail — tab layout is non-critical state.
    }
  },
}));

function cmdToKind(cmd: string): TabKind {
  if (cmd === "claude" || cmd === "codex" || cmd === "gemini") return "agent";
  return "shell";
}
