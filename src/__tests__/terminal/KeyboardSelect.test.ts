/**
 * Keyboard select (lib/terminal/keyboardSelect): the cursor walk, the anchor
 * Shift / v / V set, and the span Enter copies.
 */
import { describe, it, expect } from "vitest";
import {
  keySelectHighlight,
  keySelectRange,
  keySelectStep,
  scrollToShow,
  startKeySelect,
  type KeySelectKey,
  type KeySelectState,
} from "../../lib/terminal/keyboardSelect";

const LINES = ["alpha beta gamma", "", "delta epsilon"];
const geo = { cols: 20, rows: 2, length: LINES.length, lineText: (y: number) => LINES[y] ?? "" };
const k = (key: string, mods: Partial<KeySelectKey> = {}): KeySelectKey => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

/** Run `keys` from `state` and return where the mode ends up. */
function walk(state: KeySelectState, ...keys: KeySelectKey[]): KeySelectState {
  for (const key of keys) {
    const step = keySelectStep(state, key, geo);
    if (step.kind !== "move") throw new Error(`${key.key} gave ${step.kind}`);
    state = step.state;
  }
  return state;
}

const at = (x: number, y: number): KeySelectState => ({ cursor: { x, y }, anchor: null, lines: false });

describe("keyboard select", () => {
  it("starts on the terminal cursor, or refines an existing mouse selection", () => {
    expect(startKeySelect({ x: 3, y: 1 }, undefined, 20)).toEqual(at(3, 1));
    const refined = startKeySelect({ x: 0, y: 0 }, { start: { x: 2, y: 0 }, end: { x: 5, y: 2 } }, 20);
    expect(refined).toEqual({ cursor: { x: 4, y: 2 }, anchor: { x: 2, y: 0 }, lines: false });
  });

  it("moves by cell, wrapping at the row ends and stopping at the buffer's", () => {
    expect(walk(at(0, 1), k("ArrowLeft")).cursor).toEqual({ x: 19, y: 0 });
    expect(walk(at(19, 0), k("l")).cursor).toEqual({ x: 0, y: 1 });
    expect(walk(at(0, 0), k("ArrowUp"), k("h")).cursor).toEqual({ x: 0, y: 0 });
    expect(walk(at(0, 2), k("j"), k("PageDown")).cursor).toEqual({ x: 0, y: 2 });
  });

  it("jumps by word, line end and buffer end", () => {
    expect(walk(at(0, 0), k("ArrowRight", { ctrlKey: true })).cursor).toEqual({ x: 6, y: 0 });
    // Past the last word the walk crosses the blank row to the next word.
    expect(walk(at(11, 0), k("ArrowRight", { ctrlKey: true })).cursor).toEqual({ x: 0, y: 2 });
    expect(walk(at(0, 2), k("ArrowLeft", { ctrlKey: true })).cursor).toEqual({ x: 11, y: 0 });
    expect(walk(at(0, 0), k("End")).cursor).toEqual({ x: 15, y: 0 });
    expect(walk(at(5, 0), k("G", { shiftKey: true })).cursor).toEqual({ x: 12, y: 2 });
    expect(walk(at(5, 2), k("g")).cursor).toEqual({ x: 0, y: 0 });
  });

  it("Shift+move anchors where the cursor was; G and $ do not", () => {
    const s = walk(at(2, 0), k("ArrowRight", { shiftKey: true }), k("ArrowRight", { shiftKey: true }));
    expect(s.anchor).toEqual({ x: 2, y: 0 });
    expect(keySelectRange(s, 20)).toEqual({ start: { x: 2, y: 0 }, end: { x: 5, y: 0 } });
    expect(walk(at(2, 0), k("G", { shiftKey: true })).anchor).toBeNull();
    expect(walk(at(2, 0), k("$", { shiftKey: true })).anchor).toBeNull();
  });

  it("selects backwards as well as forwards", () => {
    const s = walk(at(4, 2), k("v"), k("ArrowUp"), k("ArrowUp"));
    expect(keySelectRange(s, 20)).toEqual({ start: { x: 4, y: 0 }, end: { x: 5, y: 2 } });
  });

  it("v toggles a character selection, V a line one", () => {
    const v = walk(at(3, 0), k("v"));
    expect(v.anchor).toEqual({ x: 3, y: 0 });
    expect(walk(v, k("v")).anchor).toBeNull();
    const lines = walk(at(3, 0), k("V"), k("j"));
    expect(keySelectRange(lines, 20)).toEqual({ start: { x: 0, y: 0 }, end: { x: 20, y: 1 } });
    expect(keySelectHighlight(lines, 20)).toEqual({ column: 0, row: 0, length: 40 });
    expect(walk(lines, k("V")).anchor).toBeNull();
  });

  it("with nothing anchored, shows the cursor and copies its row", () => {
    expect(keySelectHighlight(at(7, 1), 20)).toEqual({ column: 7, row: 1, length: 1 });
    expect(keySelectRange(at(7, 2), 20)).toEqual({ start: { x: 0, y: 2 }, end: { x: 20, y: 2 } });
  });

  it("copies on Enter, y and Ctrl+C; leaves on Esc, q and the entry chord", () => {
    for (const key of [k("Enter"), k("y"), k("c", { ctrlKey: true }), k("C", { ctrlKey: true, shiftKey: true })]) {
      expect(keySelectStep(at(0, 0), key, geo).kind).toBe("copy");
    }
    for (const key of [k("Escape"), k("q"), k("X", { ctrlKey: true, shiftKey: true })]) {
      expect(keySelectStep(at(0, 0), key, geo).kind).toBe("exit");
    }
    expect(keySelectStep(at(0, 0), k("z"), geo).kind).toBe("ignore");
    expect(keySelectStep(at(0, 0), k("c"), geo).kind).toBe("ignore");
  });

  it("scrolls only when the cursor leaves the viewport", () => {
    expect(scrollToShow(5, 3, 4)).toBeNull();
    expect(scrollToShow(2, 3, 4)).toBe(2);
    expect(scrollToShow(9, 3, 4)).toBe(6);
  });
});
