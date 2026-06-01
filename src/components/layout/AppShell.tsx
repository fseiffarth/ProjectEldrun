import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BottomBar } from "./BottomBar";
import { CenterPanel } from "./CenterPanel";
import { GlobalAppBar } from "./GlobalAppBar";
import { HeaderBar } from "./HeaderBar";
import { RightPanel } from "./RightPanel";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useKeyboard } from "../../hooks/useKeyboard";

export function AppShell() {
  const loadSettings = useSettingsStore((s) => s.load);
  const loadProjects = useProjectsStore((s) => s.load);
  const activeId = useProjectsStore((s) => s.activeId);
  const [panelsHidden, setPanelsHidden] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [bottomOpen, setBottomOpen] = useState(false);
  const [globalOpen, setGlobalOpen] = useState(false);
  const rightCloseTimer = useRef<number | null>(null);
  const bottomCloseTimer = useRef<number | null>(null);
  const globalCloseTimer = useRef<number | null>(null);

  useEffect(() => {
    loadSettings();
    loadProjects();
    getCurrentWindow().setFullscreen(true).catch(() => {});
  }, [loadSettings, loadProjects]);

  const reveal = (
    timer: MutableRefObject<number | null>,
    setter: (open: boolean) => void,
  ) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setter(true);
  };

  const scheduleClose = (
    timer: MutableRefObject<number | null>,
    setter: (open: boolean) => void,
    delay = 250,
  ) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setter(false);
      timer.current = null;
    }, delay);
  };

  useKeyboard({ onTogglePanels: () => setPanelsHidden((v) => !v) });

  const revealRight = activeId !== null && !panelsHidden && rightOpen;
  const revealBottom = !panelsHidden && bottomOpen;
  const revealGlobal = !panelsHidden && globalOpen;

  return (
    <div className="app-shell">
      <HeaderBar />
      <div className="app-body">
        <CenterPanel />
        <div
          className={`global-apps-area ${revealGlobal ? "open" : ""}`}
          onMouseEnter={() => !panelsHidden && reveal(globalCloseTimer, setGlobalOpen)}
          onMouseLeave={() => scheduleClose(globalCloseTimer, setGlobalOpen)}
        >
          <div className={`global-apps-toggle-bar ${revealGlobal ? "panel-open" : ""}`} />
          {revealGlobal && <GlobalAppBar />}
        </div>
        {activeId !== null && !panelsHidden && (
          <div
            className={`file-tree-toggle-strip ${revealRight ? "panel-open" : ""}`}
            onMouseEnter={() => reveal(rightCloseTimer, setRightOpen)}
            onMouseLeave={() => scheduleClose(rightCloseTimer, setRightOpen)}
          />
        )}
        {activeId !== null && !panelsHidden && (
          <RightPanel
            open={revealRight}
            onMouseEnter={() => reveal(rightCloseTimer, setRightOpen)}
            onMouseLeave={() => scheduleClose(rightCloseTimer, setRightOpen)}
          />
        )}
        {!panelsHidden && (
          <div
            className={`bottom-toggle-strip ${revealBottom ? "panel-open" : ""}`}
            onMouseEnter={() => reveal(bottomCloseTimer, setBottomOpen)}
            onMouseLeave={() => scheduleClose(bottomCloseTimer, setBottomOpen)}
          />
        )}
        <div
          className={`bottom-bar-wrap ${revealBottom ? "open" : ""}`}
          onMouseEnter={() => !panelsHidden && reveal(bottomCloseTimer, setBottomOpen)}
          onMouseLeave={() => scheduleClose(bottomCloseTimer, setBottomOpen)}
        >
          <BottomBar />
        </div>
      </div>
    </div>
  );
}
