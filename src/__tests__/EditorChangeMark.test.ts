/**
 * Unit tests for the change-tint trail helpers: `diffRange`/`editSpan` (the
 * inserted/replaced run between two drafts), `remapChangeRange` (re-mapping an
 * older run through a fresh edit), and `decorateChangeRanges` (the transparent
 * overlay that tints those runs, sequenced new→old by tier). Mirrors the
 * search-decoration tests.
 */
import { describe, it, expect } from "vitest";
import {
  diffRange,
  editSpan,
  remapChangeRange,
  decorateChangeRanges,
  decorateDeleteRanges,
} from "../components/embed/FileViewerPane";

describe("diffRange", () => {
  it("returns null when the text is unchanged", () => {
    expect(diffRange("hello", "hello")).toBeNull();
  });

  it("locates a single inserted run (in `next` coordinates)", () => {
    // "ab|cd" → typed "XY" → "abXYcd"
    expect(diffRange("abcd", "abXYcd")).toEqual({ start: 2, end: 4 });
  });

  it("locates an append at the end of the file", () => {
    expect(diffRange("foo", "foobar")).toEqual({ start: 3, end: 6 });
  });

  it("locates an insert at the very start", () => {
    expect(diffRange("bar", "foobar")).toEqual({ start: 0, end: 3 });
  });

  it("spans the replaced run when text is swapped", () => {
    // common prefix "a", common suffix "d"; middle "bc" → "XYZ"
    expect(diffRange("abcd", "aXYZd")).toEqual({ start: 1, end: 4 });
  });

  it("returns null for a pure deletion (zero-width in `next`)", () => {
    expect(diffRange("abXYcd", "abcd")).toBeNull();
  });

  it("handles repeated characters without drifting the suffix past the prefix", () => {
    // inserting one more "a" into "aaa": prefix/suffix both made of the same
    // char must still yield a single-char range, not a negative/overlapping one.
    const r = diffRange("aaa", "aaaa");
    expect(r).not.toBeNull();
    expect(r!.end - r!.start).toBe(1);
  });
});

describe("editSpan", () => {
  it("returns null for equal strings", () => {
    expect(editSpan("hi", "hi")).toBeNull();
  });

  it("reports the inserted run's prev/next ends (equal for a pure insert)", () => {
    // "ab|cd" → "abXYcd": replaces prev[2,2] with next[2,4]
    expect(editSpan("abcd", "abXYcd")).toEqual({ start: 2, endPrev: 2, endNext: 4 });
  });

  it("reports a pure deletion as a zero-width run in `next`", () => {
    // remove "XY" from "abXYcd": replaces prev[2,4] with next[2,2]
    expect(editSpan("abXYcd", "abcd")).toEqual({ start: 2, endPrev: 4, endNext: 2 });
  });

  it("reports a replacement spanning both prev and next runs", () => {
    expect(editSpan("abcd", "aXYZd")).toEqual({ start: 1, endPrev: 3, endNext: 4 });
  });
});

describe("remapChangeRange", () => {
  // An insert of "XY" at offset 2: prev[2,2] → next[2,4], delta +2.
  const insert = { start: 2, endPrev: 2, endNext: 4 };

  it("leaves a range entirely before the edit untouched", () => {
    expect(remapChangeRange({ start: 0, end: 2 }, insert)).toEqual({ start: 0, end: 2 });
  });

  it("shifts a range entirely after the edit by the length delta", () => {
    expect(remapChangeRange({ start: 2, end: 4 }, insert)).toEqual({ start: 4, end: 6 });
  });

  it("drops a range overlapping the edited region", () => {
    expect(remapChangeRange({ start: 1, end: 3 }, insert)).toBeNull();
  });

  it("shifts later ranges left through a deletion", () => {
    // remove "XY" from offset 2: prev[2,4] → next[2,2], delta -2.
    const del = { start: 2, endPrev: 4, endNext: 2 };
    expect(remapChangeRange({ start: 6, end: 8 }, del)).toEqual({ start: 4, end: 6 });
  });
});

describe("decorateChangeRanges", () => {
  it("wraps a single run in a tiered change-mark span, escaping the rest", () => {
    expect(decorateChangeRanges("a<b>c", [{ start: 1, end: 4, tier: 0 }])).toBe(
      'a<span class="file-viewer-change-mark tier-0">&lt;b&gt;</span>c',
    );
  });

  it("tints several runs in source order with their own tiers", () => {
    expect(
      decorateChangeRanges("abcde", [
        { start: 3, end: 4, tier: 0 },
        { start: 0, end: 1, tier: 1 },
      ]),
    ).toBe(
      '<span class="file-viewer-change-mark tier-1">a</span>bc' +
        '<span class="file-viewer-change-mark tier-0">d</span>e',
    );
  });

  it("escapes HTML inside a marked run too", () => {
    expect(decorateChangeRanges("x&y", [{ start: 1, end: 2, tier: 2 }])).toBe(
      'x<span class="file-viewer-change-mark tier-2">&amp;</span>y',
    );
  });

  it("clamps an out-of-range end to the source length", () => {
    expect(decorateChangeRanges("hi", [{ start: 0, end: 99, tier: 0 }])).toBe(
      '<span class="file-viewer-change-mark tier-0">hi</span>',
    );
  });

  it("emits plain escaped text when there are no usable ranges", () => {
    expect(decorateChangeRanges("a<b", [{ start: 2, end: 2, tier: 0 }])).toBe("a&lt;b");
  });
});

describe("decorateDeleteRanges", () => {
  it("injects the deleted text at its anchor with a zero fade offset", () => {
    // "hello world" had "world" removed → draft is "hello ", ghost anchored at 6.
    expect(
      decorateDeleteRanges("hello ", [{ id: 1, pos: 6, text: "world", born: 1000 }], 1000),
    ).toBe(
      'hello <span class="file-viewer-delete-mark" style="animation-delay:-0ms">world</span>',
    );
  });

  it("offsets the fade by the elapsed time since the ghost was born", () => {
    expect(
      decorateDeleteRanges("ab", [{ id: 1, pos: 2, text: "c", born: 500 }], 1700),
    ).toBe(
      'ab<span class="file-viewer-delete-mark" style="animation-delay:-1200ms">c</span>',
    );
  });

  it("escapes HTML in both the surrounding source and the deleted text", () => {
    expect(
      decorateDeleteRanges("x&y", [{ id: 1, pos: 1, text: "<b>", born: 0 }], 0),
    ).toBe(
      'x<span class="file-viewer-delete-mark" style="animation-delay:-0ms">&lt;b&gt;</span>&amp;y',
    );
  });

  it("orders several ghosts by anchor and clamps an out-of-range anchor", () => {
    expect(
      decorateDeleteRanges(
        "abc",
        [
          { id: 2, pos: 99, text: "Z", born: 0 },
          { id: 1, pos: 1, text: "Y", born: 0 },
        ],
        0,
      ),
    ).toBe(
      'a<span class="file-viewer-delete-mark" style="animation-delay:-0ms">Y</span>bc' +
        '<span class="file-viewer-delete-mark" style="animation-delay:-0ms">Z</span>',
    );
  });
});
