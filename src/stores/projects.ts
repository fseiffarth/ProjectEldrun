import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { ProjectEntry } from "../types";

interface ProjectsStore {
  projects: ProjectEntry[];
  activeId: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  setActive: (id: string) => void;
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

  setActive: (id) => set({ activeId: id }),
}));
