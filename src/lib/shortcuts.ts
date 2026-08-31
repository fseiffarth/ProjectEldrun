/**
 * #62 / Group L — shared keyboard-shortcut model.
 *
 * One source of truth for the rebindable navigation chords. Both
 * `useKeyboard.ts` (which acts on them) and the settings panel (which lets the
 * user customise them) import from here, so the default table and the matching
 * logic never drift.
 *
 * A chord is a plain, serializable descriptor (`ChordDescriptor`) stored in
 * `settings.keyboard_shortcuts` keyed by action id. F11 (OS fullscreen) and
 * Escape (exit fullscreen) are deliberately *not* rebindable — they stay fixed
 * in `useKeyboard` — so only the rebindable actions live here (`FIXED_KEYS`
 * below is their display-only description table).
 *
 * `STEERING_KEYS` (bottom) is the sibling table for the FIXED keys inside
 * keyboard steering mode: those aren't chords and aren't rebindable, but every
 * surface that explains them (legend overlay, help, lessons) renders from it.
 */
import { IS_MAC, PLATFORM } from "./platform";
import type { TranslationKey } from "./i18n";

/** A serializable key chord. `key` is a `KeyboardEvent.key` value, normalized:
 *  single letters are lower-cased, named keys ("Tab", "Enter", "ArrowLeft")
 *  are kept verbatim. Modifier booleans default to false when absent. */
export interface ChordDescriptor {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/** Stable ids for each rebindable navigation action. */
export type ShortcutAction =
  | "toggleFullscreen"
  | "cycleProject"
  | "prevTab"
  | "nextTab"
  | "subwindowUp"
  | "subwindowDown"
  | "cycleTabs"
  | "hideSubwindow"
  | "toggleSubwindowFiles"
  | "closeSubwindow"
  | "closeTab"
  | "closeAllTabs"
  | "steeringMode"
  | "cycleProjectBack"
  | "shortcutHelp";

/** Section ids for the cheat-sheet/settings grouping (`SHORTCUT_GROUPS`). */
export type ShortcutGroup = "navigation" | "tabs" | "steering";

export interface ShortcutDef {
  action: ShortcutAction;
  label: string;
  /** Which `SHORTCUT_GROUPS` section the action is listed under. */
  group: ShortcutGroup;
  /** The built-in default chord, used whenever the user hasn't rebound it. */
  default: ChordDescriptor;
  /** Renders the shared `UntestedTag` pill beside the row in the settings
   *  panel; removed per action once the user confirms it live. */
  untested?: boolean;
}

/** The cheat sheet's section order + i18n titles — kept here beside the defs
 *  so a new action must pick its section where the table lives. */
export const SHORTCUT_GROUPS: { id: ShortcutGroup; labelKey: TranslationKey }[] = [
  { id: "navigation", labelKey: "shortcutHelp.group.navigation" },
  { id: "tabs", labelKey: "shortcutHelp.group.tabs" },
  { id: "steering", labelKey: "shortcutHelp.group.steering" },
];

/**
 * The configurable action table, in display order. The defaults mirror the
 * historical hard-coded chords in `useKeyboard` so behaviour is unchanged when
 * `keyboard_shortcuts` is empty.
 */
export const SHORTCUT_DEFS: ShortcutDef[] = [
  {
    action: "toggleFullscreen",
    label: "Toggle subwindow fullscreen",
    group: "tabs",
    default: { key: "Enter", ctrl: true },
  },
  {
    action: "cycleProject",
    label: "Cycle to next project",
    group: "navigation",
    default: { key: "Tab", ctrl: true, shift: true },
  },
  {
    action: "prevTab",
    label: "Previous tab in subwindow",
    group: "tabs",
    default: { key: "ArrowLeft", shift: true },
  },
  {
    action: "nextTab",
    label: "Next tab in subwindow",
    group: "tabs",
    default: { key: "ArrowRight", shift: true },
  },
  {
    action: "subwindowUp",
    label: "Cycle focused subwindow up",
    group: "navigation",
    default: { key: "ArrowUp", shift: true },
  },
  {
    action: "subwindowDown",
    label: "Cycle focused subwindow down",
    group: "navigation",
    default: { key: "ArrowDown", shift: true },
  },
  {
    action: "cycleTabs",
    label: "Cycle tabs in subwindow",
    group: "tabs",
    default: { key: "Tab", shift: true },
  },
  {
    action: "hideSubwindow",
    label: "Hide focused subwindow",
    group: "tabs",
    default: { key: "h", ctrl: true, shift: true },
  },
  {
    action: "toggleSubwindowFiles",
    label: "Toggle subwindow file viewer",
    group: "tabs",
    default: { key: "f", shift: true },
  },
  {
    action: "closeSubwindow",
    label: "Close focused subwindow",
    group: "tabs",
    default: { key: "w", ctrl: true, shift: true },
  },
  {
    action: "closeTab",
    label: "Close active tab",
    group: "tabs",
    default: { key: "w", ctrl: true },
  },
  {
    action: "closeAllTabs",
    label: "Close all tabs in project",
    group: "tabs",
    default: { key: "w", ctrl: true, shift: true, alt: true },
  },
  // Keyboard steering mode (part 1 of the keyboard-only steering system). The
  // chord toggles the mode; the keys INSIDE it are fixed (see STEERING_KEYS).
  // Ctrl+Shift+Space collides with no default above and with no common
  // terminal chord (Ctrl+Space is emacs set-mark; the Shift keeps clear of it).
  {
    action: "steeringMode",
    label: "Enter keyboard steering mode",
    group: "steering",
    default: { key: " ", ctrl: true, shift: true },
    untested: true,
  },
  // Backward twin of cycleProject. Ctrl distinguishes it from prevTab's
  // Shift+← default.
  {
    action: "cycleProjectBack",
    label: "Cycle to previous project",
    group: "navigation",
    default: { key: "ArrowLeft", ctrl: true, shift: true },
    untested: true,
  },
  {
    action: "shortcutHelp",
    label: "Open shortcut help",
    group: "steering",
    default: { key: "F1" },
    untested: true,
  },
];

/** Lone modifier keys that must be ignored while capturing a chord. */
const MODIFIER_KEYS = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "Super",
  "OS",
  "AltGraph",
  "CapsLock",
]);

/** Normalize a `KeyboardEvent.key` for storage/comparison: single printable
 *  letters become lower-case so "W" and "w" match; everything else is kept. */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** True when the keystroke is only a modifier (Ctrl/Shift/Alt/Meta) — these
 *  must not be captured as a chord on their own. */
export function isLoneModifier(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

/**
 * Build a `ChordDescriptor` from a real `KeyboardEvent`. Returns `null` for a
 * lone-modifier keypress (caller should keep waiting for a real key). Used by
 * the settings panel's capture input.
 */
export function chordFromEvent(e: KeyboardEvent): ChordDescriptor | null {
  if (isLoneModifier(e.key)) return null;
  const chord: ChordDescriptor = { key: normalizeKey(e.key) };
  if (e.ctrlKey) chord.ctrl = true;
  if (e.shiftKey) chord.shift = true;
  if (e.altKey) chord.alt = true;
  if (e.metaKey) chord.meta = true;
  return chord;
}

/**
 * True when `e` matches `chord` (key normalized).
 *
 * Primary-modifier handling (macOS): the platform-primary modifier is Cmd
 * (metaKey) on macOS and Ctrl elsewhere. The default chord table encodes the
 * primary modifier as `ctrl` (its historical Linux/Windows shape). Rather than
 * fork the whole table, on macOS we treat a chord's primary-modifier
 * requirement — whether it was stored as `ctrl` (a default) or `meta` (a mac
 * user's captured rebind) — as satisfied by EITHER Cmd or Ctrl. So both Cmd+W
 * and Ctrl+W fire on a mac, while a plain key still rejects a stray Cmd press.
 * This collapses ⌘/⌃ into one "primary" on macOS (you can't bind a mac-only
 * Control-vs-Command distinction) — the deliberate, low-risk trade-off the task
 * calls for. Off macOS, modifiers are matched exactly as before.
 */
export function chordMatches(chord: ChordDescriptor, e: KeyboardEvent): boolean {
  if (normalizeKey(e.key) !== normalizeKey(chord.key)) return false;
  if (e.shiftKey !== !!chord.shift) return false;
  if (e.altKey !== !!chord.alt) return false;
  if (IS_MAC) {
    const wantsPrimary = !!chord.ctrl || !!chord.meta;
    const hasPrimary = e.ctrlKey || e.metaKey;
    return wantsPrimary === hasPrimary;
  }
  return e.ctrlKey === !!chord.ctrl && e.metaKey === !!chord.meta;
}

/** Human-readable label for a chord, e.g. "Shift+Ctrl+Tab" — or native mac
 *  glyphs ("⇧⌘Tab") on macOS. On macOS the primary modifier (stored as `ctrl`)
 *  and `meta`/Super both render as ⌘ (deduped), matching what a mac user
 *  actually presses; off macOS the textual labels are unchanged. */
export function chordLabel(chord: ChordDescriptor): string {
  if (IS_MAC) {
    const parts: string[] = [];
    if (chord.alt) parts.push("⌥"); // Option
    if (chord.shift) parts.push("⇧"); // Shift
    if (chord.ctrl || chord.meta) parts.push("⌘"); // primary modifier / Super
    parts.push(prettyKey(chord.key));
    return parts.join(""); // mac convention concatenates the glyphs
  }
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.shift) parts.push("Shift");
  if (chord.alt) parts.push("Alt");
  if (chord.meta) parts.push("Super");
  parts.push(prettyKey(chord.key));
  return parts.join("+");
}

function prettyKey(key: string): string {
  const map: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    " ": "Space",
  };
  if (map[key]) return map[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

/** The stored shortcut map (action id → chord). Partial: any unset action
 *  falls back to its default. Mirrors `Settings["keyboard_shortcuts"]`. */
export type ShortcutMap = Partial<Record<ShortcutAction, ChordDescriptor>>;

/**
 * Resolve the effective chord for an action: the user override if present,
 * otherwise the built-in default. Central so `useKeyboard` and the panel agree.
 */
export function resolveChord(
  action: ShortcutAction,
  overrides: ShortcutMap | undefined | null,
): ChordDescriptor {
  const custom = overrides?.[action];
  if (custom) return custom;
  return SHORTCUT_DEFS.find((d) => d.action === action)!.default;
}

/** True when two chords are the same effective keystroke: key normalized via
 *  `normalizeKey`, modifier booleans coerced with `!!` so an absent flag
 *  equals an explicit `false`. */
export function chordsEqual(a: ChordDescriptor, b: ChordDescriptor): boolean {
  return (
    normalizeKey(a.key) === normalizeKey(b.key) &&
    !!a.ctrl === !!b.ctrl &&
    !!a.shift === !!b.shift &&
    !!a.alt === !!b.alt &&
    !!a.meta === !!b.meta
  );
}

/**
 * Which actions collide: every action whose *effective* chord (override or
 * default, via `resolveChord`) equals another action's, mapped to the actions
 * sharing its chord. Both sides of a collision get an entry so the settings
 * panel can warn on each row; an action with a unique chord is absent. Pure so
 * the panel stays thin and so a unit test can guard the pristine default table
 * (no two defaults may ever collide).
 */
export function findConflicts(
  overrides: ShortcutMap | undefined | null,
): Map<ShortcutAction, ShortcutAction[]> {
  const out = new Map<ShortcutAction, ShortcutAction[]>();
  for (let i = 0; i < SHORTCUT_DEFS.length; i++) {
    for (let j = i + 1; j < SHORTCUT_DEFS.length; j++) {
      const a = SHORTCUT_DEFS[i].action;
      const b = SHORTCUT_DEFS[j].action;
      if (!chordsEqual(resolveChord(a, overrides), resolveChord(b, overrides))) continue;
      out.set(a, [...(out.get(a) ?? []), b]);
      out.set(b, [...(out.get(b) ?? []), a]);
    }
  }
  return out;
}

/**
 * True when a chord can never fire because `useKeyboard` consumes its key
 * before the rebindable table is consulted: F11 (OS fullscreen), F9 (panel
 * toggle) and Escape (exit fullscreen / dismiss) are all matched there on
 * `e.key` alone, so no modifier rescues such a chord. Deliberately independent
 * of `FIXED_KEYS`, which stores display strings. Not covered on purpose: a
 * lone Super/Meta never reaches capture (`chordFromEvent` returns null), and
 * the zoom chords match on `e.code` (keyboard-layout dependent), which a
 * stored `key` cannot reproduce faithfully.
 */
export function isFixedChord(chord: ChordDescriptor): boolean {
  const key = normalizeKey(chord.key);
  return key === "F11" || key === "F9" || key === "Escape";
}

/** One fixed key (or key family) inside steering mode. `keys` is display text
 *  (already glyphs, never translated); the two i18n keys carry the short
 *  legend label and the longer help/lesson description. */
export interface SteeringKeyDef {
  keys: string;
  labelKey: TranslationKey;
  descKey: TranslationKey;
}

/** One fixed, non-rebindable key handled directly in `useKeyboard`. Same shape
 *  as `SteeringKeyDef`: display keys plus i18n label/description keys. */
export interface FixedKeyDef {
  keys: string;
  labelKey: TranslationKey;
  descKey: TranslationKey;
}

/**
 * The fixed (non-rebindable) keys `useKeyboard` handles outside the chord
 * table, in display order — rendered by the cheat sheet and reusable by the
 * settings panel and lessons. Platform-resolved at module load: the panel
 * toggle is the lone Super key only on Linux (on macOS Cmd is the chord
 * modifier, on Windows the Win key belongs to the OS), F9 elsewhere; the zoom
 * chords ride the primary modifier (⌘ on macOS).
 */
export const FIXED_KEYS: FixedKeyDef[] = [
  {
    keys: "F11",
    labelKey: "fixedKeys.osFullscreen.label",
    descKey: "fixedKeys.osFullscreen.desc",
  },
  {
    keys: PLATFORM === "linux" ? "Super" : "F9",
    labelKey: "fixedKeys.panels.label",
    descKey: "fixedKeys.panels.desc",
  },
  {
    keys: "Esc",
    labelKey: "fixedKeys.exitFullscreen.label",
    descKey: "fixedKeys.exitFullscreen.desc",
  },
  {
    keys: IS_MAC ? "⌘ + / − / 0" : "Ctrl + / − / 0",
    labelKey: "fixedKeys.zoom.label",
    descKey: "fixedKeys.zoom.desc",
  },
];

/**
 * The FIXED in-steering-mode keys, in display order — the one source of truth
 * for the legend overlay, the shortcut cheat sheet, and any lesson surface.
 * `useKeyboard`'s steering handler is the acting counterpart; the two must
 * stay in step. Digit mapping: 1 = root scope, 2 = the first project pill
 * (display order) — the same ring `cycleProject` walks.
 */
export const STEERING_KEYS: SteeringKeyDef[] = [
  { keys: "1–9", labelKey: "steering.jump.label", descKey: "steering.jump.desc" },
  { keys: "↑ ↓ ← →", labelKey: "steering.focus.label", descKey: "steering.focus.desc" },
  { keys: "Tab / Shift+Tab", labelKey: "steering.tabs.label", descKey: "steering.tabs.desc" },
  { keys: "F", labelKey: "steering.files.label", descKey: "steering.files.desc" },
  { keys: "P", labelKey: "steering.panels.label", descKey: "steering.panels.desc" },
  { keys: "W", labelKey: "steering.closeTab.label", descKey: "steering.closeTab.desc" },
  { keys: "S", labelKey: "steering.settings.label", descKey: "steering.settings.desc" },
  { keys: "?", labelKey: "steering.help.label", descKey: "steering.help.desc" },
  { keys: "Esc / Enter", labelKey: "steering.exit.label", descKey: "steering.exit.desc" },
];
