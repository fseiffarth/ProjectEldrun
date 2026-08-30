/**
 * Turns xterm's emulated screen into a readable, phone-width rendering of the
 * *same* session — colours, emphasis and all.
 *
 * This deliberately replaces the earlier semantic parser, which classified each
 * line by regex into prompt/tool/success/warning/error cards. That parser was
 * guessing: it turned a numbered list inside an ordinary answer into an
 * "approval dialog" with buttons that injected keystrokes, split a tool call
 * from its own result, and threw away the colour the program had already sent.
 *
 * Here nothing is inferred. Style comes from the cells the program actually
 * wrote, and the only thing dropped is box-drawing decoration — announced
 * whenever earlier output is left out.
 */

export interface ReadableSpan {
  text: string;
  /** Space-separated attribute classes (`b`, `i`, `u`, `d`, `s`). */
  className?: string;
  color?: string;
  background?: string;
}

export interface ReadableLine {
  /** Stable across frames: the absolute buffer row the logical line starts at. */
  key: string;
  text: string;
  spans: ReadableSpan[];
}

export interface ReadableScreen {
  lines: ReadableLine[];
  /** Whether output above the first rendered line exists but is not shown. */
  clipped: boolean;
}

export interface ReadableCellLike {
  getChars(): string;
  getWidth(): number;
  isBold(): number;
  isItalic(): number;
  isDim(): number;
  isUnderline(): number;
  isStrikethrough(): number;
  isInverse(): number;
  isInvisible(): number;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  getFgColor(): number;
  getBgColor(): number;
}

export interface ReadableLineLike {
  readonly isWrapped?: boolean;
  readonly length?: number;
  translateToString(trimRight?: boolean): string;
  getCell?(x: number, cell?: ReadableCellLike): ReadableCellLike | undefined;
}

export interface ReadableBufferLike {
  readonly length: number;
  getLine(row: number): ReadableLineLike | undefined;
}

/** Rows read off the end of the buffer. Bounds the per-frame cost on a phone. */
export const MAX_ROWS = 1_200;
/** Logical lines kept after joining and blank-collapsing. */
export const MAX_LINES = 400;
/** A single logical line longer than this is clipped, with a marker. */
const MAX_LINE = 4_000;

export const TRUNCATION_NOTICE =
  "Earlier output is not shown here. Switch to Terminal for the full session.";

/** The default foreground/background of the phone terminal theme. Needed to
 * resolve `inverse` on a cell that is otherwise using terminal defaults. */
const DEFAULT_FG = "#e7e9f2";
const DEFAULT_BG = "#0b0d13";

/** The 16 ANSI colours, tuned for the dark reading background rather than for
 * a white terminal: the dim variants of blue and black stay legible. */
const BASE_16 = [
  "#3f4453", "#ed7180", "#55d187", "#f4c95d", "#7aa9f7", "#c39bf5", "#62d0d4", "#c8cdda",
  "#5b6273", "#ff97a2", "#7ce4a8", "#ffdd8a", "#9dc2ff", "#d9bbff", "#8fe6e8", "#f2f4fb",
];

const CUBE = [0, 95, 135, 175, 215, 255];

/** xterm's 256-colour palette: 16 base colours, a 6×6×6 cube, a 24-step ramp. */
function paletteColor(index: number) {
  if (index < 16) return BASE_16[index];
  if (index < 232) {
    const offset = index - 16;
    const r = CUBE[Math.floor(offset / 36) % 6];
    const g = CUBE[Math.floor(offset / 6) % 6];
    const b = CUBE[offset % 6];
    return `rgb(${r},${g},${b})`;
  }
  const level = 8 + (index - 232) * 10;
  return `rgb(${level},${level},${level})`;
}

function rgbColor(packed: number) {
  return `rgb(${(packed >> 16) & 0xff},${(packed >> 8) & 0xff},${packed & 0xff})`;
}

function cellColor(cell: ReadableCellLike, layer: "fg" | "bg") {
  const isDefault = layer === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return undefined;
  const isPalette = layer === "fg" ? cell.isFgPalette() : cell.isBgPalette();
  const value = layer === "fg" ? cell.getFgColor() : cell.getBgColor();
  if (isPalette) return paletteColor(value);
  const isRGB = layer === "fg" ? cell.isFgRGB() : cell.isBgRGB();
  return isRGB ? rgbColor(value) : undefined;
}

function styleOf(cell: ReadableCellLike): Omit<ReadableSpan, "text"> {
  let color = cellColor(cell, "fg");
  let background = cellColor(cell, "bg");
  if (cell.isInverse()) {
    const fg = color ?? DEFAULT_FG;
    const bg = background ?? DEFAULT_BG;
    color = bg;
    background = fg;
  }
  const classes: string[] = [];
  if (cell.isBold()) classes.push("b");
  if (cell.isItalic()) classes.push("i");
  if (cell.isUnderline()) classes.push("u");
  if (cell.isDim()) classes.push("d");
  if (cell.isStrikethrough()) classes.push("s");
  return {
    className: classes.length ? classes.join(" ") : undefined,
    color,
    background,
  };
}

function sameStyle(a: Omit<ReadableSpan, "text">, b: Omit<ReadableSpan, "text">) {
  return a.className === b.className && a.color === b.color && a.background === b.background;
}

/** Everything an agent draws its frames with. A line made only of these is
 * decoration, and on a phone it reflows into nonsense. */
const BORDER_ONLY = /^[\s─-╿▀-▟―—]+$/u;
/** A leading/trailing frame edge around real content on the same row. */
const LEFT_EDGE = /^\s*[│┃┆┇┊┋]\s?/u;
const RIGHT_EDGE = /\s*[│┃┆┇┊┋]\s*$/u;

/** Drops `count` characters from the front of a span run, in place. */
function trimSpansLeft(spans: ReadableSpan[], count: number) {
  let remaining = count;
  while (remaining > 0 && spans.length > 0) {
    const span = spans[0];
    if (span.text.length <= remaining) {
      remaining -= span.text.length;
      spans.shift();
    } else {
      span.text = span.text.slice(remaining);
      remaining = 0;
    }
  }
}

/** Drops `count` characters from the end of a span run, in place. */
function trimSpansRight(spans: ReadableSpan[], count: number) {
  let remaining = count;
  while (remaining > 0 && spans.length > 0) {
    const span = spans[spans.length - 1];
    if (span.text.length <= remaining) {
      remaining -= span.text.length;
      spans.pop();
    } else {
      span.text = span.text.slice(0, span.text.length - remaining);
      remaining = 0;
    }
  }
}

function pushSpan(spans: ReadableSpan[], span: ReadableSpan) {
  const previous = spans[spans.length - 1];
  if (previous && sameStyle(previous, span)) previous.text += span.text;
  else spans.push(span);
}

/** One buffer row as styled spans, padding included.
 *
 * Trailing blanks are *not* dropped here: a row that continues on the next one
 * can legitimately end in a space, and trimming it per row glued the last word
 * of one row to the first of the next ("come from" + "the session" read as
 * "come fromthe session"). The trim happens once the logical line is complete.
 */
function rowSpans(line: ReadableLineLike): ReadableSpan[] {
  if (typeof line.getCell !== "function") {
    const plain = line.translateToString();
    return plain ? [{ text: plain }] : [];
  }
  const spans: ReadableSpan[] = [];
  const width = line.length ?? line.translateToString().length;
  let cell: ReadableCellLike | undefined;
  for (let x = 0; x < width; x += 1) {
    cell = line.getCell(x, cell);
    if (!cell) break;
    // Width 0 is the trailing half of a wide glyph, already carried by the
    // cell before it.
    if (cell.getWidth() === 0) continue;
    const chars = cell.isInvisible() ? " ".repeat(cell.getChars().length || 1) : cell.getChars() || " ";
    pushSpan(spans, { text: chars, ...styleOf(cell) });
  }
  return spans;
}

/** Drops the blank cells a row is padded to the window width with. A styled
 * background would otherwise stretch a highlight across the whole screen. */
function trimTrailing(spans: ReadableSpan[]) {
  const text = spanText(spans);
  const trailing = text.length - text.replace(/\s+$/u, "").length;
  if (trailing > 0) trimSpansRight(spans, trailing);
  return spans;
}

function spanText(spans: ReadableSpan[]) {
  return spans.map((span) => span.text).join("");
}

/** Strips the frame an agent draws around its input box and dialogs. This is
 * decoration removal, not content filtering: a row that also carries text keeps
 * the text, a row made only of frame is `"border"`, and an empty row is
 * `"blank"` — the two are not the same, because a dropped border must not open
 * a paragraph break where the program drew none. */
function undecorate(spans: ReadableSpan[]): ReadableSpan[] | "blank" | "border" {
  const text = spanText(spans);
  if (!text.trim()) return "blank";
  if (BORDER_ONLY.test(text)) return "border";
  const left = LEFT_EDGE.exec(text);
  if (left) trimSpansLeft(spans, left[0].length);
  const right = RIGHT_EDGE.exec(spanText(spans));
  if (right) trimSpansRight(spans, right[0].length);
  return spans.length ? spans : "blank";
}

function capLine(line: ReadableLine): ReadableLine {
  if (line.text.length <= MAX_LINE) return line;
  const spans = line.spans.slice();
  trimSpansRight(spans, line.text.length - MAX_LINE);
  spans.push({ text: "… [line truncated]", className: "d" });
  return { ...line, text: `${line.text.slice(0, MAX_LINE)}… [line truncated]`, spans };
}

/**
 * Builds readable lines for buffer rows [first, end). Physical rows that xterm
 * wrapped are rejoined into the logical line the program emitted, so the phone
 * re-wraps at *its* width instead of showing the desktop tmux window's column
 * count as hard breaks.
 *
 * `afterText` is the text of the rendered line directly above this range. Blank
 * collapsing needs it at the seam: when the ranges above and below are built in
 * separate passes (the lazy history and the live tail), a paragraph break at
 * the start of this range survives exactly when the line above it holds text —
 * the same result one pass over both would produce. Absent or blank, leading
 * blanks are dropped, which is also how the whole-screen build never opens
 * with one.
 */
export function readableRange(
  buffer: ReadableBufferLike,
  first: number,
  end: number,
  afterText?: string,
): ReadableLine[] {
  const joined: ReadableLine[] = [];

  for (let row = first; row < end; row += 1) {
    const bufferLine = buffer.getLine(row);
    if (!bufferLine) continue;
    const spans = rowSpans(bufferLine);
    const previous = joined[joined.length - 1];
    if (bufferLine.isWrapped && previous) {
      // A wrapped continuation belongs to the line above it: join first, and
      // let the trim and the frame stripping run over the completed line.
      spans.forEach((span) => pushSpan(previous.spans, span));
      continue;
    }
    joined.push({ key: `r${row}`, text: "", spans });
  }
  joined.forEach((line) => { line.text = spanText(trimTrailing(line.spans)); });

  const lines: ReadableLine[] = [];
  for (const line of joined) {
    const spans = undecorate(line.spans);
    if (spans === "border") continue;
    if (spans === "blank") {
      // Collapse a run of blank rows — a repainting TUI leaves plenty — into a
      // single paragraph break, and never open the range with one unless the
      // caller says real text stands directly above it.
      const previousText = lines.length > 0 ? lines[lines.length - 1].text : afterText ?? "";
      if (previousText !== "") {
        lines.push({ key: `${line.key}b`, text: "", spans: [] });
      }
      continue;
    }
    lines.push(capLine({ key: line.key, text: spanText(spans), spans }));
  }
  return lines;
}

/**
 * Builds the bounded reading view: the last `maxRows` rows of the buffer,
 * capped to MAX_LINES logical lines. The fallback shape — the lazy history in
 * `readableHistory.ts` extends the same rendering backwards without the caps.
 */
export function readableScreen(buffer: ReadableBufferLike, maxRows = MAX_ROWS): ReadableScreen {
  const first = Math.max(0, buffer.length - maxRows);
  let clipped = first > 0;
  const lines = readableRange(buffer, first, buffer.length);
  while (lines.length > 0 && lines[lines.length - 1].text === "") lines.pop();

  if (lines.length > MAX_LINES) clipped = true;
  return { lines: lines.slice(-MAX_LINES), clipped };
}

/** The plain text of what the reading view is showing, for Copy. */
export function readableText(lines: readonly ReadableLine[]) {
  return lines.map((line) => line.text).join("\n");
}
