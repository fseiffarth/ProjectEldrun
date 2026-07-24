/**
 * Tests for the deck sidecar (`lib/viewers/deck/sidecar`).
 *
 * Two properties carry the whole feature and are tested hardest here:
 *
 *  1. **Parsing never throws and never cascades.** A deck is hand-editable text
 *     under git, so one badly merged object must not cost the author the other
 *     twenty slides.
 *  2. **Re-anchoring never silently drops a layer.** TeX rewrites the base PDF on
 *     every compile; inserting one slide renumbers every page after it. Anything
 *     `reconcile` cannot place has to end up in `detached`, not in the bin.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  type BasePage,
  deckPathForPdf,
  fingerprint,
  normalizeDeck,
  parseDeck,
  pdfPathForDeck,
  reattach,
  reconcile,
  serializeDeck,
} from "../lib/viewers/deck/sidecar";
import {
  type Deck,
  type DeckObject,
  type Slide,
  blankSlide,
  emptyDeck,
  resetIdCounter,
  setIdSuffixSource,
} from "../lib/viewers/deck/model";

beforeEach(() => {
  resetIdCounter();
  setIdSuffixSource(() => "");
});

function textObj(id: string, text = "hello"): DeckObject {
  return {
    id,
    kind: "text",
    text,
    style: {
      family: "sans",
      size: 14,
      bold: false,
      italic: false,
      color: "#111111",
      align: "left",
      lineHeight: 1.25,
    },
    padding: 2,
    x: 0.1,
    y: 0.1,
    w: 0.3,
    h: 0.1,
    rot: 0,
    opacity: 1,
  };
}

function page(n: number, text: string, lines?: number[]): BasePage {
  return { page: n, width: 364, height: 205, text, ...(lines ? { lines } : {}) };
}

describe("TeX-figure objects", () => {
  it("round-trips an image object's texSrc", () => {
    const deck: Deck = {
      ...emptyDeck("talk.pdf"),
      slides: [
        {
          ...blankSlide(1),
          objects: [
            {
              id: "o1",
              kind: "image",
              src: "talk.tex-figures/o1.png",
              texSrc: "talk.tex-figures/o1.tex",
              fit: "contain",
              x: 0.1,
              y: 0.1,
              w: 0.2,
              h: 0.2,
              rot: 0,
              opacity: 1,
            },
          ],
        },
      ],
    };
    const { deck: parsed } = parseDeck(serializeDeck(deck));
    const obj = parsed.slides[0].objects[0] as Extract<DeckObject, { kind: "image" }>;
    expect(obj.texSrc).toBe("talk.tex-figures/o1.tex");
  });

  it("drops texSrc for an ordinary image rather than inventing one", () => {
    const { deck } = normalizeDeck({
      slides: [
        {
          id: "s1",
          anchor: { page: 1 },
          objects: [{ kind: "image", src: "pic.png" }],
        },
      ],
    });
    const obj = deck.slides[0].objects[0] as Extract<DeckObject, { kind: "image" }>;
    expect(obj.texSrc).toBeUndefined();
  });
});

describe("paths", () => {
  it("pairs a deck with its base PDF, both ways", () => {
    expect(deckPathForPdf("/p/talk.pdf")).toBe("/p/talk.eldeck.json");
    expect(deckPathForPdf("/p/talk.PDF")).toBe("/p/talk.eldeck.json");
    expect(pdfPathForDeck("/p/talk.eldeck.json")).toBe("/p/talk.pdf");
  });
});

describe("serialization", () => {
  it("round-trips, and formats to diff line-by-line", () => {
    const deck = { ...emptyDeck("talk.pdf"), slides: [blankSlide(1)] };
    const text = serializeDeck(deck);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n").length).toBeGreaterThan(10); // not one compact line
    expect(parseDeck(text).deck).toEqual(deck);
  });
});

describe("defensive parsing", () => {
  it("returns an empty deck rather than throwing on junk", () => {
    expect(parseDeck("{not json").error).toBeTruthy();
    expect(parseDeck("[]").error).toBeTruthy();
    expect(parseDeck("{not json").deck.slides).toEqual([]);
  });

  it("drops one unrenderable object without losing the rest of the slide", () => {
    const { deck, repaired } = normalizeDeck({
      slides: [
        {
          id: "s1",
          anchor: { page: 1 },
          objects: [
            textObj("keep"),
            { kind: "image" }, // no src — cannot render, cannot repair
            { kind: "from-the-future" }, // a newer build's object
          ],
        },
      ],
    });
    expect(deck.slides[0].objects.map((o) => o.id)).toEqual(["keep"]);
    expect(repaired).toContain("object");
  });

  it("coerces out-of-range and wrong-typed fields to something renderable", () => {
    const { deck } = normalizeDeck({
      pageWidth: "wide",
      slides: [
        {
          anchor: { page: -4 },
          objects: [{ ...textObj("a"), opacity: 5, style: { size: -2, color: "puce" } }],
        },
      ],
    });
    expect(deck.pageWidth).toBeGreaterThan(0);
    expect(deck.slides[0].anchor.page).toBe(1);
    const o = deck.slides[0].objects[0] as Extract<DeckObject, { kind: "text" }>;
    expect(o.opacity).toBe(1);
    expect(o.style.size).toBeGreaterThan(0);
    expect(o.style.color).toBe("#111111"); // "puce" is not a hex color
  });

  it("flags a deck written by a newer build instead of pretending it is fine", () => {
    expect(normalizeDeck({ version: 99 }).repaired).toContain("newer");
  });

  it("mints ids for objects that lost theirs in a merge", () => {
    const { deck } = normalizeDeck({
      slides: [{ anchor: { page: 1 }, objects: [{ ...textObj("a"), id: undefined }] }],
    });
    expect(deck.slides[0].objects[0].id).toBeTruthy();
  });
});

describe("fingerprint", () => {
  it("survives an edit past the covered prefix", () => {
    const head = "Introduction to the thing ".repeat(10); // comfortably > 200 chars
    expect(fingerprint({ width: 364, height: 205, text: `${head} early ending` })).toBe(
      fingerprint({ width: 364, height: 205, text: `${head} a completely different tail` }),
    );
  });

  it("distinguishes two different slides, and two page sizes", () => {
    const a = fingerprint({ width: 364, height: 205, text: "Results" });
    const b = fingerprint({ width: 364, height: 205, text: "Method" });
    const c = fingerprint({ width: 595, height: 842, text: "Results" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("ignores whitespace and case, which the extractor varies", () => {
    expect(fingerprint({ width: 1, height: 1, text: "  A   B \n C " })).toBe(
      fingerprint({ width: 1, height: 1, text: "a b c" }),
    );
  });
});

describe("reconcile", () => {
  /** A two-slide deck whose second slide carries a layer. */
  function deckOf(texts: string[], withLayerOn = 1): Deck {
    const pages = texts.map((t, i) => page(i + 1, t));
    const slides: Slide[] = texts.map((_t, i) => ({
      ...blankSlide(i + 1),
      id: `s${i + 1}`,
      anchor: { page: i + 1, print: fingerprint(pages[i]) },
      objects: i === withLayerOn ? [textObj(`o${i}`)] : [],
    }));
    return { ...emptyDeck("talk.pdf"), slides };
  }

  it("does nothing when nothing moved — the common case", () => {
    const deck = deckOf(["Intro", "Method", "Results"]);
    const pages = ["Intro", "Method", "Results"].map((t, i) => page(i + 1, t));
    const r = reconcile(deck, pages);
    expect(r.unchanged).toBe(true);
    expect(r.moved).toBe(0);
    expect(r.detached).toBe(0);
  });

  it("preserves the deck's OWN slide order — a manual reorder survives a reload", () => {
    // A three-page base, but the author reordered the slides so the deck presents
    // page 3, then 1, then 2. Each slide still backs its original page.
    const pages = ["Intro", "Method", "Results"].map((t, i) => page(i + 1, t));
    const deck: Deck = {
      ...emptyDeck("talk.pdf"),
      slides: [
        { ...blankSlide(3), id: "s3", anchor: { page: 3, print: fingerprint(pages[2]) } },
        {
          ...blankSlide(1),
          id: "s1",
          anchor: { page: 1, print: fingerprint(pages[0]) },
          objects: [textObj("o1")],
        },
        { ...blankSlide(2), id: "s2", anchor: { page: 2, print: fingerprint(pages[1]) } },
      ],
    };

    const r = reconcile(deck, pages);
    // The reordered sequence must come back verbatim, not re-sorted into page order.
    expect(r.deck.slides.map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
    // Each slide still backs the page it always did — nothing moved, nothing lost.
    expect(r.moved).toBe(0);
    expect(r.added).toBe(0);
    expect(r.detached).toBe(0);
    expect(r.deck.slides.map((s) => s.anchor.page)).toEqual([3, 1, 2]);
    // And the layer is still on its slide.
    expect(r.deck.slides.find((s) => s.id === "s1")!.objects.map((o) => o.id)).toEqual(["o1"]);
  });

  it("keeps a DUPLICATED slide — two slides may share one base page", () => {
    // The author copied slide 1; the copy backs the same page and carries its own
    // (freshly-ided) layer. Both must survive a reload rather than the copy being
    // dropped for want of a page of its own.
    const pages = ["Intro", "Method"].map((t, i) => page(i + 1, t));
    const deck: Deck = {
      ...emptyDeck("talk.pdf"),
      slides: [
        {
          ...blankSlide(1),
          id: "s1",
          anchor: { page: 1, print: fingerprint(pages[0]) },
          objects: [textObj("o1")],
        },
        {
          ...blankSlide(1),
          id: "s1copy",
          anchor: { page: 1, print: fingerprint(pages[0]) },
          objects: [textObj("o1copy")],
        },
        { ...blankSlide(2), id: "s2", anchor: { page: 2, print: fingerprint(pages[1]) } },
      ],
    };

    const r = reconcile(deck, pages);
    expect(r.detached).toBe(0);
    expect(r.added).toBe(0);
    expect(r.deck.slides.map((s) => s.id)).toEqual(["s1", "s1copy", "s2"]);
    // Both copies back page 1; the second slide backs page 2.
    expect(r.deck.slides.map((s) => s.anchor.page)).toEqual([1, 1, 2]);
    expect(r.deck.slides[1].objects.map((o) => o.id)).toEqual(["o1copy"]);
  });

  it("follows a layer when a slide is INSERTED above it", () => {
    const deck = deckOf(["Intro", "Method", "Results"]); // layer on "Method"
    const pages = ["Intro", "NEW", "Method", "Results"].map((t, i) => page(i + 1, t));

    const r = reconcile(deck, pages);
    expect(r.detached).toBe(0);
    expect(r.added).toBe(1);
    expect(r.deck.slides).toHaveLength(4);
    // The layer must now be on page 3, which is where "Method" went.
    const withLayer = r.deck.slides.find((s) => s.objects.length > 0)!;
    expect(withLayer.anchor.page).toBe(3);
  });

  it("prefers the SyncTeX line over everything, so retitling a slide is safe", () => {
    const deck: Deck = {
      ...emptyDeck("talk.pdf", "talk.tex"),
      slides: [
        { ...blankSlide(1), id: "s1", anchor: { page: 1, line: 10, print: "stale" } },
        {
          ...blankSlide(2),
          id: "s2",
          anchor: { page: 2, line: 40, print: "stale" },
          objects: [textObj("o")],
        },
      ],
    };
    // The slide moved to page 1 AND its title changed, so the fingerprint is no
    // help at all. Only the source line still identifies it.
    const pages = [page(1, "Renamed Method", [40]), page(2, "Intro", [10])];

    const r = reconcile(deck, pages);
    expect(r.detached).toBe(0);
    const withLayer = r.deck.slides.find((s) => s.objects.length > 0)!;
    expect(withLayer.anchor.page).toBe(1);
  });

  it("refuses to guess between two IDENTICAL pages", () => {
    const dup = fingerprint(page(1, "Section"));
    const deck: Deck = {
      ...emptyDeck("talk.pdf"),
      slides: [
        { ...blankSlide(1), id: "s1", anchor: { page: 1, print: dup }, objects: [textObj("a")] },
        { ...blankSlide(9), id: "s2", anchor: { page: 9, print: dup } },
      ],
    };
    const pages = [page(1, "Section"), page(2, "Section")];
    const r = reconcile(deck, pages);
    // Ambiguous fingerprints are ignored; order decides instead, and nothing is
    // lost either way.
    expect(r.detached).toBe(0);
    expect(r.deck.slides).toHaveLength(2);
    expect(r.deck.slides.some((s) => s.objects.length > 0)).toBe(true);
  });

  it("detaches a layer rather than dropping it when the base loses pages", () => {
    const deck = deckOf(["Intro", "Method", "Results"], 2); // layer on "Results"
    const pages = [page(1, "Intro")];

    const r = reconcile(deck, pages);
    expect(r.deck.slides).toHaveLength(1);
    expect(r.detached).toBe(1);
    expect(r.deck.detached[0].objects.map((o) => o.id)).toEqual(["o2"]);
  });

  it("drops EMPTY orphan slides silently — there is nothing to lose", () => {
    const deck = deckOf(["Intro", "Method", "Results"], -1); // no layers anywhere
    const r = reconcile(deck, [page(1, "Intro")]);
    expect(r.detached).toBe(0);
    expect(r.deck.detached).toEqual([]);
  });

  it("treats a base that reports zero pages as a failed load, not an empty one", () => {
    const deck = deckOf(["Intro", "Method"]);
    const r = reconcile(deck, []);
    expect(r.deck.slides).toHaveLength(2);
    expect(r.deck.detached).toEqual([]);
  });

  it("adopts the base's real page size", () => {
    const deck = deckOf(["Intro"]);
    const r = reconcile(deck, [{ page: 1, width: 595, height: 842, text: "Intro" }]);
    expect(r.deck.pageWidth).toBe(595);
    expect(r.deck.pageHeight).toBe(842);
  });
});

describe("reattach", () => {
  it("MERGES onto the slide instead of replacing what is already there", () => {
    const deck: Deck = {
      ...emptyDeck("talk.pdf"),
      slides: [{ ...blankSlide(1), id: "s1", objects: [textObj("already")], notes: "mine" }],
      detached: [{ from: { page: 4 }, objects: [textObj("orphan")], notes: "theirs" }],
    };
    const out = reattach(deck, 0, 0);
    expect(out.slides[0].objects.map((o) => o.id)).toEqual(["already", "orphan"]);
    expect(out.slides[0].notes).toBe("mine\n\ntheirs");
    expect(out.detached).toEqual([]);
  });

  it("ignores an out-of-range target rather than corrupting the deck", () => {
    const deck: Deck = {
      ...emptyDeck("talk.pdf"),
      slides: [blankSlide(1)],
      detached: [{ from: { page: 4 }, objects: [textObj("orphan")], notes: "" }],
    };
    expect(reattach(deck, 0, 9)).toEqual(deck);
    expect(reattach(deck, 9, 0)).toEqual(deck);
  });
});
