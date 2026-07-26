/**
 * The dual-window presenter's wire protocol — and the navigation arithmetic both
 * ends share.
 *
 * Two Tauri windows are two JS heaps: the audience window cannot read the
 * editor's store, so everything it needs crosses as an event payload. The split
 * that keeps it honest is **one owner**: the presenter (main) window owns the
 * current stop and the blank screen; the audience window renders what it is told
 * and forwards the keys pressed *in it* back as requests. A second copy of the
 * index in the audience window is what would let the two displays disagree —
 * which is the one failure the audience actually sees.
 *
 * The deck itself travels as its serialized sidecar text (small, and already the
 * canonical form). The heavy parts — the base PDF, images, GIF frames — are NOT
 * streamed: the audience window is given the deck's *path* and file scope and
 * loads them itself through the ordinary confined file commands, so a 40 MB
 * plate never becomes an event payload.
 *
 * Everything here is pure so both windows and the tests can share it.
 */

import type { Stop } from "./model";

/** Blank-screen modes; `null` = showing the slide. */
export type Blank = null | "black" | "white";

// --- window identity -------------------------------------------------------

/**
 * FNV-1a (32-bit), base36. Only needs to be deterministic and collision-shy
 * across the handful of decks one session opens — it names a window, it does not
 * secure anything.
 */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * The audience window's Tauri label for a deck.
 *
 * Derived from the path rather than minted per click so that opening the second
 * display twice for one deck is idempotent (the backend returns the existing
 * window), and so a re-opened presenter re-seeds the window that is already on
 * the projector. The `present-` prefix is load-bearing: `capabilities/default.json`
 * grants window permissions by that glob.
 */
export function presenterLabel(path: string): string {
  return `present-${hash32(path)}`;
}

/**
 * Parse the `?present=<label>` query that selects the audience-window render
 * branch in `App`. Returns null when absent (→ the normal shell).
 */
export function parsePresentParam(search: string): string | null {
  const raw = new URLSearchParams(search).get("present");
  if (!raw) return null;
  return /^present-[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
}

// --- events ----------------------------------------------------------------

/** Main → audience, namespaced: the whole deck + where to start. */
export const presentSeedEvent = (label: string) => `deck-present-seed-${label}`;
/** Main → audience, namespaced: the current stop / blank screen. */
export const presentStateEvent = (label: string) => `deck-present-state-${label}`;
/** Audience → main: "I am mounted, send me a seed" (carries its label). */
export const PRESENT_READY = "deck-present-ready";
/** Audience → main: a key was pressed over there; here is what it asked for. */
export const PRESENT_NAV = "deck-present-nav";
/** Audience → main: this window is going away (WM close), so drop back to one screen. */
export const PRESENT_CLOSED = "deck-present-closed";

export interface PresentSeed {
  /** The deck's sidecar path — the audience window resolves its own assets from it. */
  path: string;
  /** File scope (owning project id) for the confined file commands; null = root. */
  scope: string | null;
  /** The deck, serialized exactly as the sidecar stores it. */
  deck: string;
  index: number;
  blank: Blank;
}

export interface PresentState {
  index: number;
  blank: Blank;
}

/**
 * What a key pressed in the audience window asks the presenter window to do.
 *
 * Every movement carries an optional `from`: **the stop the requester was
 * looking at when it asked**. `applyNav` refuses a request whose `from` no
 * longer matches, which makes navigation *idempotent* — two requests racing for
 * one advance move the talk one stop, not two.
 *
 * That matters because there are several ways to produce the race and all of
 * them happen in front of a room: a clicker that double-fires, a key forwarded
 * from the audience window arriving just after the same key was pressed locally,
 * and an auto-advancing GIF whose clip ends on both displays' own clocks. Without
 * it the deck skips a slide, nondeterministically, only in dual-window mode.
 */
export type NavAction =
  | { kind: "next"; from?: number }
  | { kind: "prev"; from?: number }
  | { kind: "first"; from?: number }
  | { kind: "last"; from?: number }
  | { kind: "slide"; delta: number; from?: number }
  | { kind: "goto"; slide: number; from?: number }
  | { kind: "blank"; mode: Exclude<Blank, null> }
  | { kind: "close" };

export interface PresentNav {
  label: string;
  action: NavAction;
}

export interface PresentReady {
  label: string;
}

// --- navigation (pure) -----------------------------------------------------

export function clampStop(stops: readonly Stop[], i: number): number {
  return Math.min(Math.max(i, 0), Math.max(0, stops.length - 1));
}

/**
 * Stamp a movement request with the stop it was made from, so the owner can
 * refuse it if the talk has moved on since — see {@link NavAction}.
 *
 * `blank` and `close` pass through unstamped: they are toggles, not movements,
 * and a blackout request arriving a beat late still means "black the screen".
 * Written as an explicit switch rather than a spread so each branch keeps its own
 * shape instead of collapsing into a union of optional fields.
 */
export function withFrom(action: NavAction, from: number): NavAction {
  switch (action.kind) {
    case "next":
    case "prev":
    case "first":
    case "last":
      return { kind: action.kind, from };
    case "slide":
      return { kind: "slide", delta: action.delta, from };
    case "goto":
      return { kind: "goto", slide: action.slide, from };
    default:
      return action;
  }
}

/**
 * The index of the *entry* stop of slide `n` (its step 0), or -1.
 *
 * Deliberately the entry stop and not "any stop on that slide": jumping to a
 * slide must show it as the audience first saw it, with its builds un-run.
 */
export function slideStopIndex(stops: readonly Stop[], n: number): number {
  return stops.findIndex((s) => s.kind === "slide" && s.slide === n && s.step === 0);
}

/**
 * Move a whole slide (the ↑/↓ behaviour): skip whatever builds remain rather
 * than stepping through them. Staying put when there is no such slide is
 * deliberate — running off the end of the deck mid-talk should do nothing.
 */
export function stepSlide(stops: readonly Stop[], i: number, delta: number): number {
  const cur = stops[i];
  if (!cur) return i;
  const found = slideStopIndex(stops, cur.slide + delta);
  return found >= 0 ? found : i;
}

/**
 * The index of the **next different slide** after stop `index`, or -1.
 *
 * "Different" is the whole point, and the reason this is a named function rather
 * than an inline `find` in the presenter's JSX. On a slide with builds, the next
 * `kind: "slide"` stop is the *same slide's* next build step — so a naive search
 * makes the speaker console's "next slide" preview show the slide the room is
 * already looking at, labelled with the wrong number, precisely while stepping
 * builds. That is the core of what the second display is for.
 */
export function nextSlideOf(stops: readonly Stop[], index: number): number {
  const cur = stops[index];
  if (!cur) return -1;
  for (let i = index + 1; i < stops.length; i += 1) {
    const s = stops[i];
    if (s.kind === "slide" && s.slide !== cur.slide) return s.slide;
  }
  return -1;
}

/**
 * Apply a navigation request from the audience window. Returns the new stop
 * index; `close` is not a movement and is handled by the caller (it returns the
 * index unchanged), and so is `blank`.
 */
export function applyNav(stops: readonly Stop[], index: number, action: NavAction): number {
  // A request that names the stop it was made from is honoured only while that is
  // still where we are. See {@link NavAction} for the races this closes.
  if ("from" in action && action.from != null && action.from !== index) return index;
  switch (action.kind) {
    case "next":
      return clampStop(stops, index + 1);
    case "prev":
      return clampStop(stops, index - 1);
    case "first":
      return 0;
    case "last":
      return clampStop(stops, stops.length - 1);
    case "slide":
      return stepSlide(stops, index, action.delta);
    case "goto": {
      const found = slideStopIndex(stops, action.slide);
      return found >= 0 ? found : index;
    }
    default:
      return index;
  }
}

/**
 * The key → action mapping the audience window forwards.
 *
 * Shared with the presenter window's own handler so the two keyboards cannot
 * drift: whichever display has focus, the same key does the same thing. Returns
 * null for a key this surface does not claim (so it stays available to the
 * browser/WM), and `digit` for a keystroke that is building a goto number —
 * which only the caller can accumulate.
 */
export function keyToAction(key: string): NavAction | { kind: "digit"; digit: string } | null {
  if (/^[0-9]$/.test(key)) return { kind: "digit", digit: key };
  switch (key) {
    case " ":
    case "ArrowRight":
    case "PageDown":
      return { kind: "next" };
    case "ArrowLeft":
    case "PageUp":
      return { kind: "prev" };
    case "ArrowDown":
      return { kind: "slide", delta: 1 };
    case "ArrowUp":
      return { kind: "slide", delta: -1 };
    case "Home":
      return { kind: "first" };
    case "End":
      return { kind: "last" };
    case "b":
    case "B":
      return { kind: "blank", mode: "black" };
    case "w":
    case "W":
      return { kind: "blank", mode: "white" };
    case "Escape":
      return { kind: "close" };
    default:
      return null;
  }
}
