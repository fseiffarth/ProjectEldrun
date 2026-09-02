import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import type { GlobalAppEntry } from "../../types";
import { basename, IS_WINDOWS } from "../../lib/paths";
import {
  cancelDelayedCapture,
  requestInAppCapture,
  SCREENSHOT_DELAY_MS,
  startDelayedCapture,
} from "../../lib/screenshot";
import { useT, type TranslationKey } from "../../lib/i18n";

// A platform-appropriate example path for the executable-picker placeholder
// (a Windows .exe vs a Unix bin path).
const EXEC_PLACEHOLDER = IS_WINDOWS
  ? "Command path, e.g. C:\\Program Files\\Mozilla Firefox\\firefox.exe"
  : "Command path, e.g. /usr/bin/firefox";

export const GLOBAL_APP_ROLES: Array<{ key: string; labelKey: TranslationKey; fallback: string }> = [
  { key: "browser", labelKey: "globalApp.role.browser", fallback: "🌐" },
  { key: "password_manager", labelKey: "globalApp.role.password_manager", fallback: "⚿" },
  { key: "video_conf", labelKey: "globalApp.role.video_conf", fallback: "▣" },
  { key: "screenshot", labelKey: "globalApp.role.screenshot", fallback: "▤" },
  { key: "screen_recorder", labelKey: "globalApp.role.screen_recorder", fallback: "●" },
  { key: "chat", labelKey: "globalApp.role.chat", fallback: "☏" },
];

const ROLE_BY_KEY = Object.fromEntries(GLOBAL_APP_ROLES.map((role) => [role.key, role]));

// Roles Eldrun no longer launches an external app for, because it now has its
// own: mail (the header's `MailIndicator` + its overlay), calendar
// (the header's `CalendarIndicator` + its overlay), the file manager (the file panel, the Files tab, the docked file
// column), the print manager (the native Print Manager tab —
// `PRINTING_TAB_CMD` / `printing/PrintManagerPane`, opened from the new-tab
// menu), the system monitor (the native Monitor tab — `MONITOR_TAB_CMD` /
// `monitoring/SystemMonitorPane`, likewise from the new-tab menu, plus the
// header's per-machine `GlobalMachineMonitorDialog`), notes (the editable
// text/markdown viewers in `embed/FileViewerPane`, reached from the file tree
// or a Files tab) and the media player (the in-tab audio/video viewer,
// `embed/MediaView`, which every playable extension routes to).
// Dropping them from `GLOBAL_APP_ROLES` alone is not enough — an
// existing `settings.json` (or a Windows/macOS seeded default) still holds the
// entries, and `orderedGlobalApps` deliberately renders *unknown* roles so a
// hand-added one isn't swallowed, so without this they'd come back as unnamed
// "●" buttons. Filtered rather than deleted from settings: a role that gets
// re-added later should find its configured command still there.
// Every role named in the paragraph above must therefore appear in the set
// below. `print_manager` was named there and missing here, so an older
// `settings.json` carrying that entry rendered exactly the stray button this
// set exists to prevent; `GlobalAppRoles.test.ts` now pins the two lists
// together so the next retirement cannot half-land the same way.
const RETIRED_GLOBAL_APP_ROLES = new Set([
  "mail",
  "calendar",
  "file_manager",
  "print_manager",
  "system_monitor",
  "notes",
  "media_player",
]);

type EditState = {
  role: string;
  label: string;
  exec: string;
  x: number;
  y: number;
};

export function GlobalAppBar() {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const [edit, setEdit] = useState<EditState | null>(null);
  const [iconDataUrls, setIconDataUrls] = useState<Record<string, string | null>>({});
  const popoverRef = useRef<HTMLDivElement>(null);

  const apps = useMemo(
    () => orderedGlobalApps(settings?.global_apps ?? {}).filter(([, app]) => app.visible !== false),
    [settings?.global_apps],
  );

  useEffect(() => {
    let cancelled = false;
    const execs = [...new Set(apps.map(([, app]) => app.exec).filter(Boolean))];
    Promise.all(
      execs.map(async (exec) => {
        try {
          const dataUrl = await invoke<string | null>("resolve_app_icon", { exec });
          return [exec, dataUrl] as const;
        } catch {
          return [exec, null] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setIconDataUrls(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [apps]);

  useEffect(() => {
    if (!edit) return;
    const close = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) setEdit(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEdit(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [edit]);

  if (apps.length === 0) return null;

  const launch = (role: string, exec: string, delayed = false) => {
    if (role === "screenshot") {
      // A pending countdown belongs to the press that started it: pressing again
      // restarts (or, for a plain click, replaces) it rather than queueing a
      // second capture behind the one about to fire.
      cancelDelayedCapture();
      if (delayed) {
        // Shift+click: wait, so the user can Alt+Tab to the window they actually
        // want. A region tool grabs the pointer AND the keyboard for the whole
        // of its selection, so once its overlay is up there is no switching
        // windows — the delay is the only place that switch can happen. An
        // in-app claimant is deliberately not offered the shot here: the point
        // of the wait is to capture something that is not this window.
        startDelayedCapture({
          delayMs: SCREENSHOT_DELAY_MS,
          tick: (secs) =>
            useProjectsStore.setState({
              switchToast: t("globalApp.screenshotCountdown", { secs }),
            }),
          capture: () => captureScreenshot(exec),
        });
        return;
      }
      // A visible PDF viewer claims the shot first: the region is then captured
      // from the rendered document itself (sharper than a screen grab, pending
      // blackouts burned in) and goes to the clipboard + the save overlay — no
      // OS tool involved. See `lib/screenshot`.
      if (requestInAppCapture()) return;
      captureScreenshot(exec);
      return;
    }
    if (!exec) return;
    invoke("launch_app", { exec, args: [], file: null, projectId: null, role }).catch(() => {});
  };

  /** Spawn the OS region tool. The PNG lands in the staging area and comes back
   *  as a `screenshot-captured` event that raises `ScreenshotSaveOverlay`; no
   *  project is written to until that overlay is answered, which is why this
   *  needs no active project any more. */
  const captureScreenshot = (exec: string) => {
    invoke("capture_screenshot", { exec: exec || null }).catch(() => {});
  };

  const updateGlobalApp = async (role: string, patch: Partial<GlobalAppEntry>) => {
    const globalApps = settings?.global_apps ?? {};
    const current = globalApps[role] ?? { exec: "", visible: true };
    await updateSettings({ global_apps: { ...globalApps, [role]: { ...current, ...patch } } });
  };

  const browseExecutable = async () => {
    if (!edit) return;
    const picked = await open({ directory: false, multiple: false });
    if (typeof picked === "string") setEdit({ ...edit, exec: picked });
  };

  const saveEdit = () => {
    if (!edit) return;
    void updateGlobalApp(edit.role, { exec: edit.exec.trim() }).then(() => setEdit(null));
  };

  const clearEdit = () => {
    if (!edit) return;
    void updateGlobalApp(edit.role, { exec: "" }).then(() => setEdit(null));
  };

  return (
    <div className="tab-new-menu" onClick={(e) => e.stopPropagation()}>
      {apps.map(([role, app]) => {
        const meta = ROLE_BY_KEY[role];
        const label = meta ? t(meta.labelKey) : role;
        const iconDataUrl = app.exec ? iconDataUrls[app.exec] : null;
        return (
          <button
            key={role}
            className="tab-new-menu-item global-app-menu-row"
            title={`${label}${app.exec ? `: ${app.exec}` : ""} · ${t("globalApp.rightClickConfigure")}${
              role === "screenshot"
                ? ` · ${t("globalApp.screenshotDelayHint", { secs: Math.round(SCREENSHOT_DELAY_MS / 1000) })}`
                : ""
            }`}
            aria-disabled={role !== "screenshot" && !app.exec}
            onClick={(event) => launch(role, app.exec, role === "screenshot" && event.shiftKey)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setEdit({ role, label, exec: app.exec, x: event.clientX, y: event.clientY });
            }}
          >
            {iconDataUrl ? (
              <img className="global-app-icon" src={iconDataUrl} aria-hidden />
            ) : (
              <span className="global-app-fallback-icon" aria-hidden>{meta?.fallback ?? "●"}</span>
            )}
            {label}
          </button>
        );
      })}
      {edit && (
        <div
          ref={popoverRef}
          className="global-app-edit-popover"
          style={{ left: edit.x, top: edit.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="global-app-edit-title">{edit.label}</div>
          <div className="global-app-edit-current">{basename(edit.exec) || t("globalApp.noCommandConfigured")}</div>
          <div className="global-app-edit-row">
            <input
              value={edit.exec}
              placeholder={EXEC_PLACEHOLDER}
              onChange={(event) => setEdit({ ...edit, exec: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveEdit();
              }}
              autoFocus
            />
            <button type="button" onClick={() => void browseExecutable()}>...</button>
          </div>
          <div className="global-app-edit-actions">
            <button type="button" onClick={clearEdit}>{t("globalApp.clear")}</button>
            <button type="button" className="suggested-action" onClick={saveEdit}>{t("globalApp.set")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Exported for `GlobalAppRoles.test.ts` — the retirement filter is the whole
 *  reason this function is not a bare `Object.entries`. */
export function orderedGlobalApps(apps: Record<string, GlobalAppEntry>): Array<[string, GlobalAppEntry]> {
  const ordered = GLOBAL_APP_ROLES
    .map((role) => [role.key, apps[role.key]] as const)
    .filter((entry): entry is [string, GlobalAppEntry] => Boolean(entry[1]));
  const known = new Set(GLOBAL_APP_ROLES.map((role) => role.key));
  return [
    ...ordered,
    ...Object.entries(apps)
      .filter(([role]) => !known.has(role) && !RETIRED_GLOBAL_APP_ROLES.has(role))
      .sort(([a], [b]) => a.localeCompare(b)),
  ];
}

