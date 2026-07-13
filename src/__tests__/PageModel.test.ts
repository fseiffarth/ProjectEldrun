/**
 * Tests for the shared page-arrangement model (`lib/viewers/pageModel`) — the one
 * the print preview's strip and the PDF viewer's page rail both edit.
 *
 * The first block is the print preview's ORIGINAL arrangement/rotation suite, moved
 * here verbatim in behaviour and re-expressed against the generalised model. It is
 * what pins the port down: if `movePages`/`deletePages`/`rotatePages` ever stop
 * agreeing with the old `movePage`/`removePage`/`rotatePage`, these fail.
 *
 * The second block covers what the old model could not express at all — multi-page
 * moves, several source documents, and independently-turned duplicates.
 */
import { describe, it, expect } from "vitest";
import {
  SELF,
  initialPages,
  pagesOf,
  movePages,
  deletePages,
  rotatePages,
  duplicatePages,
  insertPages,
  isPristine,
  type PageList,
} from "../lib/viewers/pageModel";

/** The arrangement as "which original page sits on each sheet" — the old `order`. */
const order = (list: PageList): number[] => list.map((r) => r.page);
/** The id of the sheet currently at `index`. */
const idAt = (list: PageList, index: number): string => list[index].id;
/** The rotation of the sheet showing original page `page`. */
const rotOf = (list: PageList, page: number): number =>
  list.find((r) => r.page === page)?.rot ?? 0;

describe("page arrangement (the print preview's original suite, on the shared model)", () => {
  it("moves a page to a new position", () => {
    // `movePages`' index counts the sheets NOT being moved, which is precisely the
    // convention the old `movePage(order, from, to)` used.
    const four = initialPages(4);
    expect(order(movePages(four, [idAt(four, 0)], 2))).toEqual([2, 3, 1, 4]);
    expect(order(movePages(four, [idAt(four, 3)], 0))).toEqual([4, 1, 2, 3]);

    const three = initialPages(3);
    // A no-op move and an unknown id leave the order untouched.
    expect(order(movePages(three, [idAt(three, 1)], 1))).toEqual([1, 2, 3]);
    expect(order(movePages(three, ["nope"], 0))).toEqual([1, 2, 3]);
    // Past the end clamps to last.
    expect(order(movePages(three, [idAt(three, 0)], 99))).toEqual([2, 3, 1]);
  });

  it("removes a page", () => {
    const three = initialPages(3);
    expect(order(deletePages(three, [idAt(three, 1)]))).toEqual([1, 3]);
    expect(order(deletePages(three, ["nope"]))).toEqual([1, 2, 3]);
  });

  it("turns a page a quarter at a time and wraps back to upright", () => {
    let list = initialPages(3);
    const id = idAt(list, 1); // original page 2
    list = rotatePages(list, [id]);
    expect(rotOf(list, 2)).toBe(90);
    list = rotatePages(list, [id]);
    expect(rotOf(list, 2)).toBe(180);
    list = rotatePages(rotatePages(list, [id]), [id]);
    // Four turns is a full circle: the page is upright again.
    expect(rotOf(list, 2)).toBe(0);
  });

  it("turns counter-clockwise and leaves other pages alone", () => {
    let list = initialPages(3);
    list = rotatePages(list, [idAt(list, 0)]); // page 1 → 90°
    list = rotatePages(list, [idAt(list, 2)], -90); // page 3 → 270°
    expect(rotOf(list, 3)).toBe(270);
    expect(rotOf(list, 1)).toBe(90);
    expect(rotOf(list, 2)).toBe(0);
  });

  it("carries a page's turn with it when the page is reordered", () => {
    // The old model keyed rotation by original page number to survive reordering;
    // here the turn simply rides along on the entry, which is stronger.
    let list = initialPages(3);
    list = rotatePages(list, [idAt(list, 2)]); // page 3 → 90°
    list = movePages(list, [idAt(list, 2)], 0); // drag page 3 to the front
    expect(order(list)).toEqual([3, 1, 2]);
    expect(list[0].rot).toBe(90);
  });

  it("starts from the document's own order", () => {
    expect(order(initialPages(3))).toEqual([1, 2, 3]);
    expect(initialPages(0)).toEqual([]);
    expect(initialPages(3).every((r) => r.src === SELF && r.rot === 0)).toBe(true);
  });

  it("knows when the arrangement is still untouched", () => {
    const list = initialPages(3);
    expect(isPristine(list, 3)).toBe(true);
    expect(isPristine(deletePages(list, [idAt(list, 0)]), 3)).toBe(false);
    expect(isPristine(movePages(list, [idAt(list, 0)], 2), 3)).toBe(false);
    expect(isPristine(rotatePages(list, [idAt(list, 0)]), 3)).toBe(false);
  });
});

describe("page arrangement (what the old per-document model could not express)", () => {
  it("moves a multi-page selection as one block, keeping its internal order", () => {
    const five = initialPages(5);
    const picked = [idAt(five, 1), idAt(five, 2)]; // pages 2 and 3
    // Land them after page 5: the survivors are [1,4,5], so index 3 is the end.
    expect(order(movePages(five, picked, 3))).toEqual([1, 4, 5, 2, 3]);
    // ...and at the very front.
    expect(order(movePages(five, picked, 0))).toEqual([2, 3, 1, 4, 5]);
  });

  it("moves a DISCONTIGUOUS selection as one block", () => {
    const five = initialPages(5);
    const picked = [idAt(five, 0), idAt(five, 4)]; // pages 1 and 5
    // Survivors are [2,3,4]; inserting before the 2nd survivor puts the block
    // between pages 2 and 3, and the block keeps its own order (1 then 5).
    expect(order(movePages(five, picked, 1))).toEqual([2, 1, 5, 3, 4]);
  });

  it("deletes a multi-page selection in one step", () => {
    const five = initialPages(5);
    expect(order(deletePages(five, [idAt(five, 0), idAt(five, 3)]))).toEqual([2, 3, 5]);
  });

  it("turns a duplicated page independently of its twin", () => {
    // The old model keyed rotation by original page number, so both copies of a
    // page necessarily turned together. Here they do not.
    let list = initialPages(2);
    list = duplicatePages(list, [idAt(list, 0)]); // page 1 twice, adjacent
    expect(order(list)).toEqual([1, 1, 2]);
    expect(list[0].id).not.toBe(list[1].id);

    list = rotatePages(list, [idAt(list, 1)]); // turn only the copy
    expect(list[0].rot).toBe(0);
    expect(list[1].rot).toBe(90);
  });

  it("merges pages from another document, keeping each sheet's own source", () => {
    const mine = initialPages(2); // "self": pages 1, 2
    const other = pagesOf("doc-b", 3); // another PDF: pages 1..3
    const merged = insertPages(mine, other.slice(0, 2), 1); // its 1-2 after my page 1

    expect(merged.map((r) => [r.src, r.page])).toEqual([
      [SELF, 1],
      ["doc-b", 1],
      ["doc-b", 2],
      [SELF, 2],
    ]);
    // A merged arrangement is never "pristine", however many pages it happens to have.
    expect(isPristine(merged, 4)).toBe(false);
  });

  it("gives inserted pages fresh ids, so re-inserting the same pages never collides", () => {
    const mine = initialPages(2);
    const twice = insertPages(insertPages(mine, mine, 0), mine, 0);
    expect(twice).toHaveLength(6);
    expect(new Set(twice.map((r) => r.id)).size).toBe(6);
  });
});
