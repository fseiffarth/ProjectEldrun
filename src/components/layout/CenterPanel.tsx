import { useEffect } from "react";
import { TabBar } from "../tabs/TabBar";
import { TerminalView } from "../terminal/TerminalView";
import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";

export function CenterPanel() {
  const { tabs, activeKey, addTab } = useTabsStore();
  const { projects, activeId } = useProjectsStore();

  const activeProject = projects.find((p) => p.id === activeId);
  const projectCwd = (activeProject?.directory as string | undefined) ?? "";

  // Ensure at least one root terminal exists.
  useEffect(() => {
    if (tabs.length === 0) {
      addTab({ label: "root", cmd: "bash", args: ["--login"], cwd: "", kind: "root" });
    }
  }, [tabs.length, addTab]);

  // When the active project changes, ensure a project terminal exists.
  useEffect(() => {
    if (!activeId || !projectCwd) return;
    const projectTab = tabs.find(
      (t) => t.kind !== "root" && t.cwd === projectCwd,
    );
    if (!projectTab) {
      addTab({
        label: activeProject?.name ?? "project",
        cmd: "bash",
        args: [],
        cwd: projectCwd,
        kind: "shell",
      });
    }
  }, [activeId, projectCwd]);

  return (
    <div className="center-panel">
      <TabBar projectCwd={projectCwd} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {tabs.map((tab) => (
          <TerminalView
            key={tab.key}
            id={tab.key}
            cmd={tab.cmd}
            args={tab.args ?? []}
            cwd={tab.cwd}
            active={tab.key === activeKey}
          />
        ))}
        {tabs.length === 0 && (
          <div className="center-placeholder">
            Opening terminal…
          </div>
        )}
      </div>
    </div>
  );
}
