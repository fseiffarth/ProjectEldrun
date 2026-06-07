import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TerminalView } from "../terminal/TerminalView";
import { FileBrowser } from "../files/FileBrowser";
import { useTabsStore, cmdToKind, FILES_TAB_CMD } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { resolveProjectDirectory } from "../../types";

export function CenterPanel() {
  const tabsByScope = useTabsStore((s) => s.tabsByScope);
  const scope = useTabsStore((s) => s.scope);
  const activeKey = useTabsStore((s) => s.activeKey);
  const setScope = useTabsStore((s) => s.setScope);
  const ensureTab = useTabsStore((s) => s.ensureTab);
  const loadFromLayout = useTabsStore((s) => s.loadFromLayout);
  const tabs = useTabsStore((s) => s.tabs);
  const saveLayout = useTabsStore((s) => s.saveLayout);
  const updateTabEnv = useTabsStore((s) => s.updateTabEnv);
  const { projects, activeId, switchGeneration } = useProjectsStore();
  const settings = useSettingsStore((s) => s.settings);

  const activeProject = projects.find((p) => p.id === activeId);
  const localFile = activeProject?.local_file as string | undefined;
  const projectCwd = resolveProjectDirectory(activeProject);

  const agentCmd = settings?.default_agent_cmd ?? "claude";

  useEffect(() => {
    const nextScope = activeId ?? "root";
    setScope(nextScope);

    // Already have live tabs for this scope — just switch, nothing to spawn.
    if ((useTabsStore.getState().tabsByScope[nextScope]?.length ?? 0) > 0) return;

    if (!activeId || !localFile) {
      // Root context: only spawn on explicit switch.
      if (switchGeneration === 0) return;
      invoke<string>("root_work_dir")
        .then((cwd) => {
          const kind = cmdToKind(agentCmd);
          ensureTab(
            { label: agentCmd, cmd: agentCmd, args: [], cwd, kind },
            (tab) => tab.kind === kind && tab.cwd === cwd,
          );
        })
        .catch(() => {});
      return;
    }

    // Project context: try to restore saved tab layout first.
    type LayoutEntry = { key: string; label: string; cmd: string; cwd: string; kind?: "agent" | "local_agent" | "shell" | "files"; type?: string; env?: Record<string, string>; sessionId?: string };
    invoke<Record<string, unknown>>("load_project", { localFile })
      .then(async (proj) => {
        const raw = proj.tab_layout as LayoutEntry[] | undefined;
        if (!raw || raw.length === 0) return;

        // Refresh session IDs before spawning to avoid resuming cleared sessions.
        const layout = await Promise.all(
          raw.map(async (tab): Promise<LayoutEntry> => {
            const kind = tab.kind ?? cmdToKind(tab.cmd || (tab.type === "files" ? FILES_TAB_CMD : ""));
            if (kind !== "agent" && kind !== "local_agent") return tab;
            const detected = await invoke<string | null>("detect_agent_session_id", {
              agentCmd: tab.cmd,
              projectDir: projectCwd,
              vibeHome: tab.env?.VIBE_HOME ?? null,
            }).catch(() => null);
            if (detected && !tab.sessionId) return { ...tab, sessionId: detected };
            return tab;
          })
        );

        loadFromLayout(layout, projectCwd);
      })
      .catch(() => {});
  }, [activeId, projectCwd, localFile, agentCmd, switchGeneration, setScope, ensureTab, loadFromLayout]);

  // After switching to a project, detect the current session ID for any agent
  // tabs that don't yet have one stored and update them so future restores can
  // resume the session.  Runs 5 s after project switch to give agents time to
  // create their session files.
  useEffect(() => {
    if (!activeId || !projectCwd) return;
    const timer = window.setTimeout(async () => {
      const { tabs: currentTabs, updateTabSessionId: update } = useTabsStore.getState();
      const agentTabs = currentTabs.filter(
        (t) => t.kind === "agent" || t.kind === "local_agent",
      );
      for (const tab of agentTabs) {
        try {
          const sessionId = await invoke<string | null>("detect_agent_session_id", {
            agentCmd: tab.cmd,
            projectDir: projectCwd,
            vibeHome: tab.env?.VIBE_HOME ?? null,
          });
          if (sessionId && !tab.sessionId) update(tab.key, sessionId);
        } catch {
          // session detection is best-effort
        }
      }
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [activeId, projectCwd]);

  // Periodically re-detect session IDs so that /clear (which creates a new
  // session) is picked up without requiring a project switch.  Only runs when
  // there is exactly one agent tab in scope to avoid incorrectly overwriting
  // session IDs across independent multi-agent tab setups.
  useEffect(() => {
    if (!activeId || !projectCwd) return;
    const interval = window.setInterval(async () => {
      const { tabs: currentTabs, updateTabSessionId: update } = useTabsStore.getState();
      const agentTabs = currentTabs.filter(
        (t) => t.kind === "agent" || t.kind === "local_agent",
      );
      if (agentTabs.length !== 1) return;
      const tab = agentTabs[0];
      try {
        const sessionId = await invoke<string | null>("detect_agent_session_id", {
          agentCmd: tab.cmd,
          projectDir: projectCwd,
          vibeHome: tab.env?.VIBE_HOME ?? null,
        });
        if (sessionId && sessionId !== tab.sessionId) update(tab.key, sessionId);
      } catch {
        // session detection is best-effort
      }
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [activeId, projectCwd]);

  // Re-hydrate local_agent tabs that were saved without VIBE_HOME/VIBE_ACTIVE_MODEL.
  useEffect(() => {
    if (!activeId) return;
    const { tabs: currentTabs } = useTabsStore.getState();
    const needsEnv = currentTabs.filter(
      (t) => t.kind === "local_agent" && Object.keys(t.env ?? {}).length === 0,
    );
    for (const tab of needsEnv) {
      invoke<{ vibe_home: string; alias: string }>("prepare_local_agent", { model: tab.label })
        .then(({ vibe_home, alias }) => {
          updateTabEnv(tab.key, { VIBE_HOME: vibe_home, VIBE_ACTIVE_MODEL: alias });
        })
        .catch(() => {});
    }
  }, [activeId, updateTabEnv]);

  useEffect(() => {
    if (!activeId || !localFile) return;
    const timer = window.setTimeout(() => {
      saveLayout(localFile).catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeId, localFile, tabs, saveLayout]);

  // Render all tabs across all scopes so TerminalView components are never
  // unmounted on scope switches (unmounting kills the PTY process).
  const allTabs = Object.entries(tabsByScope).flatMap(([s, tabs]) =>
    tabs.map((tab) => ({ tab, scopeKey: s })),
  );
  const hasVisibleTab = (tabsByScope[scope]?.length ?? 0) > 0;

  return (
    <div className="center-panel">
      {allTabs.map(({ tab, scopeKey }) => (
        tab.kind === "files" ? (
          <FileBrowser
            key={`${scopeKey}/${tab.key}`}
            projectDir={tab.cwd}
            projectId={scopeKey === "root" ? null : scopeKey}
            active={scopeKey === scope && tab.key === activeKey}
          />
        ) : (
          <TerminalView
            key={`${scopeKey}/${tab.key}`}
            id={tab.key}
            cmd={tab.cmd}
            args={tab.args ?? []}
            env={tab.env ?? {}}
            initialInput={tab.initialInput}
            cwd={tab.cwd}
            active={scopeKey === scope && tab.key === activeKey}
          />
        )
      ))}
      {!hasVisibleTab && (
        <div className="center-placeholder">No active project terminal</div>
      )}
    </div>
  );
}
