/**
 * Pure multi-selection logic for the right-panel file tree: a shift-range spans
 * the contiguous slice of the visible order, ctrl/cmd toggles a single row, and
 * a plain click collapses to one. These lock the range math (order-independent,
 * inclusive) and the click state machine (selection + anchor transitions).
 */
import { describe, it, expect } from "vitest";

import { rangeSelect, nextSelection } from "../lib/viewers/fileUtils";

const ORDER = ["/p/a", "/p/b", "/p/c", "/p/d", "/p/e"];

describe("rangeSelect", () => {
  it("returns the inclusive slice anchor→target", () => {
    expect(rangeSelect(ORDER, "/p/b", "/p/d")).toEqual(["/p/b", "/p/c", "/p/d"]);
  });

  it("is order-independent (target above anchor)", () => {
    expect(rangeSelect(ORDER, "/p/d", "/p/b")).toEqual(["/p/b", "/p/c", "/p/d"]);
  });

  it("a single-row range is just that row", () => {
    expect(rangeSelect(ORDER, "/p/c", "/p/c")).toEqual(["/p/c"]);
  });

  it("falls back to the target when an endpoint is gone", () => {
    expect(rangeSelect(ORDER, "/p/gone", "/p/c")).toEqual(["/p/c"]);
  });
});

describe("nextSelection", () => {
  it("plain click selects only the row and sets the anchor", () => {
    const r = nextSelection(new Set(["/p/a", "/p/b"]), ORDER, "/p/a", "/p/d", {
      shift: false,
      toggle: false,
    });
    expect([...r.selected]).toEqual(["/p/d"]);
    expect(r.anchor).toBe("/p/d");
  });

  it("shift+anchor replaces selection with the range, anchor unchanged", () => {
    const r = nextSelection(new Set(["/p/b"]), ORDER, "/p/b", "/p/e", {
      shift: true,
      toggle: false,
    });
    expect([...r.selected]).toEqual(["/p/b", "/p/c", "/p/d", "/p/e"]);
    expect(r.anchor).toBe("/p/b");
  });

  it("shift without an anchor behaves like a plain click", () => {
    const r = nextSelection(new Set(["/p/a"]), ORDER, null, "/p/c", {
      shift: true,
      toggle: false,
    });
    expect([...r.selected]).toEqual(["/p/c"]);
    expect(r.anchor).toBe("/p/c");
  });

  it("toggle adds a row and moves the anchor", () => {
    const r = nextSelection(new Set(["/p/a"]), ORDER, "/p/a", "/p/c", {
      shift: false,
      toggle: true,
    });
    expect([...r.selected].sort()).toEqual(["/p/a", "/p/c"]);
    expect(r.anchor).toBe("/p/c");
  });

  it("toggle removes an already-selected row", () => {
    const r = nextSelection(new Set(["/p/a", "/p/c"]), ORDER, "/p/a", "/p/c", {
      shift: false,
      toggle: true,
    });
    expect([...r.selected]).toEqual(["/p/a"]);
    expect(r.anchor).toBe("/p/c");
  });
});
