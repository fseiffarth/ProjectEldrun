/**
 * The native-move tracker behind `CenterPanel`'s pane hide (`stores/drag/windowMove`).
 * What it pins: the hide shows only on the FIRST `onMoved` (a plain click never
 * flashes it), and every one of the belt-and-suspenders ends — pointer release,
 * the 250 ms idle after the last move, the 10 s hard stop — clears it exactly
 * once and unlistens, including when the native listener resolves late.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const onMoved = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onMoved: (cb: () => void) => onMoved(cb) }),
}));

import { trackWindowMove, useWindowMoveStore } from "../stores/drag/windowMove";

const unlisten = vi.fn();
let moved: (() => void) | undefined;
const realSetMoving = useWindowMoveStore.getState().setMoving;

/** Flush the `onMoved(...).then(...)` chain. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  onMoved.mockReset();
  unlisten.mockReset();
  moved = undefined;
  onMoved.mockImplementation((cb: () => void) => {
    moved = cb;
    return Promise.resolve(unlisten);
  });
  useWindowMoveStore.setState({ moving: false, setMoving: realSetMoving });
});

afterEach(() => {
  vi.useRealTimers();
});

const moving = () => useWindowMoveStore.getState().moving;

describe("trackWindowMove", () => {
  it("never shows the hide for a click that moves nothing", async () => {
    const setMoving = vi.fn(realSetMoving);
    useWindowMoveStore.setState({ setMoving });
    trackWindowMove();
    await flush();
    window.dispatchEvent(new Event("pointerup"));
    expect(setMoving).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("shows on the first move and hides on the pointer release", async () => {
    trackWindowMove();
    await flush();
    moved!();
    expect(moving()).toBe(true);
    moved!();
    window.dispatchEvent(new Event("pointerup"));
    expect(moving()).toBe(false);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("hides once the window has stopped moving for a beat when the up is swallowed", async () => {
    trackWindowMove();
    await flush();
    moved!();
    await vi.advanceTimersByTimeAsync(200);
    moved!(); // still dragging: the idle clock restarts
    await vi.advanceTimersByTimeAsync(200);
    expect(moving()).toBe(true);
    await vi.advanceTimersByTimeAsync(60);
    expect(moving()).toBe(false);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("can never stay stuck on: the hard stop ends it", async () => {
    trackWindowMove();
    await flush();
    moved!();
    // Keep moving faster than the idle clock so only the hard stop can end it.
    for (let t = 0; t < 10000; t += 100) {
      await vi.advanceTimersByTimeAsync(100);
      if (t < 9900) moved!();
    }
    expect(moving()).toBe(false);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("finishes exactly once however many ends fire, and a late listener is dropped at once", async () => {
    const setMoving = vi.fn(realSetMoving);
    useWindowMoveStore.setState({ setMoving });
    let resolveListener!: (fn: () => void) => void;
    onMoved.mockImplementation((cb: () => void) => {
      moved = cb;
      return new Promise<() => void>((r) => (resolveListener = r));
    });
    trackWindowMove();
    // No listener yet — the native call is still pending.
    window.dispatchEvent(new Event("pointerup"));
    window.dispatchEvent(new Event("pointercancel"));
    await vi.advanceTimersByTimeAsync(11000);
    expect(setMoving).not.toHaveBeenCalled();
    // The move ended before the listener even registered: unlisten immediately.
    resolveListener(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  // A move report landing between the pointer release and the `onMoved`
  // promise resolving (the listener is still live then) must not set `moving`
  // back to true: `finish` is already spent and would never clear it.
  it("ignores a move report that arrives after the move has ended", async () => {
    let resolveListener!: (fn: () => void) => void;
    onMoved.mockImplementation((cb: () => void) => {
      moved = cb;
      return new Promise<() => void>((r) => (resolveListener = r));
    });
    trackWindowMove();
    window.dispatchEvent(new Event("pointerup"));
    moved!();
    resolveListener(unlisten);
    await flush();
    await vi.advanceTimersByTimeAsync(11000);
    expect(moving()).toBe(false);
  });

  it("removes its window listeners so a later release touches nothing", async () => {
    const setMoving = vi.fn(realSetMoving);
    useWindowMoveStore.setState({ setMoving });
    trackWindowMove();
    await flush();
    moved!();
    window.dispatchEvent(new Event("pointerup"));
    expect(setMoving).toHaveBeenLastCalledWith(false);
    setMoving.mockClear();
    window.dispatchEvent(new Event("pointerup"));
    window.dispatchEvent(new Event("pointercancel"));
    expect(setMoving).not.toHaveBeenCalled();
  });
});
