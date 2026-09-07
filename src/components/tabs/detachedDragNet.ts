/**
 * Group B #238: the net under a cross-window drag whose END never arrives.
 *
 * A tab dragged out of a popout streams START / MOVE / END to the main window.
 * START puts the main drag store into `kind:"detached"`, which flips
 * `.center-panel.dragging` on and makes every pane `pointer-events:none` so the
 * drop preview can hit-test the bars underneath; only END (or Escape pressed IN
 * the main window) takes it back out — the main window's own release handlers
 * deliberately never end a detached drag, because the popout owns the pointer.
 * So a popout destroyed mid-gesture, or an engine that swallows the terminal
 * event, left the main window ignoring every click until someone found Escape.
 *
 * The net is two facts the main window CAN observe: MOVEs stop arriving (the
 * popout polls the OS cursor at frame rate while the gesture is live, so a gap
 * of a couple of seconds means it is dead), and a `pointerdown` lands in the
 * main window (a live gesture holds the pointer in the popout, so a press here
 * means the gesture is over). Either expires the drag. Pure timer logic, so the
 * expiry rule is unit-tested; the caller wires the pointer listener.
 */
export interface DetachedDragNet {
  /** A START arrived — arm the watchdog. */
  start(): void;
  /** A MOVE arrived — the gesture is alive, push the deadline out. */
  touch(): void;
  /** END arrived (or the drag was ended by other means) — disarm. */
  stop(): void;
  /** Whether the net is currently armed. */
  armed(): boolean;
}

/** How long the main window waits for the next MOVE before declaring the
 *  gesture dead. The popout's cursor poll runs every frame while dragging, and
 *  the slowest legitimate gap is a WebKitGTK pause of a few hundred ms. */
export const DETACHED_DRAG_TIMEOUT_MS = 2000;

export function createDetachedDragNet(
  onExpire: () => void,
  timeoutMs: number = DETACHED_DRAG_TIMEOUT_MS,
  timers: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): DetachedDragNet {
  let handle: unknown = null;
  const disarm = () => {
    if (handle !== null) {
      timers.clear(handle);
      handle = null;
    }
  };
  const arm = () => {
    disarm();
    handle = timers.set(() => {
      handle = null;
      onExpire();
    }, timeoutMs);
  };
  return {
    start: arm,
    touch: () => {
      // A MOVE with no START (a stale popout still polling after main ended the
      // drag) must not arm a net that then "expires" a drag nobody is in.
      if (handle !== null) arm();
    },
    stop: disarm,
    armed: () => handle !== null,
  };
}
