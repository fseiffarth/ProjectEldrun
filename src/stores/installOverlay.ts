import { create } from "zustand";

/**
 * The **install overlay** — a centered terminal dialog mirroring the root-scope
 * install tab `runInstallInTab` just opened, so a one-click install is watched
 * (and its sudo/installer prompts answered) right where it was clicked instead
 * of behind a scope switch.
 *
 * A store rather than a prop for the family's usual reason: installs are
 * triggered from settings sub-panels, the 🧠 menu, project dialogs and file
 * viewers, while the overlay must be mounted once at the shell where it covers
 * the window and survives a project switch.
 *
 * It holds only the *identity* of the terminal to attach to — the PTY id of the
 * root tab (`root:<tab.key>`) and the install's label for the title band. The
 * PTY itself is owned by the root tab's pane: the overlay's `TerminalView` is
 * attach-only, so closing the overlay merely stops watching and the install
 * runs on in the root terminal.
 */
interface InstallOverlayState {
  /** PTY id of the root-scope install tab the overlay mirrors; null = closed. */
  ptyId: string | null;
  /** The install's label (e.g. "Install LaTeX"), already translated by the caller. */
  label: string;
  open: (ptyId: string, label: string) => void;
  close: () => void;
}

export const useInstallOverlayStore = create<InstallOverlayState>((set) => ({
  ptyId: null,
  label: "",
  open: (ptyId, label) => set({ ptyId, label }),
  close: () => set({ ptyId: null }),
}));
