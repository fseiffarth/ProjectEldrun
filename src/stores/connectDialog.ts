import { create } from "zustand";

/**
 * Which remote project's Connect modal is open, if any. A single
 * `<RemoteConnectDialog>` is mounted once (in AppShell) and reads this store;
 * the per-pill SSH status lamp (and the disconnected-pane placeholder) open the
 * modal by calling `open(projectId)`. Keyed by an explicit project id — not the
 * active project — so switching projects never retargets an open modal.
 */
interface ConnectDialogStore {
  projectId: string | null;
  open: (projectId: string) => void;
  close: () => void;
}

export const useConnectDialogStore = create<ConnectDialogStore>((set) => ({
  projectId: null,
  open: (projectId) => set({ projectId }),
  close: () => set({ projectId: null }),
}));
