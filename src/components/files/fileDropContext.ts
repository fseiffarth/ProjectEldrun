import { createContext } from "react";
import type { TabDrag } from "../../stores/drag";
import type { TabEntry } from "../../stores/tabs";

/**
 * How a file dragged out of the file tree is resolved and committed — the seam
 * that lets the SAME `FileTree` gesture work in the main window and inside a
 * detached popout.
 *
 * In the main window this is absent (null): `CenterPanel` owns a window-wide
 * pointer-drag authority that resolves the pane target and `FileTree` commits
 * through `commitFileDrop` into the main tab store. A detached window has
 * neither — it can't reach that authority (its panes are in another webview) nor
 * mutate the store (the main window owns tab creation + the PTY) — so
 * `DetachedCenterPanel` provides this controller: `resolveTarget` writes the
 * hovered pane into the popout's own drag store (so the split/merge preview
 * lights up), and `commit` streams the drop to the main window as a detached
 * `add` edit instead of a local store write.
 */
export interface FileDropController {
  /** Resolve the pane under the cursor into the drag store (overGroup/edge or
   *  reorderGroup/reorderIndex), driving the live split/merge preview. Called on
   *  every pointer move of a file drag. */
  resolveTarget: (clientX: number, clientY: number) => void;
  /** Commit a released file drag against the last resolved target. */
  commit: (d: TabDrag, projectCwd: string) => void;
  /** Open a tab INSIDE this popout (its focused group), streamed to the main
   *  window like the "+" button and file drops. Used by the Python ▶ Run so the
   *  terminal appears in the detached window, not the main window's tab store. */
  openTab: (tab: Omit<TabEntry, "key">) => void;
}

/** Non-null only inside a detached window. See {@link FileDropController}. */
export const FileDropContext = createContext<FileDropController | null>(null);
