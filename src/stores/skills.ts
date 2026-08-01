import { create } from "zustand";

/**
 * Open/closed state for the **Skills Library overlay** (`docs/skills_plan.md`) —
 * the header 🧠 menu's machine-level door into the same library the project tab
 * hosts.
 *
 * A store rather than a prop for the ordinary reason the other overlays use one:
 * the control that opens it lives in the header (`LocalModelMenu`) and the
 * overlay has to be mounted at the shell, where it survives a project switch and
 * covers the window. One boolean, mirroring `stores/hpcPipeline`.
 *
 * There is deliberately nothing else here. The catalog, the sources and the
 * installed lists are read by `SkillsLibraryView` itself and are the same reads
 * the tab makes — a store holding a *copy* of them would be a second answer to
 * "what is installed" that could disagree with the disk, which is precisely what
 * the feature's no-manifest rule exists to prevent.
 */
interface SkillsOverlayStore {
  open: boolean;
  openOverlay: () => void;
  close: () => void;
}

export const useSkillsOverlayStore = create<SkillsOverlayStore>((set) => ({
  open: false,
  openOverlay: () => set({ open: true }),
  close: () => set({ open: false }),
}));
