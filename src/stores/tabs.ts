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
  cwd: string;
  kind: TabKind;
  sessionId?: string;
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
  updateTabSessionId: (key: string, sessionId: string) => void;
  updateTabEnv: (key: string, env: Record<string, string>) => void;
  loadFromLayout: (
    layout: Array<{ key: string; label: string; cmd: string; cwd: string; kind?: TabKind; type?: string; env?: Record<string, string>; sessionId?: string }>,
    defaultCwd: string,
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

  updateTabSessionId: (key, sessionId) => {
    set((s) => {
      const tabs = s.tabs.map((t) =>
        t.key === key ? { ...t, sessionId } : t,
      );
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

  loadFromLayout: (layout, defaultCwd) => {
    const tabs: TabEntry[] = layout.map((t) => {
      const kind = t.kind ?? cmdToKind(t.cmd || (t.type === "files" ? FILES_TAB_CMD : ""));
      const canResume = (kind === "agent" || kind === "local_agent") && !!t.sessionId;
      const args = canResume ? agentResumeArgs(t.cmd, t.sessionId!) : [];
      return {
        key: t.key,
        label: t.label,
        cmd: t.cmd,
        args,
        env: t.env ?? {},
        cwd: t.cwd || defaultCwd,
        kind,
        sessionId: t.sessionId,
      };
    });
    // Prevent key collisions: advance the counter past any restored key numbers.
    for (const t of tabs) {
      const n = parseInt(t.key.split("-").pop() ?? "0", 10);
      if (!isNaN(n) && n > _keyCounter) _keyCounter = n;
    }
    const activeKey = tabs[0]?.key ?? null;
    set((s) => ({
      tabs,
      activeKey,
      ...patchScopeTabs(s, tabs),
      activeKeyByScope: { ...s.activeKeyByScope, [s.scope]: activeKey },
    }));
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
        ...(t.sessionId ? { sessionId: t.sessionId } : {}),
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

/// Build the spawn args that resume a previous session for the given agent CLI.
/// codex uses a subcommand (`codex resume <id>`); all others use `--resume <id>`.
export function agentResumeArgs(cmd: string, sessionId: string): string[] {
  if (cmd === "codex") return ["resume", sessionId];
  return ["--resume", sessionId];
}
