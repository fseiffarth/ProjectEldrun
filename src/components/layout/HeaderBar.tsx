import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Clock } from "../header/Clock";
import { ConnTypeIcon } from "../header/ConnTypeIcon";
import { StatusLamp } from "../header/StatusLamp";
import { WindowControls } from "../header/WindowControls";
import { TabBar } from "../tabs/TabBar";
import { useProjectsStore } from "../../stores/projects";

interface WorkspaceInfo {
  label: string;
  current_desktop: number | null;
  desktop_count: number | null;
}

const APP_VERSION = "0.1.0";

const NON_DRAG_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  ".no-drag",
  ".tab",
  ".tab-bar",
  ".tab-new-wrap",
].join(",");

function handleDrag(e: React.MouseEvent) {
  if (e.buttons !== 1) return;
  const target = e.target as HTMLElement;
  if (!target.closest(NON_DRAG_SELECTOR)) {
    getCurrentWindow().startDragging().catch(() => {});
  }
}

export function HeaderBar() {
  const [online, setOnline] = useState(navigator.onLine);
  const [connType, setConnType] = useState<string | null>(null);
  const { projects, activeId } = useProjectsStore();

  const activeProject = projects.find((p) => p.id === activeId);
  const projectCwd = (activeProject?.directory as string | undefined) ?? "";

  useEffect(() => {
    invoke<WorkspaceInfo>("workspace_info").catch(() => {});
    listen<WorkspaceInfo>("workspace-changed", () => {}).then((fn) => fn());
  }, []);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    const poll = () =>
      invoke<string>("network_conn_type")
        .then(setConnType)
        .catch(() => {});
    poll();
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, []);

  const isDev = import.meta.env.DEV;
  const connKind =
    connType === "lan" ? "lan" : connType === "wlan" ? "wlan" : null;

  return (
    <header className="app-header" onMouseDown={handleDrag}>
      <div className="header-left" data-tauri-drag-region>
        <StatusLamp online={online} />
        <div className="app-version-stack">
          {isDev && <span className="debug-badge">DEBUG</span>}
          <span className="app-version-label">v{APP_VERSION}</span>
        </div>
        {connKind && <ConnTypeIcon type={connKind} />}
      </div>
      <div className="header-center no-drag">
        <TabBar projectCwd={projectCwd} />
      </div>
      <div className="header-right no-drag">
        <Clock />
        <WindowControls />
      </div>
    </header>
  );
}
