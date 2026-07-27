/**
 * Tests for `texFigures` (`components/embed/deck/DeckTexPanel`) — the pure part
 * of the deck-wide TeX-figure list: which objects it collects and in what order.
 */

import { describe, it, expect } from "vitest";
import { texFigures } from "../components/embed/deck/DeckTexPanel";
import { type Deck, blankSlide, emptyDeck } from "../lib/viewers/deck/model";

function texImage(id: string, texSrc: string) {
  return {
    id,
    kind: "image" as const,
    src: `${id}.png`,
    texSrc,
    fit: "contain" as const,
    x: 0,
    y: 0,
    w: 0.2,
    h: 0.2,
    rot: 0,
    opacity: 1,
  };
}

function plainImage(id: string) {
  return {
    id,
    kind: "image" as const,
    src: `${id}.png`,
    fit: "contain" as const,
    x: 0,
    y: 0,
    w: 0.2,
    h: 0.2,
    rot: 0,
    opacity: 1,
  };
}

describe("texFigures", () => {
  it("finds only image objects that carry a texSrc, across every slide", () => {
    const deck: Deck = {
      ...emptyDeck("talk.pdf"),
      slides: [
        { ...blankSlide(1), objects: [plainImage("a"), texImage("b", "b.tex")] },
        { ...blankSlide(2), objects: [] },
        { ...blankSlide(3), objects: [texImage("c", "c.tex")] },
      ],
    };
    expect(texFigures(deck).map((f) => [f.slideIndex, f.obj.id])).toEqual([
      [0, "b"],
      [2, "c"],
    ]);
  });

  it("returns an empty list for a deck with no TeX figures", () => {
    const deck: Deck = { ...emptyDeck("talk.pdf"), slides: [blankSlide(1)] };
    expect(texFigures(deck)).toEqual([]);
  });
});
