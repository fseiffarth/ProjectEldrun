import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { create } from "zustand";
import type { Settings, Theme, WindowState } from "../types";

function applyTheme(scheme: string) {
  document.documentElement.setAttribute("data-theme", scheme);
  // Cache for index.html's pre-paint inline script, so the next launch
  // paints the right theme immediately instead of flashing the CSS
  // :root default until settings arrive over the async invoke.
  try {
    localStorage.setItem("eldrun-theme", scheme);
  } catch {
    // localStorage unavailable — worst case is the old one-frame flash.
  }
}

/** Global UI zoom (4K-monitor scaling). `1` is 100% (the current/default look);
 *  higher enlarges the whole interface, lower shrinks it. Applied via the
 *  webview's native zoom so every layer scales — including `position: fixed` /
 *  portaled overlays (menus, dropdowns, hover popovers) that a CSS `zoom` misses
 *  on WebKitGTK. */
export const MIN_UI_ZOOM = 0.5;
export const MAX_UI_ZOOM = 3;

export function clampZoom(z: number | undefined | null): number {
  if (typeof z !== "number" || !Number.isFinite(z)) return 1;
  return Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, z));
}

function applyZoom(zoom: number | undefined) {
  const z = clampZoom(zoom);
  // Use the webview's native zoom (WebKitGTK `zoom_level` / WebView2 ZoomFactor)
  // rather than a CSS `zoom` on the root: CSS zoom does not scale
  // `position: fixed` / portaled overlays (menus, dropdowns, hover popovers) in
  // WebKitGTK, so those stayed at 100%. Native zoom scales the entire webview
  // uniformly, overlays included.
  void getCurrentWebview()
    .setZoom(z)
    .catch((err) => {
      console.warn("failed to apply UI zoom", err);
    });
}

interface SettingsStore {
  settings: Settings | null;
  loaded: boolean;
  load: () => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  saveWindowState: (ws: WindowState) => Promise<void>;
  /** Set (or clear, with "") the Python Run/Debug args for one file, keyed by its
   *  absolute path. Kept per file so every viewer of the same script shares them;
   *  persisted in settings.json so they survive a restart (see Settings.python_run_args). */
  setPythonRunArgs: (path: string, args: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: null,
  loaded: false,

  load: async () => {
    const settings = await invoke<Settings>("get_settings");
    applyTheme(settings.color_scheme ?? "light_lavender");
    applyZoom(settings.ui_zoom);
    set({ settings, loaded: true });
  },

  setTheme: async (theme) => {
    const current = get().settings ?? {};
    const updated = { ...current, color_scheme: theme };
    await invoke<void>("save_settings", { settings: updated });
    applyTheme(theme);
    set({ settings: updated as Settings });
  },

  updateSettings: async (patch) => {
    const current = get().settings ?? {};
    const updated = { ...current, ...patch };
    await invoke<void>("save_settings", { settings: updated });
    if (typeof updated.color_scheme === "string") {
      applyTheme(updated.color_scheme);
    }
    if ("ui_zoom" in patch) {
      applyZoom(updated.ui_zoom);
    }
    set({ settings: updated as Settings });
  },

  // Persist the main window's geometry through its OWN command rather than
  // `updateSettings`. This fires on a debounce every time the user drags or
  // resizes the window, and `updateSettings` writes the *whole* settings object
  // back from this cache — so routing it there would rewrite the entire settings
  // file on every window nudge and clobber anything changed elsewhere meanwhile.
  // `save_window_state` read-modify-writes the single field on disk.
  //
  // The local cache is still updated, for two reasons: the debounced save diffs
  // against it to skip no-op writes, and a later `updateSettings` spreads this
  // cache — a stale `window_state` here would be written straight back over the
  // fresh one on disk.
  saveWindowState: async (ws) => {
    const current = get().settings;
    if (!current) return;
    set({ settings: { ...current, window_state: ws } });
    try {
      await invoke<void>("save_window_state", { state: ws });
    } catch (err) {
      console.warn("failed to save window state", err);
    }
  },

  setPythonRunArgs: async (path, args) => {
    const current = get().settings ?? {};
    const map = { ...(current.python_run_args ?? {}) };
    const trimmed = args.trim();
    // "" clears the entry outright rather than storing an empty string, so the map
    // holds only files that actually have args (and reading back a cleared file
    // yields undefined → "", identical to never having set it).
    if (trimmed) map[path] = trimmed;
    else delete map[path];
    // No-op if nothing changed, so re-committing identical args (e.g. the popover's
    // outside-click after a run) doesn't rewrite the whole settings file.
    if ((current.python_run_args ?? {})[path] === map[path]) return;
    await get().updateSettings({ python_run_args: map });
  },
}));
