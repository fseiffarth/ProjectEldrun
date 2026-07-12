import { create } from "zustand";
import type { FileSource } from "../components/embed/fileAccess";

/**
 * Ephemeral, non-persisted map of a viewer tab's resolved file source
 * (`"remote"` = read straight from the host over SFTP, `"local"` = the paired
 * local mirror copy, `"none"` = a local project / not applicable), keyed by tab
 * key. `FileViewerPane` publishes each viewer tab's source here so the tab strip
 * can render the Remote/Local badge on the tab itself instead of spending a
 * whole header row on it. Cleared when the viewer unmounts.
 */
interface FileSourcesStore {
  byTab: Record<string, FileSource>;
  setSource: (tabKey: string, source: FileSource) => void;
  clearSource: (tabKey: string) => void;
}

export const useFileSourcesStore = create<FileSourcesStore>((set) => ({
  byTab: {},
  setSource: (tabKey, source) =>
    set((s) =>
      s.byTab[tabKey] === source ? s : { byTab: { ...s.byTab, [tabKey]: source } },
    ),
  clearSource: (tabKey) =>
    set((s) => {
      if (!(tabKey in s.byTab)) return s;
      const next = { ...s.byTab };
      delete next[tabKey];
      return { byTab: next };
    }),
}));
