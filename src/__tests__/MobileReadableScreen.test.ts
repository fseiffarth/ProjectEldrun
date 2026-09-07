import { describe, expect, it } from "vitest";
import {
  MAX_LINES,
  readableRange,
  readableScreen,
  readableText,
  type ReadableBufferLike,
  type ReadableCellLike,
} from "../../mobile-web/src/terminal/readableScreen";
import {
  HISTORY_CHUNK,
  HISTORY_MAX_LINES,
  absorbHistory,
  emptyHistory,
  lastHistoryText,
  shiftHistory,
} from "../../mobile-web/src/terminal/readableHistory";

/** Marks a row xterm wrapped from the row above it. An explicit glyph, not a
 * leading space: a wrap point regularly *is* a space, and the two must not be
 * the same character in a fixture about exactly that. */
const WRAP = "↵";

/** A buffer of plain rows: no cell attributes, the shape a terminal without
 * styling produces. */
function plainBuffer(rows: string[]): ReadableBufferLike {
  return {
    length: rows.length,
    getLine(row) {
      const source = rows[row];
      if (source === undefined) return undefined;
      const wrapped = source.startsWith(WRAP);
      const text = wrapped ? source.slice(1) : source;
      return { isWrapped: wrapped, translateToString: () => text };
    },
  };
}

interface FakeStyle {
  text: string;
  fg?: number;
  rgb?: number;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

/** A single styled row, cell by cell, mirroring xterm's `IBufferCell`. */
function styledBuffer(runs: FakeStyle[]): ReadableBufferLike {
  const cells: ReadableCellLike[] = [];
  for (const run of runs) {
    for (const char of run.text) {
      cells.push({
        getChars: () => char,
        getWidth: () => 1,
        isBold: () => (run.bold ? 1 : 0),
        isItalic: () => 0,
        isDim: () => (run.dim ? 1 : 0),
        isUnderline: () => 0,
        isStrikethrough: () => 0,
        isInverse: () => (run.inverse ? 1 : 0),
        isInvisible: () => 0,
        isFgDefault: () => run.fg === undefined && run.rgb === undefined,
        isBgDefault: () => true,
        isFgPalette: () => run.fg !== undefined,
        isBgPalette: () => false,
        isFgRGB: () => run.rgb !== undefined,
        isBgRGB: () => false,
        getFgColor: () => run.fg ?? run.rgb ?? 0,
        getBgColor: () => 0,
      });
    }
  }
  const text = runs.map((run) => run.text).join("");
  return {
    length: 1,
    getLine: () => ({
      length: cells.length,
      translateToString: () => text,
      getCell: (x) => cells[x],
    }),
  };
}

const texts = (buffer: ReadableBufferLike) => readableScreen(buffer).lines.map((line) => line.text);

describe("Eldrun Mobile readable terminal view", () => {
  it("rejoins wrapped rows so the phone re-wraps at its own width", () => {
    // The desktop tmux window is far wider than a phone. Keeping xterm's
    // physical breaks would show that window's column count as hard newlines.
    expect(texts(plainBuffer([
      "The agent explained the change in one long",
      `${WRAP} sentence that tmux had to wrap.`,
      "Next line.",
    ]))).toEqual([
      "The agent explained the change in one long sentence that tmux had to wrap.",
      "Next line.",
    ]);
  });

  it("keeps the space a row was wrapped on, and drops the row's padding", () => {
    // Trimming each row before joining glued the last word of one row to the
    // first of the next: "come from" + "the session" read as "come fromthe".
    expect(texts(plainBuffer(["come from ", `${WRAP}the session itself.`, "done      "])))
      .toEqual(["come from the session itself.", "done"]);
  });

  it("carries the colour and emphasis the program actually emitted", () => {
    // Style is read off the cells, never guessed from the words — the old
    // parser painted prose like \"Error handling in Rust\" as a red verdict.
    const [line] = readableScreen(styledBuffer([
      { text: "ok ", fg: 2, bold: true },
      { text: "plain ", },
      { text: "rgb", rgb: 0x8c7df4 },
    ])).lines;
    expect(line.spans.map((span) => [span.text, span.className, span.color])).toEqual([
      ["ok ", "b", "#55d187"],
      ["plain ", undefined, undefined],
      ["rgb", undefined, "rgb(140,125,244)"],
    ]);
  });

  it("resolves inverse video against the terminal's own colours", () => {
    const [line] = readableScreen(styledBuffer([{ text: "sel", inverse: true }])).lines;
    expect(line.spans[0].color).toBe("#0b0d13");
    expect(line.spans[0].background).toBe("#e7e9f2");
  });

  it("drops frame decoration but never the text inside it", () => {
    expect(texts(plainBuffer([
      "╭──────────────────────────────╮",
      "│ > run the tests              │",
      "╰──────────────────────────────╯",
    ]))).toEqual(["> run the tests"]);
  });

  it("keeps a numbered list as text instead of an answerable prompt", () => {
    // The old parser turned any run of numbered lines into an approval dialog
    // whose buttons typed those digits into the agent.
    expect(texts(plainBuffer([
      "Here is what I propose:",
      "  1. Keep xterm as the authority.",
      "  2. Render the buffer with its real colours.",
    ]))).toEqual([
      "Here is what I propose:",
      "  1. Keep xterm as the authority.",
      "  2. Render the buffer with its real colours.",
    ]);
  });

  it("collapses blank runs into one break and trims the edges", () => {
    expect(texts(plainBuffer(["", "", "first", "", "", "", "second", "", ""])))
      .toEqual(["first", "", "second"]);
  });

  it("says so whenever earlier output is left out", () => {
    const rows = Array.from({ length: MAX_LINES + 40 }, (_, index) => `line ${index}`);
    const screen = readableScreen(plainBuffer(rows));
    expect(screen.clipped).toBe(true);
    expect(screen.lines).toHaveLength(MAX_LINES);
    expect(screen.lines[screen.lines.length - 1].text).toBe(`line ${rows.length - 1}`);
  });

  it("keeps line keys stable while the session grows", () => {
    const rows = ["first", "second"];
    const before = readableScreen(plainBuffer(rows)).lines.map((line) => line.key);
    const after = readableScreen(plainBuffer([...rows, "third"])).lines.map((line) => line.key);
    // Keying on the buffer row means a new line does not remount every line
    // above it — which used to destroy a selection mid-gesture.
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it("clips a single runaway line rather than the whole view", () => {
    const [line] = readableScreen(plainBuffer(["x".repeat(40_000)])).lines;
    expect(line.text.endsWith("… [line truncated]")).toBe(true);
    expect(line.text.length).toBeLessThan(5_000);
  });

  it("copies out exactly what is on screen", () => {
    const screen = readableScreen(plainBuffer(["alpha", "", "beta"]));
    expect(readableText(screen.lines)).toBe("alpha\n\nbeta");
  });
});

describe("Eldrun Mobile lazy terminal history", () => {
  /** The combined reading — absorbed history plus the live tail, exactly as the
   * Focus view composes them. */
  const view = (buffer: ReadableBufferLike, history: ReturnType<typeof emptyHistory>) => {
    const tail = readableRange(buffer, history.end, buffer.length, lastHistoryText(history));
    while (tail.length > 0 && tail[tail.length - 1].text === "") tail.pop();
    return readableText([
      ...history.chunks.flatMap((chunk) => chunk.lines),
      ...history.open,
      ...tail,
    ]);
  };

  it("absorbs everything above the tail window, once, and reads seamlessly", () => {
    const rows = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    const history = emptyHistory();
    expect(absorbHistory(plainBuffer(rows), history, 5)).toBe(true);
    expect(history.end).toBe(25);
    // A second pass with no new output absorbs nothing more.
    expect(absorbHistory(plainBuffer(rows), history, 5)).toBe(false);
    expect(view(plainBuffer(rows), history)).toBe(rows.join("\n"));
  });

  it("never splits a wrapped logical line at the absorb boundary", () => {
    const rows = ["first", "a long line that", `${WRAP} tmux wrapped`, "prompt"];
    const history = emptyHistory();
    // The boundary lands on the continuation row; it backs off so the tail
    // rebuild re-joins the line whole.
    absorbHistory(plainBuffer(rows), history, 2);
    expect(history.end).toBe(1);
    expect(view(plainBuffer(rows), history)).toBe(
      "first\na long line that tmux wrapped\nprompt",
    );
  });

  it("keeps one paragraph break across the absorb seam and never doubles it", () => {
    const rows = ["above", "", "below", "prompt"];
    const history = emptyHistory();
    absorbHistory(plainBuffer(rows), history, 3);
    expect(history.end).toBe(1);
    expect(view(plainBuffer(rows), history)).toBe("above\n\nbelow\nprompt");
  });

  it("follows a scrollback trim without losing or doubling lines", () => {
    const rows = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const history = emptyHistory();
    absorbHistory(plainBuffer(rows), history, 10);
    // The buffer trims its oldest 12 rows and 12 new ones arrive.
    const grown = [...rows, ...Array.from({ length: 12 }, (_, index) => `line ${40 + index}`)];
    const trimmed = grown.slice(12);
    shiftHistory(history, 12);
    absorbHistory(plainBuffer(trimmed), history, 10);
    expect(history.lost).toBe(false);
    expect(view(plainBuffer(trimmed), history)).toBe(grown.join("\n"));
  });

  it("says so when rows were trimmed before they could be absorbed", () => {
    const history = emptyHistory();
    shiftHistory(history, 3);
    expect(history.end).toBe(0);
    expect(history.lost).toBe(true);
  });

  it("freezes full chunks with stable ids and bounds the memory", () => {
    const rows = Array.from({ length: HISTORY_MAX_LINES + 2 * HISTORY_CHUNK }, (_, index) => `line ${index}`);
    const history = emptyHistory();
    absorbHistory(plainBuffer(rows), history, 10);
    expect(history.chunks.every((chunk) => chunk.lines.length === HISTORY_CHUNK)).toBe(true);
    expect(history.open.length).toBeLessThan(HISTORY_CHUNK);
    // The oldest chunks were dropped to stay under the cap — and counted.
    const kept = history.chunks.reduce((sum, chunk) => sum + chunk.lines.length, 0);
    expect(kept).toBeLessThanOrEqual(HISTORY_MAX_LINES);
    expect(history.droppedLines).toBeGreaterThan(0);
    expect(history.droppedLines % HISTORY_CHUNK).toBe(0);
    // Keys are unique across chunks and the open tail (React keys).
    const keys = [...history.chunks.flatMap((chunk) => chunk.lines), ...history.open].map((line) => line.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
