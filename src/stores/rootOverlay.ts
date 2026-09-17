import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { isDetachedWindow } from "./detachedContext";
import { ROOT_SCOPE, hydrateScopeFromDisk, useTabsStore, type TabEntry } from "./tabs";

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
 * views of those — the popout's arrangement — so closing it ends nothing.
 *
 * It is the ONE overlay onto the root terminal. One-click installs used to float
 * a second one (`InstallOverlay`, a lone attach-only terminal on the install's
 * root tab) beside it: two dialogs over one scope, the smaller of which could
 * show only the tab it was opened for. An install now opens its tab here, through
 * `openTabInRootConsole`, the same door a parked login takes.
 *
 * A store for the family's reason: the hotkey, the scope chip and the flows that
 * park a login or an install in a root tab all open it, while it is mounted once
 * at the shell. It also holds the console's **frame** — a floating subwindow
 * that cannot be moved or resized is a dialog, and this one holds terminals
 * somebody works in. The frame is per machine (localStorage, like
 * `fileSourcePref`/`texViewPref`), never `settings.json`: it is where a window
 * sits on one desk, not a preference worth syncing.
 */
/**
 * Where the console floats and how big it is — the frame a move or a resize
 * writes. `null` means "as it opens": the size the stylesheet gives it, centred
 * by the backdrop, which is what everyone who never drags it keeps.
 */
export interface RootOverlayFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Below this the console stops being a terminal and becomes a sliver. */
export const MIN_ROOT_OVERLAY_WIDTH = 420;
export const MIN_ROOT_OVERLAY_HEIGHT = 240;
/** What a filled console leaves of the window on each side. */
export const ROOT_OVERLAY_FILL_MARGIN = 16;

/** Which edge (or the whole thing) a frame drag is moving. */
export type RootOverlayDragMode = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const FRAME_STORAGE_KEY = "eldrun.rootConsoleFrame";

/**
 * Keep a frame inside the window and above the minimum. Applied on every write
 * AND on every read: the frame is remembered across relaunches, so the monitor
 * it was sized on is regularly not the one it opens on.
 */
export function clampRootOverlayFrame(
  frame: RootOverlayFrame,
  viewportWidth: number,
  viewportHeight: number,
): RootOverlayFrame {
  const width = Math.round(
    Math.min(Math.max(frame.width, MIN_ROOT_OVERLAY_WIDTH), Math.max(viewportWidth, MIN_ROOT_OVERLAY_WIDTH)),
  );
  const height = Math.round(
    Math.min(Math.max(frame.height, MIN_ROOT_OVERLAY_HEIGHT), Math.max(viewportHeight, MIN_ROOT_OVERLAY_HEIGHT)),
  );
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(frame.x, 0), Math.max(viewportWidth - width, 0))),
    y: Math.round(Math.min(Math.max(frame.y, 0), Math.max(viewportHeight - height, 0))),
  };
}

/** The frame a filled console takes: the window, less one margin all round. */
export function filledRootOverlayFrame(
  viewportWidth: number,
  viewportHeight: number,
): RootOverlayFrame {
  const m = ROOT_OVERLAY_FILL_MARGIN;
  return clampRootOverlayFrame(
    { x: m, y: m, width: viewportWidth - 2 * m, height: viewportHeight - 2 * m },
    viewportWidth,
    viewportHeight,
  );
}

/**
 * The frame a drag of `mode` produces, pure so the whole gesture is testable.
 *
 * The one rule that is not arithmetic: an edge dragged PAST the minimum pins
 * the opposite edge rather than sliding it — dragging the left edge right past
 * the minimum width must stop the console shrinking, not start pushing it
 * across the screen.
 */
export function rootOverlayFrameDrag(
  start: RootOverlayFrame,
  mode: RootOverlayDragMode,
  dx: number,
  dy: number,
  viewportWidth: number,
  viewportHeight: number,
): RootOverlayFrame {
  if (mode === "move") {
    return clampRootOverlayFrame(
      { ...start, x: start.x + dx, y: start.y + dy },
      viewportWidth,
      viewportHeight,
    );
  }
  let { x, y, width, height } = start;
  if (mode.includes("e")) width = start.width + dx;
  if (mode.includes("s")) height = start.height + dy;
  if (mode.includes("w")) {
    width = start.width - dx;
    x = start.x + dx;
  }
  if (mode.includes("n")) {
    height = start.height - dy;
    y = start.y + dy;
  }
  if (width < MIN_ROOT_OVERLAY_WIDTH) {
    if (mode.includes("w")) x = start.x + start.width - MIN_ROOT_OVERLAY_WIDTH;
    width = MIN_ROOT_OVERLAY_WIDTH;
  }
  if (height < MIN_ROOT_OVERLAY_HEIGHT) {
    if (mode.includes("n")) y = start.y + start.height - MIN_ROOT_OVERLAY_HEIGHT;
    height = MIN_ROOT_OVERLAY_HEIGHT;
  }
  return clampRootOverlayFrame({ x, y, width, height }, viewportWidth, viewportHeight);
}

interface PersistedFrame {
  frame: RootOverlayFrame | null;
  filled: boolean;
}

function readPersistedFrame(): PersistedFrame {
  try {
    const raw = localStorage.getItem(FRAME_STORAGE_KEY);
    if (!raw) return { frame: null, filled: false };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { frame: null, filled: false };
    const { frame, filled } = parsed as Record<string, unknown>;
    const nums = frame as Record<string, unknown> | undefined;
    const ok =
      !!nums &&
      typeof nums === "object" &&
      (["x", "y", "width", "height"] as const).every((k) => Number.isFinite(nums[k] as number));
    return {
      frame: ok ? (frame as RootOverlayFrame) : null,
      filled: filled === true,
    };
  } catch {
    return { frame: null, filled: false };
  }
}

function writePersistedFrame(row: PersistedFrame) {
  try {
    localStorage.setItem(FRAME_STORAGE_KEY, JSON.stringify(row));
  } catch {
    // localStorage unavailable — the frame still holds for this session.
  }
}

interface RootOverlayState {
  open: boolean;
  /** Open the console; with a `key`, bring that root tab to the front of its
   *  subwindow. Which tab each subwindow shows is the root LAYOUT's, so it is
   *  the same answer the scope persists. */
  show: (key?: string) => void;
  close: () => void;
  /** Where it floats; `null` = the stylesheet's own size, centred. */
  frame: RootOverlayFrame | null;
  /** Filling the window. `frame` then holds what ⤡ restores. */
  filled: boolean;
  /** Commit a finished move/resize drag. Leaves `filled` behind — a drag on a
   *  filled console is the user sizing it by hand again. */
  setFrame: (frame: RootOverlayFrame) => void;
  /** ⤢ / ⤡, and a double-click on the title bar. */
  toggleFilled: () => void;
}

export const useRootOverlayStore = create<RootOverlayState>((set) => ({
  open: false,
  ...readPersistedFrame(),
  show: (key) => {
    void ensureRootScopeHydrated();
    if (key) useTabsStore.getState().revealTabInScope(ROOT_SCOPE, key);
    set({ open: true });
  },
  close: () => set({ open: false }),
  setFrame: (frame) => {
    writePersistedFrame({ frame, filled: false });
    set({ frame, filled: false });
  },
  toggleFilled: () =>
    set((s) => {
      const filled = !s.filled;
      writePersistedFrame({ frame: s.frame, filled });
      return { filled };
    }),
}));

export function toggleRootConsole(): void {
  const s = useRootOverlayStore.getState();
  if (s.open) s.close();
  else s.show();
}

/**
 * Open `spec` as a root tab and put it in front of the user in the console —
 * the one door for every flow that runs something in the root terminal on the
 * user's behalf (a one-click install, a login that needs a password).
 *
 * Root is hydrated FIRST when this is its first use this session: a tab added
 * to an unhydrated root creates the scope key, which reads as "hydrated", so
 * the restore is skipped and the host's persist then writes the lone new tab
 * over the saved root layout. `onOpened` runs synchronously when root is
 * already hydrated, after the restore otherwise.
 */
export function openTabInRootConsole(
  spec: Omit<TabEntry, "key">,
  onOpened?: (tab: TabEntry) => void,
): void {
  const open = () => {
    const tab = useTabsStore.getState().addTabToScope(ROOT_SCOPE, spec);
    onOpened?.(tab);
    useRootOverlayStore.getState().show(tab.key);
  };
  // A popout's heap owns no tabs: the add is forwarded to the main window,
  // which owns root's hydration too.
  if (isDetachedWindow() || ROOT_SCOPE in useTabsStore.getState().tabsByScope) {
    open();
    return;
  }
  void ensureRootScopeHydrated().then(open);
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
