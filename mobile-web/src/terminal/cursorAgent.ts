/**
 * Cursor agent's `/model` dialog (`cursor-agent` 2026.09.26), for a tab whose
 * label names it. Captured from a live session at 60 columns:
 *
 *    → Plan, search, build anything        ← the input box, above the dialog
 *
 *   Available models                             Max mode: OFF
 *
 *   Filter:
 *
 *      Auto
 *   →  Grok 4.7                 256K High Fast (Tab to modify)
 *      Grok 4.6                 High Fast
 *      Composer 2.5             Fast
 *      …
 *
 *   1-10 of 39
 *
 *   Type to filter • Enter to select • Tab to edit
 *
 * The rows carry no numbers, so `selectPrompt` recognized nothing and the
 * model sheet waited out its timeout on an empty list. The dialog is found by
 * its heading and filter field instead, and its rows are numbered here by
 * their place in the whole list, which the window note gives (`4-13 of 39` →
 * these rows are 4 to 13). That lets the caller walk the highlight by a
 * difference of printed numbers, as it does for a windowed Claude Code picker:
 * the dialog moves one row per ↑/↓, wraps at either end, and applies the
 * highlighted model on a single Enter.
 *
 * At phone width Ink lays the rows out loosely: the indent drifts by a column
 * from row to row, a row's note wraps onto rows of its own far to the right,
 * the highlighted row's `(Tab to modify)` hint is interleaved with its note,
 * and a blank row can sit inside the list. Rows are told from their wrapped
 * notes by indent alone, and a note that does not read cleanly is dropped
 * rather than shown garbled.
 *
 * Everything here is read off the screen. What is pressed is the caller's.
 */

import type { SelectPrompt } from "./selectPrompt";

interface CursorLineLike { text: string }

/** The registry's label for `cursor-agent` is "Cursor". */
const AGENT = /cursor/iu;

export function isCursorTab(agentLabel?: string): boolean {
  return agentLabel !== undefined && AGENT.test(agentLabel);
}

/** How far up from the bottom the heading may sit: ten rows, each wrapped
 * onto up to three at phone width, and the footer under them. */
const SEARCH_WINDOW = 50;
/** The heading, with the `Max mode` readout the dialog right-aligns beside it. */
const HEADING = /^\s{0,4}(Available models)(?:\s{2,}(\S.*))?$/u;
/** The filter field, empty or holding a query: between the heading and the
 * rows, and what tells this dialog from a heading somebody printed. */
const FILTER_FIELD = /^\s{0,4}Filter:/u;
/** A row: the dialog's one-column margin, then the highlight arrow or the
 * blanks every other row is indented by. How deep is left to the indent check
 * below — at phone width it drifts from row to row. */
const ROW = /^\s*(→\s+)?(\S.*)$/u;
/** A wrapped note sits in the note column, far right of any row's label. */
const MIN_NOTE_INDENT = 8;
/** The window a list too long for the pane is drawn in: `4-13 of 39`. */
const WINDOW_RANGE = /^(\d{1,3})\s*[-–]\s*(\d{1,3})\s+of\s+(\d{1,3})$/u;
/** The keyboard line under the list; the list has ended by then. */
const FOOTER = /^Type to filter\b/u;
const COLUMN_SPLIT = /\s{2,}/u;
/** The hint the dialog prints after the highlighted row's note. */
const MODIFY_HINT = /\s*\(Tab to modify\)\s*$/u;
/** Rows read out of one dialog; the cap only bounds a misread. */
const MAX_ROWS = 24;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 120;

function skipBlank(lines: readonly CursorLineLike[], from: number): number {
  let index = from;
  while (index < lines.length && !lines[index].text.trim()) index += 1;
  return index;
}

/** The lowest `Available models` heading on screen, or -1. The lowest, because
 * a dialog the session has scrolled past is not the one it is showing. */
function headingIndex(lines: readonly CursorLineLike[]): number {
  const first = Math.max(0, lines.length - SEARCH_WINDOW);
  for (let index = lines.length - 1; index >= first; index -= 1) {
    if (HEADING.test(lines[index].text.replace(/\s+$/u, ""))) return index;
  }
  return -1;
}

/**
 * The `Available models` dialog the session is showing right now, as the rows
 * the phone lists, or `null` when the screen holds none in the recognized
 * shape — which includes a frame caught mid-repaint, whose row count does not
 * match its own window note.
 */
export function readCursorPicker(lines: readonly CursorLineLike[]): SelectPrompt | null {
  const heading = headingIndex(lines);
  if (heading < 0) return null;
  let index = skipBlank(lines, heading + 1);
  if (index >= lines.length || !FILTER_FIELD.test(lines[index].text)) return null;
  index = skipBlank(lines, index + 1);

  const start = index;
  const rows: { label: string; notes: string[]; marked: boolean }[] = [];
  let range: RegExpExecArray | null = null;
  for (; index < lines.length && rows.length <= MAX_ROWS; index += 1) {
    const text = lines[index].text.replace(/\s+$/u, "");
    if (!text) continue;
    const trimmed = text.trim();
    range = WINDOW_RANGE.exec(trimmed);
    if (range || FOOTER.test(trimmed)) break;
    const indent = text.length - text.trimStart().length;
    const row = indent < MIN_NOTE_INDENT ? ROW.exec(text) : null;
    if (row) {
      const [label, ...notes] = row[2].split(COLUMN_SPLIT);
      rows.push({ label: label.trim().slice(0, MAX_LABEL), notes, marked: row[1] !== undefined });
      continue;
    }
    const last = rows[rows.length - 1];
    if (!last || indent < MIN_NOTE_INDENT) return null;
    last.notes.push(trimmed);
  }
  // One highlight, always: walking from a highlight this cannot see is a guess.
  if (rows.length < 2 || rows.length > MAX_ROWS || rows.filter((row) => row.marked).length !== 1) return null;

  let first = 1;
  let total = rows.length;
  if (range) {
    const [from, to, count] = range.slice(1).map(Number);
    // The note counts these very rows, or the frame is not a whole one.
    if (to - from + 1 !== rows.length || count < to) return null;
    first = from;
    total = count;
  }

  return {
    options: rows.map((row, at) => {
      let description = row.notes.join(" ").replace(/\s+/gu, " ").trim();
      if (row.marked) description = description.replace(MODIFY_HINT, "");
      // The highlighted row's hint, interleaved with its note at phone width.
      if (/[()]/u.test(description)) description = "";
      return {
        index: at,
        number: first + at,
        label: row.label,
        ...(description ? { description: description.slice(0, MAX_DESCRIPTION) } : {}),
      };
    }),
    current: rows.findIndex((row) => row.marked),
    title: HEADING.exec(lines[heading].text.replace(/\s+$/u, ""))![1],
    start,
    // The heading is the dialog's question; what sits above it — the input
    // box, the banner — is the session's own screen.
    question: heading,
    context: heading,
    ...(total > rows.length ? { hidden: total - rows.length } : {}),
  };
}
