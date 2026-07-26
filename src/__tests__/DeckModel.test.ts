/**
 * Tests for the deck model (`lib/viewers/deck/model`) — the native presenter's
 * pure core (`docs/deck_presenter_plan.md`).
 *
 * The cases worth reading are the ones encoding a decision rather than a
 * mechanism: that `locked` is enforced in the model and not at every call site,
 * that a raise of several adjacent objects moves them as a block instead of
 * deadlocking against each other, that distribution equalises *gaps* rather than
 * origins, and that the presenter sequence expands builds and interstitials into
 * one flat list so `←` can step a build backwards.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  type Deck,
  type DeckObject,
  type ObjectList,
  type Slide,
  addObject,
  alignObjects,
  blankSlide,
  boundingBox,
  rotatedCorners,
  distributeObjects,
  duplicateObjects,
  emptyDeck,
  lowerObjects,
  maxBuildStep,
  moveObjects,
  moveSlides,
  raiseObjects,
  removeObjects,
  resetIdCounter,
  sequence,
  setIdSuffixSource,
  stagger,
  toBack,
  toFront,
  updateObjects,
  visibleAt,
} from "../lib/viewers/deck/model";

/** A deterministic id source, so assertions can name ids. */
beforeEach(() => {
  resetIdCounter();
  setIdSuffixSource(() => "");
});

function box(id: string, x: number, y: number, w = 0.1, h = 0.1): DeckObject {
  return {
    id,
    kind: "shape",
    shape: "rect",
    stroke: "#111111",
    strokeWidth: 1,
    x,
    y,
    w,
    h,
    rot: 0,
    opacity: 1,
  };
}

describe("object list ops", () => {
  it("appends on top, because the list IS the z-order", () => {
    const list = addObject([box("a", 0, 0)], box("b", 0.5, 0.5));
    expect(list.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("skips locked objects on update, move and remove", () => {
    const list: ObjectList = [{ ...box("a", 0, 0), locked: true }, box("b", 0, 0)];

    expect(moveObjects(list, ["a", "b"], 0.1, 0.1).map((o) => o.x)).toEqual([0, 0.1]);
    expect(removeObjects(list, ["a", "b"]).map((o) => o.id)).toEqual(["a"]);
    expect(
      updateObjects(list, ["a", "b"], (o) => ({ ...o, opacity: 0.5 })).map((o) => o.opacity),
    ).toEqual([1, 0.5]);
  });

  it("duplicates with fresh ids, offset so the copy is visible", () => {
    const { list, ids } = duplicateObjects([box("a", 0.2, 0.2)], ["a"]);
    expect(list).toHaveLength(2);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe("a");
    expect(list[1].x).toBeCloseTo(0.22);
    expect(list[1].y).toBeCloseTo(0.22);
  });
});

describe("z-order", () => {
  const list = [box("a", 0, 0), box("b", 0, 0), box("c", 0, 0), box("d", 0, 0)];

  it("moves a multi-selection to front as a block, preserving its order", () => {
    expect(toFront(list, ["a", "c"]).map((o) => o.id)).toEqual(["b", "d", "a", "c"]);
    expect(toBack(list, ["b", "d"]).map((o) => o.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("raises adjacent selected objects together instead of deadlocking", () => {
    // b and c are adjacent and both selected. Swapping naively from the bottom
    // would have b swap with c (both selected), leaving the block where it was.
    expect(raiseObjects(list, ["b", "c"]).map((o) => o.id)).toEqual(["a", "d", "b", "c"]);
    expect(lowerObjects(list, ["b", "c"]).map((o) => o.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("leaves the topmost object alone on raise", () => {
    expect(raiseObjects(list, ["d"]).map((o) => o.id)).toEqual(["a", "b", "c", "d"]);
    expect(lowerObjects(list, ["a"]).map((o) => o.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("align", () => {
  it("aligns a SINGLE object to the page — otherwise it would be a no-op", () => {
    const list = [box("a", 0.3, 0.3, 0.2, 0.2)];
    expect(alignObjects(list, ["a"], "left")[0].x).toBeCloseTo(0);
    expect(alignObjects(list, ["a"], "hcenter")[0].x).toBeCloseTo(0.4);
    expect(alignObjects(list, ["a"], "right")[0].x).toBeCloseTo(0.8);
    expect(alignObjects(list, ["a"], "bottom")[0].y).toBeCloseTo(0.8);
  });

  it("aligns a multi-selection to its own bounding box", () => {
    const list = [box("a", 0.2, 0, 0.1, 0.1), box("b", 0.5, 0, 0.3, 0.1)];
    const out = alignObjects(list, ["a", "b"], "left");
    expect(out.map((o) => o.x)).toEqual([0.2, 0.2]);

    const right = alignObjects(list, ["a", "b"], "right");
    // Bounding box spans 0.2 → 0.8, so both far edges land on 0.8.
    expect(right[0].x).toBeCloseTo(0.7);
    expect(right[1].x).toBeCloseTo(0.5);
  });
});

describe("distribute", () => {
  it("equalises the GAPS, not the origins, so mixed widths look right", () => {
    const list = [
      box("a", 0, 0, 0.1, 0.1),
      box("b", 0.3, 0, 0.4, 0.1), // deliberately much wider
      box("c", 0.9, 0, 0.1, 0.1),
    ];
    const out = distributeObjects(list, ["a", "b", "c"], "h");
    const by = (id: string) => out.find((o) => o.id === id)!;
    const gap1 = by("b").x - (by("a").x + by("a").w);
    const gap2 = by("c").x - (by("b").x + by("b").w);
    expect(gap1).toBeCloseTo(gap2);
    // The outermost two must not move.
    expect(by("a").x).toBeCloseTo(0);
    expect(by("c").x).toBeCloseTo(0.9);
  });

  it("needs three objects to mean anything", () => {
    const list = [box("a", 0, 0), box("b", 0.5, 0)];
    expect(distributeObjects(list, ["a", "b"], "h")).toEqual(list);
  });
});

describe("bounding box", () => {
  it("is the tight box, and is zero for nothing", () => {
    expect(boundingBox([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    const b = boundingBox([box("a", 0.2, 0.1, 0.1, 0.1), box("b", 0.5, 0.4, 0.2, 0.2)]);
    expect(b.x).toBeCloseTo(0.2);
    expect(b.y).toBeCloseTo(0.1);
    expect(b.w).toBeCloseTo(0.5);
    expect(b.h).toBeCloseTo(0.5);
  });

  it("encloses ROTATED content, not the box it was authored in (V #111)", () => {
    // The selection rectangle, the marquee hit test and every align/distribute
    // are computed from this. An axis-aligned box over the *unrotated* geometry
    // put all three somewhere the object is not.
    const square = { ...box("a", 0.4, 0.4, 0.2, 0.2), rot: 45 };
    const b = boundingBox([square], 1);
    // A square turned 45° needs √2 of its side, still centred where it was.
    expect(b.w).toBeCloseTo(0.2 * Math.SQRT2, 4);
    expect(b.x + b.w / 2).toBeCloseTo(0.5, 6);
    expect(b.y + b.h / 2).toBeCloseTo(0.5, 6);
  });

  it("is unchanged for unrotated objects, whatever the page aspect", () => {
    // The overwhelmingly common case must cost nothing and move nothing.
    const objs = [box("a", 0.2, 0.1, 0.1, 0.1), box("b", 0.5, 0.4, 0.2, 0.2)];
    expect(boundingBox(objs, 16 / 9)).toEqual(boundingBox(objs));
  });

  it("turns in an aspect-corrected frame, so a square does not shear", () => {
    // The page is not square. Rotating in page space would come back a lozenge —
    // wider than tall for a 16:9 plate — which is exactly what the render does
    // NOT do, and the two must agree.
    const square = { ...box("a", 0.4, 0.4, 0.2, 0.2), rot: 90 };
    const b = boundingBox([square], 16 / 9);
    // A 90° turn swaps the box's PHYSICAL sides, which in normalized terms means
    // dividing/multiplying by the page aspect — 0.2 → 0.1125 across, 0.3556 down.
    expect(b.w).toBeCloseTo(0.2 * (9 / 16), 6);
    expect(b.h).toBeCloseTo(0.2 * (16 / 9), 6);
    // Still centred where it was: rotation is about the centre.
    expect(b.x + b.w / 2).toBeCloseTo(0.5, 6);
    expect(b.y + b.h / 2).toBeCloseTo(0.5, 6);
  });

  it("gives every corner of a rotated object", () => {
    const square = { x: 0, y: 0, w: 1, h: 1, rot: 0 };
    expect(rotatedCorners(square)).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    // 180° maps each corner to its opposite.
    const flipped = rotatedCorners({ ...square, rot: 180 });
    expect(flipped[0][0]).toBeCloseTo(1, 6);
    expect(flipped[0][1]).toBeCloseTo(1, 6);
  });
});

describe("slides", () => {
  it("moves a block using the survivor-index convention pageModel uses", () => {
    const slides = [1, 2, 3, 4].map((p) => ({ ...blankSlide(p), id: `s${p}` }));
    // "insert before the 0th survivor" — the survivors are s1, s2, s4.
    expect(moveSlides(slides, ["s3"], 0).map((s) => s.id)).toEqual(["s3", "s1", "s2", "s4"]);
    // An index past the end appends.
    expect(moveSlides(slides, ["s1"], 99).map((s) => s.id)).toEqual(["s2", "s3", "s4", "s1"]);
  });
});

describe("presenter sequence", () => {
  function deckWith(slides: Slide[]): Deck {
    return { ...emptyDeck("talk.pdf"), slides };
  }

  it("expands each slide's build steps into its own stop", () => {
    const s = blankSlide(1);
    s.objects = [
      { ...box("a", 0, 0), build: { step: 0, effect: "fade" } },
      { ...box("b", 0, 0), build: { step: 2, effect: "fade" } },
    ];
    expect(maxBuildStep(s)).toBe(2);
    expect(sequence(deckWith([s]))).toEqual([
      { kind: "slide", slide: 0, step: 0 },
      { kind: "slide", slide: 0, step: 1 },
      { kind: "slide", slide: 0, step: 2 },
    ]);
  });

  it("puts an interstitial BETWEEN two slides, as its own stop", () => {
    const a = blankSlide(1);
    a.after = {
      id: "g1",
      src: "anim.gif",
      fit: "contain",
      background: "#000000",
      advance: { on: "manual" },
      poster: 0,
    };
    const b = blankSlide(2);
    expect(sequence(deckWith([a, b]))).toEqual([
      { kind: "slide", slide: 0, step: 0 },
      { kind: "interstitial", slide: 0 },
      { kind: "slide", slide: 1, step: 0 },
    ]);
  });

  it("hides an object until its build step, and never shows a hidden one", () => {
    const shown = { ...box("a", 0, 0), build: { step: 2, effect: "fade" as const } };
    expect(visibleAt(shown, 1)).toBe(false);
    expect(visibleAt(shown, 2)).toBe(true);
    expect(visibleAt({ ...shown, hidden: true }, 5)).toBe(false);
    // No build at all = visible on entry.
    expect(visibleAt(box("b", 0, 0), 0)).toBe(true);
  });
});

describe("stagger", () => {
  it("assigns consecutive steps in paint order — the one-click list reveal", () => {
    const list = [box("a", 0, 0), box("b", 0, 0), box("c", 0, 0)];
    const out = stagger(list, ["c", "a", "b"], 1);
    // Paint order wins over the order the ids were passed in.
    expect(out.map((o) => o.build?.step)).toEqual([1, 2, 3]);
    expect(out.every((o) => o.build?.effect === "fade")).toBe(true);
  });
});
