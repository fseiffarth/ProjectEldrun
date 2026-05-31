import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Clock } from "../header/Clock";
import { StatusLamp } from "../header/StatusLamp";
import { WindowControls } from "../header/WindowControls";

interface WorkspaceInfo {
  label: string;
  current_desktop: number | null;
  desktop_count: number | null;
}

export function HeaderBar() {
  const [wsInfo, setWsInfo] = useState<WorkspaceInfo | null>(null);

  useEffect(() => {
    invoke<WorkspaceInfo>("workspace_info")
      .then(setWsInfo)
      .catch(() => {});

    const unlisten = listen<WorkspaceInfo>("workspace-changed", (ev) => {
      setWsInfo(ev.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <header className="app-header">
      <WindowControls />
      <span className="app-title" style={{ flex: 1 }}>Eldrun</span>
      <StatusLamp online={true} workspaceLabel={wsInfo?.label} />
      <Clock />
    </header>
  );
}
