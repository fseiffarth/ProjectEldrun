import { create } from "zustand";

/** Whether a clipboard entry will be duplicated (`copy`) or relocated (`cut`). */
export type ClipboardOp = "copy" | "cut";

/** A single file/folder placed on the in-app file clipboard ("paste storage").
 *  Carries its owning project dir so a paste can target a different project's
 *  tree (e.g. across box-co-accessible roots), and `name`/`isDir` so the paste
 *  rename window can pre-fill and the dest path can be built without a re-stat. */
export interface FileClipboardEntry {
  projectDir: string;
  relPath: string;
  // Absolute source path (matches an open viewer tab's `embedPath`), so a
  // same-project cut/paste can retarget that tab to the moved file.
  path: string;
  name: string;
  isDir: boolean;
  op: ClipboardOp;
}

interface FileClipboardState {
  entry: FileClipboardEntry | null;
  setEntry: (entry: FileClipboardEntry) => void;
  clear: () => void;
}

/** App-wide file clipboard backing the file-tree Copy/Cut/Paste actions. A
 *  module-level store (not per-tree state) so a copy in one folder/tree can be
 *  pasted in another. */
export const useFileClipboardStore = create<FileClipboardState>((set) => ({
  entry: null,
  setEntry: (entry) => set({ entry }),
  clear: () => set({ entry: null }),
}));
