import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useSettingsStore } from "./settings";

/** Mirrors the backend `PowerState` (commands/power.rs). */
interface PowerState {
  on_battery: boolean;
  supported: boolean;
  percentage: number | null;
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
  /** Average state-of-charge across all present batteries, 0-100. `null` when
   *  unsupported or no batteries are present (a desktop). */
  percentage: number | null;
  /** Whether the poll loop has produced at least one reading. */
  ready: boolean;
  /** True while this window is unfocused (typing-latency plan, step 3). Fed by
   *  {@link startFocusTracking}; per-window by construction, since a popout is
   *  its own JS context with its own copy of this store. */
  blurred: boolean;
  /** Begin polling; returns a stop function that clears the interval. Idempotent
   *  enough for React StrictMode double-mount (the stop from the first run tears
   *  the first interval down). */
  start: () => () => void;
}

export const usePowerStore = create<PowerStore>((set) => ({
  onBattery: false,
  supported: false,
  percentage: null,
  ready: false,
  blurred: false,

  start: () => {
    const poll = async () => {
      try {
        const s = await invoke<PowerState>("get_power_state");
        set({
          onBattery: s.on_battery,
          supported: s.supported,
          percentage: s.percentage,
          ready: true,
        });
      } catch {
        // Treat a failed query as on-AC (fail open) so Energy Saver never
        // sticks the app in a throttled state because of a transient error.
        set({ onBattery: false, supported: false, percentage: null, ready: true });
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  },
}));

/** Track this window's focus so background quiescence can engage while the
 *  user works elsewhere (typing-latency plan, step 3: the renderer never
 *  reaching idle is what forfeits the scheduler's interactive treatment).
 *  Writes the store's `blurred` and mirrors it as `data-blurred` on the
 *  document root, where themes.css pauses every animation wholesale. Returns
 *  a stop function; call once per window root (AppShell / DetachedApp). */
export function startFocusTracking(): () => void {
  const apply = (blurred: boolean) => {
    usePowerStore.setState({ blurred });
    const root = document.documentElement;
    if (blurred) root.dataset.blurred = "on";
    else delete root.dataset.blurred;
  };
  const onBlur = () => apply(true);
  const onFocus = () => apply(false);
  apply(!document.hasFocus());
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  return () => {
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
  };
}

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

/** Reactive: true when background activity should be throttled — Energy Saver
 *  active OR this window unfocused. The blur half exists for the scheduler,
 *  not the battery: a renderer that keeps repainting while nobody looks at it
 *  never sleeps, and a thread that never sleeps is round-robined against batch
 *  load instead of getting the interactive fast path. Feed this (not
 *  {@link useEnergySaver}) to `saverInterval` timer sites and the CSS collapse;
 *  keep decisions about *power* (e.g. model autoload) on the saver reading. */
export function useQuiesce(): boolean {
  const saver = useEnergySaver();
  const blurred = usePowerStore((s) => s.blurred);
  return saver || blurred;
}

/** Non-reactive snapshot of {@link useQuiesce}, for reads inside animation
 *  loops that must not resubscribe per frame. */
export function quiesceActive(): boolean {
  return energySaverActive() || usePowerStore.getState().blurred;
}

/** Widen a base interval (ms) when Energy Saver is active. Kept here so the
 *  throttle factor lives in one place across every always-on timer site. */
export function saverInterval(base: number, active: boolean, factor = 3): number {
  return active ? base * factor : base;
}
