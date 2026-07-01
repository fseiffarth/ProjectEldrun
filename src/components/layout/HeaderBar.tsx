import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PLATFORM } from "../../lib/dragPlatform";
import { IS_MAC } from "../../lib/platform";
import { trackWindowMove } from "../../stores/windowMove";
import { AppTimerDisplay } from "../header/AppTimerDisplay";
import { AppResourceDisplay } from "../header/AppResourceDisplay";
import { Clock } from "../header/Clock";
import { ConnTypeIcon } from "../header/ConnTypeIcon";
import { RemoteConnMenu } from "../header/RemoteConnMenu";
import { WindowControls } from "../header/WindowControls";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { GlobalAppMenu } from "./GlobalAppMenu";
import { LocalModelMenu } from "./LocalModelMenu";
import { LogoIcon } from "./LogoIcon";
import { useProjectsStore } from "../../stores/projects";
// Single source of truth for the displayed version: read package.json (kept in
// lockstep with src-tauri/Cargo.toml + tauri.conf.json on every bump) so the
// header never drifts behind a release.
import { version as APP_VERSION } from "../../../package.json";

interface WorkspaceInfo {
  label: string;
  current_desktop: number | null;
  desktop_count: number | null;
}

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
  // Gate on `button` (singular: 0 = left) not `buttons` (the held-button bitmask).
  // WebKitGTK reports `buttons === 0` during the mousedown that begins a press —
  // the bit isn't set until the next event — so `buttons !== 1` swallowed every
  // drag on Linux (no grab ever started). `button === 0` is reliable on mousedown
  // across WebKitGTK/Chromium/WKWebView and also ignores middle/right clicks.
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (!target.closest(NON_DRAG_SELECTOR)) {
    // Windows: hide the heavy terminal panes for the duration of the OS move loop
    // so WebView2 only composites the cheap frame and keeps up with the cursor
    // (otherwise the canvases lag/swim behind the dragged window). Other engines
    // drag the live content smoothly, so they skip the hide.
    if (PLATFORM === "windows") trackWindowMove();
    getCurrentWindow().startDragging().catch(() => {});
  }
}

export function HeaderBar() {
  const [online, setOnline] = useState(navigator.onLine);
  const [connType, setConnType] = useState<string | null>(null);
  const activeId = useProjectsStore((s) => s.activeId);
  const setActive = useProjectsStore((s) => s.setActive);
  // The active project's remote spec + its live SSH/VPN connection state, shown as
  // header lamps so the user can see at a glance whether a remote project is up.
  const activeProject = useProjectsStore((s) => s.projects.find((p) => p.id === s.activeId));

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
    <header
      className={`app-header${IS_MAC ? " is-mac" : ""}`}
      onMouseDown={handleDrag}
    >
      <div className="header-left" data-tauri-drag-region>
        <button
          type="button"
          className={`root-logo-btn no-drag ${activeId === null ? "active" : ""}`}
          title="Root terminal"
          aria-label="Root terminal"
          onClick={() => void setActive(null)}
        >
          <LogoIcon className="app-logo" />
        </button>
        <div className="app-version-stack">
          {isDev && <span className="debug-badge">DEBUG</span>}
          <span className="app-version-label">v{APP_VERSION}</span>
        </div>
        {(connKind || !online) && (
          <ConnTypeIcon type={connKind ?? "wlan"} online={online} />
        )}
        {activeProject?.remote && <RemoteConnMenu project={activeProject} />}
      </div>

      <div className="header-center no-drag">
        <LocalModelMenu />
        <GlobalAppMenu />
        <ProjectSwitcher open />
      </div>
      <div className="header-right no-drag">
        <AppResourceDisplay />
        <AppTimerDisplay />
        <Clock />
        <WindowControls />
      </div>
    </header>
  );
}
