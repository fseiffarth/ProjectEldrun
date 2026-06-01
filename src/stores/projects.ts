import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { resolveProjectDirectory, type ProjectEntry } from "../types";
import { useTimerStore } from "./timer";

interface ProjectsStore {
  projects: ProjectEntry[];
  activeId: string | null;
  loaded: boolean;
  rootDir: string | null;
  switchToast: string | null;
  /** Incremented only on explicit setActive calls, never by load(). */
  switchGeneration: number;
  load: () => Promise<void>;
  setActive: (id: string | null) => Promise<void>;
  clearSwitchToast: () => void;
  addProject: (project: ProjectEntry) => Promise<void>;
  deactivateProject: (id: string) => Promise<void>;
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  projects: [],
  activeId: null,
  loaded: false,
  rootDir: null,
  switchToast: null,
  switchGeneration: 0,

  load: async () => {
    const [raw, rootDir] = await Promise.all([
      invoke<ProjectEntry[]>("get_projects"),
      invoke<string>("root_work_dir").catch(() => null),
    ]);
    const projects = [...raw].sort((a, b) => a.position - b.position);
    const current = projects.find((p) => p.status === "current");
    set({
      projects,
      loaded: true,
      rootDir,
      activeId: current?.id ?? projects[0]?.id ?? null,
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
    invoke<void>("switch_project_windows", {
      projectId: id,
      previousProjectId: previousId,
    }).catch((error) => {
      console.warn("switch_project_windows failed", error);
    });
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
}));
