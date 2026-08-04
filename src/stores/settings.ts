import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { emit } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { Settings, Theme, WindowState } from "../types";
import { applyLanguage, type Language } from "../lib/i18n";
import { mergeVerdicts, verdictsUnchanged, type PyMainCache } from "../lib/pythonMainCache";

/** Each Tauri window is its own JS runtime with its own copy of this store, so
 *  a theme change made in one (normally the main window's Settings dialog)
 *  only calls `applyTheme` on that window's own `document` — a detached/popped-
 *  out subwindow (`DetachedApp`) keeps whatever theme it loaded at open time.
 *  Broadcast the new scheme so every live window can re-apply it; see the
 *  listener in `DetachedApp`. */
export const THEME_CHANGED_EVENT = "eldrun:theme-changed";

/** Like THEME_CHANGED_EVENT, but for the UI language: broadcast so every live
 *  window (including detached popouts, which each hold their own i18n store)
 *  re-applies the new language. See the listener in `DetachedApp`. */
export const LANGUAGE_CHANGED_EVENT = "eldrun:language-changed";

export function applyTheme(scheme: string) {
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

/** UI zoom (4K-monitor scaling). `1` is 100% (the current/default look); higher
 *  enlarges the whole interface, lower shrinks it. Applied via the webview's
 *  native zoom so every layer scales — including `position: fixed` / portaled
 *  overlays (menus, dropdowns, hover popovers) that a CSS `zoom` misses on
 *  WebKitGTK.
 *
 *  Zoom is **per window**, not global: each OS window (the main window and every
 *  detached popout, #42) is its own webview and holds its own zoom. `ui_zoom`
 *  persists the MAIN window's value; a popout persists its own alongside its
 *  bounds (see `DetachedGroup.zoom`). So bumping one window's zoom never rescales
 *  another, and each window restores at the zoom it was left at. */
export const MIN_UI_ZOOM = 0.5;
export const MAX_UI_ZOOM = 3;

/** The zoom ladder shared by the Settings dropdown and the Ctrl +/- keyboard
 *  steps, so both surfaces move through the same stops. */
export const ZOOM_STEPS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function clampZoom(z: number | undefined | null): number {
  if (typeof z !== "number" || !Number.isFinite(z)) return 1;
  return Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, z));
}

/** Next zoom stop up (`dir > 0`) or down (`dir < 0`) from `current` on the
 *  `ZOOM_STEPS` ladder, for the Ctrl +/- keyboard shortcuts. Clamped to the ends. */
export function stepZoom(current: number | undefined, dir: 1 | -1): number {
  const cur = clampZoom(current);
  if (dir > 0) {
    const up = ZOOM_STEPS.find((z) => z > cur + 1e-6);
    return up ?? MAX_UI_ZOOM;
  }
  const down = [...ZOOM_STEPS].reverse().find((z) => z < cur - 1e-6);
  return down ?? MIN_UI_ZOOM;
}

/** Apply a zoom to THIS window's webview (native WebKitGTK `zoom_level` /
 *  WebView2 ZoomFactor). Exported so a detached popout can drive its OWN zoom
 *  (the popout skips the global apply in `load` and owns its value; see
 *  DetachedApp). CSS `zoom` on the root is deliberately not used: it does not
 *  scale `position: fixed` / portaled overlays in WebKitGTK, so those stayed at
 *  100%. Native zoom scales the entire webview uniformly, overlays included. */
export function applyZoom(zoom: number | undefined) {
  const z = clampZoom(zoom);
  void getCurrentWebview()
    .setZoom(z)
    .catch((err) => {
      console.warn("failed to apply UI zoom", err);
    });
}

interface SettingsStore {
  settings: Settings | null;
  loaded: boolean;
  /** Load settings and apply theme. `skipZoom` suppresses applying the persisted
   *  `ui_zoom` to this window's webview — used by a detached popout, which owns
   *  its OWN zoom (restored from its seed) rather than the main window's. */
  load: (opts?: { skipZoom?: boolean }) => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
  setLanguage: (lang: Language) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  saveWindowState: (ws: WindowState) => Promise<void>;
  /** Set (or clear, with "") the Python Run/Debug args for one file, keyed by its
   *  absolute path. Kept per file so every viewer of the same script shares them;
   *  persisted in settings.json so they survive a restart (see Settings.python_run_args). */
  setPythonRunArgs: (path: string, args: string) => Promise<void>;
  /** Fold a batch of `.py` "is this a script" verdicts into the persisted cache
   *  that gates the tree's ▶ (see `lib/pythonMainCache`). Batched — one settings
   *  write per folder scan, not one per file — and a no-op when every verdict
   *  already matches, so re-listing an unchanged folder writes nothing. */
  setPythonMainVerdicts: (updates: PyMainCache) => Promise<void>;
}

/**
 * Resolve once settings have loaded — or after `timeoutMs`, whichever comes first.
 *
 * Every gate that decides whether Eldrun may reach a host **without a gesture**
 * reads settings (`lib/hpcHost`'s `mayAutoTouch`, `machines_enabled`) and every one
 * of them fails closed on an unloaded store. That is the right default, and its
 * consequence is that the launch sweeps must *wait* rather than fire into the gap:
 * `AppShell` starts this load in parallel with the projects load, so the answer is
 * milliseconds away, and firing first would either skip a project that is perfectly
 * eligible or — before the gates existed — dial a tagged cluster.
 *
 * It waits; it never loads. A second `get_settings` from a background caller would
 * re-apply the theme and this window's zoom as a side effect. On timeout the caller
 * proceeds against an unloaded store, i.e. every gate answers "no" — the failure
 * mode is "nothing connected", never "something connected blind".
 */
export function whenSettingsLoaded(timeoutMs = 5000): Promise<void> {
  if (useSettingsStore.getState().loaded) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const unsubscribe = useSettingsStore.subscribe((s) => {
      if (s.loaded) finish();
    });
  });
}

/**
 * The object a write must merge its patch onto — **never `{}`**.
 *
 * Every writer here is a read-modify-write of the WHOLE settings object
 * (`save_settings` replaces the file; only `save_window_state` touches a single
 * field). They all used to spread `get().settings ?? {}`, and that `?? {}` is a
 * silent factory reset: `settings` is null until `load()` resolves, so a write
 * that lands before then persists the patch ALONE and every key not mentioned in
 * it — the theme, the header's CPU/RAM/GPU toggles, the Ollama host, every
 * opt-in — is dropped from settings.json.
 *
 * That is not hypothetical and it is not rare. It happened on 2026-08-03: a hot
 * reload of a half-saved file threw a ReferenceError during render, the mount
 * that calls `load()` never completed, a background writer fired anyway, and the
 * user's settings came back with six keys. The trigger was a one-line typo in an
 * unrelated component — the damage was this line.
 *
 * So: re-read from disk instead of assuming empty, and if even that fails, let
 * the write REJECT. A settings change that reports an error is a nuisance; a
 * settings change that quietly erases everything else is unrecoverable — there
 * is no undo and no backup of this file.
 */
async function baseForWrite(): Promise<Partial<Settings>> {
  const cached = useSettingsStore.getState().settings;
  if (cached) return cached;
  // Deliberately not `load()`: that re-applies the theme, language and this
  // window's zoom as a side effect, which a background writer must not do.
  const fresh = await invoke<Settings>("get_settings");
  useSettingsStore.setState({ settings: fresh, loaded: true });
  return fresh;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: null,
  loaded: false,

  load: async (opts) => {
    const settings = await invoke<Settings>("get_settings");
    applyTheme(settings.color_scheme ?? "fancy_dark");
    applyLanguage(settings.language);
    // `ui_zoom` is the MAIN window's own zoom. A popout skips it and applies its
    // own persisted zoom from its seed instead (zoom is per window, not global).
    if (!opts?.skipZoom) applyZoom(settings.ui_zoom);
    set({ settings, loaded: true });
  },

  setTheme: async (theme) => {
    const current = await baseForWrite();
    const updated = { ...current, color_scheme: theme };
    await invoke<void>("save_settings", { settings: updated });
    applyTheme(theme);
    void emit(THEME_CHANGED_EVENT, theme);
    set({ settings: updated as Settings });
  },

  setLanguage: async (lang) => {
    const current = await baseForWrite();
    const updated = { ...current, language: lang };
    await invoke<void>("save_settings", { settings: updated });
    applyLanguage(lang);
    void emit(LANGUAGE_CHANGED_EVENT, lang);
    set({ settings: updated as Settings });
  },

  updateSettings: async (patch) => {
    const current = await baseForWrite();
    const updated = { ...current, ...patch };
    await invoke<void>("save_settings", { settings: updated });
    if (typeof updated.color_scheme === "string") {
      applyTheme(updated.color_scheme);
      if ("color_scheme" in patch) {
        void emit(THEME_CHANGED_EVENT, updated.color_scheme);
      }
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
    // Same rule as the writers above, for the same reason one step removed: this
    // reads the CURRENT map to build the patch, so an unloaded store would hand
    // `updateSettings` a map missing every other file's args — a partial wipe of
    // one key rather than the whole file, but a wipe.
    const current = await baseForWrite();
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

  setPythonMainVerdicts: async (updates) => {
    const current = await baseForWrite();
    if (verdictsUnchanged(current.python_main_scripts, updates)) return;
    await get().updateSettings({
      python_main_scripts: mergeVerdicts(current.python_main_scripts, updates),
    });
  },
}));
