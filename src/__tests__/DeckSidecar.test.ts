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

  it("keeps a newer deck's version instead of stamping it down (V #94)", () => {
    // Stamping `DECK_VERSION` is what turned "open a newer deck" into "silently
    // downgrade it": the autosave 800ms later wrote the coerced result back under
    // a version number claiming it was fine.
    const r = normalizeDeck({ version: 99, slides: [] });
    expect(r.version).toBe(99);
    expect(r.deck.version).toBe(99);
    expect(r.lossy).toBe(true);
    expect(r.lossReason).toContain("newer");
  });

  it("reports an unmodellable object kind as LOSSY, not merely repaired (V #94)", () => {
    // The distinction the flag exists for: this is not a coercion that lost
    // nothing, it is a write-back that would DELETE the object.
    const r = normalizeDeck({
      slides: [{ anchor: { page: 1 }, objects: [{ id: "x", kind: "hologram" }] }],
    });
    expect(r.lossy).toBe(true);
    expect(r.deck.slides[0].objects).toHaveLength(0);
  });

  it("is not lossy for an ordinary deck, however much it repaired", () => {
    // A numeric field that arrived as a string costs the author nothing, so it
    // must not hold the autosave — otherwise the banner is permanent noise.
    const r = normalizeDeck({
      slides: [{ anchor: { page: 1 }, objects: [{ ...textObj("a"), opacity: "nope" }] }],
    });
    expect(r.lossy).toBe(false);
    expect(r.deck.slides[0].objects[0].opacity).toBe(1);
  });

  it("re-mints an id a bad merge duplicated (V #109)", () => {
    // The whole id design exists to survive exactly this, and the reader never
    // enforced it — so `updateObjects`/`removeObjects`/selection acted on both
    // objects at once.
    const r = normalizeDeck({
      slides: [
        {
          id: "s1",
          anchor: { page: 1 },
          objects: [textObj("dup"), { ...textObj("dup"), text: "second" }],
        },
      ],
    });
    const ids = r.deck.slides[0].objects.map((o) => o.id);
    expect(new Set(ids).size).toBe(2);
    expect(r.repaired).toContain("duplicate id");
  });

  it("re-mints a duplicated SLIDE id, which would corrupt reconcile's map", () => {
    const r = normalizeDeck({
      slides: [
        { id: "s", anchor: { page: 1 }, objects: [] },
        { id: "s", anchor: { page: 2 }, objects: [] },
      ],
    });
    expect(new Set(r.deck.slides.map((s) => s.id)).size).toBe(2);
  });
});

describe("parseDeck: the from-blank path (V #107)", () => {
  it("reads an EMPTY file as a fresh deck rather than an error", () => {
    // The file tree's "New file" produces a zero-byte file, and rejecting that
    // made the from-blank authoring path unreachable: the editor refused to open
    // the very file it needed you to create.
    for (const text of ["", "   ", "\n\n", "{}"]) {
      const r = parseDeck(text, "talk.pdf");
      expect(r.error).toBeUndefined();
      expect(r.lossy).toBe(false);
      expect(r.deck.slides).toEqual([]);
      expect(r.deck.base).toBe("talk.pdf");
    }
  });

  it("still refuses malformed JSON that has real content in it", () => {
    // Overwriting an author's broken-but-real file with a blank deck is the loss
    // this module exists to prevent — the empty case is safe precisely because
    // there is nothing there to lose.
    expect(parseDeck('{"slides": [oops').error).toBeTruthy();
    expect(parseDeck("[1,2,3]").error).toBeTruthy();
  });
});

describe("fingerprint", () => {
  it("survives an edit in the middle of a long page", () => {
    // The tolerance the fingerprint exists for: fixing a typo in a slide's body
    // must not re-anchor it. Head and tail are both covered, so what survives is
    // an edit *between* them — which is where the body of a long page is.
    const head = "Introduction to the thing ".repeat(10); // comfortably > 200 chars
    const tail = " and in conclusion the thing was introduced".repeat(6);
    expect(
      fingerprint({ width: 364, height: 205, items: 4, text: `${head} early middle ${tail}` }),
    ).toBe(
      fingerprint({
        width: 364,
        height: 205,
        items: 4,
        text: `${head} a completely different middle ${tail}`,
      }),
    );
  });

  it("distinguishes two different slides, and two page sizes", () => {
    const a = fingerprint({ width: 364, height: 205, text: "Results" });
    const b = fingerprint({ width: 364, height: 205, text: "Method" });
    const c = fingerprint({ width: 595, height: 842, text: "Results" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("tells consecutive Beamer overlay pages apart", () => {
    // THE case the fingerprint was failing at (TODO V #100b). `\pause` emits
    // pages whose LEADING text is identical by construction, so a prefix-only
    // hash gave them all one value — which step 3 then refuses to trust, so
    // every overlay page fell through to the order fallback.
    const lead = "Our contribution ".repeat(20); // > 200 chars, shared by all
    const pages = [
      { width: 364, height: 205, items: 3, text: `${lead} first point` },
      { width: 364, height: 205, items: 5, text: `${lead} first point second point` },
      { width: 364, height: 205, items: 7, text: `${lead} first point second point third` },
    ];
    const prints = pages.map(fingerprint);
    expect(new Set(prints).size).toBe(3);
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

  it("records a page box that differs from the deck's, per slide (V #112)", () => {
    // A plate with a portrait appendix. Scaling every layer by page 1's box put
    // them in the wrong place on those pages; the slide now carries its own.
    const deck = deckOf(["Intro", "Appendix"], -1);
    const r = reconcile(deck, [
      { page: 1, width: 364, height: 205, text: "Intro" },
      { page: 2, width: 595, height: 842, text: "Appendix" },
    ]);
    expect(r.deck.pageWidth).toBe(364);
    // The landscape page inherits the deck's box (no redundant per-slide copy);
    // the portrait one states its own.
    expect(r.deck.slides[0].pageWidth).toBeUndefined();
    expect(r.deck.slides[1].pageWidth).toBe(595);
    expect(r.deck.slides[1].pageHeight).toBe(842);
  });

  it("does not resurrect a slide the author deleted (V #106)", () => {
    // Deleting a slide used to be undone by the very next load: the "cover every
    // base page" pass re-added a blank one for the now-uncovered page, so a title
    // page or a backup frame could not be dropped from the sequence at all.
    const pages = ["Intro", "Backup"].map((t, i) => page(i + 1, t));
    const deck: Deck = {
      ...emptyDeck("talk.pdf"),
      slides: [{ ...blankSlide(1), id: "s1", anchor: { page: 1, print: fingerprint(pages[0]) } }],
      skippedPrints: [fingerprint(pages[1])],
    };
    const r = reconcile(deck, pages);
    expect(r.deck.slides.map((s) => s.id)).toEqual(["s1"]);
    expect(r.added).toBe(0);
  });

  it("reports `ambiguous` when several content slides are placed by order alone (V #100)", () => {
    // Nothing matches: no lines, and every fingerprint is stale. Three
    // content-bearing slides therefore get pages handed out in DECK order, which
    // on a reordered deck puts layers on the wrong pages — so the caller is told
    // to hold the autosave rather than persist the guess.
    const deck: Deck = {
      ...emptyDeck("talk.pdf"),
      slides: ["a", "b", "c"].map((id, i) => ({
        ...blankSlide(i + 1),
        id,
        anchor: { page: i + 1, print: "stale" },
        objects: [textObj(`o${id}`)],
      })),
    };
    const r = reconcile(deck, ["X", "Y", "Z"].map((t, i) => page(i + 1, t)));
    expect(r.ambiguous).toBe(true);
    expect(r.detached).toBe(0); // still never loses anything
  });

  it("does NOT cry ambiguous for a single edited slide", () => {
    // The ordinary case — one slide's text changed, so only its own fingerprint
    // went stale. One order placement is evidence-free but unambiguous.
    const pages = ["Intro", "Method", "Results"].map((t, i) => page(i + 1, t));
    const deck: Deck = {
      ...emptyDeck("talk.pdf"),
      slides: [
        { ...blankSlide(1), id: "s1", anchor: { page: 1, print: fingerprint(pages[0]) } },
        {
          ...blankSlide(2),
          id: "s2",
          anchor: { page: 2, print: "stale" },
          objects: [textObj("o")],
        },
        { ...blankSlide(3), id: "s3", anchor: { page: 3, print: fingerprint(pages[2]) } },
      ],
    };
    const r = reconcile(deck, pages);
    expect(r.ambiguous).toBe(false);
    expect(r.deck.slides.find((s) => s.objects.length > 0)!.anchor.page).toBe(2);
  });

  it("matches overlay pages WITHIN their shared source line (V #100)", () => {
    // A Beamer frame with `\pause` attributes every one of its pages to the same
    // source lines, so a line names a FRAME, not a page. The k-th slide anchored
    // to line L must claim the k-th page L produced — a first-match-wins map
    // would pile all three overlays onto the frame's first page.
    const deck: Deck = {
      ...emptyDeck("talk.pdf", "talk.tex"),
      slides: [
        { ...blankSlide(1), id: "o1", anchor: { page: 1, line: 12 }, objects: [textObj("a")] },
        { ...blankSlide(2), id: "o2", anchor: { page: 2, line: 12 }, objects: [textObj("b")] },
        { ...blankSlide(3), id: "o3", anchor: { page: 3, line: 12 }, objects: [textObj("c")] },
      ],
    };
    // The frame moved down two pages (a title and an outline were inserted).
    const pages = [
      page(1, "Title", [2]),
      page(2, "Outline", [7]),
      page(3, "Contribution", [12]),
      page(4, "Contribution more", [12]),
      page(5, "Contribution most", [12]),
    ];
    const r = reconcile(deck, pages);
    expect(r.detached).toBe(0);
    expect(r.deck.slides.filter((s) => s.objects.length > 0).map((s) => s.anchor.page)).toEqual([
      3, 4, 5,
    ]);
  });

  it("writes the source line back, so the anchor exists on the NEXT load too", () => {
    // The producer half of the line anchor: it was documented and consumed but
    // never written, so the mechanism did not exist at runtime (V #100a).
    const deck = deckOf(["Intro", "Method"], -1);
    const r = reconcile(deck, [page(1, "Intro", [4]), page(2, "Method", [19])]);
    expect(r.deck.slides.map((s) => s.anchor.line)).toEqual([4, 19]);
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
