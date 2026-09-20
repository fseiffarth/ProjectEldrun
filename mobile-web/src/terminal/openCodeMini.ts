/**
 * What OpenCode draws in its **minimal interface** (`opencode --mini`), which
 * is the one shape of it the phone can read at all.
 *
 * Plain `opencode` is a full-screen (alternate-screen) TUI: it has no
 * scrollback, so Focus hands it to the Terminal view and nothing here applies.
 * `--mini` writes the conversation into ordinary scrollback and keeps a live
 * area — an input box and one status row — pinned under it. That live area is
 * drawn with absolute cursor moves and no input marker of its own, so none of
 * the shapes the other families are found by is present: there is no `>` box
 * row for `statusLine` to anchor on, and the status row has no mode word on
 * it, only the agent's name in capitals.
 *
 * Everything here was read off a real `opencode --mini` 1.18.31 session
 * (captures at 60, 80 and 100 columns, replayed through the phone's own
 * emulator), not out of the bundle, and it is deliberately scoped to a tab
 * whose label names OpenCode — the same tie-break `agentModes` uses, and the
 * only way a bare ` BUILD` row can be told from a line of output.
 *
 * The shapes, in the order a session prints them:
 *
 *   `█▀▀█  OpenCode` / `█  █  ~/project`   the banner, once, at the top
 *   `› the prompt as it was submitted`      the echo — **hard-wrapped** by
 *                                           OpenCode itself, at the pane
 *                                           width, with no indent on the
 *                                           continuation rows
 *   `→ Read src/App.tsx`                    a tool call: `→` for read/edit/
 *   `✱ Grep "foo" in src`                   list/bash/skill, `✱` for glob and
 *   `◈ Parallel Web Search "…"`             grep, `◈` for a web search, `%`
 *   `% WebFetch https://…`                  for a fetch, `✗` for a refused
 *   `# General Task …`                      tool, `#` for a subagent task —
 *                                           each wrapped the same way
 *   `$ npm test` + its output               the bash tool's own block, which
 *                                           is kept: it is output, not a label
 *   `Thinking: …`                           reasoning, kept like Claude's
 *   the answer                              plain text, wrapped by OpenCode
 *   `▣ Build · Muse Spark 1.3 Free · 6.2s`  the turn footer: agent, model,
 *                                           duration
 *   ` BUILD   223.0K (21%) · ctrl+p cmd`    the live status row, always the
 *                                           last non-blank row on screen
 *
 * Because OpenCode wraps its own rows, a continuation carries no marker and no
 * indent — nothing on the row says it belongs to the row above. What *does*
 * hold is that OpenCode prints a blank row between blocks and none inside one,
 * so a block runs from its marker row to the next blank row. That is the rule
 * `chatTurns` uses to keep a wrapped prompt whole and to drop a wrapped tool
 * call whole, and it is the reason those two rules live here rather than in
 * the indent-based ones the other CLIs share.
 */

import type { ReadableLine, ReadableSpan } from "./readableScreen";
import type { SelectPrompt } from "./selectPrompt";

/** A tab whose label names OpenCode. Renamable by the user, like every other
 * family's — `agentModes` explains why the label is the tie-break. */
const OPENCODE_AGENT = /open\s*code/iu;

export function isOpenCodeTab(agentLabel?: string): boolean {
  return agentLabel !== undefined && OPENCODE_AGENT.test(agentLabel);
}

/** The two rows of the start-up banner that carry text beside their block
 * glyphs (`readableScreen` drops the stroke-only third row itself). */
const BANNER = /^[█▀▄▌▐]+\s/u;

export function isOpenCodeBanner(text: string): boolean {
  return BANNER.test(text);
}

/** The hint OpenCode draws inside its *empty* input box, in three shapes:
 * `Ask anything... "Fix a TODO in the codebase"`, `Ask anything… `, and
 * `Ask anything, / for commands, @ for context...`. The box is the frame, so
 * this is part of it and not a line of the conversation. */
const PLACEHOLDER = /^\s*Ask anything[.,…]/u;

export function isOpenCodePlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text);
}

/** A tool call's first row. The glyph set is OpenCode's own (`→ ✱ ◈ % ✗`),
 * read off a live session and confirmed against the title functions in the
 * 1.18.31 bundle.
 *
 * `#` is only claimed as a subagent task (`# General Task explore the repo`):
 * on its own it is the markdown heading an answer opens a section with, and
 * claiming that would drop the section. `+`/`-`/`~`, which the edit tool uses
 * for `+ Created`/`- Deleted`/`~ Patched`, are not claimed at all — a `- ` row
 * is the bullet of every list an agent ever wrote. `%` is claimed only as
 * `% WebFetch`, since a bare `%` opens plenty of shell output. */
const TOOL_ROW = /^(?:[→✱◈✗]\s|%\s+WebFetch\b|#\s+\S.*\bTask\b)/u;

export function isOpenCodeToolRow(text: string): boolean {
  return TOOL_ROW.test(text);
}

export interface OpenCodeTurnFooter {
  /** The agent the turn ran as, as printed (`Build`, `Plan`, …). */
  agent: string;
  /** The model's display name (`Muse Spark 1.3 Free`), when the row named one. */
  model?: string;
  /** How long the turn took (`6.2s`), when the row named it. */
  duration?: string;
}

/** `▣ Build · Muse Spark 1.3 Free · 6.2s` — the row OpenCode closes a turn
 * with. It is the only place a mini session prints the model's display name,
 * which is why `statusLine` reads the chip out of it. */
const TURN_FOOTER = /^\s*▣\s+(\S.*)$/u;

export function openCodeTurnFooter(text: string): OpenCodeTurnFooter | null {
  const match = TURN_FOOTER.exec(text);
  if (!match) return null;
  const [agent, model, duration] = match[1].split(" · ").map((part) => part.trim());
  if (!agent) return null;
  return { agent, model: model || undefined, duration: duration || undefined };
}

export interface OpenCodeStatus {
  /** The agent the session is in, lower-cased (`build`, `plan`, …) — what
   * `agentModes` calls a mode for every other family. */
  mode: string;
  /** Context used, as the row prints it (`223.0K (21%)` → `21%`). */
  context?: string;
  /** The model id from the row's notice slot, right after a switch. */
  model?: string;
}

/** The live status row: one space of padding, the agent's name in capitals,
 * then — two or more columns over — a notice (`model union-alpha`, `no
 * variants available`), the progress dots and `esc interrupt` while the
 * session is working, and the token count and key hint when it is idle. At 60
 * columns there is room for the chip alone.
 *
 * The tail is not required to be a shape this knows: an unrecognized notice
 * must still leave the row readable as the frame, or the phone would paint
 * OpenCode's own status bar into the conversation. What the tail is *asked*
 * for is only the two facts below. */
const CHIP_ROW = /^ ([A-Z][A-Z0-9]*(?:[ ._-][A-Z0-9]+)*)(?:\s{2,}(\S.*?))?\s*$/u;
/** Longer than any agent name OpenCode draws; a longer run of capitals is a
 * line of output that happens to be shouting. */
const MAX_CHIP = 24;
/** `223.0K (21%)` — tokens used and the share of the window they are. The
 * percentage is what the chip shows, the same way Gemini CLI's `25% used`
 * does: it is what the session printed, not a figure this converts. */
const CONTEXT = /(?:\d+(?:\.\d+)?[KM]?)\s*\((\d{1,3})%\)/u;
/** The notice OpenCode shows in the status row after a model switch, its own
 * column: `model union-alpha`. */
const MODEL_NOTICE = /(?:^|\s{2,})model\s+([A-Za-z0-9][\w.:/-]*)/u;

/** The status the row carries, or `null` when the row is not one. */
export function openCodeStatusRow(text: string): OpenCodeStatus | null {
  const match = CHIP_ROW.exec(text.replace(/\s+$/u, ""));
  if (!match) return null;
  const chip = match[1];
  if (chip.length > MAX_CHIP) return null;
  const status: OpenCodeStatus = { mode: chip.toLowerCase() };
  const tail = match[2];
  if (tail) {
    const context = CONTEXT.exec(tail);
    if (context) status.context = `${context[1]}%`;
    const model = MODEL_NOTICE.exec(tail);
    if (model) status.model = model[1];
  }
  return status;
}

/** Where the block opening at `start` ends, exclusive: the next blank row, or
 * the end of the lines. OpenCode wraps its own rows without an indent, so this
 * is the only thing that holds a wrapped prompt or a wrapped tool call
 * together — it prints a blank row between blocks and none inside one. */
export function openCodeBlockEnd(lines: readonly { text: string }[], start: number): number {
  let index = start + 1;
  while (index < lines.length && lines[index].text.trim() !== "") index += 1;
  return index;
}

/** A row that opens a block of OpenCode's own: a tool call, the turn footer,
 * the prompt echo, the banner. Never the continuation of the row above it. */
function opensBlock(text: string): boolean {
  return isOpenCodeToolRow(text)
    || isOpenCodeBanner(text)
    || openCodeTurnFooter(text) !== null
    || /^ ?›\s/u.test(text);
}

/** The columns a wrapped row is indented by without anything having been
 * written there: OpenCode hangs the continuation of a list item under its
 * text. Anything past that is a space the wrap swallowed. */
function hangingIndent(opener: string): number {
  const indent = opener.length - opener.trimStart().length;
  return indent + (/^\s*[-*+•]\s/u.test(opener) ? 2 : 0);
}

/** Characters a long token is broken *inside* rather than after: a path's
 * slash, a hyphenated name, a dotted host or version. A row that ends on one
 * is rejoined with nothing between. */
const TOKEN_TAIL = /[/\-_:=.]$/u;

/** Whether `next` is the rest of `previous`, wrapped — and with what between
 * them.
 *
 * OpenCode wraps greedily at the pane width, so a break is *explained*: either
 * the row ran into the last column, or the next row's first word would not
 * have fitted after it. A row that ends well short of the width with room for
 * that word to follow was broken by the session on purpose, and stays broken.
 *
 * What belongs in the seam is read the same way, from the three things the
 * wrap can have done with the space it broke at:
 *   - it kept it, and the row below opens indented past its hanging indent
 *     (`…(Capacitor,` + `   wraps Web UI`) — the space comes back;
 *   - it broke a long token at the token's own punctuation
 *     (`github.com/dzianisv/` + `opencode-mobile`, `~/.` + `local/share`) —
 *     nothing comes back, and a sentence is spared by its capital: a `.` is
 *     only read this way when what follows it is lower-case or a digit;
 *   - it cut at the last column, which leaves nothing to say — the row is
 *     rejoined as it stood.
 * Getting one of these wrong costs a space, which is why the rule is allowed
 * to be this simple: nothing is dropped either way.
 */
function wrapSeam(previous: string, next: string, columns: number, opener: string): string | null {
  if (!previous.trim() || !next.trim() || opensBlock(next)) return null;
  const rest = next.trimStart();
  const word = /^\S+/u.exec(rest)?.[0] ?? "";
  const cut = previous.length >= columns;
  // A word "fits" only with a column to spare: OpenCode wraps a word that
  // would end exactly on the last column, so a row broken there is a wrap and
  // not a newline the session wrote (`Thinking: … for` + `opencode using …`,
  // 51 + 1 + 8 at 60 columns, from a capture).
  if (!cut && previous.length + 1 + word.length < columns) return null;
  if (next.length - rest.length > hangingIndent(opener)) return " ";
  if (TOKEN_TAIL.test(previous) && /^[A-Za-z0-9]/u.test(rest)) {
    if (!previous.endsWith(".") || /^[a-z0-9]/u.test(rest)) return "";
  }
  return cut ? "" : " ";
}

/**
 * The lines with OpenCode's own wrapping undone, so the phone re-wraps them at
 * *its* width — what `readableScreen` does for every other CLI by rejoining
 * the rows xterm wrapped.
 *
 * OpenCode cannot be helped that way: it wraps its output itself and prints
 * each row as its own line, so the terminal never marks one as a continuation
 * and the reading view showed the pane's column count as hard breaks,
 * re-wrapped again at the phone's width into ragged half-lines. `columns` is
 * the pane's width, which is what OpenCode wrapped against.
 */
export function joinOpenCodeWraps(lines: readonly ReadableLine[], columns: number): ReadableLine[] {
  if (!(columns > 0)) return [...lines];
  const out: ReadableLine[] = [];
  /** The last *physical* row appended, which is what OpenCode wrapped against
   * — not the line it has been joined onto. */
  let physical = "";
  for (const line of lines) {
    const previous = out[out.length - 1];
    const seam = previous ? wrapSeam(physical, line.text, columns, previous.text) : null;
    physical = line.text;
    if (previous && seam !== null) {
      const indent = line.text.length - line.text.trimStart().length;
      out[out.length - 1] = {
        ...previous,
        text: previous.text + seam + line.text.slice(indent),
        spans: [...previous.spans, ...(seam ? [{ text: seam }] : []), ...dropLeading(line.spans, indent)],
      };
      continue;
    }
    out.push({ ...line });
  }
  return out;
}

/** A copy of `spans` with the first `count` characters removed — the indent
 * OpenCode puts on a wrapped list item, which the seam replaces. */
function dropLeading(spans: readonly ReadableSpan[], count: number): ReadableSpan[] {
  if (count <= 0) return [...spans];
  const out: ReadableSpan[] = [];
  let remaining = count;
  for (const span of spans) {
    if (remaining >= span.text.length) {
      remaining -= span.text.length;
      continue;
    }
    out.push(remaining > 0 ? { ...span, text: span.text.slice(remaining) } : span);
    remaining = 0;
  }
  return out;
}

/**
 * OpenCode's own picker, which it opens from its command palette (ctrl+p)
 * rather than from a slash command — mini has no `/model` at all, and sending
 * one there would post the words to the model as a prompt.
 *
 * Both interfaces draw the same overlay, and it is not the numbered dialog
 * `selectPrompt` reads: a title, a search field, then the rows, each a label
 * with an optional tag in a second column. So it is read here and answered by
 * *typing* — `openCodePickKeys` clears the search field, types the row's label
 * and submits, which is how a person uses it and what a capture of a live
 * session confirms. The picker filters on the label as printed, provider and
 * all (`Grok 4.5 GitHub Copilot` finds the one row), so nothing has to be
 * taken apart to answer with it.
 *
 * Where the two differ is the geometry, and the geometry is all this reads:
 *
 *   - **mini** draws the overlay full width, two columns in, and marks the
 *     highlighted row in colour alone.
 *   - the **full TUI** centres it — 82 columns in on a 215-column pane — and
 *     marks the highlight with a `●` two columns left of the labels. It also
 *     paints the dialog over its own composer box, so rows can carry that
 *     box's `┃` and fragments of its text to the *left* of the dialog.
 *
 * So the rows are read by column rather than by indent: the title's column is
 * the dialog's, everything left of it on a row is the screen behind it, and
 * everything from it is the row. That is also what holds the full TUI's rows
 * together across the blank line it leaves between provider groups — mini's
 * list is one block, the full TUI's is several, and a blank row in the middle
 * of the dialog's own column band is a separator, not the end of the list.
 *
 * A group header (`OpenCode Zen`) is listed like any other row — nothing but
 * its colour tells it from a model. Tapping one types its name, which filters
 * the picker to that group instead of picking anything, and the sheet reads
 * the narrowed list as the next step. That is the graceful end of the one
 * ambiguity here.
 */
const PICKER_TITLE = /^(\s+)(Select [a-z][\w ]{0,30}?)(?:\s+\d+(?:\/\d+)?)?(?:\s+esc)?$/u;
/** Rows read out of one picker. The full TUI lists every provider's models on
 * a tall pane; the cap only bounds a misread. */
const MAX_PICKER_ROWS = 40;
/** Blank rows the dialog may leave inside its own list — one between provider
 * groups, and `readableScreen` collapses any run to one. A second in a row is
 * the end of the overlay. */
const MAX_LIST_GAP = 1;
/** The dialog's own key hints, under the rows (`Connect provider ctrl+a
 * Favorite ctrl+f`). No model is named after a key. */
const PICKER_FOOTER = /(?:^|\s)ctrl\+\p{L}\b/u;
/** The full TUI's highlight, drawn left of the labels' column. Mini draws no
 * marker at all, so a picker without one simply reports no current row. */
const PICKER_MARK = /[●▸❯>]/u;
/** Narrower than any picker OpenCode draws: a title row that ends before this
 * is not the overlay's right edge. */
const MIN_PICKER_WIDTH = 24;
/** Two or more spaces — the gap before a row's tag (`Free`). */
const COLUMN_SPLIT = /\s{2,}/u;
const MAX_LABEL = 80;

export function readOpenCodePicker(lines: readonly { text: string }[]): SelectPrompt | null {
  let title = -1;
  let heading: RegExpExecArray | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    heading = PICKER_TITLE.exec(lines[index].text);
    if (heading) {
      title = index;
      break;
    }
  }
  if (title < 0 || !heading) return null;
  /** The column the dialog's own text starts at — the title's. */
  const column = heading[1].length;
  /** …and where it ends: the title row spans the overlay's whole width (its
   * `esc` sits at the far edge), so its own end is the dialog's. The full TUI
   * paints over the session's status bar as well as its composer box, and
   * without this the bar's tail rode into a row's second column (`GitHub
   * Copilot` · `ommands`). A title too short to bound anything — a dialog this
   * has misread, or one drawn without the hint — bounds nothing. */
  const right = lines[title].text.trimEnd().length;
  const end = right >= column + MIN_PICKER_WIDTH ? right : Number.POSITIVE_INFINITY;
  /** The row as the dialog drew it: what stands between the dialog's own two
   * columns, with whatever the screen behind it left on either side dropped. */
  const cell = (text: string) => (text.length > column ? text.slice(column, end).trimEnd() : "");
  let index = title + 1;
  const skipBlank = () => { while (index < lines.length && !lines[index].text.trim()) index += 1; };
  skipBlank();
  // The search field, whether it holds the placeholder or a typed query.
  if (index >= lines.length) return null;
  index += 1;
  skipBlank();
  const options: SelectPrompt["options"] = [];
  let current = -1;
  let gap = 0;
  for (; index < lines.length && options.length < MAX_PICKER_ROWS; index += 1) {
    const text = lines[index].text;
    if (!text.trim()) {
      // Between two groups of the same list; past the list, the end of it.
      gap += 1;
      if (gap > MAX_LIST_GAP || options.length === 0) break;
      continue;
    }
    const row = cell(text);
    // A line that reaches the dialog's column with nothing on it is the screen
    // behind the overlay showing past its left edge, not a row of the list.
    if (!row) break;
    if (PICKER_FOOTER.test(row)) break;
    const columns = row.split(COLUMN_SPLIT);
    const label = columns[0].trim();
    if (!label) break;
    gap = 0;
    if (PICKER_MARK.test(text.slice(0, column))) current = options.length;
    options.push({
      index: options.length,
      number: options.length + 1,
      label: label.slice(0, MAX_LABEL),
      description: columns.slice(1).join(" · ").trim() || undefined,
    });
  }
  if (options.length === 0) return null;
  // The picker's own heading is the line `start` points at, so it has no
  // question block above its rows: the model sheet reads the rows and the
  // heading, never the screen around them.
  return {
    options,
    current,
    start: title,
    question: title,
    context: title,
    title: heading[2].trim(),
  };
}

/** ctrl+p — the only way into OpenCode mini's commands. */
const PALETTE = "";
/** ctrl+u — clears the picker's search field, so a second tap never types onto
 * what the first one left there. */
const CLEAR_SEARCH = "";

/** The keys that open the model picker: the palette, the word that finds
 * "Switch model" in it, and Enter. */
export const OPENCODE_MODEL_KEYS = [PALETTE, "model", "\r"];

/** The keys that answer the picker with `label`: clear the search, type the
 * label, submit. A label the pane truncated (`Ling 3.0 Flash Fin…`) is typed
 * without its ellipsis — the picker filters on a prefix, so the shorter query
 * still finds the row, while the `…` itself would match nothing. */
export function openCodePickKeys(label: string): string[] {
  return [CLEAR_SEARCH, label.replace(/\s*(?:…|\.\.\.)$/u, "").trim(), "\r"];
}
