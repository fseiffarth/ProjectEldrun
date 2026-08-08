/**
 * Window-blur quiescence (`stores/power`, typing-latency plan step 3).
 *
 * The renderer never reaching idle is what forfeits the scheduler's
 * interactive fast path, so a blurred window must engage the same throttles
 * Energy Saver does: `startFocusTracking` mirrors this window's focus into the
 * store AND onto the document root (`data-blurred`, where themes.css pauses
 * every animation), and `quiesceActive` reads "throttle now?" as saver OR
 * blurred. The rules worth pinning: blur engages, focus disengages, teardown
 * stops listening, and the blur half never leaks into the *battery* reading
 * (`energySaverActive`), which decisions about power — model autoload — stay on.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  usePowerStore,
  startFocusTracking,
  quiesceActive,
  energySaverActive,
  saverInterval,
} from "../stores/power";
import { useSettingsStore } from "../stores/settings";
import type { Settings } from "../types";

beforeEach(() => {
  usePowerStore.setState({ onBattery: false, blurred: false });
  useSettingsStore.setState({
    settings: { energy_saver: "battery" } as unknown as Settings,
  });
  delete document.documentElement.dataset.blurred;
});

describe("startFocusTracking", () => {
  it("blur engages quiesce and marks the root; focus disengages both", () => {
    const stop = startFocusTracking();
    // Tracking seeds from document.hasFocus() (false in jsdom); a focus event
    // settles it, which is also what a real window fires as it comes forward.
    window.dispatchEvent(new Event("focus"));
    expect(usePowerStore.getState().blurred).toBe(false);
    expect(quiesceActive()).toBe(false);

    window.dispatchEvent(new Event("blur"));
    expect(usePowerStore.getState().blurred).toBe(true);
    expect(quiesceActive()).toBe(true);
    expect(document.documentElement.dataset.blurred).toBe("on");

    window.dispatchEvent(new Event("focus"));
    expect(usePowerStore.getState().blurred).toBe(false);
    expect(quiesceActive()).toBe(false);
    expect(document.documentElement.dataset.blurred).toBeUndefined();
    stop();
  });

  it("stops listening after teardown", () => {
    const stop = startFocusTracking();
    window.dispatchEvent(new Event("focus"));
    stop();
    window.dispatchEvent(new Event("blur"));
    expect(usePowerStore.getState().blurred).toBe(false);
    expect(document.documentElement.dataset.blurred).toBeUndefined();
  });
});

describe("quiesce vs energy saver", () => {
  it("blur throttles timers without pretending to be on battery", () => {
    usePowerStore.setState({ blurred: true });
    // The timer sites widen…
    expect(quiesceActive()).toBe(true);
    expect(saverInterval(1000, quiesceActive())).toBe(3000);
    // …but the battery reading (model autoload's gate) is untouched.
    expect(energySaverActive()).toBe(false);
  });

  it("energy saver alone also quiesces", () => {
    useSettingsStore.setState({
      settings: { energy_saver: "always" } as unknown as Settings,
    });
    expect(quiesceActive()).toBe(true);
  });
});
