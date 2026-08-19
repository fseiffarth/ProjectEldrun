import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PLATFORM } from "../../lib/dragPlatform";
import { IS_MAC } from "../../lib/platform";
import { trackWindowMove } from "../../stores/windowMove";
import { AppResourceDisplay } from "../header/AppResourceDisplay";
import { Clock } from "../header/Clock";
import { useQuiesce, saverInterval, usePowerStore } from "../../stores/power";
import { ConnTypeIcon } from "../header/ConnTypeIcon";
import { BatteryIndicator } from "../header/BatteryIndicator";
import { VpnIndicator } from "../header/VpnIndicator";
import { MachinesIndicator } from "../header/MachinesIndicator";
import { MailIndicator } from "../header/MailIndicator";
import { CalendarIndicator } from "../header/CalendarIndicator";
import { TodoIndicator } from "../header/TodoIndicator";
import { WindowControls } from "../header/WindowControls";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { GlobalAppMenu } from "./GlobalAppMenu";
import { LocalModelMenu } from "./LocalModelMenu";
import { useT } from "../../lib/i18n";

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
  const t = useT();
  const [online, setOnline] = useState(navigator.onLine);
  const [connType, setConnType] = useState<string | null>(null);
  const quiesce = useQuiesce();
  const batterySupported = usePowerStore((s) => s.supported);
  const batteryPercentage = usePowerStore((s) => s.percentage);
  const onBattery = usePowerStore((s) => s.onBattery);

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
    const id = setInterval(poll, saverInterval(10_000, quiesce));
    return () => clearInterval(id);
  }, [quiesce]);

  const connKind =
    connType === "lan" ? "lan" : connType === "wlan" ? "wlan" : null;

  return (
    <header
      className={`app-header${IS_MAC ? " is-mac" : ""}`}
      onMouseDown={handleDrag}
    >
      <div className="header-left" data-tauri-drag-region>
        {/* Explicit window-move grip. The whole header is already a drag region
            (`handleDrag`), but a crowded header can leave nothing obvious to grab —
            this grip is an always-present handle. A plain (non-button) element in a
            drag-eligible area, so its mousedown bubbles to `handleDrag` (it doesn't
            match NON_DRAG_SELECTOR), driving the same `startDragging()`. */}
        <span
          className="app-drag-grip"
          title={t("header.dragToMove")}
          aria-hidden="true"
        >
          ⠿
        </span>
        <Clock />
        <span className="project-switcher-separator" aria-hidden="true" />
      </div>

      <div className="header-center no-drag">
        <LocalModelMenu />
        {/* Directly right of the brain button: these are global apps you reach
            from anywhere, not per-project status readouts like the right
            cluster. Each renders nothing until its own "in the header" setting
            is on — see MailIndicator / CalendarIndicator. */}
        <MailIndicator />
        <CalendarIndicator />
        <TodoIndicator />
        <GlobalAppMenu />
        <ProjectSwitcher open />
      </div>
      <div className="header-right no-drag">
        {(connKind || !online) && (
          <ConnTypeIcon type={connKind ?? "wlan"} online={online} />
        )}
        {batterySupported && (
          <BatteryIndicator percentage={batteryPercentage} plugged={!onBattery} />
        )}
        <VpnIndicator />
        <MachinesIndicator />
        <AppResourceDisplay />
        <span className="project-switcher-separator" aria-hidden="true" />
        <WindowControls />
      </div>
    </header>
  );
}
