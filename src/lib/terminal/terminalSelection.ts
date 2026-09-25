/**
 * What a mouse selection in a terminal pane copies, and keeping that selection
 * alive while the program underneath keeps changing its mouse mode.
 */
import type { IBufferRange, IDisposable, Terminal } from "@xterm/xterm";
import { IS_WINDOWS } from "../platform";

/** The slice of xterm's `IBufferCell` the row-join rule reads. */
export interface CellLike {
  getChars(): string;
  getWidth(): number;
}

/** The slice of xterm's `IBufferLine` the row-join rule reads. */
export interface LineLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
  getCell(x: number): CellLike | undefined;
}

/**
 * How far short of the right edge a TUI's own word-wrap may break a line and
 * still count as "ran out of room". Agent CLIs lay their text out in a box a few
 * columns narrower than the pane (an indent on the left, a margin on the right).
 */
export const WRAP_SLACK = 3;

// A row that starts like a list item / agent message / quote / heading is a new
// line in its own right, even when the row above it ran to the edge.
const NEW_ITEM = /^([-*+•◦▪‣●○■□▶>#|⏺⎿✻※]|\d{1,3}[.)])(\s|$)/u;
// Box-drawing and block elements: TUI frames, input boxes, separators. A row
// that ends or begins with one is layout, never a sentence broken in two.
const FRAME = /[─-▟]/u;
const NBSP = /\u00a0/gu;

/** Cells the row actually uses: one past its last non-blank cell (wide glyphs
 *  count both halves). Zero for a blank row. */
function usedCells(line: LineLike, cols: number): number {
  for (let x = cols - 1; x >= 0; x--) {
    const cell = line.getCell(x);
    const ch = cell?.getChars() ?? "";
    if (ch && ch !== " ") return x + Math.max(1, cell!.getWidth());
  }
  return 0;
}

/**
 * Whether row `next` continues row `prev` as one line that was wrapped only
 * because it ran out of columns: `""` = joined as-is (the row was filled to the
 * last column — the terminal's, or tmux's, character wrap), `" "` = joined with
 * a space (a TUI's word wrap: the next row's first word would not have fit on
 * this one), `null` = a real line break.
 *
 * Why a guess is needed at all: xterm marks a row it wrapped itself
 * (`isWrapped`) and joins those already, but every local pane runs inside tmux,
 * which repaints with explicit cursor moves, and agent CLIs wrap their own text
 * with hard newlines — so neither kind of wrap reaches xterm as one.
 */
export function rowJoin(prev: LineLike, next: LineLike, cols: number): "" | " " | null {
  const prevText = prev.translateToString(true);
  const lead = next.translateToString(true).trimStart();
  if (!prevText.trim() || !lead) return null;
  if (FRAME.test(prevText.slice(-1)) || FRAME.test(lead[0])) return null;
  if (NEW_ITEM.test(lead)) return null;
  const used = usedCells(prev, cols);
  if (used >= cols) return "";
  const width = cols - WRAP_SLACK;
  const word = lead.split(/\s/u, 1)[0].length;
  // The word must have been short enough to fit on a row of its own — a long
  // URL under a short "See:" line was put there on purpose — and the row above
  // must be well filled, or it simply ended early.
  if (used * 2 >= cols && word < width && used + 1 + word > width) return " ";
  return null;
}

/**
 * The text of the selection `range` (xterm's own 0-based, end-exclusive
 * coordinates) with wrapped rows put back together — see {@link rowJoin}.
 */
export function joinedSelectionText(
  getLine: (y: number) => LineLike | undefined,
  cols: number,
  range: IBufferRange,
): string {
  const { start, end } = range;
  if (end.y < start.y) return "";
  const segment = (y: number): string =>
    getLine(y)?.translateToString(true, y === start.y ? start.x : 0, y === end.y ? end.x : undefined) ?? "";
  const eol = IS_WINDOWS ? "\r\n" : "\n";
  let out = segment(start.y);
  for (let y = start.y + 1; y <= end.y; y++) {
    const line = getLine(y);
    const prev = getLine(y - 1);
    const join = line?.isWrapped ? "" : line && prev ? rowJoin(prev, line, cols) : null;
    const text = segment(y);
    if (join === "") out += text;
    else if (join === " ") out += " " + text.trimStart();
    else out += eol + text;
  }
  return out.replace(NBSP, " ");
}

/** What copying `term`'s current selection should put on the clipboard. A
 *  column (Alt-drag) selection is a rectangle the user drew, so it is copied
 *  exactly as xterm reads it, row per line. */
export function copyableSelection(term: Terminal, columnMode: boolean): string {
  const range = columnMode ? undefined : term.getSelectionPosition();
  if (!range) return term.getSelection();
  const buf = term.buffer.active;
  return joinedSelectionText((y) => buf.getLine(y), term.cols, range);
}

type MouseTracking = Terminal["modes"]["mouseTrackingMode"];
const TRACKING: Record<number, MouseTracking> = { 9: "x10", 1000: "vt200", 1002: "drag", 1003: "any" };
// An arbitrary DEC private mode number no terminal defines, tagging the
// sequences the guard writes into xterm itself (they never reach the program).
const REPLAY_TAG = 64_527;

export interface MouseModeGuard extends IDisposable {
  /** The primary button went down in the pane: a selection may be starting. */
  beginDrag(): void;
  /** The button came up (or the window lost it). */
  endDrag(): void;
}

/**
 * Keeps mouse selections from being wiped by the program's mouse-mode escapes.
 *
 * xterm answers EVERY "mouse tracking on" sequence (`CSI ? 9/1000/1002/1003 h`)
 * by disabling its selection service — even when that mode is already on — and
 * disabling clears the selection AND drops the listeners of a drag in progress.
 * Agent TUIs (and tmux relaying them) switch these modes as they run, so a drag
 * made while the agent worked would vanish mid-gesture and copy nothing: the
 * "copying out of an agent tab is flaky" report. So:
 *
 *  - a sequence that would leave the mode as it already is is dropped —
 *    nothing changes for the program, and the selection survives;
 *  - during a drag, a real change is held back and applied once the button is
 *    up, after the selection has been copied. It is replayed by writing tagged
 *    copies of each candidate mode into xterm; the tag handler, running in parse
 *    order, lets through only the one still wanted — so a mode sequence the
 *    program sent after the release (which clears the held one) always wins.
 *
 * "Tracking off" (`… l`) never clears a selection, so it always passes; it only
 * cancels a held-back "on".
 */
export function installMouseModeGuard(term: Terminal): MouseModeGuard {
  let dragging = false;
  let held: MouseTracking | null = null;
  const flat = (params: (number | number[])[]) => params.map((p) => (Array.isArray(p) ? p[0] : p));

  const onSet = term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (raw) => {
    const params = flat(raw);
    if (params.includes(REPLAY_TAG)) {
      const want = TRACKING[params.find((p) => p !== REPLAY_TAG) ?? -1];
      if (dragging || !want || want !== held) return true;
      held = null;
      return want === term.modes.mouseTrackingMode;
    }
    const tracking = params.filter((p) => p in TRACKING);
    if (tracking.length === 0) return false;
    // Mixed in with other modes (alternate screen, …): those must apply now, so
    // let xterm have the whole sequence.
    if (tracking.length !== params.length) {
      held = null;
      return false;
    }
    const want = TRACKING[tracking[tracking.length - 1]];
    if (dragging) {
      held = want;
      return true;
    }
    held = null;
    return want === term.modes.mouseTrackingMode;
  });
  const onReset = term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (raw) => {
    if (flat(raw).some((p) => p in TRACKING)) held = null;
    return false;
  });

  return {
    beginDrag() {
      dragging = true;
    },
    endDrag() {
      if (!dragging) return;
      dragging = false;
      if (held) term.write(Object.keys(TRACKING).map((p) => `\x1b[?${p};${REPLAY_TAG}h`).join(""));
    },
    dispose() {
      onSet.dispose();
      onReset.dispose();
    },
  };
}
