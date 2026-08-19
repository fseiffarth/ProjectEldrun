/**
 * The quiet PDF reload: what makes a LaTeX recompile update the open document
 * without the flash it used to put on screen.
 *
 * Two pure pieces carry it, and both are pinned here.
 *
 * `keepPageIds` is why the page canvases survive a reload at all — the viewer
 * keys them by entry id, so a fresh identity arrangement with fresh ids remounts
 * every page and blanks the document. It must reuse an id ONLY where the sheet is
 * demonstrably the same one, or a kept canvas would stand for a page it never
 * painted.
 *
 * `fingerprintPage` is why an unchanged page then repaints nothing: two versions
 * of a page that draw the same thing must fingerprint the same, and any change to
 * what is drawn — a word, a coordinate, a figure, the sheet's size, its turn —
 * must not.
 */
import { describe, it, expect } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist";
import { keepPageIds, initialPages, SELF } from "../lib/viewers/pageModel";
import { fingerprintPage, samePage } from "../components/embed/pdf/pageFingerprint";

/** A minimal pdf.js page: a size, a `/Rotate`, and an operator list. */
function fakePage(
  ops: { fnArray: number[]; argsArray: unknown[] },
  size: { w: number; h: number } = { w: 595, h: 842 },
  rotate = 0,
): PDFPageProxy {
  return {
    rotate,
    getViewport: ({ rotation = 0 }: { scale: number; rotation?: number }) =>
      rotation % 180 === 0 ? { width: size.w, height: size.h } : { width: size.h, height: size.w },
    getOperatorList: async () => ops,
  } as unknown as PDFPageProxy;
}

/** Two glyphs' worth of "show this text", the shape pdf.js hands `showText`. */
const glyphs = (word: string) =>
  [...word].map((c) => ({ unicode: c, fontChar: c, width: 500, isSpace: c === " " }));

describe("keepPageIds", () => {
  it("carries the previous ids across a same-length reload", () => {
    const prev = initialPages(3);
    const next = initialPages(3);
    const kept = keepPageIds(prev, next);
    expect(kept.map((p) => p.id)).toEqual(prev.map((p) => p.id));
    // Everything else is the fresh list's — only the identity is borrowed.
    expect(kept.map((p) => p.page)).toEqual([1, 2, 3]);
  });

  it("gives fresh ids to pages the document grew", () => {
    const prev = initialPages(2);
    const next = initialPages(4);
    const kept = keepPageIds(prev, next);
    expect(kept.slice(0, 2).map((p) => p.id)).toEqual(prev.map((p) => p.id));
    expect(kept[2].id).not.toBe(prev[0].id);
    expect(kept[3].id).not.toBe(prev[1].id);
    expect(new Set(kept.map((p) => p.id)).size).toBe(4);
  });

  it("drops the ids a shorter document no longer has", () => {
    const prev = initialPages(5);
    const next = initialPages(2);
    const kept = keepPageIds(prev, next);
    expect(kept).toHaveLength(2);
    expect(kept.map((p) => p.id)).toEqual(prev.slice(0, 2).map((p) => p.id));
  });

  it("refuses an id whose old entry was a different sheet", () => {
    // A reordered arrangement: index 0 was showing page 3.
    const prev = initialPages(3);
    const reordered = [prev[2], prev[0], prev[1]];
    const kept = keepPageIds(reordered, initialPages(3));
    // Index 0 (file page 1) must NOT inherit the canvas that painted page 3.
    expect(kept[0].id).not.toBe(reordered[0].id);
    expect(kept[1].id).not.toBe(reordered[1].id);
  });

  it("refuses an id from a turned sheet or one carrying pending edits", () => {
    const prev = initialPages(3);
    const dirty = [
      { ...prev[0], rot: 90 as const },
      { ...prev[1], marks: [{ id: "m1", page: 2, x: 0, y: 0, w: 10, h: 10 }] },
      { ...prev[2], notes: [] },
    ];
    const kept = keepPageIds(dirty, initialPages(3));
    expect(kept.map((p) => p.id)).not.toContain(dirty[0].id);
    expect(kept.map((p) => p.id)).not.toContain(dirty[1].id);
    expect(kept.map((p) => p.id)).not.toContain(dirty[2].id);
  });

  it("refuses an id from a merged-in page", () => {
    const prev = initialPages(2).map((p) => ({ ...p, src: "s2" }));
    const kept = keepPageIds(prev, initialPages(2, SELF));
    expect(kept.map((p) => p.id)).not.toContain(prev[0].id);
  });
});

describe("fingerprintPage", () => {
  it("is stable across two loads of the same page", async () => {
    const ops = { fnArray: [1, 44, 2], argsArray: [[1, 0, 0, 1, 72, 720], [glyphs("Hello")], []] };
    const a = await fingerprintPage(fakePage(ops));
    const b = await fingerprintPage(fakePage({ ...ops, argsArray: [...ops.argsArray] }));
    expect(a).not.toBeNull();
    expect(samePage(a, b)).toBe(true);
  });

  it("changes when a word on the page changes", async () => {
    const a = await fingerprintPage(
      fakePage({ fnArray: [44], argsArray: [[glyphs("Hello")]] }),
    );
    const b = await fingerprintPage(
      fakePage({ fnArray: [44], argsArray: [[glyphs("Hallo")]] }),
    );
    expect(samePage(a, b)).toBe(false);
  });

  it("changes when text merely moves on the page", async () => {
    const at = (y: number) => ({
      fnArray: [1, 44],
      argsArray: [[1, 0, 0, 1, 72, y], [glyphs("Hello")]],
    });
    const a = await fingerprintPage(fakePage(at(720)));
    const b = await fingerprintPage(fakePage(at(700)));
    expect(samePage(a, b)).toBe(false);
  });

  it("changes when the drawing instructions change without the text", async () => {
    // A redrawn figure: same words, different vector ops.
    const a = await fingerprintPage(fakePage({ fnArray: [44, 91], argsArray: [[glyphs("Fig")], [0, 0, 10, 10]] }));
    const b = await fingerprintPage(fakePage({ fnArray: [44, 91], argsArray: [[glyphs("Fig")], [0, 0, 10, 20]] }));
    expect(samePage(a, b)).toBe(false);
  });

  it("changes when the sheet's size or turn changes", async () => {
    const ops = { fnArray: [44], argsArray: [[glyphs("Hello")]] };
    const a4 = await fingerprintPage(fakePage(ops));
    const letter = await fingerprintPage(fakePage(ops, { w: 612, h: 792 }));
    const turned = await fingerprintPage(fakePage(ops), 90);
    expect(samePage(a4, letter)).toBe(false);
    expect(samePage(a4, turned)).toBe(false);
  });

  it("survives float noise below a thousandth of a point", async () => {
    const a = await fingerprintPage(fakePage({ fnArray: [1], argsArray: [[1, 0, 0, 1, 72.00000001, 720]] }));
    const b = await fingerprintPage(fakePage({ fnArray: [1], argsArray: [[1, 0, 0, 1, 72, 720]] }));
    expect(samePage(a, b)).toBe(true);
  });

  it("reports null rather than throwing when the page cannot be read", async () => {
    const broken = {
      rotate: 0,
      getViewport: () => ({ width: 595, height: 842 }),
      getOperatorList: async () => {
        throw new Error("still being written");
      },
    } as unknown as PDFPageProxy;
    expect(await fingerprintPage(broken)).toBeNull();
  });
});

describe("samePage", () => {
  it("never treats a missing fingerprint as a match", () => {
    // Both directions: a page that has never been painted, and one whose
    // fingerprint could not be taken, must both fall through to a repaint.
    expect(samePage(null, null)).toBe(false);
    expect(samePage("a:1", null)).toBe(false);
    expect(samePage(null, "a:1")).toBe(false);
    expect(samePage(undefined, undefined)).toBe(false);
    expect(samePage("a:1", "a:1")).toBe(true);
  });
});
