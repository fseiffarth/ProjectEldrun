/**
 * Scroll a phone drag through the session.  The emulator carries the desktop
 * tmux window's geometry, so its screen is usually taller than the phone's
 * box as well as wider: the drag therefore pans the box over the rows it hides
 * before it moves the buffer, which is one continuous gesture over
 * `[scrollback] + [the rows below the fold]`.  A session that fits has no
 * overflow to consume and scrolls history from the first pixel, as before.
 *
 * Pointer Events are the reliable touch stream in current Android/iOS
 * browsers; some older embedded webviews only expose Touch Events, so keep
 * that path as a fallback.
 */
export interface TerminalScroller {
  scrollLines(lines: number): void;
}

const PIXELS_PER_LINE = 14;
/** How far a drag must lean sideways before it counts as a pan, not a scroll. */
const AXIS_SLACK = 8;

export function installTerminalTouchScroll(host: HTMLElement, terminal: TerminalScroller) {
  let activeId: number | undefined;
  let lastY: number | undefined;
  let startX: number | undefined;
  let startY: number | undefined;
  let panning = false;
  let remainder = 0;

  /**
   * Moves the box over the emulated screen and returns the pixels it could not
   * take, so a drag that runs out of hidden rows continues into the buffer.
   * `.terminal` is `overflow-y:hidden` — user scrolling is this function, not
   * the browser's — but a hidden box still scrolls programmatically.
   */
  const panRows = (delta: number) => {
    const room = host.scrollHeight - host.clientHeight;
    if (room <= 0) return delta;
    const before = host.scrollTop;
    host.scrollTop = Math.min(room, Math.max(0, before + delta));
    return delta - (host.scrollTop - before);
  };
  const begin = (id: number, clientX: number, clientY: number) => {
    if (activeId !== undefined) return false;
    activeId = id;
    lastY = clientY;
    startX = clientX;
    startY = clientY;
    panning = false;
    remainder = 0;
    return true;
  };
  const move = (id: number, clientX: number, clientY: number) => {
    if (id !== activeId || lastY === undefined || panning) return false;
    // The session is usually wider than the phone, so a sideways drag pans it
    // across the screen — and that scroller is the browser's own (`.terminal`
    // in style.css). Swallowing the gesture here, as the Touch Events path
    // must to scroll history at all, would leave the right of every long line
    // unreachable. Decided once per gesture, before the first line moves.
    const sideways = Math.abs(clientX - (startX ?? clientX));
    if (sideways > AXIS_SLACK && sideways > Math.abs(clientY - (startY ?? clientY))) {
      panning = true;
      return false;
    }
    remainder += lastY - clientY;
    lastY = clientY;
    remainder = panRows(remainder);
    const lines = remainder < 0
      ? Math.ceil(remainder / PIXELS_PER_LINE)
      : Math.floor(remainder / PIXELS_PER_LINE);
    if (lines) {
      terminal.scrollLines(lines);
      remainder -= lines * PIXELS_PER_LINE;
    }
    return true;
  };
  const end = (id: number) => {
    if (id !== activeId) return false;
    activeId = undefined;
    lastY = undefined;
    startX = undefined;
    startY = undefined;
    panning = false;
    remainder = 0;
    return true;
  };

  const pointerStart = (event: PointerEvent) => {
    if (event.pointerType && event.pointerType !== "touch") return;
    if (!begin(event.pointerId, event.clientX, event.clientY)) return;
    // Do not let xterm turn this drag into a terminal mouse gesture. Capture
    // waits for the first move: taking the pointer here would risk the gesture
    // never reaching the browser's own horizontal pan of the wide session.
    event.stopPropagation();
  };
  const pointerMove = (event: PointerEvent) => {
    if (!move(event.pointerId, event.clientX, event.clientY)) return;
    host.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  const pointerEnd = (event: PointerEvent) => {
    if (!end(event.pointerId)) return;
    if (host.hasPointerCapture?.(event.pointerId)) host.releasePointerCapture?.(event.pointerId);
    event.stopPropagation();
  };

  const touchAt = (touches: TouchList, identifier: number) => {
    for (let index = 0; index < touches.length; index += 1) {
      const touch = touches.item(index);
      if (touch?.identifier === identifier) return touch;
    }
    return null;
  };
  const touchStart = (event: TouchEvent) => {
    const touch = event.changedTouches.item(0);
    if (!touch || !begin(touch.identifier, touch.clientX, touch.clientY)) return;
    event.stopPropagation();
  };
  const touchMove = (event: TouchEvent) => {
    if (activeId === undefined) return;
    const touch = touchAt(event.touches, activeId);
    if (!touch || !move(touch.identifier, touch.clientX, touch.clientY)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const touchEnd = (event: TouchEvent) => {
    if (activeId === undefined || !touchAt(event.changedTouches, activeId)) return;
    end(activeId);
    event.stopPropagation();
  };

  const options: AddEventListenerOptions = { capture: true, passive: false };
  if ("PointerEvent" in window) {
    // A phone fires Touch Events alongside Pointer Events, and stopping the
    // pointer stream does nothing to the touch one. xterm listens for
    // `touchstart`/`touchmove` on its own element and scrolls its viewport by
    // the raw finger delta — so a drag that this handler already turned into
    // `scrollLines` was scrolled a second time by xterm, at a different rate.
    // Only the propagation is stopped: `touch-action` on the host decides what
    // the browser itself does with the gesture, and a sideways pan stays its.
    const swallowTouch = (event: TouchEvent) => event.stopPropagation();
    const touchOptions: AddEventListenerOptions = { capture: true, passive: true };
    host.addEventListener("pointerdown", pointerStart, options);
    host.addEventListener("pointermove", pointerMove, options);
    host.addEventListener("pointerup", pointerEnd, options);
    host.addEventListener("pointercancel", pointerEnd, options);
    host.addEventListener("touchstart", swallowTouch, touchOptions);
    host.addEventListener("touchmove", swallowTouch, touchOptions);
    return () => {
      host.removeEventListener("pointerdown", pointerStart, true);
      host.removeEventListener("pointermove", pointerMove, true);
      host.removeEventListener("pointerup", pointerEnd, true);
      host.removeEventListener("pointercancel", pointerEnd, true);
      host.removeEventListener("touchstart", swallowTouch, true);
      host.removeEventListener("touchmove", swallowTouch, true);
    };
  }
  host.addEventListener("touchstart", touchStart, options);
  host.addEventListener("touchmove", touchMove, options);
  host.addEventListener("touchend", touchEnd, options);
  host.addEventListener("touchcancel", touchEnd, options);
  return () => {
    host.removeEventListener("touchstart", touchStart, true);
    host.removeEventListener("touchmove", touchMove, true);
    host.removeEventListener("touchend", touchEnd, true);
    host.removeEventListener("touchcancel", touchEnd, true);
  };
}
