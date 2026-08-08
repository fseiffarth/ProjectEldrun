/**
 * Turning a selection on a PDF page into geometry (#pdf-textselect).
 *
 * The half worth testing is the arithmetic, not the engine: `Range.getClientRects()`
 * is the browser's and jsdom has no layout to produce one from, so the rect merge is
 * exercised directly with the rectangles a real range hands back. Those are the two
 * cases that decide whether a highlight looks right — a sentence broken into fragments
 * along one line, and a sentence broken across two.
 */
import { describe, it, expect } from "vitest";
import { mergeSelectionRects } from "../components/embed/pdf/selection";

/** A rect, as a plain object — jsdom has `DOMRect`, and this keeps the cases legible. */
const r = (left: number, top: number, w: number, h: number) => new DOMRect(left, top, w, h);
const shape = (rects: DOMRect[]) =>
  rects.map((x) => [x.left, x.top, Math.round(x.width), Math.round(x.height)]);

describe("merging a selection's rectangles", () => {
  it("joins the fragments of one line into a single box", () => {
    // What a range over "the *estimator* is unbiased" hands back: one rect per text
    // node, three of them, touching. As quads these would be three overlapping
    // annotations, each drawn at 40% — visibly darker at every seam.
    expect(
      shape(mergeSelectionRects([r(10, 100, 40, 12), r(50, 100, 30, 12), r(80, 100, 50, 12)], 2)),
    ).toEqual([[10, 100, 120, 12]]);
  });

  it("keeps two lines apart, however close together they are set", () => {
    // A highlight's quads are per line by definition: one box spanning both would
    // paint the leading between them.
    expect(shape(mergeSelectionRects([r(100, 40, 80, 12), r(20, 56, 140, 12)], 2))).toEqual([
      [100, 40, 80, 12],
      [20, 56, 140, 12],
    ]);
  });

  it("does not bridge a real gap on the same line", () => {
    // Two columns, or a selection that skips a figure: joining these would paint a
    // stripe across whatever sits between them.
    expect(shape(mergeSelectionRects([r(10, 100, 40, 12), r(300, 100, 40, 12)], 2))).toEqual([
      [10, 100, 40, 12],
      [300, 100, 40, 12],
    ]);
  });

  it("orders lines down the page whatever order the drag produced", () => {
    // A selection dragged bottom-to-top reports its rects in either direction, and
    // the first box is what a highlight is anchored (and its card hung) from.
    expect(shape(mergeSelectionRects([r(20, 56, 140, 12), r(100, 40, 80, 12)], 2))[0]).toEqual([
      100, 40, 80, 12,
    ]);
  });

  it("treats boxes of unequal height on one line as one line", () => {
    // A footnote mark or a subscript inside a sentence is a shorter box on the same
    // baseline; splitting there would leave the marker unhighlighted.
    expect(shape(mergeSelectionRects([r(10, 100, 40, 12), r(50, 103, 8, 7)], 2))).toEqual([
      [10, 100, 48, 12],
    ]);
  });

  it("says nothing about nothing", () => {
    expect(mergeSelectionRects([], 2)).toEqual([]);
  });
});
