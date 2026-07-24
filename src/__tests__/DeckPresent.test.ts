/**
 * Tests for the dual-window presenter's link (`lib/viewers/deck/present`) —
 * the protocol and the navigation arithmetic the two windows share
 * (`docs/deck_presenter_plan.md` §6).
 *
 * The cases worth reading are the ones that encode a decision. That the window
 * label is derived from the deck's *path*, so opening the second display twice
 * for one talk targets one window rather than stacking two on the projector.
 * That `?present=` is validated rather than trusted, since it names a window and
 * lands in a URL. That `←` from a build steps the build back while `↑` skips the
 * whole slide — the difference between surviving an audience question and losing
 * the slide to it. And that both windows share ONE key→action map, because a
 * clicker bound to whichever display has focus must not mean two different
 * things.
 */

import { describe, it, expect } from "vitest";
import {
  type NavAction,
  applyNav,
  clampStop,
  keyToAction,
  parsePresentParam,
  presentSeedEvent,
  presentStateEvent,
  presenterLabel,
  slideStopIndex,
  stepSlide,
} from "../lib/viewers/deck/present";
import { type Deck, emptyDeck, blankSlide, sequence } from "../lib/viewers/deck/model";

/** A deck of three slides: the middle one has two builds, the first a GIF after it. */
function deckFixture(): Deck {
  const deck = emptyDeck("talk.pdf");
  const s0 = blankSlide(1);
  const s1 = blankSlide(2);
  const s2 = blankSlide(3);
  s0.after = {
    id: "gif1",
    src: "clip.gif",
    fit: "contain",
    background: "#000000",
    advance: { on: "manual" },
    poster: 0,
  };
  s1.objects = [
    {
      id: "a",
      kind: "text",
      text: "one",
      style: deck.theme.text,
      padding: 2,
      x: 0.1,
      y: 0.1,
      w: 0.2,
      h: 0.1,
      rot: 0,
      opacity: 1,
      build: { step: 1, effect: "fade" },
    },
    {
      id: "b",
      kind: "text",
      text: "two",
      style: deck.theme.text,
      padding: 2,
      x: 0.1,
      y: 0.3,
      w: 0.2,
      h: 0.1,
      rot: 0,
      opacity: 1,
      build: { step: 2, effect: "fade" },
    },
  ];
  return { ...deck, slides: [s0, s1, s2] };
}

describe("window identity", () => {
  it("derives one stable label per deck path", () => {
    const a = presenterLabel("/home/x/talk.eldeck.json");
    expect(a).toBe(presenterLabel("/home/x/talk.eldeck.json"));
    // Opening the second display for a DIFFERENT deck must not re-use the window
    // already showing the first one.
    expect(a).not.toBe(presenterLabel("/home/x/other.eldeck.json"));
    // The prefix is load-bearing: it is what `capabilities/default.json` grants
    // window permissions by, and what the backend validates.
    expect(a.startsWith("present-")).toBe(true);
    expect(/^present-[A-Za-z0-9_-]+$/.test(a)).toBe(true);
  });

  it("accepts only a well-formed ?present= label", () => {
    const label = presenterLabel("/tmp/t.eldeck.json");
    expect(parsePresentParam(`?present=${label}`)).toBe(label);
    // Absent → the ordinary shell renders.
    expect(parsePresentParam("")).toBeNull();
    expect(parsePresentParam("?detached=p:g1")).toBeNull();
    // The value names a window and goes into a URL, so anything shaped wrong is
    // refused here rather than handed on.
    expect(parsePresentParam("?present=main")).toBeNull();
    expect(parsePresentParam("?present=present-../etc")).toBeNull();
    expect(parsePresentParam("?present=present-")).toBeNull();
  });

  it("namespaces the seed and state channels per window", () => {
    expect(presentSeedEvent("present-a")).not.toBe(presentSeedEvent("present-b"));
    expect(presentStateEvent("present-a")).not.toBe(presentSeedEvent("present-a"));
  });
});

describe("navigation", () => {
  const deck = deckFixture();
  const stops = sequence(deck);

  it("flattens builds and interstitials into one ordered list", () => {
    // slide 0 (step 0) · its GIF · slide 1 steps 0,1,2 · slide 2 (step 0)
    expect(stops).toEqual([
      { kind: "slide", slide: 0, step: 0 },
      { kind: "interstitial", slide: 0 },
      { kind: "slide", slide: 1, step: 0 },
      { kind: "slide", slide: 1, step: 1 },
      { kind: "slide", slide: 1, step: 2 },
      { kind: "slide", slide: 2, step: 0 },
    ]);
  });

  it("clamps at both ends instead of wrapping", () => {
    // Wrapping mid-talk sends you to slide 1 in front of a room.
    expect(clampStop(stops, -3)).toBe(0);
    expect(clampStop(stops, 99)).toBe(stops.length - 1);
    expect(applyNav(stops, 0, { kind: "prev" })).toBe(0);
    expect(applyNav(stops, stops.length - 1, { kind: "next" })).toBe(stops.length - 1);
  });

  it("steps a build backwards rather than losing the slide", () => {
    // Sitting on slide 1's second build; `←` must undo that reveal.
    const at = stops.findIndex((s) => s.kind === "slide" && s.slide === 1 && s.step === 2);
    expect(applyNav(stops, at, { kind: "prev" })).toBe(at - 1);
    expect(stops[at - 1]).toEqual({ kind: "slide", slide: 1, step: 1 });
  });

  it("enters an interstitial rather than skipping past it", () => {
    expect(applyNav(stops, 0, { kind: "next" })).toBe(1);
    expect(stops[1].kind).toBe("interstitial");
    // …and leaving it lands on the next slide, so it costs exactly one stop.
    expect(stops[applyNav(stops, 1, { kind: "next" })]).toEqual({
      kind: "slide",
      slide: 1,
      step: 0,
    });
  });

  it("skips the remaining builds on a whole-slide step", () => {
    const at = stops.findIndex((s) => s.kind === "slide" && s.slide === 1 && s.step === 0);
    expect(stops[stepSlide(stops, at, 1)]).toEqual({ kind: "slide", slide: 2, step: 0 });
    // Backwards lands on the slide's ENTRY stop, not its last build: a slide you
    // go back to should look the way the room first saw it.
    expect(stops[stepSlide(stops, at, -1)]).toEqual({ kind: "slide", slide: 0, step: 0 });
  });

  it("does nothing when a whole-slide step would run off the deck", () => {
    const last = stops.length - 1;
    expect(stepSlide(stops, last, 1)).toBe(last);
    expect(stepSlide(stops, 0, -1)).toBe(0);
  });

  it("jumps to a slide's entry stop, and refuses a slide that is not there", () => {
    expect(slideStopIndex(stops, 2)).toBe(stops.length - 1);
    expect(slideStopIndex(stops, 7)).toBe(-1);
    const at = 3;
    expect(applyNav(stops, at, { kind: "goto", slide: 7 })).toBe(at);
    expect(stops[applyNav(stops, at, { kind: "goto", slide: 0 })]).toEqual({
      kind: "slide",
      slide: 0,
      step: 0,
    });
  });

  it("leaves the index alone for the actions that are not movements", () => {
    const at = 2;
    for (const action of [
      { kind: "close" },
      { kind: "blank", mode: "black" },
    ] as NavAction[]) {
      expect(applyNav(stops, at, action)).toBe(at);
    }
  });

  it("first/last reach the ends of a deck with builds", () => {
    expect(applyNav(stops, 3, { kind: "first" })).toBe(0);
    expect(applyNav(stops, 0, { kind: "last" })).toBe(stops.length - 1);
  });

  it("handles an empty deck without throwing", () => {
    const empty = sequence(emptyDeck(null));
    expect(applyNav(empty, 0, { kind: "next" })).toBe(0);
    expect(stepSlide(empty, 0, 1)).toBe(0);
    expect(slideStopIndex(empty, 0)).toBe(-1);
  });
});

describe("the shared key map", () => {
  it("gives both windows the same meaning for the same key", () => {
    expect(keyToAction(" ")).toEqual({ kind: "next" });
    expect(keyToAction("ArrowRight")).toEqual({ kind: "next" });
    expect(keyToAction("PageDown")).toEqual({ kind: "next" });
    expect(keyToAction("ArrowLeft")).toEqual({ kind: "prev" });
    expect(keyToAction("PageUp")).toEqual({ kind: "prev" });
    expect(keyToAction("ArrowDown")).toEqual({ kind: "slide", delta: 1 });
    expect(keyToAction("ArrowUp")).toEqual({ kind: "slide", delta: -1 });
    expect(keyToAction("Home")).toEqual({ kind: "first" });
    expect(keyToAction("End")).toEqual({ kind: "last" });
    expect(keyToAction("Escape")).toEqual({ kind: "close" });
  });

  it("treats B and W as the two blank screens, either case", () => {
    expect(keyToAction("b")).toEqual({ kind: "blank", mode: "black" });
    expect(keyToAction("B")).toEqual({ kind: "blank", mode: "black" });
    expect(keyToAction("w")).toEqual({ kind: "blank", mode: "white" });
    expect(keyToAction("W")).toEqual({ kind: "blank", mode: "white" });
  });

  it("reports digits for the caller to accumulate into a goto", () => {
    expect(keyToAction("4")).toEqual({ kind: "digit", digit: "4" });
    // Enter is deliberately NOT claimed here: only the caller knows whether a
    // number is pending.
    expect(keyToAction("Enter")).toBeNull();
  });

  it("claims nothing it does not own", () => {
    // The presenter window's own overlays (G/N/D) never reach this map, so they
    // stay local to the speaker's screen.
    for (const k of ["g", "n", "d", "F5", "Tab", "a"]) {
      expect(keyToAction(k)).toBeNull();
    }
  });
});
