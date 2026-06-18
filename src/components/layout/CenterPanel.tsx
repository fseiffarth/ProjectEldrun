import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TerminalView } from "../terminal/TerminalView";
import { FileBrowser } from "../files/FileBrowser";
import { useTabsStore, type TabKind } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { resolveProjectDirectory } from "../../types";

export function CenterPanel() {
  const tabsByScope = useTabsStore((s) => s.tabsByScope);
  const scope = useTabsStore((s) => s.scope);
  const activeKey = useTabsStore((s) => s.activeKey);
  const grid = useTabsStore((s) => s.grid);
  const setScope = useTabsStore((s) => s.setScope);
  const setActive = useTabsStore((s) => s.setActive);
  const loadFromLayout = useTabsStore((s) => s.loadFromLayout);
  const tabs = useTabsStore((s) => s.tabs);
  const saveLayout = useTabsStore((s) => s.saveLayout);
  const updateTabEnv = useTabsStore((s) => s.updateTabEnv);

  const { projects, activeId } = useProjectsStore();

  const activeProject = projects.find((p) => p.id === activeId);
  const localFile = activeProject?.local_file as string | undefined;
  const projectCwd = resolveProjectDirectory(activeProject);

  useEffect(() => {
    const nextScope = activeId ?? "root";
    setScope(nextScope);

    if (!activeId || !localFile) {
      // Root context: never auto-spawn; leave empty until the user opens a tab.
      return;
    }

    // Scope was already initialized this session (tabs may be empty by user intent).
    // Trust in-memory state rather than re-reading disk — avoids restoring
    // intentionally-closed tabs, and eliminates a race where load_project reads
    // stale project.json before switch_project_runtime has written the empty layout.
    if (nextScope in useTabsStore.getState().tabsByScope) return;

    // Project context: restore saved tab layout from disk (first visit this session).
    // Capture the scope now so the async chain always writes to the right
    // scope bucket even if the user switches projects before it resolves.
    const scopeForLoad = nextScope;
    type LayoutEntry = { key: string; label: string; cmd: string; cwd: string; kind?: TabKind; type?: string; env?: Record<string, string> };
    invoke<Record<string, unknown>>("load_project", { localFile })
      .then((proj) => {
        const raw = proj.tab_layout as LayoutEntry[] | undefined;
        if (!raw || raw.length === 0) return;
        // Guard: don't overwrite tabs that switch_project_runtime already loaded.
        if (scopeForLoad in useTabsStore.getState().tabsByScope) return;
        loadFromLayout(raw, projectCwd, scopeForLoad);
      })
      .catch(() => {});
  }, [activeId, projectCwd, localFile, setScope, loadFromLayout]);

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
  const scopeTabCount = tabsByScope[scope]?.length ?? 0;
  const hasVisibleTab = scopeTabCount > 0;
  // Grid is only meaningful with more than one pane in the current scope.
  const gridMode = grid && scopeTabCount > 1;
  const cols = gridMode ? Math.ceil(Math.sqrt(scopeTabCount)) : 1;
  const rows = gridMode ? Math.ceil(scopeTabCount / cols) : 1;
  const gridStyle = gridMode
    ? {
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        gap: "1px",
      }
    : undefined;

  return (
    <div className={`center-panel${gridMode ? " grid-mode" : ""}`} style={gridStyle}>
      {allTabs.map(({ tab, scopeKey }) => {
        const isCurrentScope = scopeKey === scope;
        // In grid mode every current-scope pane is laid out; otherwise only the
        // active tab is. The active tab is always the focused one.
        const focused = isCurrentScope && tab.key === activeKey;
        const visible = isCurrentScope && (gridMode || focused);
        const paneClass =
          "center-pane" + (visible ? " visible" : "") + (gridMode && focused ? " focused" : "");
        return (
          <div
            key={`${scopeKey}/${tab.key}`}
            className={paneClass}
            // In grid mode, clicking a pane makes it the focused/active tab.
            onMouseDownCapture={
              gridMode && !focused ? () => setActive(tab.key) : undefined
            }
          >
            {tab.kind === "files" ? (
              <FileBrowser
                projectDir={tab.cwd}
                projectId={scopeKey === "root" ? null : scopeKey}
                active={visible}
              />
            ) : (
              <TerminalView
                // PTY ids must include the scope: tab keys alone can collide
                // across projects (restored layouts), which would attach two
                // projects' terminals to the same PTY stream.
                id={`${scopeKey}:${tab.key}`}
                cmd={tab.cmd}
                args={tab.args ?? []}
                env={tab.env ?? {}}
                initialInput={tab.initialInput}
                cwd={tab.cwd}
                visible={visible}
                focused={focused}
              />
            )}
          </div>
        );
      })}
      {!hasVisibleTab && (
        <div className="center-placeholder">No active project terminal</div>
      )}
    </div>
  );
}
