import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TerminalView } from "../terminal/TerminalView";
import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";

export function CenterPanel() {
  const { tabs, activeKey, ensureTab } = useTabsStore();
  const { projects, activeId } = useProjectsStore();

  const activeProject = projects.find((p) => p.id === activeId);
  const projectCwd = (activeProject?.directory as string | undefined) ?? "";

  useEffect(() => {
    if (!activeId) {
      invoke<string>("root_work_dir")
        .then((cwd) => {
          ensureTab(
            {
              label: "root",
              cmd: "bash",
              args: [],
              cwd,
              kind: "shell",
            },
            (tab) => tab.kind === "shell" && tab.cwd === cwd,
          );
        })
        .catch(() => {});
      return;
    }
    if (!projectCwd) return;
    ensureTab(
      {
        label: activeProject?.name ?? "project",
        cmd: "bash",
        args: [],
        cwd: projectCwd,
        kind: "shell",
      },
      (tab) => tab.kind === "shell" && tab.cwd === projectCwd,
    );
  }, [activeId, projectCwd, activeProject?.name, ensureTab]);

  return (
    <div className="center-panel">
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
        <div className="center-placeholder">No active project terminal</div>
      )}
    </div>
  );
}
