import { emit } from "@tauri-apps/api/event";
import { create } from "zustand";
import { isDetachedWindow } from "./detachedContext";

/** Mirrors `DETACHED_OPEN_DIALOG` in stores/detached (spelled here to keep this
 *  module free of that import: detached.ts imports this one). */
const DETACHED_OPEN_DIALOG_EVENT = "detached-open-dialog";

/**
 * Which project's giant-folder prompt is open, if any.
 *
 * A single `<BigFolderDialogHost>` is mounted once (in AppShell) and reads this
 * store, mirroring `stores/remoteMachines`. Keyed by an explicit project id —
 * not the active project — because the moment that opens it (a project just
 * created, imported, or extended to a host) is also a moment the user may switch
 * away from, and the prompt must keep asking about the tree it measured.
 *
 * `askedProjects` is the once-per-project latch: the prompt is a *setup*
 * question, so it opens itself unasked exactly once per project and is a menu
 * item thereafter. It lives in memory only — a session that answered it has an
 * answer in the sync manifest, and a session that dismissed it can be asked
 * again next launch rather than losing the question forever.
 */
interface BigFolderDialogStore {
  projectId: string | null;
  askedProjects: Set<string>;
  /** Open the prompt for a project (a manual "Big folders…" click). */
  open: (projectId: string) => void;
  /** Open it only if this project has not been asked in this session — the
   *  post-create / post-extend trigger. */
  openOnce: (projectId: string) => void;
  close: () => void;
}

export const useBigFoldersStore = create<BigFolderDialogStore>((set, get) => ({
  projectId: null,
  askedProjects: new Set(),
  open: (projectId) => {
    // Group B #233: the host is main-window only; a popout's "Large folders…"
    // asks the main window to open it rather than flipping a dead store.
    if (isDetachedWindow()) {
      void emit(DETACHED_OPEN_DIALOG_EVENT, { kind: "bigFolders", projectId });
      return;
    }
    set((s) => ({ projectId, askedProjects: new Set(s.askedProjects).add(projectId) }));
  },
  openOnce: (projectId) => {
    if (get().askedProjects.has(projectId)) return;
    get().open(projectId);
  },
  close: () => set({ projectId: null }),
}));
