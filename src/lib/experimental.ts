/**
 * Experimental features and the one rule that governs them.
 *
 * An experimental feature is **off for everyone and on in debug mode**: the flag
 * is a tri-state, and when it is unset the answer is `settings.debug`. That is the
 * whole point of the gate — a feature that is still moving needs to be invisible
 * to someone using Eldrun to work, and present *by default* for someone using
 * Eldrun to build Eldrun, without them having to re-tick a list of toggles every
 * time a new one lands.
 *
 * Unset is therefore NOT the same as false. An explicit value always wins, in both
 * directions: a user can opt into one experiment without debug mode, and can switch
 * one off while *in* debug mode — otherwise "turn this off" would silently fail for
 * exactly the people most likely to hit a broken experiment.
 *
 * Adding an experiment: add its key to `Settings` (and to the Rust `Settings`, so
 * it round-trips through `save_settings`), list it here, and read it through
 * `useExperimental`. Never read `settings.<flag> ?? false` at the call site — that
 * spelling is what makes a flag miss the debug default.
 */

import { useSettingsStore } from "../stores/settings";
import type { Settings } from "../types";

/** Every experimental flag. Keys of `Settings`, all `boolean | undefined`. */
export const EXPERIMENTAL_FLAGS = [
  "agent_mode_toggle",
  "python_run_debug",
  "deck_presenter",
] as const;

export type ExperimentalFlag = (typeof EXPERIMENTAL_FLAGS)[number];

/** Is `flag` live? Explicit setting if there is one, else debug mode, else off. */
export function experimentalEnabled(
  settings: Settings | null | undefined,
  flag: ExperimentalFlag,
): boolean {
  return settings?.[flag] ?? settings?.debug ?? false;
}

/** `experimentalEnabled` as a store subscription — the call site for a component. */
export function useExperimental(flag: ExperimentalFlag): boolean {
  return useSettingsStore((s) => experimentalEnabled(s.settings, flag));
}
