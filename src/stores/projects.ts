import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { resolveProjectDirectory, type ProjectEntry } from "../types";
import { useTabsStore } from "./tabs";
import { useTimerStore } from "./timer";

interface ProjectRuntimeSwitchedPayload {
  projectId: string | null;
  tabLayout: Array<{ key: string; label: string; cmd: string; cwd: string }>;
  activeTabIndex: number;
  fileTabs: unknown[];
  rightPanelFolder: string | null;
  openedWindowIds: string[];
}

interface ProjectsStore {
  projects: ProjectEntry[];
  activeId: string | null;
  loaded: boolean;
  rootDir: string | null;
  switchToast: string | null;
  rightPanelFolderByProject: Record<string, string>;
  /** Incremented only on explicit setActive calls, never by load(). */
  switchGeneration: number;
  load: () => Promise<void>;
  setActive: (id: string | null) => Promise<void>;
  setRightPanelFolder: (projectId: string, folder: string) => void;
  clearSwitchToast: () => void;
  addProject: (project: ProjectEntry) => Promise<void>;
  deactivateProject: (id: string) => Promise<void>;
  updateProjectDescription: (id: string, description: string) => Promise<void>;
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  projects: [],
  activeId: null,
  loaded: false,
  rootDir: null,
  switchToast: null,
  rightPanelFolderByProject: {},
  switchGeneration: 0,

  load: async () => {
    const [raw, rootDir] = await Promise.all([
      invoke<ProjectEntry[]>("get_projects"),
      invoke<string>("root_work_dir").catch(() => null),
    ]);
    const projects = [...raw].sort((a, b) => a.position - b.position);
    const current = projects.find((p) => p.status === "current");
    const activeId = current?.id ?? projects[0]?.id ?? null;
    // Restore the active project's right-panel subfolder before any component
    // mounts, so the file tree opens straight to the saved folder on startup.
    // (Switching projects already restores via switch_project_runtime; this
    // covers the initially-active project, which never triggers a switch.)
    const rightPanelFolderByProject: Record<string, string> = {};
    const activeLocalFile = activeId
      ? projects.find((p) => p.id === activeId)?.local_file
      : undefined;
    if (activeId && activeLocalFile) {
      const folder = await invoke<string | null>("load_right_panel_folder", {
        localFile: activeLocalFile,
      }).catch(() => null);
      if (folder) rightPanelFolderByProject[activeId] = folder;
    }
    set({
      projects,
      loaded: true,
      rootDir,
      activeId,
      rightPanelFolderByProject,
    });
  },

  setActive: async (id) => {
    const previousId = get().activeId;
    let nextProjects: ProjectEntry[] = [];
    set((state) => {
      nextProjects = state.projects.map((project) => {
        const status =
          id === null
            ? project.status === "current"
              ? "active"
              : project.status
            : project.id === id
              ? "current"
              : project.status === "current"
                ? "active"
                : project.status;
        return status === project.status ? project : { ...project, status };
      });
      let toastPath: string | null = null;
      if (id === null) {
        toastPath = state.rootDir ?? "root";
      } else {
        const proj = state.projects.find((p) => p.id === id);
        if (proj) {
          toastPath = resolveProjectDirectory(proj) || proj.name;
        }
      }
      return {
        projects: nextProjects,
        activeId: id,
        switchToast: toastPath,
        switchGeneration: state.switchGeneration + 1,
      };
    });
    await invoke<void>("save_projects", { projects: nextProjects });
    void useTimerStore.getState().setProject(id);
    const tabsStore = useTabsStore.getState();
    const tabs = tabsStore.tabs;
    const activeTabIndex = Math.max(
      0,
      tabs.findIndex((t) => t.key === tabsStore.activeKey),
    );
    // Fire-and-forget: the switch runs on a backend worker thread and returns
    // immediately. The resulting tab layout / right-panel folder arrives via the
    // `project-runtime-switched` event, handled by listenProjectRuntimeSwitched.
    invoke("switch_project_runtime", {
      projectId: id,
      previousProjectId: previousId,
      previousSnapshot: {
        tabLayout: tabs.map((t) => ({ key: t.key, label: t.label, cmd: t.cmd, cwd: t.cwd })),
        activeTabIndex,
        fileTabs: [],
        rightPanelFolder: previousId ? get().rightPanelFolderByProject[previousId] ?? null : null,
        activeLayoutMetadata: null,
        flushSecs: 0.0,
      },
    }).catch((error) => {
      console.warn("switch_project_runtime failed", error);
    });
  },

  setRightPanelFolder: (projectId, folder) => {
    set((state) => ({
      rightPanelFolderByProject: {
        ...state.rightPanelFolderByProject,
        [projectId]: folder,
      },
    }));
    // Persist immediately so the panel view survives a restart even if the user
    // quits without switching projects. Re-saving the same value on restore or
    // project switch is harmless and idempotent.
    const localFile = get().projects.find((p) => p.id === projectId)?.local_file;
    if (localFile) {
      void invoke("save_right_panel_folder", { localFile, folder }).catch(() => {});
    }
  },

  clearSwitchToast: () => set({ switchToast: null }),

  addProject: async (project) => {
    let nextProjects: ProjectEntry[] = [];
    set((state) => {
      nextProjects = [...state.projects, project].sort((a, b) => a.position - b.position);
      return { projects: nextProjects };
    });
    await useProjectsStore.getState().setActive(project.id);
  },

  deactivateProject: async (id) => {
    let nextProjects: ProjectEntry[] = [];
    let nextActiveId: string | null = null;
    set((state) => {
      nextProjects = state.projects.map((project) =>
        project.id === id && project.status !== "inactive"
          ? { ...project, status: "inactive" }
          : project,
      );
      nextActiveId =
        state.activeId === id
          ? (nextProjects.find((p) => p.status === "active") ?? nextProjects[0])?.id ?? null
          : state.activeId;
      return { projects: nextProjects };
    });
    await invoke<void>("save_projects", { projects: nextProjects });
    if (useProjectsStore.getState().activeId !== nextActiveId) {
      await useProjectsStore.getState().setActive(nextActiveId);
    }
  },

  updateProjectDescription: async (id, description) => {
    // Backend cleans (trims, empties → null) and writes projects.json +
    // project.json; mirror the cleaned value into local state.
    const cleaned = await invoke<string | null>("set_project_description", {
      projectId: id,
      description,
    });
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, description: cleaned ?? undefined } : project,
      ),
    }));
  },
}));

/// Listen for the backend's `project-runtime-switched` event and apply the
/// restored tab layout + right-panel folder. The switch runs on a backend
/// worker thread (see `switch_project_runtime`), so its result arrives here
/// asynchronously rather than as the return value of the invoke in setActive.
/// Register once at app startup; returns an unlisten function.
export function listenProjectRuntimeSwitched(): Promise<() => void> {
  return listen<ProjectRuntimeSwitchedPayload>("project-runtime-switched", (ev) => {
    const payload = ev.payload;
    const scopeKey = payload.projectId ?? "root";
    const tabsStore = useTabsStore.getState();
    // Only restore from disk if this scope was never initialized this session.
    // An existing (possibly empty) entry means the user's in-memory tabs win.
    if (payload.tabLayout.length > 0 && !(scopeKey in tabsStore.tabsByScope)) {
      const project = payload.projectId
        ? useProjectsStore.getState().projects.find((p) => p.id === payload.projectId) ?? null
        : null;
      tabsStore.loadFromLayout(payload.tabLayout, resolveProjectDirectory(project), scopeKey);
    }
    if (payload.projectId && payload.rightPanelFolder !== null) {
      useProjectsStore.getState().setRightPanelFolder(payload.projectId, payload.rightPanelFolder);
    }
  });
}
