import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TerminalView } from "../terminal/TerminalView";
import { FileBrowser } from "../files/FileBrowser";
import { useTabsStore, cmdToKind } from "../../stores/tabs";
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
    invoke<Record<string, unknown>>("load_project", { localFile })
      .then((proj) => {
        const layout = proj.tab_layout as
          | Array<{ key: string; label: string; cmd: string; cwd: string; kind?: "agent" | "local_agent" | "shell" | "files"; type?: string; env?: Record<string, string>; sessionId?: string }>
          | undefined;
        if (layout && layout.length > 0) {
          loadFromLayout(layout, projectCwd);
        }
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
      const needsSession = currentTabs.filter(
        (t) => (t.kind === "agent" || t.kind === "local_agent") && !t.sessionId,
      );
      for (const tab of needsSession) {
        try {
          const sessionId = await invoke<string | null>("detect_agent_session_id", {
            agentCmd: tab.cmd,
            projectDir: projectCwd,
            vibeHome: tab.env?.VIBE_HOME ?? null,
          });
          if (sessionId) update(tab.key, sessionId);
        } catch {
          // session detection is best-effort
        }
      }
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [activeId, projectCwd]);

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
