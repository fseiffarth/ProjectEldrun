import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export type TabKind = "agent" | "shell" | "files";

export const FILES_TAB_CMD = "__eldrun_files__";

export interface TabEntry {
  key: string;
  label: string;
  cmd: string;
  args?: string[];
  cwd: string;
  kind: TabKind;
}

interface TabsStore {
  scope: string;
  tabsByScope: Record<string, TabEntry[]>;
  activeKeyByScope: Record<string, string | null>;
  tabs: TabEntry[];
  activeKey: string | null;
  setScope: (scope: string) => void;
  setActive: (key: string) => void;
  renameTab: (key: string, label: string) => void;
  addTab: (tab: Omit<TabEntry, "key">) => TabEntry;
  ensureTab: (
    tab: Omit<TabEntry, "key">,
    matches: (tab: TabEntry) => boolean,
  ) => TabEntry;
  removeTab: (key: string) => void;
  reorder: (from: number, to: number) => void;
  loadFromLayout: (
    layout: Array<{ key: string; label: string; cmd: string; cwd: string; kind?: TabKind; type?: string }>,
    defaultCwd: string,
  ) => void;
  saveLayout: (localFile: string) => Promise<void>;
}

let _keyCounter = 0;
function nextKey(prefix: string) {
  return `${prefix}-${++_keyCounter}`;
}

export const useTabsStore = create<TabsStore>((set, get) => ({
  scope: "root",
  tabsByScope: {},
  activeKeyByScope: {},
  tabs: [],
  activeKey: null,

  setScope: (scope) => {
    set((s) => ({
      scope,
      tabs: s.tabsByScope[scope] ?? [],
      activeKey: s.activeKeyByScope[scope] ?? null,
    }));
  },

  setActive: (key) => {
    set((s) => ({
      activeKey: key,
      activeKeyByScope: { ...s.activeKeyByScope, [s.scope]: key },
    }));
  },

  renameTab: (key, label) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    set((s) => {
      const tabs = s.tabs.map((tab) =>
        tab.key === key ? { ...tab, label: nextLabel } : tab,
      );
      return {
        tabs,
        tabsByScope: { ...s.tabsByScope, [s.scope]: tabs },
      };
    });
  },

  addTab: (tab) => {
    const key = nextKey(tab.kind);
    const entry: TabEntry = { key, ...tab };
    set((s) => {
      const tabs = [...s.tabs, entry];
      return {
        tabs,
        activeKey: key,
        tabsByScope: { ...s.tabsByScope, [s.scope]: tabs },
        activeKeyByScope: { ...s.activeKeyByScope, [s.scope]: key },
      };
    });
    return entry;
  },

  ensureTab: (tab, matches) => {
    const existing = get().tabs.find(matches);
    if (existing) {
      get().setActive(existing.key);
      return existing;
    }
    return get().addTab(tab);
  },

  removeTab: (key) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key !== key);
      const activeKey =
        s.activeKey === key ? (tabs[tabs.length - 1]?.key ?? null) : s.activeKey;
      return {
        tabs,
        activeKey,
        tabsByScope: { ...s.tabsByScope, [s.scope]: tabs },
        activeKeyByScope: { ...s.activeKeyByScope, [s.scope]: activeKey },
      };
    });
  },

  reorder: (from, to) => {
    set((s) => {
      const tabs = [...s.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      return {
        tabs,
        tabsByScope: { ...s.tabsByScope, [s.scope]: tabs },
      };
    });
  },

  loadFromLayout: (layout, defaultCwd) => {
    const tabs: TabEntry[] = layout.map((t) => ({
      key: t.key,
      label: t.label,
      cmd: t.cmd,
      args: [],
      cwd: t.cwd || defaultCwd,
      kind: t.kind ?? cmdToKind(t.cmd || (t.type === "files" ? FILES_TAB_CMD : "")),
    }));
    // Prevent key collisions: advance the counter past any restored key numbers.
    for (const t of tabs) {
      const n = parseInt(t.key.split("-").pop() ?? "0", 10);
      if (!isNaN(n) && n > _keyCounter) _keyCounter = n;
    }
    const activeKey = tabs[0]?.key ?? null;
    set((s) => ({
      tabs,
      activeKey,
      tabsByScope: { ...s.tabsByScope, [s.scope]: tabs },
      activeKeyByScope: { ...s.activeKeyByScope, [s.scope]: activeKey },
    }));
  },

  saveLayout: async (localFile) => {
    const { tabs } = get();
    try {
      const project = await invoke<Record<string, unknown>>("load_project", {
        localFile,
      });
      const tabLayout = tabs.map((t) => ({
        key: t.key,
        label: t.label,
        cmd: t.cmd,
        cwd: t.cwd,
        kind: t.kind,
        type: t.kind,
      }));
      await invoke("save_project", {
        localFile,
        project: { ...project, tab_layout: tabLayout },
      });
    } catch {
      // tab layout is non-critical
    }
  },
}));

export function cmdToKind(cmd: string): TabKind {
  if (cmd === FILES_TAB_CMD) return "files";
  if (cmd === "claude" || cmd === "codex" || cmd === "gemini" || cmd === "vibe") return "agent";
  return "shell";
}
