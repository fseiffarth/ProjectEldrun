import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TerminalView } from "../terminal/TerminalView";
import { FileBrowser } from "../files/FileBrowser";
import { useTabsStore, cmdToKind, type TabKind } from "../../stores/tabs";
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
    // Capture the scope now so the async chain always writes to the right
    // scope bucket even if the user switches projects before it resolves.
    const scopeForLoad = nextScope;
    type LayoutEntry = { key: string; label: string; cmd: string; cwd: string; kind?: TabKind; type?: string; env?: Record<string, string> };
    invoke<Record<string, unknown>>("load_project", { localFile })
      .then((proj) => {
        const raw = proj.tab_layout as LayoutEntry[] | undefined;
        if (!raw || raw.length === 0) return;
        // Guard: don't overwrite tabs that switch_project_runtime already loaded.
        if ((useTabsStore.getState().tabsByScope[scopeForLoad]?.length ?? 0) > 0) return;
        loadFromLayout(raw, projectCwd, scopeForLoad);
      })
      .catch(() => {});
  }, [activeId, projectCwd, localFile, agentCmd, switchGeneration, setScope, ensureTab, loadFromLayout]);

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
