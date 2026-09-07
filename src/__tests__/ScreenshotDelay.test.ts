import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cancelDelayedCapture,
  SCREENSHOT_DELAY_MS,
  startDelayedCapture,
} from "../lib/screenshot";

/**
 * The Shift+click delay: the window the user Alt+Tabs in.
 *
 * The interesting cases are all about the countdown outliving the thing that
 * started it — `GlobalAppBar` unmounts the moment the hover menu closes, which
 * is immediately after the click — and about an occluded window's throttled
 * timers, which is the normal state during the wait (the point of the delay is
 * that another window is now on top).
 */
describe("delayed screenshot capture", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cancelDelayedCapture();
    vi.useRealTimers();
  });

  it("counts down whole seconds, then captures exactly once", () => {
    const ticks: number[] = [];
    const capture = vi.fn();
    startDelayedCapture({ delayMs: 3000, tick: (s) => ticks.push(s), capture });

    // The first tick is immediate: the toast must not wait a second to appear.
    expect(ticks).toEqual([3]);
    expect(capture).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([3, 2]);
    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([3, 2, 1]);
    expect(capture).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(capture).toHaveBeenCalledTimes(1);

    // The interval is cleared by the firing, not left running behind it.
    vi.advanceTimersByTime(10_000);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("fires on the first tick past the deadline when timers are throttled", () => {
    const capture = vi.fn();
    startDelayedCapture({ delayMs: 5000, tick: () => {}, capture });
    // An occluded WebKitGTK page gets ~1s buckets rather than the 200ms asked
    // for; a deadline comparison still fires, where a drifting countdown would
    // not. One long jump stands in for that.
    vi.advanceTimersByTime(6000);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("restarts rather than queueing a second capture", () => {
    const first = vi.fn();
    const second = vi.fn();
    startDelayedCapture({ delayMs: 2000, tick: () => {}, capture: first });
    vi.advanceTimersByTime(1500);
    startDelayedCapture({ delayMs: 2000, tick: () => {}, capture: second });

    // The first countdown's own deadline passes and must produce nothing.
    vi.advanceTimersByTime(600);
    expect(first).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending capture and reports whether there was one", () => {
    const capture = vi.fn();
    expect(cancelDelayedCapture()).toBe(false);
    startDelayedCapture({ delayMs: 5000, tick: () => {}, capture });
    expect(cancelDelayedCapture()).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(capture).not.toHaveBeenCalled();
    expect(cancelDelayedCapture()).toBe(false);
  });

  it("waits long enough to switch windows in", () => {
    // The number is a UX claim, not an implementation detail: too short and the
    // Alt+Tab never lands.
    expect(SCREENSHOT_DELAY_MS).toBeGreaterThanOrEqual(3000);
  });
});
