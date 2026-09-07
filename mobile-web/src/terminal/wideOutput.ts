/**
 * Terminal view is deliberately wider than the phone: tmux sizes a window to
 * its widest attached client, and the bridge hands the phone that geometry
 * (`pty_bridge::window_size`) so no line arrives silently truncated.  The view
 * therefore pans horizontally over a desktop-width screen — and a touch screen
 * draws no scrollbar at rest, so nothing would tell a reader that the line
 * continues past the edge.  These classes do: the marker element fades the
 * edge that still hides output.
 */
export interface WideOutputHint {
  /** Re-reads the geometry now — after a resize no scroll event follows. */
  sync(): void;
  dispose(): void;
}

/** Sub-pixel scroll offsets are normal; only real hidden output counts. */
const EDGE_SLACK = 2;

export function installWideOutputHint(scroller: HTMLElement, marker: HTMLElement): WideOutputHint {
  const apply = () => {
    const hidden = scroller.scrollWidth - scroller.clientWidth;
    const offset = scroller.scrollLeft;
    marker.classList.toggle("wide-left", offset > EDGE_SLACK);
    marker.classList.toggle("wide-right", hidden - offset > EDGE_SLACK);
  };
  // A pan fires a scroll event per frame; coalescing keeps the layout reads to
  // one per frame instead of one per event.
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      apply();
    });
  };
  scroller.addEventListener("scroll", schedule, { passive: true });
  // The emulator's width changes without a scroll event whenever the desktop
  // resizes the tmux window. Watching the rendered screen catches that whether
  // it came from a resize, a font change, or xterm's own redraw.
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
  observer?.observe(scroller);
  if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild);
  apply();
  return {
    sync: apply,
    dispose: () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      observer?.disconnect();
      marker.classList.remove("wide-left", "wide-right");
    },
  };
}
