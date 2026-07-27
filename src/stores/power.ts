import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useSettingsStore } from "./settings";

/** Mirrors the backend `PowerState` (commands/power.rs). */
interface PowerState {
  on_battery: boolean;
  supported: boolean;
}

/** How often we re-read the AC/battery state. A generous interval: the only
 *  consumer is Energy Saver, where a few seconds of lag on plug/unplug is fine
 *  and a tight poll would itself cost power. */
const POLL_MS = 30_000;

interface PowerStore {
  /** True only while every present battery is discharging. */
  onBattery: boolean;
  /** False when the backend could not read power state at all (fail open to AC). */
  supported: boolean;
  /** Whether the poll loop has produced at least one reading. */
  ready: boolean;
  /** Begin polling; returns a stop function that clears the interval. Idempotent
   *  enough for React StrictMode double-mount (the stop from the first run tears
   *  the first interval down). */
  start: () => () => void;
}

export const usePowerStore = create<PowerStore>((set) => ({
  onBattery: false,
  supported: false,
  ready: false,

  start: () => {
    const poll = async () => {
      try {
        const s = await invoke<PowerState>("get_power_state");
        set({ onBattery: s.on_battery, supported: s.supported, ready: true });
      } catch {
        // Treat a failed query as on-AC (fail open) so Energy Saver never
        // sticks the app in a throttled state because of a transient error.
        set({ onBattery: false, supported: false, ready: true });
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  },
}));

/** Resolve the effective mode + power state into "is Energy Saver active right
 *  now". Shared by the hook and the non-hook getter so the rule lives once. */
function isActive(mode: string | undefined, onBattery: boolean): boolean {
  switch (mode ?? "battery") {
    case "off":
      return false;
    case "always":
      return true;
    case "battery":
    default:
      return onBattery;
  }
}

/** Reactive: true when Energy Saver should be throttling activity. Re-renders
 *  its caller when either the setting or the power state changes. */
export function useEnergySaver(): boolean {
  const mode = useSettingsStore((s) => s.settings?.energy_saver);
  const onBattery = usePowerStore((s) => s.onBattery);
  return isActive(mode, onBattery);
}

/** Non-reactive snapshot of {@link useEnergySaver}, for reads inside animation
 *  loops (e.g. the ProjectBlobPane rAF) that must not resubscribe per frame. */
export function energySaverActive(): boolean {
  const mode = useSettingsStore.getState().settings?.energy_saver;
  return isActive(mode, usePowerStore.getState().onBattery);
}

/** Widen a base interval (ms) when Energy Saver is active. Kept here so the
 *  throttle factor lives in one place across every always-on timer site. */
export function saverInterval(base: number, active: boolean, factor = 3): number {
  return active ? base * factor : base;
}
