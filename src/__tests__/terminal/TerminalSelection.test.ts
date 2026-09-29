import { beforeAll, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import {
  WRAP_SLACK,
  installMouseModeGuard,
  joinedSelectionText,
  rowJoin,
  type LineLike,
} from "../../lib/terminal/terminalSelection";

const COLS = 40;

/** A buffer row as xterm holds it: one cell per character, padded to COLS. */
function row(text: string, isWrapped = false): LineLike {
  const cells = text.padEnd(COLS, " ").slice(0, COLS);
  return {
    isWrapped,
    getCell: (x) => (x < COLS ? { getChars: () => cells[x], getWidth: () => 1 } : undefined),
    translateToString: (trimRight, start = 0, end = COLS) => {
      const s = cells.slice(start, end);
      return trimRight ? s.replace(/\s+$/u, "") : s;
    },
  };
}

function copy(rows: LineLike[], range?: { sx: number; ex: number }): string {
  return joinedSelectionText((y) => rows[y], COLS, {
    start: { x: range?.sx ?? 0, y: 0 },
    end: { x: range?.ex ?? COLS, y: rows.length - 1 },
  });
}

describe("rowJoin", () => {
  it("joins a row filled to the last column as-is (character wrap)", () => {
    expect(rowJoin(row("x".repeat(COLS)), row("yz"), COLS)).toBe("");
  });

  it("joins a TUI word wrap with a space when the next word could not have fit", () => {
    // 36 cells used; the 4-letter word needs 5 more → past COLS - WRAP_SLACK.
    const prev = "  " + "word ".repeat(6) + "word";
    expect(prev.length + 5).toBeGreaterThan(COLS - WRAP_SLACK);
    expect(rowJoin(row(prev), row("  next and more"), COLS)).toBe(" ");
  });

  it("keeps real line breaks", () => {
    // Short row: it simply ended.
    expect(rowJoin(row("short line"), row("next"), COLS)).toBeNull();
    // Blank rows, list items, agent markers and frames are never continuations.
    expect(rowJoin(row("x".repeat(COLS)), row(""), COLS)).toBeNull();
    expect(rowJoin(row("x".repeat(COLS)), row("  - item"), COLS)).toBeNull();
    expect(rowJoin(row("x".repeat(COLS)), row("2. step"), COLS)).toBeNull();
    expect(rowJoin(row("x".repeat(COLS)), row("⏺ Done."), COLS)).toBeNull();
    expect(rowJoin(row("│" + "x".repeat(COLS - 2) + "│"), row("│ more │"), COLS)).toBeNull();
    // A long URL under a short label was put on its own line on purpose.
    expect(rowJoin(row("See:"), row("https://example.com/" + "a".repeat(10)), COLS)).toBeNull();
  });
});

describe("joinedSelectionText", () => {
  it("rebuilds a word-wrapped paragraph and keeps the next paragraph apart", () => {
    const rows = [
      row("⏺ The quick brown fox jumps over the"),
      row("  lazy dog and keeps running far away"),
      row("  until the end."),
      row(""),
      row("  Second paragraph."),
    ];
    expect(copy(rows)).toBe(
      "⏺ The quick brown fox jumps over the lazy dog and keeps running far away until the end.\n\n  Second paragraph.",
    );
  });

  it("rejoins character-wrapped rows without inventing spaces", () => {
    const long = "abcdefghij".repeat(6);
    expect(copy([row(long.slice(0, COLS)), row(long.slice(COLS))])).toBe(long);
  });

  it("trusts xterm's own soft-wrap flag", () => {
    expect(copy([row("left"), row("right", true)])).toBe("leftright");
  });

  it("clips the first and last rows to the selection", () => {
    const rows = [row("⏺ The quick brown fox jumps over the"), row("  lazy dog and keeps running far away")];
    expect(copy(rows, { sx: 2, ex: 10 })).toBe("The quick brown fox jumps over the lazy dog");
  });
});

describe("mouse-mode guard (real xterm)", () => {
  const write = (term: Terminal, data: string) => new Promise<void>((r) => term.write(data, r));
  beforeAll(() => {
    // jsdom has no matchMedia; xterm's DPR watcher only needs it to exist.
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
  });

  async function setup() {
    const term = new Terminal({ cols: COLS, rows: 5 });
    term.open(document.createElement("div"));
    const guard = installMouseModeGuard(term);
    await write(term, "hello world\r\n");
    return { term, guard };
  }

  it("xterm itself drops the selection on a repeated tracking-on — the bug", async () => {
    const term = new Terminal({ cols: COLS, rows: 5 });
    term.open(document.createElement("div"));
    await write(term, "hello world\x1b[?1002h");
    term.select(0, 0, 5);
    await write(term, "\x1b[?1002h");
    expect(term.hasSelection()).toBe(false);
  });

  it("drops a tracking-on that changes nothing, so the selection survives", async () => {
    const { term } = await setup();
    await write(term, "\x1b[?1002h");
    term.select(0, 0, 5);
    await write(term, "\x1b[?1002h");
    expect(term.hasSelection()).toBe(true);
    expect(term.modes.mouseTrackingMode).toBe("drag");
  });

  it("holds a real change back during a drag and applies it on release", async () => {
    const { term, guard } = await setup();
    await write(term, "\x1b[?1002h");
    guard.beginDrag();
    term.select(0, 0, 5);
    await write(term, "\x1b[?1003h");
    expect(term.hasSelection()).toBe(true);
    expect(term.modes.mouseTrackingMode).toBe("drag");
    guard.endDrag();
    await write(term, "");
    expect(term.modes.mouseTrackingMode).toBe("any");
  });

  it("a tracking-off during the drag cancels the held-back on", async () => {
    const { term, guard } = await setup();
    await write(term, "\x1b[?1002h");
    guard.beginDrag();
    await write(term, "\x1b[?1003h\x1b[?1003l");
    guard.endDrag();
    await write(term, "");
    expect(term.modes.mouseTrackingMode).toBe("none");
  });

  it("a mode the program sends after the release wins over the replay", async () => {
    const { term, guard } = await setup();
    await write(term, "\x1b[?1002h");
    guard.beginDrag();
    await write(term, "\x1b[?1003h");
    // Queued ahead of the replay: PTY output that arrived before the release.
    term.write("\x1b[?1000h");
    guard.endDrag();
    await write(term, "");
    expect(term.modes.mouseTrackingMode).toBe("vt200");
  });

  it("never holds back a sequence that also switches other modes", async () => {
    const { term, guard } = await setup();
    guard.beginDrag();
    await write(term, "\x1b[?1049;1003h");
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.modes.mouseTrackingMode).toBe("any");
    guard.endDrag();
  });
});
