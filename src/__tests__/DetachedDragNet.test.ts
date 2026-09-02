/**
 * Group B #238: the net under a cross-window drag whose END never arrives.
 *
 * A drag started in a popout puts the MAIN window's drag store into
 * `kind:"detached"`, which flips `.center-panel.dragging` on and makes every
 * pane `pointer-events:none` so the drop preview can hit-test the tab bars
 * underneath. Only END takes it back out — the main window's own release
 * handlers deliberately never end a detached drag, because the popout owns the
 * pointer for the whole gesture. So a popout destroyed mid-drag, or an engine
 * that swallows the terminal event, left the main window ignoring every click,
 * with nothing on screen saying why and only an Escape pressed *in the main
 * window* to get out of it.
 */
import { describe, it, expect, vi } from "vitest";

import {
  createDetachedDragNet,
  DETACHED_DRAG_TIMEOUT_MS,
} from "../components/tabs/detachedDragNet";

/** A hand-driven clock, so the rule is tested rather than the wall clock. */
function fakeTimers() {
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (h: unknown) => {
        pending.delete(h as number);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
  };
}

describe("detached drag net (#238)", () => {
  it("expires a drag whose MOVEs stop arriving", () => {
    const onExpire = vi.fn();
    const clock = fakeTimers();
    const net = createDetachedDragNet(onExpire, DETACHED_DRAG_TIMEOUT_MS, clock.timers);

    net.start();
    expect(net.armed()).toBe(true);
    clock.advance(DETACHED_DRAG_TIMEOUT_MS);

    // The popout died mid-gesture: no END is ever coming, so the main window
    // takes itself back out of the drag rather than staying click-deaf.
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(net.armed()).toBe(false);
  });

  it("a live gesture is never expired, however long it runs", () => {
    const onExpire = vi.fn();
    const clock = fakeTimers();
    const net = createDetachedDragNet(onExpire, DETACHED_DRAG_TIMEOUT_MS, clock.timers);

    net.start();
    // The popout polls the OS cursor every frame while dragging, so MOVEs keep
    // pushing the deadline out — a slow, deliberate drag across two monitors
    // must not be cut off.
    for (let i = 0; i < 20; i += 1) {
      clock.advance(DETACHED_DRAG_TIMEOUT_MS - 100);
      net.touch();
    }
    expect(onExpire).not.toHaveBeenCalled();

    // …and it still expires once they genuinely stop.
    clock.advance(DETACHED_DRAG_TIMEOUT_MS);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("an END disarms it, so a finished drag never fires the net", () => {
    const onExpire = vi.fn();
    const clock = fakeTimers();
    const net = createDetachedDragNet(onExpire, DETACHED_DRAG_TIMEOUT_MS, clock.timers);

    net.start();
    net.stop();
    clock.advance(DETACHED_DRAG_TIMEOUT_MS * 5);

    expect(onExpire).not.toHaveBeenCalled();
    expect(net.armed()).toBe(false);
  });

  it("a stray MOVE after the drag ended does not re-arm it", () => {
    const onExpire = vi.fn();
    const clock = fakeTimers();
    const net = createDetachedDragNet(onExpire, DETACHED_DRAG_TIMEOUT_MS, clock.timers);

    net.start();
    net.stop();
    // A popout still polling after the main window ended the drag must not
    // arm a net that would then "expire" a gesture nobody is in.
    net.touch();
    clock.advance(DETACHED_DRAG_TIMEOUT_MS * 2);

    expect(onExpire).not.toHaveBeenCalled();
  });
});
