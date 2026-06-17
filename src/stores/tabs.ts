import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export type TabKind = "agent" | "local_agent" | "shell" | "files";

export const FILES_TAB_CMD = "__eldrun_files__";

export interface TabEntry {
  key: string;
  label: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  initialInput?: string;
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
  updateTabEnv: (key: string, env: Record<string, string>) => void;
  loadFromLayout: (
    layout: Array<{ key: string; label: string; cmd: string; cwd: string; kind?: TabKind; type?: string; env?: Record<string, string> }>,
    defaultCwd: string,
    targetScope?: string,
  ) => void;
  saveLayout: (localFile: string) => Promise<void>;
}

let _keyCounter = 0;
function nextKey(prefix: string) {
  return `${prefix}-${++_keyCounter}`;
}

function patchScopeTabs(s: TabsStore, tabs: TabEntry[]) {
  return { tabsByScope: { ...s.tabsByScope, [s.scope]: tabs } };
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
        ...patchScopeTabs(s, tabs),
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
        ...patchScopeTabs(s, tabs),
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
        ...patchScopeTabs(s, tabs),
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
        ...patchScopeTabs(s, tabs),
      };
    });
  },

  updateTabEnv: (key, env) => {
    set((s) => {
      const tabs = s.tabs.map((t) =>
        t.key === key ? { ...t, env } : t,
      );
      return {
        tabs,
        ...patchScopeTabs(s, tabs),
      };
    });
  },

  loadFromLayout: (layout, defaultCwd, targetScope) => {
    const tabs: TabEntry[] = layout.map((t) => {
      const kind = t.kind ?? cmdToKind(t.cmd || (t.type === "files" ? FILES_TAB_CMD : ""));
      // Agent tabs always start in the current project dir so stale saved cwds
      // don't put the agent in the wrong directory after a project move/rename.
      const isAgent = kind === "agent" || kind === "local_agent";
      return {
        // Saved keys are only unique within the session that wrote them — two
        // projects can persist the same key (e.g. both saved "agent-1"). Keys
        // double as PTY ids, so always mint a fresh one on restore.
        key: nextKey(kind),
        label: t.label,
        cmd: t.cmd,
        args: [],
        env: t.env ?? {},
        cwd: (isAgent && defaultCwd) ? defaultCwd : (t.cwd || defaultCwd),
        kind,
      };
    });
    const activeKey = tabs[0]?.key ?? null;
    set((s) => {
      // Use the explicitly requested scope when provided; this prevents a race
      // where a stale async resolve would write into whatever scope happens to
      // be current at the time the set() callback runs.
      const scope = targetScope ?? s.scope;
      const isCurrentScope = s.scope === scope;
      return {
        // Only update the flat tabs/activeKey shortcuts when this is still the
        // active scope — they are always the current scope's mirror.
        ...(isCurrentScope ? { tabs, activeKey } : {}),
        tabsByScope: { ...s.tabsByScope, [scope]: tabs },
        activeKeyByScope: { ...s.activeKeyByScope, [scope]: activeKey },
      };
    });
  },

  saveLayout: async (localFile) => {
    const { tabs } = get();
    try {
      const tabLayout = tabs.map((t) => ({
        key: t.key,
        label: t.label,
        cmd: t.cmd,
        cwd: t.cwd,
        kind: t.kind,
        env: t.env ?? {},
      }));
      await invoke("save_tab_layout", { localFile, tabs: tabLayout });
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

export function isLocalAgentKind(kind: TabKind): kind is "local_agent" {
  return kind === "local_agent";
}

