import { create } from "zustand";

/**
 * Ephemeral, non-persisted "which side is this remote project's file view
 * currently showing" preference, keyed by project id. The single source of
 * truth for the right file tree / Files (Project) tab's Local/Remote switch
 * (`useFileSource` in `components/files/ProjectFilesPane.tsx`), and read (not
 * subscribed — a snapshot at open time, not a live sync) by `FileViewerPane` so
 * a freshly opened subwindow file viewer defaults to the same side the tree is
 * currently showing, instead of whichever side its own path happened to be on.
 */
interface FileSourcePrefStore {
  byProject: Record<string, "local" | "remote">;
  set: (projectId: string, source: "local" | "remote") => void;
}

export const useFileSourcePrefStore = create<FileSourcePrefStore>((set) => ({
  byProject: {},
  set: (projectId, source) =>
    set((s) => ({ byProject: { ...s.byProject, [projectId]: source } })),
}));
