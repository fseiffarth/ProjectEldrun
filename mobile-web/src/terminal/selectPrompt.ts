/**
 * Reads the option list an agent TUI draws for a select dialog — the one
 * `/model` opens in Claude Code and Codex — so the phone can answer it by
 * tapping a row instead of walking the highlight there with the arrow keys.
 *
 * The scoping is the same as `statusLine`'s, and for the reason `readableScreen`
 * dropped the semantic parser it replaced: this never runs over ordinary
 * output. The caller reads it only while Eldrun itself has just sent the
 * command that opens the dialog, and only a shape it positively recognizes — a
 * contiguous run of numbered rows, numbered from 1, carrying exactly one
 * highlight marker — becomes a list. Anything else returns `null`, the dialog
 * stays on screen as the session drew it, and the arrow keys still answer it.
 *
 * Nothing here sends keystrokes: what a tapped row does is the caller's.
 */

export interface SelectOption {
  /** Position in the run, 0-based. The caller moves the highlight by the
   * difference between this and `current`, which is why it is not the printed
   * number: a dialog may renumber, but the rows are always in screen order. */
  index: number;
  /** The number the dialog printed beside the row. */
  number: number;
  label: string;
  /** The note the dialog printed in the row's second column, if any. */
  description?: string;
}

export interface SelectPrompt {
  options: SelectOption[];
  /** Index of the row the dialog is highlighting — where the cursor starts. */
  current: number;
}

interface SelectLineLike { text: string }

/** How far up from the bottom a dialog may sit. Below it the TUI still draws
 * its footer ("Esc to cancel") and, in Codex, the input box. */
const SEARCH_WINDOW = 40;
/** A single numbered row is a sentence about a list, not a list. */
const MIN_OPTIONS = 2;
/** Longer than any picker either CLI draws; a longer run is not one. */
const MAX_OPTIONS = 12;

/** `❯ 1. Label   Description` once `readableScreen` stripped the box frame.
 * The marker is optional per row: exactly one row carries it. */
const OPTION = /^\s*([❯▸▶›>→])?\s*(\d{1,2})[.)]\s+(\S.*)$/u;
/** Two or more spaces — what both CLIs put between a row's label and its
 * note. A single space is inside the label. */
const COLUMN_SPLIT = /\s{2,}/u;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 200;

interface ReadRow { marked: boolean; option: Omit<SelectOption, "index"> }

function readRow(text: string): ReadRow | null {
  const match = OPTION.exec(text);
  if (!match) return null;
  const [, marker, digits, rest] = match;
  const columns = rest.split(COLUMN_SPLIT);
  const label = columns[0].trim();
  if (!label) return null;
  const description = columns.slice(1).join(" · ").trim();
  return {
    marked: marker !== undefined,
    option: {
      number: Number(digits),
      label: label.slice(0, MAX_LABEL),
      description: description ? description.slice(0, MAX_DESCRIPTION) : undefined,
    },
  };
}

/**
 * The select dialog the session is showing right now, or `null` when the bottom
 * of the screen does not hold one in the recognized shape.
 */
export function readSelectPrompt(lines: readonly SelectLineLike[]): SelectPrompt | null {
  const first = Math.max(0, lines.length - SEARCH_WINDOW);
  const runs: { options: SelectOption[]; marked: number[] }[] = [];
  let run: { options: SelectOption[]; marked: number[] } | undefined;

  for (let index = first; index < lines.length; index += 1) {
    const text = lines[index].text;
    // A run is contiguous. A blank row or any other text ends it, so a numbered
    // list elsewhere on screen can never be glued onto the dialog's own rows.
    if (!text.trim()) {
      run = undefined;
      continue;
    }
    const row = readRow(text);
    if (!row) {
      run = undefined;
      continue;
    }
    const continues = run !== undefined
      && run.options.length < MAX_OPTIONS
      && row.option.number === run.options.length + 1;
    if (!continues) {
      run = undefined;
      if (row.option.number !== 1) continue;
      run = { options: [], marked: [] };
      runs.push(run);
    }
    if (!run) continue;
    if (row.marked) run.marked.push(run.options.length);
    run.options.push({ index: run.options.length, ...row.option });
  }

  // The live dialog is the lowest one on screen; an earlier, scrolled-past
  // picker in the same session must not win.
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const candidate = runs[index];
    if (candidate.options.length >= MIN_OPTIONS && candidate.marked.length === 1) {
      return { options: candidate.options, current: candidate.marked[0] };
    }
  }
  return null;
}

/** The keystrokes that move a dialog's highlight from `current` to `target` and
 * accept it — the same keys the on-screen arrow row sends, so a tapped row is
 * answered exactly as a walked one. */
export function selectKeys(current: number, target: number): string[] {
  const distance = Math.abs(target - current);
  const key = target > current ? "\u001b[B" : "\u001b[A";
  return [...Array.from({ length: distance }, () => key), "\r"];
}
