import { create } from "zustand";

/**
 * Multi-selected project pills (Ctrl/Cmd-click in the switcher), kept in click
 * order so "Box these (N)…" creates the box with the members in the order they
 * were picked. Session-only UI state: a plain pill click, Escape, or the commit
 * itself clears it. Deliberately NOT in `stores/pillDrag` — a selection is not
 * a gesture, and the drag store's non-null state puts siblings into drag mode.
 */
interface PillSelectionStore {
  selected: string[];
  toggle: (projectId: string) => void;
  clear: () => void;
}

export const usePillSelectionStore = create<PillSelectionStore>((set) => ({
  selected: [],
  toggle: (projectId) =>
    set((s) => ({
      selected: s.selected.includes(projectId)
        ? s.selected.filter((id) => id !== projectId)
        : [...s.selected, projectId],
    })),
  clear: () => set((s) => (s.selected.length === 0 ? s : { selected: [] })),
}));
