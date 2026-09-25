import { create } from "zustand";

/**
 * Open/closed state and the active tab of the **Models & agents overlay**
 * (`components/models/ModelsOverlay`), opened by a click on the header's
 * processor-chip button (`layout/LocalModelMenu`) or one of its dropdown's
 * doors.
 *
 * A store rather than a prop for the reason the other header overlays use one:
 * the button lives in the header and the overlay is mounted at the shell. It
 * holds no data copies — the panes read their own (Settings' panels, the
 * skills library) or the shared `stores/agents/ollamaActivity`.
 */
export type ModelsOverlayTab = "agents" | "models" | "ollama" | "skills";

export const MODELS_OVERLAY_TABS: readonly ModelsOverlayTab[] = ["agents", "models", "ollama", "skills"];

const TAB_KEY = "eldrun.modelsOverlayTab";

function readTab(): ModelsOverlayTab {
  try {
    const raw = localStorage.getItem(TAB_KEY);
    if (raw && (MODELS_OVERLAY_TABS as readonly string[]).includes(raw)) return raw as ModelsOverlayTab;
  } catch {
    // Storage unavailable — the first tab is the answer.
  }
  return "agents";
}

function writeTab(tab: ModelsOverlayTab) {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Storage unavailable — the tab still holds for this session.
  }
}

interface ModelsOverlayState {
  open: boolean;
  /** Initial: the last tab from localStorage, else "agents". */
  tab: ModelsOverlayTab;
  /** No argument keeps the current (last) tab; a tab deep-links to it. */
  openOverlay: (tab?: ModelsOverlayTab) => void;
  /** Switches and remembers the tab. */
  setTab: (tab: ModelsOverlayTab) => void;
  close: () => void;
}

export const useModelsOverlayStore = create<ModelsOverlayState>((set) => ({
  open: false,
  tab: readTab(),
  openOverlay: (tab) => {
    if (tab) writeTab(tab);
    set((s) => ({ open: true, tab: tab ?? s.tab }));
  },
  setTab: (tab) => {
    writeTab(tab);
    set({ tab });
  },
  close: () => set({ open: false }),
}));
