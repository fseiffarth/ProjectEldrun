import { create } from "zustand";

/** A global machine dropped onto a project, awaiting only its shared path
 *  before `RemoteMachinesWindow` turns it into a `shared_fs` compute host. */
export interface DroppedGlobalMachine {
  id: string;
  host: string;
  user?: string;
  port?: number;
  label?: string;
}

/**
 * Which remote project's "Remote machines" manager is open, if any (multi-host
 * remote, `docs/multi_host_remote_plan.md`). A single `<RemoteMachinesDialogHost>`
 * is mounted once (in AppShell) and reads this store; the pill's Runtime menu item
 * and a right-click on the pill's remote lamp both open it via `open(projectId)`.
 * Keyed by an explicit project id — not the active project — so switching projects
 * never retargets an open manager.
 *
 * `pendingDrop` seeds the "confirm shared path" panel when a global machine
 * (`stores/globalMachines.ts`) is dropped onto this project — either directly
 * onto the worker-list area of an already-open window, or onto the project's
 * pill (which calls `open(projectId, payload)` to open the window with the
 * drop pre-filled). Both drop targets converge on the same panel/state.
 */
interface RemoteMachinesDialogStore {
  projectId: string | null;
  pendingDrop: DroppedGlobalMachine | null;
  open: (projectId: string, pendingDrop?: DroppedGlobalMachine | null) => void;
  setPendingDrop: (pendingDrop: DroppedGlobalMachine | null) => void;
  close: () => void;
}

export const useRemoteMachinesStore = create<RemoteMachinesDialogStore>((set) => ({
  projectId: null,
  pendingDrop: null,
  open: (projectId, pendingDrop = null) => set({ projectId, pendingDrop }),
  setPendingDrop: (pendingDrop) => set({ pendingDrop }),
  close: () => set({ projectId: null, pendingDrop: null }),
}));
