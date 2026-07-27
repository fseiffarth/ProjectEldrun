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
  /** Which host of the project the modal targets (multi-host remote,
   *  `docs/multi_host_remote_plan.md`): `"primary"` (the default) or a worker id.
   *  `null` when no modal is open. */
  hostId: string | null;
  /** Open the Connect modal for a project host. `hostId` defaults to the primary. */
  open: (projectId: string, hostId?: string) => void;
  close: () => void;
}

export const useConnectDialogStore = create<ConnectDialogStore>((set) => ({
  projectId: null,
  hostId: null,
  open: (projectId, hostId = "primary") => set({ projectId, hostId }),
  close: () => set({ projectId: null, hostId: null }),
}));
