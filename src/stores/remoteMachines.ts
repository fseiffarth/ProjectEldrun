import { create } from "zustand";

/**
 * Which remote project's "Remote machines" manager is open, if any (multi-host
 * remote, `docs/multi_host_remote_plan.md`). A single `<RemoteMachinesDialogHost>`
 * is mounted once (in AppShell) and reads this store; the pill's Runtime menu item
 * and a right-click on the pill's remote lamp both open it via `open(projectId)`.
 * Keyed by an explicit project id — not the active project — so switching projects
 * never retargets an open manager.
 */
interface RemoteMachinesDialogStore {
  projectId: string | null;
  open: (projectId: string) => void;
  close: () => void;
}

export const useRemoteMachinesStore = create<RemoteMachinesDialogStore>((set) => ({
  projectId: null,
  open: (projectId) => set({ projectId }),
  close: () => set({ projectId: null }),
}));
