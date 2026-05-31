import { useEffect, useState } from "react";
import { BottomBar } from "./BottomBar";
import { CenterPanel } from "./CenterPanel";
import { HeaderBar } from "./HeaderBar";
import { RightPanel } from "./RightPanel";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";

export function AppShell() {
  const loadSettings = useSettingsStore((s) => s.load);
  const loadProjects = useProjectsStore((s) => s.load);
  const [rightOpen, setRightOpen] = useState(false);

  useEffect(() => {
    loadSettings();
    loadProjects();
  }, [loadSettings, loadProjects]);

  return (
    <div className="app-shell">
      <HeaderBar />
      <div className="app-body">
        <CenterPanel />
        <RightPanel open={rightOpen} />
      </div>
      <BottomBar onToggleRight={() => setRightOpen((v) => !v)} />
    </div>
  );
}
