import { create } from "zustand";

/** A global machine handed to a project, awaiting only its shared path
 *  before `RemoteMachinesWindow` turns it into a `shared_fs` compute host.
 *  (Named for the drag gesture that used to deliver it; the machine now
 *  arrives from the header menu's "add to a project" picker instead.) */
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
 * (`stores/globalMachines.ts`) is added to this **remote** project — picked from
 * the header machine menu's "add to a project" list, which calls
 * `open(projectId, payload)` to open this window with the machine pre-filled.
 *
 * `extendTarget` is the same handoff for a **local** project, whose answer is
 * not a worker but the "Extend to remote" flow — a dialog `ProjectPill` owns.
 * The picker lists only *open* projects, so the target's pill is mounted and
 * picks this up in an effect (clearing it). It lives here, beside `pendingDrop`,
 * because the two are one decision: which of the two ways a machine can join a
 * project applies to the one that was picked.
 */
interface RemoteMachinesDialogStore {
  projectId: string | null;
  pendingDrop: DroppedGlobalMachine | null;
  extendTarget: { projectId: string; machine: DroppedGlobalMachine } | null;
  open: (projectId: string, pendingDrop?: DroppedGlobalMachine | null) => void;
  setPendingDrop: (pendingDrop: DroppedGlobalMachine | null) => void;
  requestExtend: (projectId: string, machine: DroppedGlobalMachine) => void;
  clearExtend: () => void;
  close: () => void;
}

export const useRemoteMachinesStore = create<RemoteMachinesDialogStore>((set) => ({
  projectId: null,
  pendingDrop: null,
  extendTarget: null,
  open: (projectId, pendingDrop = null) => set({ projectId, pendingDrop }),
  setPendingDrop: (pendingDrop) => set({ pendingDrop }),
  requestExtend: (projectId, machine) => set({ extendTarget: { projectId, machine } }),
  clearExtend: () => set({ extendTarget: null }),
  close: () => set({ projectId: null, pendingDrop: null }),
}));
