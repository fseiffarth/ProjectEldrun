/**
 * #42 on native Wayland: cross-window tab drops WITHOUT desktop coordinates.
 *
 * The streamed dock protocol (`DETACHED_DRAG_START/MOVE/END`) hit-tests a
 * PHYSICAL desktop cursor against every window's desktop frame. A native Wayland
 * client has neither: `cursorPosition()` and `outerPosition()` answer a dummy
 * `(0,0)` (`desktopCoordinatesSupported` refuses them), so the source window
 * cannot say WHICH window the tab was released over — and until this module
 * existed a tab dragged out of a popout simply stayed put unless it was dropped
 * back into the same popout (whose own DOM coordinates still work).
 *
 * What the compositor DOES give us: the moment the button is released, the
 * implicit grab ends and the compositor moves pointer focus to the surface under
 * the cursor. GDK turns that into an enter-notify, and WebKitGTK synthesises a
 * mouse move for it — so the window under the cursor receives a DOM pointer
 * event right after the release, with the cursor in ITS OWN client px. That is
 * the one signal that names the drop target, and it comes from the target, not
 * the source. So:
 *
 *   1. the SOURCE window emits `DETACHED_DROP_PROBE` at release ("a tab was let
 *      go somewhere outside me — whoever has the pointer, say so");
 *   2. every OTHER window arms a one-shot pointer listener; the first DOM pointer
 *      event within `DROP_CLAIM_TIMEOUT_MS` makes that window emit
 *      `DETACHED_DROP_CLAIM` with its client coordinates and the pane target it
 *      resolves there (a popout resolves its own panes; the main window resolves
 *      through its usual `resolveTarget`);
 *   3. the main window — the host of every dock — acts on the first claim for
 *      that probe: dock into main, or into the claiming popout.
 *
 * No claim within the timeout means the release landed on free space or on
 * another application (or the compositor sent no crossing event). The tab then
 * stays where it was: a missed event must not fork a new window the user did
 * not ask for. Shift + release still pops a new window through the streamed
 * protocol's explicit new-window request, which needs no geometry.
 *
 * Nothing here is Wayland-specific in mechanism; the callers gate on
 * `desktopCoordinatesSupported()` so the geometric protocol keeps precedence
 * wherever it works (X11, Windows, macOS): it also paints a live preview, which
 * this fallback cannot (the target sees no pointer until the button is up).
 */
import { emit, listen } from "@tauri-apps/api/event";
import type { DetachedDockTarget } from "../../stores/tabs";

export const DETACHED_DROP_PROBE = "detached-drop-probe";
export const DETACHED_DROP_CLAIM = "detached-drop-claim";

/** How long a probe waits for the window under the cursor to claim it. The
 *  crossing event follows the release within a frame; the margin covers a busy
 *  WebKitGTK main loop and a user who let go and only then twitched the mouse. */
export const DROP_CLAIM_TIMEOUT_MS = 1200;

export interface DetachedDropProbe {
  /** Pairs claims with this probe (one gesture at a time, but a late claim for
   *  a previous probe must never dock a later tab). */
  token: string;
  /** The dragged tab's scope: only windows of that scope may claim. */
  scope: string;
  /** Window label of the source, which never claims its own probe. */
  sourceLabel: string;
  /** The source popout's record id — `undefined` when the source is the main
   *  window (a main→popout drag). */
  groupId?: string;
  tabKey: string;
  label: string;
  /** `Date.now()` at the release. Every webview shares the one process clock,
   *  so a claimant can tell a pointer event it saw AFTER the release from the
   *  ones before it — the crossing can beat the probe's IPC round trip. */
  releasedAt: number;
}

export interface DetachedDropClaim {
  token: string;
  /** Window label of the claimant. */
  windowLabel: string;
  /** The claiming popout's record id — `undefined` when the main window claims
   *  (it claims through its own DOM, so the event form is popout-only today,
   *  but the field keeps the payload self-describing). */
  groupId?: string;
  clientX: number;
  clientY: number;
  /** The pane target the claimant resolved under the cursor, or null (released
   *  over its chrome / empty area — the host then docks at the default spot). */
  target: DetachedDockTarget | null;
}

/** The DOM events that can carry the post-release crossing into a window. The
 *  synthesised crossing arrives as a mouse move; a real move or press after it
 *  serves as well. Both mouse and pointer flavours are watched, since which one
 *  the engine raises for a synthesised crossing is not guaranteed. */
const CLAIM_EVENTS = ["pointermove", "mousemove", "pointerover", "mouseover", "pointerdown"] as const;

/** The last DOM pointer event this window saw, with its timestamp. The
 *  post-release crossing races the probe (a DOM event is direct; the probe is
 *  an IPC hop through Rust), so a claimant that only starts listening when the
 *  probe lands would miss a cursor that arrived first and then held still.
 *  `installPointerTracker` keeps this current; `awaitPointerClaim` consults it
 *  for an event already newer than the release. */
let lastPointer: { x: number; y: number; t: number } | null = null;
let trackerInstalled = false;
export function installPointerTracker(): void {
  if (trackerInstalled) return;
  trackerInstalled = true;
  const note = (ev: Event) => {
    const e = ev as MouseEvent;
    if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
    lastPointer = { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  for (const name of CLAIM_EVENTS) window.addEventListener(name, note, true);
}
/** Test seam: forget the tracked pointer (and let a test reinstall). */
export function resetPointerTracker(): void {
  lastPointer = null;
}

let tokenSeq = 0;
export const newDropToken = (windowLabel: string): string =>
  `${windowLabel}:${Date.now().toString(36)}:${(tokenSeq += 1)}`;

/**
 * Arm a one-shot "the pointer is in this window" watch: the FIRST qualifying DOM
 * event (with a finite client position) fires `onPointer` once and disarms;
 * `timeoutMs` without one fires `onTimeout` instead. Returns a cancel function
 * (idempotent). Listeners bind in the capture phase so a pane that stops
 * propagation cannot hide the crossing.
 *
 * With `since` (the release time), a pointer event the tracker already saw at
 * or after that moment counts as the claim and fires `onPointer` SYNCHRONOUSLY
 * before this returns — the cursor got here before the probe did.
 */
export function awaitPointerClaim(
  onPointer: (clientX: number, clientY: number) => void,
  onTimeout: () => void,
  opts: { since?: number; timeoutMs?: number } = {},
): () => void {
  const timeoutMs = opts.timeoutMs ?? DROP_CLAIM_TIMEOUT_MS;
  if (opts.since != null && lastPointer && lastPointer.t >= opts.since) {
    const { x, y } = lastPointer;
    onPointer(x, y);
    return () => {};
  }
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const handler = (ev: Event) => {
    const e = ev as MouseEvent;
    if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
    if (done) return;
    finish();
    onPointer(e.clientX, e.clientY);
  };
  const finish = () => {
    done = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const name of CLAIM_EVENTS) window.removeEventListener(name, handler, true);
  };
  for (const name of CLAIM_EVENTS) window.addEventListener(name, handler, true);
  timer = setTimeout(() => {
    if (done) return;
    finish();
    onTimeout();
  }, timeoutMs);
  return () => {
    if (!done) finish();
  };
}

/**
 * Source side of a main-window drag: broadcast a probe and resolve with the
 * first matching claim, or `null` after the timeout. The main window is also the
 * host, so it consumes the claim right here rather than through `CenterPanel`'s
 * probe host (which ignores probes the main window itself sent).
 */
export async function probeDropTarget(
  probe: DetachedDropProbe,
  timeoutMs: number = DROP_CLAIM_TIMEOUT_MS,
): Promise<DetachedDropClaim | null> {
  let settle: (c: DetachedDropClaim | null) => void = () => {};
  const claimed = new Promise<DetachedDropClaim | null>((res) => {
    settle = res;
  });
  // Register the claim listener BEFORE the probe goes out, or a popout that
  // answers promptly answers nobody (the same race `detachedDropTargets`
  // documents for its panes request).
  const unlisten = await listen<DetachedDropClaim>(DETACHED_DROP_CLAIM, (ev) => {
    if (ev.payload.token === probe.token) settle(ev.payload);
  }).catch(() => undefined);
  const timer = setTimeout(() => settle(null), timeoutMs);
  await emit(DETACHED_DROP_PROBE, probe).catch(() => settle(null));
  try {
    return await claimed;
  } finally {
    clearTimeout(timer);
    unlisten?.();
  }
}
