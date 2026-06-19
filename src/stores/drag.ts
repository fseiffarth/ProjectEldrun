import { create } from "zustand";
import type { DropEdge } from "./tabs";

/**
 * Result of the backend `embed_capability` check for a dragged file, prefetched
 * when a file drag starts. `null` while the query is in flight.
 */
export interface EmbedCap {
  os_embeddable: boolean;
  app_embeddable: boolean;
  resolved_exec: string | null;
}

/**
 * Pointer-driven drag state. Kept separate from the tabs store so the
 * high-frequency pointermove updates during a drag (coords, hover target) don't
 * churn the tab tree / re-render every subwindow. The tabs store is only
 * touched once, on the committed drop.
 *
 * Two drag kinds share this state:
 *  - "tab"  — an existing tab being reordered / moved / split (TabBar source).
 *  - "file" — a file row dragged from the right-panel FileTree to open as an
 *             embedded tab (TODO Group K #40). A tab-bar drop adds the embed tab
 *             to that group; a subwindow-body edge drop carves out a NEW
 *             subwindow holding it (overGroup/edge, like tab drags). Capability
 *             is resolved at release time (embed vs external), not a drop gate.
 */
export interface TabDrag {
  kind: "tab" | "file";
  key: string; // the dragged tab's key (tab drags); "" for file drags
  fromGroup: string; // group the tab started in (tab drags); "" for file drags
  label: string; // shown in the floating ghost
  pointerX: number;
  pointerY: number;
  // Edge-split target: a subwindow group + the edge the pointer is over.
  overGroup: string | null;
  edge: DropEdge | null;
  // Within-bar reorder target: a tab bar's group + the insertion slot.
  reorderGroup: string | null;
  reorderIndex: number | null;
  // ── File-drag payload (kind === "file") ──────────────────────────────────
  filePath?: string; // absolute path of the dragged file
  fileName?: string; // basename, used to label the embed tab
  fileExec?: string; // explicit handler hint, if any
  // When set, drop opens the file in the named built-in viewer (pdf/image/
  // markdown/text) rather than the external embed path. See commitFileDrop.
  viewer?: "pdf" | "image" | "markdown" | "text";
  // Prefetched capability for this file (null while the query is in flight).
  embedCap?: EmbedCap | null;
}

interface DragStore {
  drag: TabDrag | null;
  start: (
    d: Pick<TabDrag, "key" | "fromGroup" | "label" | "pointerX" | "pointerY">,
  ) => void;
  startFileDrag: (
    d: Pick<TabDrag, "label" | "pointerX" | "pointerY"> & {
      filePath: string;
      fileName: string;
      fileExec?: string;
      viewer?: "pdf" | "image" | "markdown" | "text";
    },
  ) => void;
  setEmbedCap: (cap: EmbedCap | null) => void;
  move: (x: number, y: number) => void;
  setTarget: (
    t: Pick<TabDrag, "overGroup" | "edge" | "reorderGroup" | "reorderIndex">,
  ) => void;
  end: () => void;
}

export const useDragStore = create<DragStore>((set) => ({
  drag: null,
  start: (d) =>
    set({
      drag: {
        kind: "tab",
        ...d,
        overGroup: null,
        edge: null,
        reorderGroup: null,
        reorderIndex: null,
      },
    }),
  startFileDrag: (d) =>
    set({
      drag: {
        kind: "file",
        key: "",
        fromGroup: "",
        label: d.label,
        pointerX: d.pointerX,
        pointerY: d.pointerY,
        overGroup: null,
        edge: null,
        reorderGroup: null,
        reorderIndex: null,
        filePath: d.filePath,
        fileName: d.fileName,
        fileExec: d.fileExec,
        viewer: d.viewer,
        embedCap: null,
      },
    }),
  setEmbedCap: (cap) =>
    set((s) => (s.drag ? { drag: { ...s.drag, embedCap: cap } } : {})),
  move: (x, y) =>
    set((s) =>
      s.drag ? { drag: { ...s.drag, pointerX: x, pointerY: y } } : {},
    ),
  setTarget: (t) =>
    set((s) => (s.drag ? { drag: { ...s.drag, ...t } } : {})),
  end: () => set({ drag: null }),
}));
