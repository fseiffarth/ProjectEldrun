import { invoke } from "@tauri-apps/api/core";

/** Wayland keeps parked surfaces mapped and may report minimized=false. */
export async function detachedWindowVisible(win: {
  isVisible(): Promise<boolean>;
  isMinimized(): Promise<boolean>;
}): Promise<boolean> {
  const [visible, minimized, parked] = await Promise.all([
    win.isVisible(),
    win.isMinimized(),
    // Frontend hot reload may reach a backend that predates this command.
    invoke<boolean>("detached_window_is_parked").catch(() => false),
  ]);
  return visible && !minimized && !parked;
}
