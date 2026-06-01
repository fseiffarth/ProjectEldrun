import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { ProjectEntry } from "../types";

interface ProjectsStore {
  projects: ProjectEntry[];
  activeId: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  setActive: (id: string | null) => Promise<void>;
  addProject: (project: ProjectEntry) => Promise<void>;
}

export const useProjectsStore = create<ProjectsStore>((set) => ({
  projects: [],
  activeId: null,
  loaded: false,

  load: async () => {
    const raw = await invoke<ProjectEntry[]>("get_projects");
    const projects = [...raw].sort((a, b) => a.position - b.position);
    const current = projects.find((p) => p.status === "current");
    set({
      projects,
      loaded: true,
      activeId: current?.id ?? projects[0]?.id ?? null,
    });
  },

  setActive: async (id) => {
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
      return { projects: nextProjects, activeId: id };
    });
    await invoke<void>("save_projects", { projects: nextProjects });
  },

  addProject: async (project) => {
    let nextProjects: ProjectEntry[] = [];
    set((state) => {
      nextProjects = [...state.projects, project].sort((a, b) => a.position - b.position);
      return { projects: nextProjects };
    });
    await useProjectsStore.getState().setActive(project.id);
  },
}));
