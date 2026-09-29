import { create } from "zustand";

/**
 * Open/closed state of the **Machines overlay** (`header/MachinesOverlay`'s
 * frame around `header/MachinesIndicator`'s list, laid out as a grid of machine
 * tiles), opened by a click on the header's Machines button or the ⤢ door in
 * its dropdown.
 *
 * A store rather than a prop for the reason `stores/modelsOverlay` is one: the
 * button lives in the header and the overlay is mounted at the shell. It holds
 * no machine data — the overlay reads `stores/remote/globalMachines` itself.
 */
interface MachinesOverlayState {
  open: boolean;
  openOverlay: () => void;
  close: () => void;
}

export const useMachinesOverlayStore = create<MachinesOverlayState>((set) => ({
  open: false,
  openOverlay: () => set({ open: true }),
  close: () => set({ open: false }),
}));
