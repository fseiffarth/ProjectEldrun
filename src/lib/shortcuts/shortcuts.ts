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
import { IS_MAC, PLATFORM } from "../platform";
import type { UntestedId } from "../untested";
import { desktopOwnsSuperKey } from "./superKey";
import { zoomChord } from "./zoomChord";
import type { TranslationKey } from "../i18n";

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
  | "reopenClosedTab"
  | "steeringMode"
  | "cycleProjectBack"
  | "cycleBox"
  | "cycleBoxBack"
  | "shortcutHelp"
  | "rootConsole"
  | "projectShell"
  | "newShellTab"
  | "newMonitorTab"
  | AgentTabAction
  | "texUp"
  | "texBack"
  | "texCompile";

/** The agent-tab chords, one per slot of the + menu's numbered agents
 *  (`agentShortcutSlots`): slot 1 is the default agent, 2–9 the others. */
export const AGENT_TAB_ACTIONS = [
  "agentTab1",
  "agentTab2",
  "agentTab3",
  "agentTab4",
  "agentTab5",
  "agentTab6",
  "agentTab7",
  "agentTab8",
  "agentTab9",
] as const;
export type AgentTabAction = (typeof AGENT_TAB_ACTIONS)[number];

/** Section ids for the cheat-sheet/settings grouping (`SHORTCUT_GROUPS`). */
export type ShortcutGroup = "navigation" | "tabs" | "newTab" | "steering" | "tex";

export interface ShortcutDef {
  action: ShortcutAction;
  /** i18n key for the row's description, resolved by the cheat sheet and the
   *  settings panel — the label itself lives in `lib/i18n` like every other
   *  user-facing string. */
  labelKey: TranslationKey;
  /** Which `SHORTCUT_GROUPS` section the action is listed under. */
  group: ShortcutGroup;
  /** The built-in default chord, used whenever the user hasn't rebound it. */
  default: ChordDescriptor;
  /** The pill's id in the untested register (`lib/untested`), which renders
   *  the shared `UntestedTag` beside the row in the settings panel; stamping
   *  that row `tested` retires the pill. */
  untested?: UntestedId;
}

/** The cheat sheet's section order + i18n titles — kept here beside the defs
 *  so a new action must pick its section where the table lives. */
export const SHORTCUT_GROUPS: { id: ShortcutGroup; labelKey: TranslationKey }[] = [
  { id: "navigation", labelKey: "shortcutHelp.group.navigation" },
  { id: "tabs", labelKey: "shortcutHelp.group.tabs" },
  { id: "newTab", labelKey: "shortcutHelp.group.newTab" },
  { id: "steering", labelKey: "shortcutHelp.group.steering" },
  { id: "tex", labelKey: "shortcutHelp.group.tex" },
];

/**
 * The configurable action table, in display order. The defaults mirror the
 * historical hard-coded chords in `useKeyboard` so behaviour is unchanged when
 * `keyboard_shortcuts` is empty.
 */
export const SHORTCUT_DEFS: ShortcutDef[] = [
  {
    action: "toggleFullscreen",
    labelKey: "shortcut.toggleFullscreen",
    group: "tabs",
    default: { key: "Enter", ctrl: true },
  },
  {
    action: "cycleProject",
    labelKey: "shortcut.cycleProject",
    group: "navigation",
    default: { key: "Tab", ctrl: true, shift: true },
  },
  // Ctrl+Shift, not plain Shift: a plain Shift+Arrow is an agent CLI's own
  // chord (Codex uses it for in-terminal selection/navigation), and a pane
  // terminal already hands prevTab/nextTab over via `terminalMayTakeChord` —
  // that handoff must not eat a chord the agent inside wants for itself.
  {
    action: "prevTab",
    labelKey: "shortcut.prevTab",
    group: "tabs",
    default: { key: "ArrowLeft", ctrl: true, shift: true },
    untested: "shortcut.prevTab",
  },
  {
    action: "nextTab",
    labelKey: "shortcut.nextTab",
    group: "tabs",
    default: { key: "ArrowRight", ctrl: true, shift: true },
    untested: "shortcut.nextTab",
  },
  {
    action: "subwindowUp",
    labelKey: "shortcut.subwindowUp",
    group: "navigation",
    default: { key: "ArrowUp", ctrl: true, shift: true },
  },
  {
    action: "subwindowDown",
    labelKey: "shortcut.subwindowDown",
    group: "navigation",
    default: { key: "ArrowDown", ctrl: true, shift: true },
  },
  {
    action: "cycleTabs",
    labelKey: "shortcut.cycleTabs",
    group: "tabs",
    default: { key: "Tab", shift: true },
  },
  {
    action: "hideSubwindow",
    labelKey: "shortcut.hideSubwindow",
    group: "tabs",
    default: { key: "h", ctrl: true, shift: true },
  },
  {
    action: "toggleSubwindowFiles",
    labelKey: "shortcut.toggleSubwindowFiles",
    group: "tabs",
    default: { key: "f", shift: true },
  },
  {
    action: "closeSubwindow",
    labelKey: "shortcut.closeSubwindow",
    group: "tabs",
    default: { key: "w", ctrl: true, shift: true },
  },
  {
    action: "closeTab",
    labelKey: "shortcut.closeTab",
    group: "tabs",
    default: { key: "w", ctrl: true },
  },
  {
    action: "closeAllTabs",
    labelKey: "shortcut.closeAllTabs",
    group: "tabs",
    default: { key: "w", ctrl: true, shift: true, alt: true },
  },
  // The browser's chord for the same act. Agent tabs only: they are the ones
  // whose closing loses something a restart would have brought back.
  {
    action: "reopenClosedTab",
    labelKey: "shortcut.reopenClosedTab",
    group: "tabs",
    default: { key: "t", ctrl: true, shift: true },
    untested: "shortcut.reopenClosedTab",
  },
  // Keyboard steering mode (part 1 of the keyboard-only steering system). The
  // chord toggles the mode; the keys INSIDE it are fixed (see STEERING_KEYS).
  // Shift+Space: one hand, collides with no default above, and terminals send
  // it as a plain space anyway. It types text, so `useKeyboard` ignores it in
  // the middle of a typing burst (a Shift still held from a capital).
  {
    action: "steeringMode",
    labelKey: "shortcut.steeringMode",
    group: "steering",
    default: { key: " ", shift: true },
    untested: "shortcut.steeringMode",
  },
  // Backward twin of cycleProject. Alt (not Ctrl) distinguishes it from
  // prevTab's Ctrl+Shift+← default.
  {
    action: "cycleProjectBack",
    labelKey: "shortcut.cycleProjectBack",
    group: "navigation",
    default: { key: "ArrowLeft", alt: true, shift: true },
    untested: "shortcut.cycleProjectBack",
  },
  // The boxes' twin of the project cycle: walk the box pills in the leading
  // segment (their row order) and open the next / previous box. Ctrl+Shift+
  // PageUp/Down is what tabbed terminals use to MOVE a tab, which an xterm.js
  // terminal in Eldrun has no use for, and it is no editor chord either.
  {
    action: "cycleBox",
    labelKey: "shortcut.cycleBox",
    group: "navigation",
    default: { key: "PageDown", ctrl: true, shift: true },
    untested: "shortcut.cycleBox",
  },
  {
    action: "cycleBoxBack",
    labelKey: "shortcut.cycleBoxBack",
    group: "navigation",
    default: { key: "PageUp", ctrl: true, shift: true },
    untested: "shortcut.cycleBoxBack",
  },
  {
    action: "shortcutHelp",
    labelKey: "shortcut.shortcutHelp",
    group: "steering",
    default: { key: "F1" },
    untested: "shortcut.shortcutHelp",
  },
  // The root console (`layout/RootOverlay`): the cross-project management
  // overlay that replaced switching to the root scope. Handled in the same
  // capture-phase listener as the steering chord, for the same reason — it has
  // to work FROM a focused terminal, which is where the hands are. Ctrl+Shift+R
  // is no terminal chord (readline's reverse search is plain Ctrl+R) and the
  // handler's preventDefault keeps WebKit's hard-reload off it.
  {
    action: "rootConsole",
    labelKey: "shortcut.rootConsole",
    group: "navigation",
    default: { key: "r", ctrl: true, shift: true },
    untested: "shortcut.rootConsole",
  },
  // The root console again, with a shell at the active project's root
  // (`openProjectShellInRootConsole`). Same capture-phase handler, same
  // reason. Ctrl+Shift+S is no terminal chord; the editors' Ctrl+S save
  // matches it too, and loses it here (plain Ctrl+S still saves).
  {
    action: "projectShell",
    labelKey: "shortcut.projectShell",
    group: "navigation",
    default: { key: "s", ctrl: true, shift: true },
    untested: "shortcut.projectShell",
  },
  // New tabs in the focused pane of the main window, taken focus and all
  // (`lib/shortcuts/newTabChord`): the + menu's Shell and System Monitor rows,
  // and its agents by number. Same capture-phase handler as the two above, so
  // they work from a focused terminal. Ctrl+Shift+N and +M are no terminal or
  // editor chord here; Ctrl+1–9 shadows only the legacy control codes some
  // terminals put on Ctrl+2–8, and is matched by physical key (`chordMatches`)
  // so it works on layouts whose digit row types symbols.
  {
    action: "newShellTab",
    labelKey: "shortcut.newShellTab",
    group: "newTab",
    default: { key: "n", ctrl: true, shift: true },
    untested: "shortcut.newTabChords",
  },
  {
    action: "newMonitorTab",
    labelKey: "shortcut.newMonitorTab",
    group: "newTab",
    default: { key: "m", ctrl: true, shift: true },
    untested: "shortcut.newTabChords",
  },
  ...AGENT_TAB_ACTIONS.map((action, i): ShortcutDef => ({
    action,
    labelKey: `shortcut.${action}`,
    group: "newTab",
    default: { key: String(i + 1), ctrl: true },
    untested: "shortcut.newTabChords",
  })),
  // The TeX workspace's two navigation steps (#tex-structure-up). Unlike every
  // chord above these are NOT handled by `useKeyboard`: they only mean anything
  // inside a workspace tab, so the workspace itself listens — on its own root
  // element, which is what scopes them to "the TeX viewer has focus" and lets
  // them work from the editor's textarea, where the global hook's editable-
  // target guard would drop them. Alt+Shift+Arrow collides with no default
  // here (Ctrl+Shift+Arrow is now subwindowUp/subwindowDown's), and the
  // workspace consumes the chord (preventDefault) so the textarea's own
  // paragraph-selection never runs.
  {
    action: "texUp",
    labelKey: "shortcut.texUp",
    group: "tex",
    default: { key: "ArrowUp", alt: true, shift: true },
    untested: "shortcut.texUp",
  },
  {
    action: "texBack",
    labelKey: "shortcut.texBack",
    group: "tex",
    default: { key: "ArrowDown", alt: true, shift: true },
    untested: "shortcut.texBack",
  },
  // The build itself. Listened for the same way as the two navigation steps
  // above — on the TeX pane's own root, not in `useKeyboard` — because a
  // compile is asked for from inside the editor's textarea, exactly where the
  // global hook's editable-target guard drops a chord. Ctrl+Shift+B is VS
  // Code's "run build task" and collides with nothing else in this table.
  {
    action: "texCompile",
    labelKey: "shortcut.texCompile",
    group: "tex",
    default: { key: "b", ctrl: true, shift: true },
    untested: "shortcut.texCompile",
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
  if (normalizeKey(e.key) !== normalizeKey(chord.key) && !isDigitKeyOf(chord.key, e)) return false;
  if (e.shiftKey !== !!chord.shift) return false;
  if (e.altKey !== !!chord.alt) return false;
  if (IS_MAC) {
    const wantsPrimary = !!chord.ctrl || !!chord.meta;
    const hasPrimary = e.ctrlKey || e.metaKey;
    return wantsPrimary === hasPrimary;
  }
  return e.ctrlKey === !!chord.ctrl && e.metaKey === !!chord.meta;
}

/** A digit chord also matches by physical key: AZERTY types `&` on the key
 *  US calls `1`, and Shift turns every digit into a symbol, so `e.key` alone
 *  would make Ctrl+1 unreachable there. */
function isDigitKeyOf(key: string, e: KeyboardEvent): boolean {
  return /^[0-9]$/.test(key) && (e.code === `Digit${key}` || e.code === `Numpad${key}`);
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
 * `e.key` alone, so no modifier rescues such a chord; the Ctrl +/-/0 zoom
 * chords (`zoomChord`) are taken first too. Deliberately independent of
 * `FIXED_KEYS`, which stores display strings. Not covered on purpose: a lone
 * Super/Meta never reaches capture (`chordFromEvent` returns null).
 */
export function isFixedChord(chord: ChordDescriptor): boolean {
  const key = normalizeKey(chord.key);
  if (key === "F11" || key === "F9" || key === "Escape") return true;
  return zoomChord({
    key,
    code: "",
    ctrlKey: !!chord.ctrl,
    metaKey: !!chord.meta,
    altKey: !!chord.alt,
    shiftKey: !!chord.shift,
  }) !== null;
}

/** The levels of steering mode (`stores/keyboardSteering`'s `SteeringLevel`,
 *  restated so this table stays free of store imports). */
export type SteeringContext = "projects" | "panes" | "tabs" | "region";

export const STEERING_CONTEXTS: { id: SteeringContext; labelKey: TranslationKey }[] = [
  { id: "projects", labelKey: "steering.level.projects" },
  { id: "panes", labelKey: "steering.level.panes" },
  { id: "tabs", labelKey: "steering.level.tabs" },
  { id: "region", labelKey: "steering.level.region" },
];

/**
 * When a key is listed beyond its levels:
 *   stepsPanes — the panes level with two or more subwindows (←/→ walk them)
 *   stepsTabs  — the tabs level, or the panes level with one subwindow, where
 *                ←/→ step its tabs instead
 *   sideRegion — the region cursor is in the side panel (←/→ switch its view)
 *   mail / calendar / todo — that header app is switched on
 */
export type SteeringCondition = "stepsPanes" | "stepsTabs" | "sideRegion" | "mail" | "calendar" | "todo";

/** One fixed key (or key family) inside steering mode. `keys` is display text
 *  (already glyphs, never translated); the two i18n keys carry the short
 *  legend label and the longer help/lesson description. */
export interface SteeringKeyDef {
  keys: string;
  labelKey: TranslationKey;
  descKey: TranslationKey;
  /** The levels whose legend lists the key. */
  levels: readonly SteeringContext[];
  when?: SteeringCondition;
  /** The legend spells the key family out as one entry per agent: the focused
   *  pane's 1–9 (`newTabSlotLabels`). */
  agentSlots?: true;
  /** A status jump: the legend lists it, with its count, only while some tab
   *  is in that state (`lib/shortcuts/statusJump`). */
  status?: "decision" | "working" | "done";
}

/** What the legend knows about the moment, for `steeringKeysFor`. */
export interface SteeringLegendState {
  level: SteeringContext;
  sideRegion: boolean;
  multiPane: boolean;
  apps: { mail: boolean; calendar: boolean; todo: boolean };
  /** How many tabs, in every scope, need an answer / work / finished unseen. */
  statusCounts: { decision: number; working: number; done: number };
}

function steeringConditionHolds(cond: SteeringCondition, s: SteeringLegendState): boolean {
  switch (cond) {
    case "stepsPanes":
      return s.level === "panes" && s.multiPane;
    case "stepsTabs":
      return s.level === "tabs" || (s.level === "panes" && !s.multiPane);
    case "sideRegion":
      return s.sideRegion;
    default:
      return s.apps[cond];
  }
}

/** The keys that act right now — the legend's rows, in table order. */
export function steeringKeysFor(s: SteeringLegendState): SteeringKeyDef[] {
  return STEERING_KEYS.filter(
    (k) =>
      k.levels.includes(s.level) &&
      (!k.when || steeringConditionHolds(k.when, s)) &&
      (!k.status || s.statusCounts[k.status] > 0),
  );
}

/** One fixed, non-rebindable key handled directly in `useKeyboard`. Same shape
 *  as `SteeringKeyDef`: display keys plus i18n label/description keys. */
export interface FixedKeyDef {
  keys: string;
  labelKey: TranslationKey;
  descKey: TranslationKey;
  /** The pill's id in the untested register, as on `ShortcutDef`. */
  untested?: UntestedId;
}

/**
 * The fixed (non-rebindable) keys `useKeyboard` handles outside the chord
 * table, in display order — rendered by the cheat sheet and reusable by the
 * settings panel and lessons. Platform-resolved at module load, except the
 * panel toggle: it is the lone Super key only where that key is free — a
 * Linux desktop that does not answer it itself (macOS uses Cmd as the chord
 * modifier, Windows gives the Win key to the OS, GNOME and KDE take it for
 * their overview/launcher) — and F9 everywhere else. That one is a getter
 * because the desktop is a backend answer; see lib/shortcuts/superKey.ts. The zoom
 * chords ride the primary modifier (⌘ on macOS).
 */
/** The key that toggles the panels on THIS desktop right now: the bare Super
 *  key where the desktop leaves it to the focused window, F9 everywhere else
 *  (see `useKeyboard`). Shared by the shortcut sheet and the "panels hidden"
 *  toast so the two never name different keys. */
export function livePanelToggleKey(): string {
  return PLATFORM === "linux" && !desktopOwnsSuperKey() ? "Super" : "F9";
}

export const FIXED_KEYS: FixedKeyDef[] = [
  {
    keys: "F11",
    labelKey: "fixedKeys.osFullscreen.label",
    descKey: "fixedKeys.osFullscreen.desc",
    untested: "fixedKeys.osFullscreen.label",
  },
  {
    // A getter, not a value: unlike the OS, the desktop is a backend answer
    // that arrives just after module load (see lib/shortcuts/superKey.ts), and the sheet
    // must not advertise a Super key the shell has already taken. Reading it
    // here keeps every consumer of FIXED_KEYS unchanged.
    get keys(): string {
      return livePanelToggleKey();
    },
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

const PANE_LEVELS: readonly SteeringContext[] = ["panes", "tabs"];
const BASE_LEVELS: readonly SteeringContext[] = ["projects", "panes", "tabs"];
const ALL_LEVELS: readonly SteeringContext[] = ["projects", "panes", "tabs", "region"];

/**
 * The FIXED in-steering-mode keys, grouped by the level they act on, in display
 * order — the one source of truth for the legend overlay (which shows the
 * current level's, `steeringKeysFor`), the shortcut cheat sheet, and any lesson
 * surface. `useKeyboard`'s steering handler is the acting counterpart; the two
 * must stay in step. Digit mapping on the project level: 1 = root scope, 2 =
 * the first project pill (display order) — the same ring `cycleProject` walks.
 * Letters mean one thing per level, so N is a new project up top and a new
 * shell inside a pane.
 */
export const STEERING_KEYS: SteeringKeyDef[] = [
  // Projects.
  { keys: "S F / ← →", labelKey: "steering.project.label", descKey: "steering.project.desc", levels: ["projects"] },
  { keys: "1–9", labelKey: "steering.jump.label", descKey: "steering.jump.desc", levels: ["projects"] },
  { keys: "D / ↓", labelKey: "steering.into.label", descKey: "steering.into.desc", levels: ["projects"] },
  { keys: "N", labelKey: "steering.newProject.label", descKey: "steering.newProject.desc", levels: ["projects"] },
  { keys: "M", labelKey: "steering.mail.label", descKey: "steering.mail.desc", levels: ["projects"], when: "mail" },
  { keys: "C", labelKey: "steering.calendar.label", descKey: "steering.calendar.desc", levels: ["projects"], when: "calendar" },
  { keys: "T", labelKey: "steering.todo.label", descKey: "steering.todo.desc", levels: ["projects"], when: "todo" },
  // Subwindows and their tabs.
  { keys: "S F / ← →", labelKey: "steering.focus.label", descKey: "steering.focus.desc", levels: ["panes"], when: "stepsPanes" },
  { keys: "S F / ← →", labelKey: "steering.tabs.label", descKey: "steering.tabs.desc", levels: PANE_LEVELS, when: "stepsTabs" },
  { keys: "D / ↓", labelKey: "steering.intoTabs.label", descKey: "steering.intoTabs.desc", levels: ["panes"], when: "stepsPanes" },
  { keys: "E / ↑", labelKey: "steering.up.label", descKey: "steering.up.desc", levels: PANE_LEVELS },
  { keys: "N", labelKey: "steering.newShell.label", descKey: "steering.newShell.desc", levels: PANE_LEVELS },
  { keys: "M", labelKey: "steering.newMonitor.label", descKey: "steering.newMonitor.desc", levels: PANE_LEVELS },
  { keys: "1–9", labelKey: "steering.newAgent.label", descKey: "steering.newAgent.desc", levels: PANE_LEVELS, agentSlots: true },
  { keys: "+", labelKey: "steering.newTabMenu.label", descKey: "steering.newTabMenu.desc", levels: PANE_LEVELS },
  { keys: "V", labelKey: "steering.files.label", descKey: "steering.files.desc", levels: PANE_LEVELS },
  { keys: "W", labelKey: "steering.closeTab.label", descKey: "steering.closeTab.desc", levels: PANE_LEVELS },
  { keys: "Space / Enter / Esc", labelKey: "steering.work.label", descKey: "steering.work.desc", levels: PANE_LEVELS },
  // The region cursor (side panel, header apps, + menu).
  { keys: "E D / ↑ ↓", labelKey: "steering.move.label", descKey: "steering.move.desc", levels: ["region"] },
  { keys: "S F / ← →", labelKey: "steering.sideView.label", descKey: "steering.sideView.desc", levels: ["region"], when: "sideRegion" },
  { keys: "Enter", labelKey: "steering.press.label", descKey: "steering.press.desc", levels: ["region"] },
  { keys: "/", labelKey: "steering.search.label", descKey: "steering.search.desc", levels: ["region"] },
  // Wherever the tab bars are. Shift walks the status jumps backwards.
  { keys: "Q", labelKey: "steering.nextDecision.label", descKey: "steering.nextDecision.desc", levels: BASE_LEVELS, status: "decision" },
  { keys: "R", labelKey: "steering.nextWorking.label", descKey: "steering.nextWorking.desc", levels: BASE_LEVELS, status: "working" },
  { keys: "X", labelKey: "steering.nextDone.label", descKey: "steering.nextDone.desc", levels: BASE_LEVELS, status: "done" },
  { keys: "B", labelKey: "steering.sidePanel.label", descKey: "steering.sidePanel.desc", levels: BASE_LEVELS },
  { keys: "P", labelKey: "steering.panels.label", descKey: "steering.panels.desc", levels: BASE_LEVELS },
  { keys: ",", labelKey: "steering.settings.label", descKey: "steering.settings.desc", levels: BASE_LEVELS },
  { keys: "?", labelKey: "steering.help.label", descKey: "steering.help.desc", levels: ALL_LEVELS },
  { keys: "Esc", labelKey: "steering.back.label", descKey: "steering.back.desc", levels: ["region"] },
  { keys: "Space", labelKey: "steering.exit.label", descKey: "steering.exit.desc", levels: ["region"] },
  { keys: "Space / Esc / Enter", labelKey: "steering.exit.label", descKey: "steering.exit.desc", levels: ["projects"] },
];
