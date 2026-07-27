import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Whether the MAIN window is currently being moved by a native OS title-bar drag
 * (`startDragging`). On Windows/WebView2, WebView2 cannot repaint the heavy
 * terminal canvases fast enough during the OS modal move loop, so the content
 * lags/swims behind the frame. While this flag is set, `CenterPanel` hides the
 * pane layer (`.center-panel.moving`), leaving only the cheap subwindow frame for
 * WebView2 to composite — so the window keeps up with the cursor.
 *
 * Lives in its own tiny store (mirroring `drag.ts` / `detachAnim.ts`) because the
 * drag is started in `HeaderBar` but the heavy panes it must hide live in
 * `CenterPanel`; a store bridges the two without prop threading. The detached
 * popout solves the identical problem with local state in `DetachedCenterPanel`.
 */
interface WindowMoveState {
  moving: boolean;
  setMoving: (v: boolean) => void;
}

export const useWindowMoveStore = create<WindowMoveState>((set) => ({
  moving: false,
  setMoving: (moving) => set({ moving }),
}));

/**
 * Track the lifetime of a native window move started via `startDragging`, toggling
 * `useWindowMoveStore.moving` so the pane layer is hidden only for the duration of
 * the OS move loop. Call this immediately BEFORE `startDragging()`.
 *
 * End detection is deliberately belt-and-suspenders because the native move loop
 * can swallow the DOM `pointerup` (mirrors `DetachedCenterPanel.beginWindowMove`):
 *   • show on the FIRST `onMoved` (so a non-drag click never flashes the hide),
 *   • hide on `pointerup`/`pointercancel` (the normal release, cursor over us),
 *   • hide once the window has stopped moving for a beat (release while the
 *     cursor is over a snap target / another monitor, where we never see the up),
 *   • a hard timeout so the hide can never get stuck on.
 */
export function trackWindowMove(): void {
  const win = getCurrentWindow();
  const { setMoving } = useWindowMoveStore.getState();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let unMoved: (() => void) | undefined;
  let shown = false;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (idle) clearTimeout(idle);
    clearTimeout(hardStop);
    unMoved?.();
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    if (shown) setMoving(false);
  };
  const onMoved = () => {
    if (!shown) {
      shown = true;
      setMoving(true);
    }
    if (idle) clearTimeout(idle);
    idle = setTimeout(finish, 250);
  };
  const hardStop = setTimeout(finish, 10000);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  win
    .onMoved(onMoved)
    .then((fn) => (done ? fn() : (unMoved = fn)))
    .catch(() => {});
}
