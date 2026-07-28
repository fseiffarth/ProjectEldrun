import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useSettingsStore } from "./settings";
import { energySaverActive, usePowerStore } from "./power";

/**
 * **Load a local (Ollama) model into memory when Eldrun starts.**
 *
 * A model that is merely *installed* is not usable — the first request pays the
 * whole load, which for a 7B model is tens of seconds. Anything that wants a
 * local model to answer *promptly and unattended* (mail-importance scoring,
 * autocomplete, grammar) therefore needs one already resident, and until now the
 * only way to get there was the 🧠 menu's per-model "Load" button, by hand, every
 * launch. `settings.ollama_autoload_models` is that click made persistent.
 *
 * Two rules carry it:
 *
 * - **Energy Saver suppresses it.** A resident model pins GPU/CPU memory and
 *   Ollama keeps it warm, which is the precise kind of standing cost Energy
 *   Saver exists to remove. So the launch run is skipped while it is active —
 *   and the skip is *announced* (the 🧠 menu's notice + "Load now"), because a
 *   silent skip is indistinguishable from the feature being broken. The opt-out
 *   is `settings.ollama_autoload_in_energy_saver`.
 * - **A skip stays skipped until a click.** Unplugging later does not
 *   retroactively start the models: the run is a launch-time decision the user
 *   was told about, and a load that begins minutes afterwards, unasked, is the
 *   surprise the announcement was meant to avoid.
 *
 * The run is **sequential**: two models loading at once contend for the same
 * VRAM and can push each other back out to CPU, so the second only starts once
 * the first is resident.
 */

/** Where the launch-time decision landed. `skipped` is the Energy Saver case. */
export type AutoloadPhase = "idle" | "loading" | "done" | "skipped" | "error";

/** How long to keep retrying a `not_running` failure, and how often. Starting
 *  Ollama's server and having it accept requests are not the same instant, and
 *  at launch we are usually the first caller after a cold boot. */
const RETRY_ATTEMPTS = 4;
const RETRY_DELAY_MS = 2500;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

interface OllamaAutoloadStore {
  phase: AutoloadPhase;
  /** The models this run is (or was) for — the configured list at the time. */
  models: string[];
  /** Models now resident because of this run. */
  loaded: string[];
  /** Per-model failure text for the ones that did not make it. */
  failed: Record<string, string>;
  /** Set once the launch decision has been taken, so it is taken exactly once. */
  ran: boolean;
  /** The user acknowledged the Energy Saver notice; stop showing it. */
  dismissed: boolean;
  /** Take the launch-time decision: load, or skip and say so. */
  autorun: () => Promise<void>;
  /** Load the configured models now, whatever Energy Saver says. The "Load now"
   *  button behind the skip notice, and the only way out of `skipped`. */
  loadNow: () => Promise<void>;
  dismiss: () => void;
}

export const useOllamaAutoloadStore = create<OllamaAutoloadStore>((set, get) => ({
  phase: "idle",
  models: [],
  loaded: [],
  failed: {},
  ran: false,
  dismissed: false,

  autorun: async () => {
    if (get().ran) return;
    set({ ran: true });
    const settings = useSettingsStore.getState().settings;
    const models = settings?.ollama_autoload_models ?? [];
    if (models.length === 0) return; // nothing armed — stay `idle`
    if (energySaverActive() && settings?.ollama_autoload_in_energy_saver !== true) {
      set({ phase: "skipped", models, dismissed: false });
      return;
    }
    await get().loadNow();
  },

  loadNow: async () => {
    const models = useSettingsStore.getState().settings?.ollama_autoload_models ?? [];
    if (models.length === 0) {
      set({ phase: "idle", models: [] });
      return;
    }
    set({ phase: "loading", models, loaded: [], failed: {}, dismissed: false });

    // Start the server first — "load a model at startup" is meaningless if the
    // thing that holds models isn't up, and at launch it very often isn't yet.
    // A failure here is not fatal on its own: the server may be reachable but
    // unmanageable (no systemd, a user-run `ollama serve`), so the loads below
    // are still attempted and report the real reason if it truly is down.
    try {
      await invoke("ensure_ollama_running");
    } catch {
      /* fall through to the load, which produces the actionable error */
    }

    const loaded: string[] = [];
    const failed: Record<string, string> = {};
    for (const model of models) {
      let error: string | null = null;
      for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        try {
          await invoke("load_ollama_model", { model });
          error = null;
          break;
        } catch (e) {
          error = typeof e === "string" ? e : String(e);
          // Only "the server isn't there yet" is worth waiting out; a model that
          // doesn't exist, or an install missing its runner, fails identically
          // on every retry.
          if (error !== "not_running") break;
          await sleep(RETRY_DELAY_MS);
        }
      }
      if (error === null) loaded.push(model);
      else failed[model] = error;
      set({ loaded: [...loaded], failed: { ...failed } });
    }
    set({ phase: Object.keys(failed).length > 0 ? "error" : "done" });
  },

  dismiss: () => set({ dismissed: true }),
}));

/**
 * Take the launch decision once, in the main window only.
 *
 * It waits for two things, and both matter: `settings` (the list lives there)
 * and the power store's first reading (`ready`) — asking "is Energy Saver on?"
 * before any battery state has been read would answer "no" for a laptop on
 * battery and load the models the mode exists to prevent.
 */
export function useOllamaAutoloadOnLaunch(): void {
  const settingsLoaded = useSettingsStore((s) => s.settings !== null);
  const powerReady = usePowerStore((s) => s.ready);
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current || !settingsLoaded || !powerReady) return;
    fired.current = true;
    void useOllamaAutoloadStore.getState().autorun();
  }, [settingsLoaded, powerReady]);
}

/** Reset the module between tests. */
export function resetOllamaAutoload(): void {
  useOllamaAutoloadStore.setState({
    phase: "idle",
    models: [],
    loaded: [],
    failed: {},
    ran: false,
    dismissed: false,
  });
}
