/**
 * Scroll xterm history from a phone drag.  Pointer Events are the reliable
 * touch stream in current Android/iOS browsers; some older embedded webviews
 * only expose Touch Events, so keep that path as a fallback.
 */
export interface TerminalScroller {
  scrollLines(lines: number): void;
}

const PIXELS_PER_LINE = 14;

export function installTerminalTouchScroll(host: HTMLElement, terminal: TerminalScroller) {
  let activeId: number | undefined;
  let lastY: number | undefined;
  let remainder = 0;

  const begin = (id: number, clientY: number) => {
    if (activeId !== undefined) return false;
    activeId = id;
    lastY = clientY;
    remainder = 0;
    return true;
  };
  const move = (id: number, clientY: number) => {
    if (id !== activeId || lastY === undefined) return false;
    remainder += lastY - clientY;
    lastY = clientY;
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
    remainder = 0;
    return true;
  };

  const pointerStart = (event: PointerEvent) => {
    if (event.pointerType && event.pointerType !== "touch") return;
    if (!begin(event.pointerId, event.clientY)) return;
    host.setPointerCapture?.(event.pointerId);
    // Do not let xterm turn this drag into a terminal mouse gesture.
    event.stopPropagation();
  };
  const pointerMove = (event: PointerEvent) => {
    if (!move(event.pointerId, event.clientY)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const pointerEnd = (event: PointerEvent) => {
    if (!end(event.pointerId)) return;
    host.releasePointerCapture?.(event.pointerId);
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
    if (!touch || !begin(touch.identifier, touch.clientY)) return;
    event.stopPropagation();
  };
  const touchMove = (event: TouchEvent) => {
    if (activeId === undefined) return;
    const touch = touchAt(event.touches, activeId);
    if (!touch || !move(touch.identifier, touch.clientY)) return;
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
    host.addEventListener("pointerdown", pointerStart, options);
    host.addEventListener("pointermove", pointerMove, options);
    host.addEventListener("pointerup", pointerEnd, options);
    host.addEventListener("pointercancel", pointerEnd, options);
    return () => {
      host.removeEventListener("pointerdown", pointerStart, true);
      host.removeEventListener("pointermove", pointerMove, true);
      host.removeEventListener("pointerup", pointerEnd, true);
      host.removeEventListener("pointercancel", pointerEnd, true);
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
