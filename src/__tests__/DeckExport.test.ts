/**
 * Tests for text layout (`deck/fonts`) and the PDF export (`deck/export`).
 *
 * The fonts half matters because **the editor and the exporter share it** — that
 * shared measurement is the only thing preventing the classic
 * WYSIWYG-over-PDF failure where the export silently reflows a paragraph.
 *
 * The export half is deliberately structural rather than pixel-exact: it asserts
 * page counts, that every object kind draws without throwing, and — most
 * usefully — that the things pdf-lib *cannot* do (crop an image, embed a GIF,
 * find a missing icon) surface as warnings instead of vanishing.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  type TextMetrics,
  listMarker,
  loadMetrics,
  lineOffset,
  standardFontFor,
  wrapText,
} from "../lib/viewers/deck/fonts";
import { exportDeck, exportPathFor } from "../lib/viewers/deck/export";
import {
  type Deck,
  type DeckObject,
  type TextStyle,
  blankSlide,
  defaultTextStyle,
  emptyDeck,
} from "../lib/viewers/deck/model";

let metrics: TextMetrics;
beforeAll(async () => {
  metrics = await loadMetrics();
});

const style = (over: Partial<TextStyle> = {}): TextStyle => ({
  ...defaultTextStyle(),
  ...over,
});

describe("standard font mapping", () => {
  it("maps each family and variant to its standard-14 face", () => {
    expect(standardFontFor({ family: "sans", bold: false, italic: false })).toBe(
      StandardFonts.Helvetica,
    );
    expect(standardFontFor({ family: "sans", bold: true, italic: true })).toBe(
      StandardFonts.HelveticaBoldOblique,
    );
    expect(standardFontFor({ family: "serif", bold: true, italic: false })).toBe(
      StandardFonts.TimesRomanBold,
    );
    expect(standardFontFor({ family: "mono", bold: false, italic: true })).toBe(
      StandardFonts.CourierOblique,
    );
  });
});

describe("metrics", () => {
  it("measures a wider string as wider, and bold as wider than regular", () => {
    const s = style();
    expect(metrics.width("iiii", s)).toBeLessThan(metrics.width("WWWW", s));
    expect(metrics.width("Hello", s)).toBeLessThan(
      metrics.width("Hello", style({ bold: true })),
    );
  });

  it("scales linearly with size", () => {
    const at10 = metrics.width("Hello", style({ size: 10 }));
    const at20 = metrics.width("Hello", style({ size: 20 }));
    expect(at20).toBeCloseTo(at10 * 2, 3);
  });

  it("gives an ascent smaller than the full height — that gap is the descender", () => {
    const s = style({ size: 20 });
    expect(metrics.ascent(s)).toBeGreaterThan(0);
    expect(metrics.ascent(s)).toBeLessThan(metrics.height(s));
  });

  it("estimates rather than throwing on a character outside WinAnsi", () => {
    // A CJK glyph the standard-14 fonts cannot measure. It must not return 0,
    // which would collapse the line.
    expect(metrics.width("漢字漢字", style())).toBeGreaterThan(0);
  });
});

describe("wrapText", () => {
  const s = style({ size: 12 });

  it("keeps a short line whole", () => {
    const lines = wrapText(metrics, "Hello world", s, 500);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Hello world");
  });

  it("breaks on words, and every line fits", () => {
    const lines = wrapText(metrics, "the quick brown fox jumps over the lazy dog", s, 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.width).toBeLessThanOrEqual(60.001);
  });

  it("never leaves trailing whitespace measured into a line", () => {
    const lines = wrapText(metrics, "alpha beta gamma delta", s, 50);
    for (const l of lines) expect(l.text).toBe(l.text.trimEnd());
  });

  it("breaks a single over-long word by character rather than overflowing", () => {
    const lines = wrapText(metrics, "https://example.com/a/very/long/path/indeed", s, 40);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.width).toBeLessThanOrEqual(40.001);
  });

  it("always breaks at an explicit newline", () => {
    const lines = wrapText(metrics, "one\ntwo\nthree", s, 1000);
    expect(lines.map((l) => l.text)).toEqual(["one", "two", "three"]);
    expect(lines.map((l) => l.source)).toEqual([0, 1, 2]);
  });

  it("keeps an empty line rather than swallowing it", () => {
    const lines = wrapText(metrics, "a\n\nb", s, 1000);
    expect(lines).toHaveLength(3);
    expect(lines[1].text).toBe("");
  });

  it("marks only the FIRST visual line of a wrapped list item", () => {
    const lines = wrapText(
      metrics,
      "a list item long enough to wrap onto a second line\nsecond item",
      s,
      60,
      { kind: "number", start: 1 },
    );
    const first = lines.filter((l) => l.source === 0);
    expect(first.length).toBeGreaterThan(1);
    expect(first[0].marker).toBe("1.");
    expect(first.slice(1).every((l) => l.marker === undefined)).toBe(true);
    expect(lines.find((l) => l.source === 1)?.marker).toBe("2.");
  });

  it("indents every line of a list, including the continuations", () => {
    const lines = wrapText(metrics, "wrapping list item text here", s, 50, {
      kind: "bullet",
      start: 1,
    });
    expect(lines.every((l) => l.indent > 0)).toBe(true);
    expect(new Set(lines.map((l) => l.indent)).size).toBe(1);
  });
});

describe("list markers", () => {
  it("spells each kind", () => {
    expect(listMarker("bullet", 0, 1)).toBe("•");
    expect(listMarker("number", 2, 1)).toBe("3.");
    expect(listMarker("alpha", 0, 1)).toBe("a.");
    expect(listMarker("roman", 3, 1)).toBe("iv.");
  });

  it("honours a non-1 start", () => {
    expect(listMarker("number", 0, 5)).toBe("5.");
  });

  it("wraps alphabetic past 26 instead of producing 'aa'", () => {
    expect(listMarker("alpha", 26, 1)).toBe("a.");
  });
});

describe("lineOffset", () => {
  const line = { text: "x", indent: 10, width: 30, source: 0 };
  it("puts a left-aligned line at the indent", () => {
    expect(lineOffset(line, style({ align: "left" }), 100)).toBe(10);
  });
  it("centres within the space after the indent, not the whole box", () => {
    // avail = 100 - 10 = 90; (90 - 30) / 2 = 30; + indent.
    expect(lineOffset(line, style({ align: "center" }), 100)).toBeCloseTo(40);
  });
  it("right-aligns to the box's far edge", () => {
    expect(lineOffset(line, style({ align: "right" }), 100)).toBeCloseTo(70);
  });
  it("never produces a negative offset for a line wider than its box", () => {
    const wide = { ...line, width: 500 };
    expect(lineOffset(wide, style({ align: "center" }), 100)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** A minimal single-page PDF to act as a base plate. */
async function basePdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([400, 200]);
  return doc.save();
}

/** A 1×1 PNG. */
const PNG_1PX = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

function deckWith(objects: DeckObject[], slides = 1): Deck {
  const d = emptyDeck("talk.pdf");
  d.pageWidth = 400;
  d.pageHeight = 200;
  d.slides = Array.from({ length: slides }, (_, i) => ({
    ...blankSlide(i + 1),
    objects: i === 0 ? objects : [],
  }));
  return d;
}

const common = { x: 0.1, y: 0.1, w: 0.3, h: 0.2, rot: 0, opacity: 1 };

describe("exportDeck", () => {
  it("writes one page per slide, from the base plate", async () => {
    const r = await exportDeck({
      deck: deckWith([], 3),
      baseBytes: await basePdf(3),
      images: new Map(),
      posters: new Map(),
      metrics,
    });
    expect(r.pages).toBe(3);
    expect(r.warnings).toEqual([]);
    // A real PDF, not an empty buffer.
    expect(new TextDecoder().decode(r.bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("still produces pages when there is no base plate at all", async () => {
    const r = await exportDeck({
      deck: deckWith([], 2),
      baseBytes: null,
      images: new Map(),
      posters: new Map(),
      metrics,
    });
    expect(r.pages).toBe(2);
  });

  it("draws every object kind without throwing", async () => {
    const objects: DeckObject[] = [
      {
        ...common,
        id: "t",
        kind: "text",
        text: "Hello\nthere",
        style: style(),
        padding: 2,
        list: { kind: "bullet", start: 1 },
        fill: "#eeeeee",
      },
      {
        ...common,
        id: "s",
        kind: "shape",
        shape: "arrow",
        stroke: "#ff0000",
        strokeWidth: 2,
        head: "arrow",
        tail: "dot",
      },
      { ...common, id: "i", kind: "icon", icon: "star", color: "#0000ff", strokeWidth: 1.5 },
      { ...common, id: "m", kind: "image", src: "pic.png", fit: "contain" },
    ];
    const r = await exportDeck({
      deck: deckWith(objects),
      baseBytes: await basePdf(),
      images: new Map([["pic.png", PNG_1PX]]),
      posters: new Map(),
      metrics,
    });
    expect(r.pages).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it("draws rotated objects too", async () => {
    const r = await exportDeck({
      deck: deckWith([
        { ...common, id: "s", kind: "shape", shape: "rect", stroke: "#000000", strokeWidth: 1, rot: 37 },
        {
          ...common,
          id: "t",
          kind: "text",
          text: "tilted",
          style: style(),
          padding: 1,
          rot: -12,
        },
      ]),
      baseBytes: await basePdf(),
      images: new Map(),
      posters: new Map(),
      metrics,
    });
    expect(r.warnings).toEqual([]);
  });

  it("skips a hidden object", async () => {
    const r = await exportDeck({
      deck: deckWith([
        { ...common, id: "m", kind: "image", src: "gone.png", fit: "contain", hidden: true },
      ]),
      baseBytes: await basePdf(),
      images: new Map(),
      posters: new Map(),
      metrics,
    });
    // Hidden, so its absent bytes are not even looked for.
    expect(r.warnings).toEqual([]);
  });

  it("WARNS rather than silently dropping a missing image", async () => {
    const r = await exportDeck({
      deck: deckWith([{ ...common, id: "m", kind: "image", src: "gone.png", fit: "contain" }]),
      baseBytes: await basePdf(),
      images: new Map(),
      posters: new Map(),
      metrics,
    });
    expect(r.warnings.join(" ")).toContain("gone.png");
  });

  it("warns that `cover` cannot be cropped, and fits instead", async () => {
    const r = await exportDeck({
      deck: deckWith([{ ...common, id: "m", kind: "image", src: "pic.png", fit: "cover" }]),
      baseBytes: await basePdf(),
      images: new Map([["pic.png", PNG_1PX]]),
      posters: new Map(),
      metrics,
    });
    expect(r.warnings.join(" ")).toContain("cover");
  });

  it("warns about an icon this build does not have", async () => {
    const r = await exportDeck({
      deck: deckWith([
        { ...common, id: "i", kind: "icon", icon: "from-the-future", color: "#000000", strokeWidth: 1 },
      ]),
      baseBytes: await basePdf(),
      images: new Map(),
      posters: new Map(),
      metrics,
    });
    expect(r.warnings.join(" ")).toContain("from-the-future");
  });

  it("writes a poster PAGE for an interstitial, between its slides", async () => {
    const deck = deckWith([], 2);
    deck.slides[0].after = {
      id: "g1",
      src: "anim.gif",
      fit: "contain",
      background: "#000000",
      advance: { on: "manual" },
      poster: 0,
    };
    const r = await exportDeck({
      deck,
      baseBytes: await basePdf(2),
      images: new Map(),
      posters: new Map([["g1", PNG_1PX]]),
      metrics,
    });
    expect(r.pages).toBe(3); // slide, poster, slide
    expect(r.warnings).toEqual([]);
  });

  it("omits interstitial pages when the deck says not to", async () => {
    const deck = deckWith([], 2);
    deck.theme.exportInterstitials = false;
    deck.slides[0].after = {
      id: "g1",
      src: "anim.gif",
      fit: "contain",
      background: "#000000",
      advance: { on: "manual" },
      poster: 0,
    };
    const r = await exportDeck({
      deck,
      baseBytes: await basePdf(2),
      images: new Map(),
      posters: new Map(),
      metrics,
    });
    expect(r.pages).toBe(2);
  });

  it("produces a valid one-page PDF for a deck with no slides at all", async () => {
    const r = await exportDeck({
      deck: emptyDeck(null),
      baseBytes: null,
      images: new Map(),
      posters: new Map(),
      metrics,
    });
    expect(r.pages).toBe(1);
    expect(r.warnings.join(" ")).toContain("no slides");
  });

  it("survives a corrupt base plate instead of failing the whole export", async () => {
    const r = await exportDeck({
      deck: deckWith([], 2),
      baseBytes: new Uint8Array([1, 2, 3, 4]),
      images: new Map(),
      posters: new Map(),
      metrics,
    });
    expect(r.pages).toBe(2); // blank pages at the deck's own size
    expect(r.warnings.join(" ")).toContain("base PDF");
  });
});

describe("exportPathFor", () => {
  it("names the output beside the deck", () => {
    expect(exportPathFor("/p/talk.eldeck.json")).toBe("/p/talk.export.pdf");
  });
});
