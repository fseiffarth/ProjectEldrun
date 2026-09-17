import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { ROOT_SCOPE, hydrateScopeFromDisk, useTabsStore } from "./tabs";

/**
 * The **root console** — the root scope, reached as an overlay instead of as a
 * place to switch to.
 *
 * The root terminal used to be a scope like a project: picking it replaced the
 * project on screen, so the one terminal that belongs to *no* project was also
 * the one that cost you the project you were in. It is now a floating subwindow
 * (`layout/RootOverlay`, Ctrl+Shift+R) over whatever is open — the fast-reach,
 * cross-project management surface: its agents are the only ones handed
 * Eldrun's own MCP tools (projects, calendar, to-do board; see the backend's
 * `services::root_mcp`), and it is never offered to the phone.
 *
 * Nothing about the *scope* changed: its tabs still live in `tabsByScope.root`,
 * persist under `sessions/root/`, and their PTYs are still owned by
 * `CenterPanel`'s keep-alive pane layer. The overlay's panes are attach-only
 * views of those — the popout's and `InstallOverlay`'s arrangement — so closing
 * it ends nothing.
 *
 * A store for the family's reason: the hotkey, the scope chip and the flows that
 * park a login in a root tab all open it, while it is mounted once at the shell.
 */
interface RootOverlayState {
  open: boolean;
  /** The root tab shown in the overlay; null = the scope's own active tab. */
  activeKey: string | null;
  show: (key?: string) => void;
  close: () => void;
  setActiveKey: (key: string | null) => void;
}

export const useRootOverlayStore = create<RootOverlayState>((set) => ({
  open: false,
  activeKey: null,
  show: (key) => {
    void ensureRootScopeHydrated();
    set((s) => ({ open: true, activeKey: key ?? s.activeKey }));
  },
  close: () => set({ open: false }),
  setActiveKey: (activeKey) => set({ activeKey }),
}));

export function toggleRootConsole(): void {
  const s = useRootOverlayStore.getState();
  if (s.open) s.close();
  else s.show();
}

/**
 * Restore the root scope's saved tabs on its first use this session. It used
 * to happen only when the root scope was *switched to*; the overlay never
 * switches, so it asks for itself. `createEmptyScope` marks a root with nothing
 * saved as hydrated, so the overlay's persist effect may write it — without it
 * an absent scope key reads as "never hydrated" and every save is skipped.
 */
export function ensureRootScopeHydrated(): Promise<boolean> {
  if (ROOT_SCOPE in useTabsStore.getState().tabsByScope) return Promise.resolve(true);
  return hydrateScopeFromDisk(
    ROOT_SCOPE,
    () => invoke<string>("root_work_dir").catch(() => ""),
    { createEmptyScope: true },
  ).catch(() => false);
}
