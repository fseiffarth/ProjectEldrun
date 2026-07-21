import { create } from "zustand";

/** The global machine a `GlobalMachineMonitorDialog` samples — enough identity
 *  to both authenticate ad-hoc (`user`/`host`/`port`) and title the dialog
 *  (`label`). Mirrors `DroppedGlobalMachine` (`stores/remoteMachines.ts`). */
export interface GlobalMachineMonitorTarget {
  id: string;
  user?: string;
  host: string;
  port?: number;
  label?: string;
}

/**
 * Which global machine's full system-monitor dialog is open, if any. A single
 * `<GlobalMachineMonitorDialogHost>` is mounted once (in AppShell) and reads
 * this store; the header's Machines menu (`MachinesIndicator`) opens it via
 * `open(machine)` from a row's "System monitor…" button — the same
 * mount-once/store-driven pattern `stores/remoteMachines.ts` uses for the
 * project-scoped Remote machines window.
 */
interface GlobalMachineMonitorStore {
  machine: GlobalMachineMonitorTarget | null;
  open: (machine: GlobalMachineMonitorTarget) => void;
  close: () => void;
}

export const useGlobalMachineMonitorStore = create<GlobalMachineMonitorStore>((set) => ({
  machine: null,
  open: (machine) => set({ machine }),
  close: () => set({ machine: null }),
}));
