import { create } from "zustand";

/**
 * Open/closed state and the current view of the **Models & agents overlay**
 * (`components/models/ModelsOverlay`), opened by a click on the header's
 * processor-chip button (`layout/LocalModelMenu`) or one of its dropdown's
 * doors.
 *
 * The overlay is a grid of sections, not a tab strip: a plain open lands on
 * the overview (`"home"`, one tile per section with its live summary), a tile
 * opens its section, and the bar's back button returns to the grid. A door
 * deep-links straight into its section.
 *
 * A store rather than a prop for the reason the other header overlays use one:
 * the button lives in the header and the overlay is mounted at the shell. It
 * holds no data copies — the sections read their own (Settings' panels, the
 * skills library) or the shared `stores/agents/ollamaActivity`.
 */
export type ModelsOverlaySection = "agents" | "models" | "ollama" | "skills";
export type ModelsOverlayView = "home" | ModelsOverlaySection;

export const MODELS_OVERLAY_SECTIONS: readonly ModelsOverlaySection[] = ["agents", "models", "ollama", "skills"];

interface ModelsOverlayState {
  open: boolean;
  /** The overview grid, or one section. */
  view: ModelsOverlayView;
  /** No argument opens the overview grid; a section deep-links to it. */
  openOverlay: (section?: ModelsOverlaySection) => void;
  /** Switches the view (a tile, the back button, a door inside a section). */
  show: (view: ModelsOverlayView) => void;
  close: () => void;
}

export const useModelsOverlayStore = create<ModelsOverlayState>((set) => ({
  open: false,
  view: "home",
  openOverlay: (section) => set({ open: true, view: section ?? "home" }),
  show: (view) => set({ view }),
  close: () => set({ open: false }),
}));
