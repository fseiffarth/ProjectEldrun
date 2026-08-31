import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PLATFORM } from "../../lib/dragPlatform";
import { IS_MAC } from "../../lib/platform";
import { trackWindowMove } from "../../stores/windowMove";
import { Clock } from "../header/Clock";
import { StatusCluster } from "../header/StatusCluster";
import { MailIndicator } from "../header/MailIndicator";
import { CalendarIndicator } from "../header/CalendarIndicator";
import { TodoIndicator } from "../header/TodoIndicator";
import { SettingsMenu } from "../header/SettingsMenu";
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

  useEffect(() => {
    invoke<WorkspaceInfo>("workspace_info").catch(() => {});
    listen<WorkspaceInfo>("workspace-changed", () => {}).then((fn) => fn());
  }, []);

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

      {/* The center is the project strip and nothing else. It used to carry the
          six global buttons as well, which made "center" mean both *where am I*
          and *what else can I open* — and, worse, made the one elastic thing in
          the whole bar (the pill strip) share its track with six fixed-width
          controls. Everything global now sits on the right, so the strip's only
          neighbours are separators. */}
      <div className="header-center no-drag">
        <ProjectSwitcher open />
      </div>
      {/* Right of the strip, in three groups separated by gap rather than by more
          hairlines: machine state, then the global *apps* (kept as their own
          buttons — mail, calendar and to-do each carry a live badge, which is
          exactly what a launcher menu would hide), then the global *menus*.
          Machine state leads rather than trails: it is a readout, not a control,
          so it belongs next to the project strip it describes — and putting it
          first also stops its widest members (the 280px machines list, the VPN
          and Mobile panels) from opening hard against the window's right edge. */}
      <div className="header-right no-drag">
        <StatusCluster />
        <span className="header-right-gap" aria-hidden="true" />
        <MailIndicator />
        <CalendarIndicator />
        <TodoIndicator />
        <span className="header-right-gap" aria-hidden="true" />
        <LocalModelMenu />
        <GlobalAppMenu />
        {/* Settings belong to the machine, not to a project, so the gear stays
            with the other global buttons rather than at the head of the project
            strip, where it put the switcher's own controls on both sides of a
            scrolling row. */}
        <SettingsMenu />
        <span className="project-switcher-separator" aria-hidden="true" />
        <WindowControls />
      </div>
    </header>
  );
}
