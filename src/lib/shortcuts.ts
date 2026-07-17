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
 * in `useKeyboard` — so only the eight navigation actions live here.
 */
import { IS_MAC } from "./platform";

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
  | "closeAllTabs";

export interface ShortcutDef {
  action: ShortcutAction;
  label: string;
  /** The built-in default chord, used whenever the user hasn't rebound it. */
  default: ChordDescriptor;
}

/**
 * The configurable action table, in display order. The defaults mirror the
 * historical hard-coded chords in `useKeyboard` so behaviour is unchanged when
 * `keyboard_shortcuts` is empty.
 */
export const SHORTCUT_DEFS: ShortcutDef[] = [
  {
    action: "toggleFullscreen",
    label: "Toggle subwindow fullscreen",
    default: { key: "Enter", ctrl: true },
  },
  {
    action: "cycleProject",
    label: "Cycle to next project",
    default: { key: "Tab", ctrl: true, shift: true },
  },
  {
    action: "prevTab",
    label: "Previous tab in subwindow",
    default: { key: "ArrowLeft", shift: true },
  },
  {
    action: "nextTab",
    label: "Next tab in subwindow",
    default: { key: "ArrowRight", shift: true },
  },
  {
    action: "subwindowUp",
    label: "Cycle focused subwindow up",
    default: { key: "ArrowUp", shift: true },
  },
  {
    action: "subwindowDown",
    label: "Cycle focused subwindow down",
    default: { key: "ArrowDown", shift: true },
  },
  {
    action: "cycleTabs",
    label: "Cycle tabs in subwindow",
    default: { key: "Tab", shift: true },
  },
  {
    action: "hideSubwindow",
    label: "Hide focused subwindow",
    default: { key: "h", ctrl: true, shift: true },
  },
  {
    action: "toggleSubwindowFiles",
    label: "Toggle subwindow file viewer",
    default: { key: "f", shift: true },
  },
  {
    action: "closeSubwindow",
    label: "Close focused subwindow",
    default: { key: "w", ctrl: true, shift: true },
  },
  {
    action: "closeTab",
    label: "Close active tab",
    default: { key: "w", ctrl: true },
  },
  {
    action: "closeAllTabs",
    label: "Close all tabs in project",
    default: { key: "w", ctrl: true, shift: true, alt: true },
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
