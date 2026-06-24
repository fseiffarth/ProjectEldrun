/**
 * Unit tests for the last-change marker helpers: `diffRange` (the inserted/
 * replaced run between two drafts) and `decorateChangeRange` (the transparent
 * overlay that tints that run). Mirrors the search-decoration tests.
 */
import { describe, it, expect } from "vitest";
import { diffRange, decorateChangeRange } from "../components/embed/FileViewerPane";

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

describe("decorateChangeRange", () => {
  it("wraps only the changed run in a change-mark span, escaping the rest", () => {
    expect(decorateChangeRange("a<b>c", { start: 1, end: 4 })).toBe(
      'a<span class="file-viewer-change-mark">&lt;b&gt;</span>c',
    );
  });

  it("escapes HTML inside the marked run too", () => {
    expect(decorateChangeRange("x&y", { start: 1, end: 2 })).toBe(
      'x<span class="file-viewer-change-mark">&amp;</span>y',
    );
  });

  it("clamps an out-of-range end to the source length", () => {
    expect(decorateChangeRange("hi", { start: 0, end: 99 })).toBe(
      '<span class="file-viewer-change-mark">hi</span>',
    );
  });

  it("emits plain escaped text for a degenerate (empty) range", () => {
    expect(decorateChangeRange("a<b", { start: 2, end: 2 })).toBe("a&lt;b");
  });
});
