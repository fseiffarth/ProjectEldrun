import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { FILES_TAB_CMD, useTabsStore } from "../../stores/tabs";
import type { GlobalAppEntry } from "../../types";
import { resolveProjectDirectory } from "../../types";

export const GLOBAL_APP_ROLES: Array<{ key: string; label: string; fallback: string }> = [
  { key: "browser", label: "Browser", fallback: "🌐" },
  { key: "mail", label: "Mail", fallback: "✉" },
  { key: "calendar", label: "Calendar", fallback: "◷" },
  { key: "print_manager", label: "Print Manager", fallback: "⎙" },
  { key: "file_manager", label: "File Manager", fallback: "📁" },
  { key: "password_manager", label: "Password Manager", fallback: "⚿" },
  { key: "video_conf", label: "Video Conf.", fallback: "▣" },
  { key: "media_player", label: "Media Player", fallback: "▶" },
  { key: "system_monitor", label: "System Monitor", fallback: "▥" },
  { key: "notes", label: "Notes", fallback: "☰" },
  { key: "screenshot", label: "Screenshot", fallback: "▤" },
  { key: "screen_recorder", label: "Screen Recorder", fallback: "●" },
  { key: "chat", label: "Chat", fallback: "☏" },
];

const ROLE_BY_KEY = Object.fromEntries(GLOBAL_APP_ROLES.map((role) => [role.key, role]));

type EditState = {
  role: string;
  label: string;
  exec: string;
  x: number;
  y: number;
};

export function GlobalAppBar() {
  const { settings, updateSettings } = useSettingsStore();
  const { projects, activeId } = useProjectsStore();
  const { ensureTab } = useTabsStore();
  const [edit, setEdit] = useState<EditState | null>(null);
  const [iconDataUrls, setIconDataUrls] = useState<Record<string, string | null>>({});
  const popoverRef = useRef<HTMLDivElement>(null);
  const activeProject = projects.find((p) => p.id === activeId);
  const activeDir = resolveProjectDirectory(activeProject) || undefined;

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

  const launch = (role: string, exec: string) => {
    if (role === "file_manager") {
      ensureTab(
        { label: "Files", cmd: FILES_TAB_CMD, cwd: activeDir ?? "", kind: "files" },
        (tab) => tab.kind === "files" && tab.cwd === (activeDir ?? ""),
      );
      return;
    }
    if (role === "screenshot") {
      // Capture a region into the active project's screenshots/ folder, driving
      // the configured tool's output path (or a native fallback) there. Without
      // an active project there's nowhere to file the shot, so fall back to
      // plainly launching the configured tool.
      if (activeDir) {
        invoke("capture_project_screenshot", { projectDir: activeDir, exec: exec || null }).catch(
          () => {},
        );
      } else if (exec) {
        invoke("launch_app", {
          exec,
          args: screenshotRegionArgs(exec),
          file: null,
          projectId: null,
          role,
        }).catch(() => {});
      }
      return;
    }
    if (!exec) return;
    invoke("launch_app", { exec, args: [], file: null, projectId: null, role }).catch(() => {});
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
    <div className="global-apps-toolbar" onClick={(e) => e.stopPropagation()}>
      {apps.map(([role, app]) => {
        const meta = ROLE_BY_KEY[role] ?? { key: role, label: role, fallback: "●" };
        const iconDataUrl = app.exec ? iconDataUrls[app.exec] : null;
        return (
          <button
            key={role}
            className="global-app-btn"
            title={`${meta.label}${app.exec ? `: ${app.exec}` : ""} · Right-click to configure`}
            aria-disabled={role !== "file_manager" && role !== "screenshot" && !app.exec}
            onClick={() => launch(role, app.exec)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setEdit({ role, label: meta.label, exec: app.exec, x: event.clientX, y: event.clientY });
            }}
          >
            {iconDataUrl ? (
              <img className="global-app-icon" src={iconDataUrl} aria-hidden />
            ) : (
              <span className="global-app-fallback-icon" aria-hidden>{meta.fallback}</span>
            )}
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
          <div className="global-app-edit-current">{basename(edit.exec) || "No command configured"}</div>
          <div className="global-app-edit-row">
            <input
              value={edit.exec}
              placeholder="Command path, e.g. /usr/bin/firefox"
              onChange={(event) => setEdit({ ...edit, exec: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveEdit();
              }}
              autoFocus
            />
            <button type="button" onClick={() => void browseExecutable()}>...</button>
          </div>
          <div className="global-app-edit-actions">
            <button type="button" onClick={clearEdit}>Clear</button>
            <button type="button" className="suggested-action" onClick={saveEdit}>Set</button>
          </div>
        </div>
      )}
    </div>
  );
}

function orderedGlobalApps(apps: Record<string, GlobalAppEntry>): Array<[string, GlobalAppEntry]> {
  const ordered = GLOBAL_APP_ROLES
    .map((role) => [role.key, apps[role.key]] as const)
    .filter((entry): entry is [string, GlobalAppEntry] => Boolean(entry[1]));
  const known = new Set(GLOBAL_APP_ROLES.map((role) => role.key));
  return [
    ...ordered,
    ...Object.entries(apps)
      .filter(([role]) => !known.has(role))
      .sort(([a], [b]) => a.localeCompare(b)),
  ];
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? "";
}

// Flags that make a screenshot tool begin interactive rectangular-region
// selection immediately on launch, keyed by the executable's basename. Tools we
// don't recognize fall through to launching with no extra arguments.
const SCREENSHOT_REGION_ARGS: Record<string, string[]> = {
  spectacle: ["--region"],
  flameshot: ["gui"],
  "gnome-screenshot": ["--area"],
  scrot: ["--select"],
  maim: ["--select"],
  "xfce4-screenshooter": ["--region"],
  ksnip: ["--rectarea"],
  shutter: ["--select"],
};

function screenshotRegionArgs(exec: string): string[] {
  return SCREENSHOT_REGION_ARGS[basename(exec).toLowerCase()] ?? [];
}
