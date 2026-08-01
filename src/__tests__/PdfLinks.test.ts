/**
 * The PDF's own hyperlinks (#pdf-links) — the pure half: which annotations become
 * clickable boxes, where those boxes sit, and where a destination points.
 *
 * The properties pinned here are the ones the feature's safety and its usefulness
 * both rest on: only a `Link` annotation with an action this viewer will honour is
 * rendered at all (so a `Launch`, a form widget or a `javascript:` URL pdf.js
 * refused to normalise can never become a click target); a destination resolves to
 * a 1-based FILE page **and** the y anchor the file names, so a `\ref` lands on its
 * line rather than at the top of the page; and an unresolvable destination is
 * dropped rather than rendered inert.
 */
import { describe, it, expect } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  rectFromAnnotation,
  linkFromAnnotation,
  destRole,
  type RawAnnotation,
  type RectViewport,
} from "../components/embed/pdf/links";
import { destTop, resolveDest } from "../components/embed/pdf/outline";

/** A scale-1, unrotated viewport over a 792bp-tall page: PDF user space is
 *  bottom-left origin, the viewport top-left, so y flips. */
const viewport: RectViewport = {
  convertToViewportRectangle: ([x1, y1, x2, y2]) => [x1, 792 - y1, x2, 792 - y2],
};

/** A minimal fake document: named destinations plus `{num}` page refs. */
function fakeDoc(named: Record<string, unknown[]> = {}): PDFDocumentProxy {
  return {
    getDestination: async (name: string) => named[name] ?? null,
    getPageIndex: async (ref: { num?: number }) => {
      if (ref && typeof ref.num === "number") return ref.num;
      throw new Error("bad ref");
    },
  } as unknown as PDFDocumentProxy;
}

describe("rectFromAnnotation", () => {
  it("normalises the corners into a top-left box in big points", () => {
    // The PDF gives (x1,y1) as the LOWER-left corner, so the converted y2 is the
    // smaller number — the box must not come out with a negative height.
    expect(rectFromAnnotation(3, [100, 700, 260, 712], viewport)).toEqual({
      page: 3,
      x: 100,
      y: 80,
      w: 160,
      h: 12,
    });
  });

  it("survives a rect given corner-swapped", () => {
    const a = rectFromAnnotation(1, [260, 712, 100, 700], viewport);
    expect(a).toEqual({ page: 1, x: 100, y: 80, w: 160, h: 12 });
  });
});

describe("destTop", () => {
  it("reads the top out of the slot each destination type spends it in", () => {
    expect(destTop([{ num: 0 }, { name: "XYZ" }, 100, 640, null])).toBe(640);
    expect(destTop([{ num: 0 }, { name: "FitH" }, 640])).toBe(640);
    expect(destTop([{ num: 0 }, { name: "FitBH" }, 640])).toBe(640);
    expect(destTop([{ num: 0 }, { name: "FitR" }, 10, 20, 300, 640])).toBe(640);
  });

  it("is null for a destination that names no position", () => {
    expect(destTop([{ num: 0 }, { name: "Fit" }])).toBeNull();
    expect(destTop([{ num: 0 }, { name: "FitB" }])).toBeNull();
    // PDF's "leave this coordinate unchanged" is a null argument, not a zero.
    expect(destTop([{ num: 0 }, { name: "XYZ" }, 100, null, null])).toBeNull();
  });
});

describe("resolveDest", () => {
  it("resolves a named destination to a 1-based page and its anchor", async () => {
    const doc = fakeDoc({ "sec:intro": [{ num: 4 }, { name: "XYZ" }, 90, 600, null] });
    expect(await resolveDest(doc, "sec:intro")).toEqual({ page: 5, top: 600 });
  });

  it("accepts an explicit array and an already-0-based page index", async () => {
    expect(await resolveDest(fakeDoc(), [{ num: 2 }, { name: "Fit" }])).toEqual({
      page: 3,
      top: null,
    });
    expect(await resolveDest(fakeDoc(), [1, { name: "FitH" }, 300])).toEqual({
      page: 2,
      top: 300,
    });
  });

  it("returns null rather than throwing on a destination it cannot resolve", async () => {
    expect(await resolveDest(fakeDoc(), "nope")).toBeNull();
    expect(await resolveDest(fakeDoc(), [{ bad: true }, { name: "Fit" }])).toBeNull();
    expect(await resolveDest(fakeDoc(), null)).toBeNull();
    expect(await resolveDest(fakeDoc(), [])).toBeNull();
  });
});

describe("destRole", () => {
  it("reads a citation off the anchor hyperref writes for one", () => {
    expect(destRole("cite.knuth1984")).toBe("cite");
    expect(destRole("Hy@cite.1984")).toBe("cite");
    expect(destRole("cite:key")).toBe("cite");
  });

  it("answers 'cross-reference' for everything it cannot tell apart", () => {
    expect(destRole("section.2")).toBe("ref");
    expect(destRole("equation.1.4")).toBe("ref");
    // A name that merely starts with the letters is not the anchor — a section
    // labelled `citations` must not come out green.
    expect(destRole("citations")).toBe("ref");
    // An explicit destination array names nothing at all, and neither does a
    // link with no destination to classify.
    expect(destRole([{ num: 3 }, { name: "Fit" }])).toBe("ref");
    expect(destRole(null)).toBe("ref");
  });
});

describe("linkFromAnnotation", () => {
  const link = (raw: RawAnnotation, named: Record<string, unknown[]> = {}) =>
    linkFromAnnotation(fakeDoc(named), 2, raw, viewport, 0);

  it("makes an internal link out of a GoTo annotation", async () => {
    const l = await link(
      { id: "12R", subtype: "Link", rect: [100, 700, 160, 712], dest: "eq:1" },
      { "eq:1": [{ num: 6 }, { name: "XYZ" }, 90, 500, null] },
    );
    expect(l).toEqual({
      id: "2:12R",
      rect: { page: 2, x: 100, y: 80, w: 60, h: 12 },
      kind: "internal",
      role: "ref",
      dest: { page: 7, top: 500 },
    });
  });

  it("carries the role a citation's colour is drawn from", async () => {
    const l = await link(
      { subtype: "Link", rect: [100, 700, 130, 710], dest: "cite.knuth1984" },
      { "cite.knuth1984": [{ num: 20 }, { name: "Fit" }] },
    );
    expect(l?.kind === "internal" && l.role).toBe("cite");
  });

  it("makes an external link out of a URI annotation", async () => {
    const l = await link({
      subtype: "Link",
      rect: [10, 700, 200, 714],
      url: "https://example.org/paper",
    });
    expect(l?.kind).toBe("external");
    expect(l && "url" in l && l.url).toBe("https://example.org/paper");
    // No annotation id in the file → the index stands in, still page-scoped.
    expect(l?.id).toBe("2:0");
  });

  it("drops everything that is not a link this viewer will honour", async () => {
    // Not a Link annotation at all (a form field).
    expect(await link({ subtype: "Widget", rect: [0, 0, 10, 10], url: "https://x.test" })).toBeNull();
    // A Link with neither a URL nor a destination: pdf.js leaves `url` unset for
    // an action it refused (`javascript:`, `file:`) and for a Launch action, so
    // this is exactly what those arrive as.
    expect(await link({ subtype: "Link", rect: [0, 0, 100, 20] })).toBeNull();
    // A destination that resolves to nothing is dropped, not rendered inert.
    expect(
      await link({ subtype: "Link", rect: [0, 0, 100, 20], dest: "missing" }),
    ).toBeNull();
    // A degenerate box is not a target.
    expect(
      await link({ subtype: "Link", rect: [10, 700, 10, 700], url: "https://x.test" }),
    ).toBeNull();
    // A malformed rect never reaches the geometry.
    expect(await link({ subtype: "Link", rect: [1, 2], url: "https://x.test" })).toBeNull();
  });

  it("prefers the URL when an annotation carries both", async () => {
    const l = await link(
      { subtype: "Link", rect: [0, 700, 100, 720], url: "https://x.test", dest: "eq:1" },
      { "eq:1": [{ num: 1 }, { name: "Fit" }] },
    );
    expect(l?.kind).toBe("external");
  });
});
