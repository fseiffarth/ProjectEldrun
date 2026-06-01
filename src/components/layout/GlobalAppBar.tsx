import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";

const ROLE_LABELS: Record<string, string> = {
  browser: "Browser",
  terminal: "Terminal",
  editor: "Editor",
  file_manager: "File Manager",
  screenshot: "Screenshot",
  notes: "Notes",
};

const ROLE_ICONS: Record<string, string> = {
  browser: "🌐",
  terminal: "▣",
  editor: "✎",
  file_manager: "📁",
  screenshot: "▤",
  notes: "☰",
};

export function GlobalAppBar() {
  const settings = useSettingsStore((s) => s.settings);
  const { projects, activeId } = useProjectsStore();
  const activeProject = projects.find((p) => p.id === activeId);
  const activeDir = (activeProject?.directory as string | undefined) ?? undefined;
  const apps = Object.entries(settings?.global_apps ?? {}).filter(
    ([, app]) => app.visible !== false && Boolean(app.exec),
  );

  if (apps.length === 0) return null;

  const launch = (role: string, exec: string) => {
    invoke("launch_app", {
      exec,
      file: role === "file_manager" ? activeDir ?? null : null,
      projectId: null,
      role,
    }).catch(() => {});
  };

  return (
    <div className="global-apps-toolbar" onClick={(e) => e.stopPropagation()}>
      {apps.map(([role, app]) => (
        <button
          key={role}
          className="global-app-btn"
          title={`${ROLE_LABELS[role] ?? role}: ${app.exec}`}
          onClick={() => launch(role, app.exec)}
        >
          <span aria-hidden>{ROLE_ICONS[role] ?? "●"}</span>
        </button>
      ))}
    </div>
  );
}
