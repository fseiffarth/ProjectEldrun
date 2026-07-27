import { create } from "zustand";

/**
 * Open/closed state for the guided **HPC pipeline wizard**
 * (`docs/quirky-knitting-umbrella` plan Phase B). The wizard itself
 * (`components/projects/HpcPipelineWizard`) holds its per-step form state; this
 * store only decides whether it is on screen, so the project-switcher **+** menu
 * (and anywhere else) can launch it without prop-drilling a callback down.
 *
 * Mirrors `stores/remoteMachines` — one boolean plus open/close, mounted once as a
 * host in `AppShell`.
 */
interface HpcPipelineStore {
  open: boolean;
  openWizard: () => void;
  close: () => void;
}

export const useHpcPipelineStore = create<HpcPipelineStore>((set) => ({
  open: false,
  openWizard: () => set({ open: true }),
  close: () => set({ open: false }),
}));
