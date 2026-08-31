import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { emit } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  THEMES,
  type Settings,
  type Theme,
  type ThemePreset,
  type WindowState,
} from "../types";
import { applyLanguage, type Language } from "../lib/i18n";
import { mergeVerdicts, verdictsUnchanged, type PyMainCache } from "../lib/pythonMainCache";
import { THEME_COLOR_RE, THEME_VAR_NAMES } from "../lib/themeTokens";

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

/** The "system" pseudo-theme resolved to a real one via the OS light/dark
 *  preference. It exists only in settings and the picker — the CSS knows
 *  nothing about it, so it must never reach `data-theme` unresolved (an
 *  unknown value there silently falls back to the :root fancy_dark tokens
 *  while claiming to be something else). */
export function resolveTheme(scheme: string): string {
  if (scheme !== "system") return scheme;
  try {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches
      ? "fancy_light"
      : "fancy_dark";
  } catch {
    return "fancy_dark";
  }
}

/** Re-applies "system" when the OS scheme flips while the app is open. Armed
 *  only while the stored scheme IS "system"; module-level because applyTheme
 *  is a plain function each window calls, and two live listeners would both
 *  re-apply — harmless but pointless. */
let systemThemeMedia: MediaQueryList | null = null;
let systemThemeOnChange: (() => void) | null = null;

function armSystemThemeListener(scheme: string) {
  if (scheme === "system") {
    if (systemThemeOnChange) return;
    try {
      const media = window.matchMedia?.("(prefers-color-scheme: light)");
      if (!media?.addEventListener) return;
      systemThemeMedia = media;
      systemThemeOnChange = () => applyTheme("system");
      media.addEventListener("change", systemThemeOnChange);
    } catch {
      // No matchMedia (tests) — "system" then just means fancy_dark.
    }
  } else if (systemThemeMedia && systemThemeOnChange) {
    systemThemeMedia.removeEventListener("change", systemThemeOnChange);
    systemThemeMedia = null;
    systemThemeOnChange = null;
  }
}

export function applyTheme(scheme: string) {
  const resolved = resolveTheme(scheme);
  document.documentElement.setAttribute("data-theme", resolved);
  armSystemThemeListener(scheme);
  // Cache for index.html's pre-paint inline script, so the next launch
  // paints the right theme immediately instead of flashing the CSS
  // :root default until settings arrive over the async invoke. The RESOLVED
  // theme is cached, never "system" — the pre-paint script sets data-theme
  // verbatim and cannot resolve. If the OS scheme flipped while the app was
  // closed, the pre-paint is one frame behind and load() corrects it.
  try {
    localStorage.setItem("eldrun-theme", resolved);
  } catch {
    // localStorage unavailable — worst case is the old one-frame flash.
  }
}

/** Like THEME_CHANGED_EVENT, for the appearance overrides (accent color,
 *  corner style, per-token theme colors): broadcast so every live window
 *  re-applies them. Payload is the full set — a popout cannot know which part
 *  changed. */
export const APPEARANCE_CHANGED_EVENT = "eldrun:appearance-changed";

export interface AppearancePayload {
  accent: string | null;
  corners: string | null;
  /** Absent from an older window's payload; treated as "no overrides". */
  themeVars?: Record<string, string>;
}

/** A user accent must be a full hex color — anything else (an empty string, a
 *  named color, a truncated paste) is treated as "no override" rather than
 *  written into the root style, where an invalid value would silently drop
 *  every rule reading it. */
export function normalizeAccent(accent: string | null | undefined): string | null {
  return typeof accent === "string" && /^#[0-9a-fA-F]{6}$/.test(accent.trim())
    ? accent.trim().toLowerCase()
    : null;
}

/** The tokens a custom accent overrides INLINE alongside `--accent`. The tinted
 *  themes would not need them (their hover/active/pill tokens already derive
 *  from `--accent` in themes.css), but the achromatic pair declares explicit
 *  literals for all five — their accent is the ink — which would keep painting
 *  the old tone under a custom accent. The inline values restate the SAME
 *  derivations themes.css runs, so a custom accent behaves exactly like a
 *  theme's own on every theme. */
const ACCENT_DERIVED: ReadonlyArray<readonly [string, string]> = [
  ["--accent-hover", "color-mix(in srgb, var(--accent) 84%, var(--text-primary))"],
  ["--accent-active", "color-mix(in srgb, var(--accent) 70%, var(--text-primary))"],
  ["--pill-active-bg", "color-mix(in srgb, var(--accent) 16%, transparent)"],
  ["--pill-active-border", "var(--accent)"],
  ["--pill-hover-bg", "color-mix(in srgb, var(--accent) 12%, transparent)"],
];

/** Apply (or with null/undefined, clear) the custom accent on THIS window's
 *  root element. Inline root vars outrank every `[data-theme]` block, so the
 *  override survives theme switching — it is a cross-theme preference. */
export function applyAccent(accent: string | null | undefined) {
  const root = document.documentElement.style;
  const value = normalizeAccent(accent);
  if (value) {
    root.setProperty("--accent", value);
    for (const [name, formula] of ACCENT_DERIVED) root.setProperty(name, formula);
  } else {
    root.removeProperty("--accent");
    for (const [name] of ACCENT_DERIVED) root.removeProperty(name);
  }
  // Pre-paint cache, applyTheme's bargain: index.html re-applies this before
  // first paint so launch doesn't flash the theme accent and then snap.
  try {
    if (value) localStorage.setItem("eldrun-accent", value);
    else localStorage.removeItem("eldrun-accent");
  } catch {
    // localStorage unavailable — worst case is a one-frame accent flash.
  }
}

/** Keep only what may safely reach the root style: a catalog token name
 *  (`lib/themeTokens`) holding a `#rrggbb`/`#rrggbbaa` color. `ui_theme_vars`
 *  is written as INLINE CUSTOM PROPERTIES, so an unvalidated pair from a
 *  hand-edited settings.json would be an arbitrary-CSS-variable write; and an
 *  invalid *value* is worse than none, since every rule reading that token
 *  silently drops (the reason `normalizeAccent` above exists). `--accent` is
 *  rejected on purpose: it has its own setting, `ui_accent`. */
export function normalizeThemeVars(
  vars: Record<string, string> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!vars || typeof vars !== "object") return out;
  for (const [name, value] of Object.entries(vars)) {
    if (!THEME_VAR_NAMES.has(name)) continue;
    if (typeof value !== "string") continue;
    const v = value.trim().toLowerCase();
    if (THEME_COLOR_RE.test(v)) out[name] = v;
  }
  return out;
}

/** Apply the per-token color overrides on THIS window's root element.
 *
 *  Every catalog token is CLEARED first and only the overridden ones re-set:
 *  inline root vars outrank every `[data-theme]` block, so a token dropped
 *  from the map has to be removed explicitly or it would keep shadowing all
 *  themes forever — with no UI left pointing at it.
 *
 *  Applied AFTER `applyAccent` by every caller, so a hand-picked
 *  `--accent-hover` wins over the value `applyAccent` derives from the accent.
 *  That ordering is the whole contract between the two overrides. */
export function applyThemeVars(vars: Record<string, string> | null | undefined) {
  const root = document.documentElement.style;
  const clean = normalizeThemeVars(vars);
  for (const name of THEME_VAR_NAMES) {
    const value = clean[name];
    if (value) root.setProperty(name, value);
    else root.removeProperty(name);
  }
  // Pre-paint cache, like the accent/corner ones: index.html re-applies these
  // before first paint so launch doesn't flash the theme's own palette.
  try {
    if (Object.keys(clean).length > 0) {
      localStorage.setItem("eldrun-theme-vars", JSON.stringify(clean));
    } else {
      localStorage.removeItem("eldrun-theme-vars");
    }
  } catch {
    // localStorage unavailable — worst case is a one-frame palette flash.
  }
}

/** How many saved looks `ui_theme_presets` may hold, and how long a name may
 *  be. Both are guards on a list that is written back whole on every settings
 *  save and rendered in one card — not a judgement about how many themes
 *  anybody needs. */
export const THEME_PRESET_LIMIT = 40;
export const THEME_PRESET_NAME_MAX = 60;

const THEME_VALUES = new Set<string>(THEMES.map((t) => t.value));

/** Keep only what may safely be loaded back onto the document. A preset is
 *  `ui_theme_vars` + `ui_accent` + `ui_corners` + a base theme travelling
 *  together, and loading one writes all four — so it gets the same treatment
 *  `normalizeThemeVars` gives the map on its own, plus an id and a name.
 *
 *  Everything is validated on READ rather than only on write: settings.json is
 *  hand-editable, and a preset sitting in it is inert until the moment somebody
 *  presses Load, at which point an unvalidated entry would be an
 *  arbitrary-CSS-variable write with a friendly button in front of it. */
export function normalizeThemePresets(
  presets: unknown,
): ThemePreset[] {
  if (!Array.isArray(presets)) return [];
  const out: ThemePreset[] = [];
  const seen = new Set<string>();
  for (const raw of presets) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id.trim() : "";
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const entry: ThemePreset = {
      id,
      name: name.slice(0, THEME_PRESET_NAME_MAX),
      vars: normalizeThemeVars(p.vars as Record<string, string> | undefined),
    };
    if (typeof p.theme === "string" && THEME_VALUES.has(p.theme)) {
      entry.theme = p.theme as Theme;
    }
    const accent = normalizeAccent(p.accent as string | undefined);
    if (accent) entry.accent = accent;
    if (p.corners === "square" || p.corners === "rounded") entry.corners = p.corners;
    if (typeof p.saved === "number" && Number.isFinite(p.saved)) entry.saved = p.saved;
    out.push(entry);
    if (out.length >= THEME_PRESET_LIMIT) break;
  }
  return out;
}

/** The radius ladders behind `Settings.ui_corners`. "rounded" matches
 *  soft_dark's own tokens, so the knob and that theme agree on what rounded
 *  means; "square" is the house default restated. */
export const CORNER_RADII: Record<"square" | "rounded", readonly [string, string, string]> = {
  square: ["0px", "0px", "0px"],
  rounded: ["4px", "8px", "12px"],
};

/** Apply (or with null/undefined/unknown, clear) the corner-style override on
 *  THIS window's root element — the three radius tokens every surface reads. */
export function applyCorners(corners: string | null | undefined) {
  const root = document.documentElement.style;
  const radii =
    corners === "square" || corners === "rounded" ? CORNER_RADII[corners] : null;
  if (radii) {
    root.setProperty("--radius-sm", radii[0]);
    root.setProperty("--radius", radii[1]);
    root.setProperty("--radius-lg", radii[2]);
  } else {
    root.removeProperty("--radius-sm");
    root.removeProperty("--radius");
    root.removeProperty("--radius-lg");
  }
  try {
    if (radii && (corners === "square" || corners === "rounded")) {
      localStorage.setItem("eldrun-corners", corners);
    } else {
      localStorage.removeItem("eldrun-corners");
    }
  } catch {
    // localStorage unavailable — worst case is a one-frame corner flash.
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
    applyAccent(settings.ui_accent);
    applyThemeVars(settings.ui_theme_vars);
    applyCorners(settings.ui_corners);
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
    if ("ui_accent" in patch || "ui_corners" in patch || "ui_theme_vars" in patch) {
      applyAccent(updated.ui_accent);
      // After the accent: a hand-picked token beats the accent's derivation.
      applyThemeVars(updated.ui_theme_vars);
      applyCorners(updated.ui_corners);
      const payload: AppearancePayload = {
        accent: updated.ui_accent ?? null,
        corners: updated.ui_corners ?? null,
        themeVars: normalizeThemeVars(updated.ui_theme_vars),
      };
      void emit(APPEARANCE_CHANGED_EVENT, payload);
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
