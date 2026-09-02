import { describe, it, expect } from "vitest";
// Read the stylesheet at test time, the way `NativeEditorMetricsCss.test.ts`
// does: a `?raw` import yields "" under the config's `css: false`, which would
// make every assertion below pass vacuously. Vitest runs from the repo root.
import { readAppStylesheet } from "./cssCorpus";
import { thumbGeometry, scrollFromDrag, type TrackMetrics } from "../lib/customScrollbar";

/**
 * The scrollbar's arithmetic, which is the whole of what can be wrong about it
 * away from a real engine: jsdom lays nothing out, so every element there
 * reports a zero box and the DOM half of the module can only be exercised
 * live. What is testable is the part a wrong pixel would show up in — how long
 * the thumb is, where it sits, and where a drag leaves the content.
 */

const track = (over: Partial<TrackMetrics> = {}): TrackMetrics => ({
  scrollSize: 1000,
  clientSize: 200,
  scrollPos: 0,
  trackLength: 200,
  ...over,
});

describe("thumbGeometry", () => {
  it("gives no thumb to an axis that cannot scroll", () => {
    expect(thumbGeometry(track({ scrollSize: 200 }))).toBeNull();
  });

  it("treats a one-pixel overflow as no overflow", () => {
    // Fractional device pixel ratios report a scrollHeight one larger than the
    // clientHeight for content that exactly fits; a thumb there would span the
    // whole track and never move.
    expect(thumbGeometry(track({ scrollSize: 201 }))).toBeNull();
  });

  it("sizes the thumb by the share of the content on screen", () => {
    // A fifth of the content is visible, so the thumb is a fifth of the track.
    expect(thumbGeometry(track())?.size).toBe(40);
  });

  it("puts the thumb at the start when the content is at the top", () => {
    expect(thumbGeometry(track())?.offset).toBe(0);
  });

  it("puts the thumb at the end of the track when the content is at the bottom", () => {
    const geom = thumbGeometry(track({ scrollPos: 800 }));
    expect(geom).not.toBeNull();
    // Bottomed out means the thumb's far edge meets the track's, whatever the
    // thumb's length — the off-by-one that leaves a gap at the bottom.
    expect((geom?.offset ?? 0) + (geom?.size ?? 0)).toBe(200);
  });

  it("keeps a very long document's thumb grabbable", () => {
    const geom = thumbGeometry(track({ scrollSize: 500_000 }));
    // The proportional size here is well under a pixel.
    expect(geom?.size).toBe(24);
    expect((geom?.offset ?? 0) + (geom?.size ?? 0)).toBeLessThanOrEqual(200);
  });

  it("never overflows a track shorter than the minimum thumb", () => {
    const geom = thumbGeometry(track({ scrollSize: 500_000, trackLength: 12 }));
    expect(geom?.size).toBe(12);
    expect(geom?.offset).toBe(0);
  });

  it("clamps a scroll position past the end", () => {
    // Momentum scrolling and rubber-banding both report positions outside the
    // real range; the thumb must stop at the track's end rather than run past.
    const geom = thumbGeometry(track({ scrollPos: 5000 }));
    expect((geom?.offset ?? 0) + (geom?.size ?? 0)).toBe(200);
  });

  it("clamps a negative scroll position", () => {
    expect(thumbGeometry(track({ scrollPos: -300 }))?.offset).toBe(0);
  });
});

describe("scrollFromDrag", () => {
  it("scales the pointer delta by the ratio the thumb is shorter than the track", () => {
    // Thumb 40px in a 200px track: 160px of thumb travel across 800px of
    // content, so one pointer pixel is five content pixels.
    expect(scrollFromDrag(0, 16, track())).toBe(80);
  });

  it("bottoms out rather than scrolling past the end", () => {
    expect(scrollFromDrag(0, 10_000, track())).toBe(800);
  });

  it("tops out rather than scrolling above the start", () => {
    expect(scrollFromDrag(400, -10_000, track())).toBe(0);
  });

  it("is a no-op on an axis that cannot scroll", () => {
    expect(scrollFromDrag(0, 50, track({ scrollSize: 200 }))).toBe(0);
  });

  it("is a no-op when the thumb fills the track and has nowhere to travel", () => {
    // A track no longer than the minimum thumb: dragging it must not teleport
    // the content, which is what dividing by a zero travel would do.
    expect(scrollFromDrag(120, 40, track({ trackLength: 12 }))).toBe(120);
  });

  it("round-trips a drag out and back to where it started", () => {
    const m = track();
    const out = scrollFromDrag(0, 16, m);
    expect(scrollFromDrag(out, -16, { ...m, scrollPos: out })).toBe(0);
  });
});

/**
 * The stylesheet half of the mechanism, guarded here because it is the half
 * that silently broke.
 *
 * WebKitGTK builds a scroll container's native bar once and ignores every later
 * change to `scrollbar-width`, so the bar can only be prevented — never removed
 * — and `themes.css` has to hide every one of them statically, up front. A
 * single per-surface rule naming a native bar anywhere in that file undoes it
 * for that surface, and the failure is invisible in every automated gate: the
 * app just paints its own thumb next to a native bar that never left. That is
 * exactly how the two-scrollbars bug survived a round of fixing, so the rule is
 * asserted rather than left to memory.
 */
describe("stylesheet scrollbar invariants", () => {
  // Comments are prose about scrollbars, including the values banned below.
  // The whole split corpus, in import order — one offender anywhere counts.
  const css: string = readAppStylesheet().replace(/\/\*[\s\S]*?\*\//g, "");

  it("hides every native bar from the baseline, where it still counts", () => {
    // Also the guard against these assertions passing vacuously: an empty or
    // unread stylesheet has no offenders either, which is how a `?raw` import
    // (stubbed to "" by the config's `css: false`) quietly made the whole
    // block meaningless once already.
    expect(css).toMatch(/(^|\n)\*\s*\{[^}]*scrollbar-width\s*:\s*none/);
  });

  it("never asks for a native scrollbar of any width", () => {
    const offenders = [...css.matchAll(/scrollbar-width\s*:\s*([^;}]+)/g)]
      .map((m) => m[1].replace(/!important/, "").trim())
      .filter((value) => value !== "none");
    expect(offenders).toEqual([]);
  });

  it("never sizes a ::-webkit-scrollbar above zero", () => {
    const offenders: string[] = [];
    for (const rule of css.split("}")) {
      const [selector, body] = rule.split("{");
      if (!body || !selector.includes("::-webkit-scrollbar")) continue;
      // The parts of a bar (-thumb, -track, -corner) may carry any size; it is
      // the bar itself whose width/height reserves a gutter.
      if (/::-webkit-scrollbar-/.test(selector)) continue;
      for (const [, prop, value] of body.matchAll(/\b(width|height)\s*:\s*([^;}]+)/g)) {
        if (parseFloat(value) !== 0) offenders.push(`${selector.trim()} { ${prop}: ${value.trim()} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("registers the opt-out property so it cannot inherit", () => {
    // An opted-out strip must not mute the thumbs of scroll containers inside
    // it, which only a registered `inherits: false` property guarantees.
    const at = css.match(/@property\s+--eldrun-scrollbar\s*\{[^}]*\}/);
    expect(at?.[0]).toMatch(/inherits\s*:\s*false/);
  });
});
