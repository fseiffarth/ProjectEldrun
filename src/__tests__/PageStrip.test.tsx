/**
 * Tests for the shared page strip (`components/common/PageStrip`) — the widget the
 * print preview's strip and the PDF viewer's page rail are both instances of.
 *
 * `insertionIndexAt` is the pure core of the drag (which gap the pointer is in), so
 * it is tested directly and on both axes. The component tests then cover the parts
 * that only exist once mounted: shift-selection, and acting on a whole selection.
 *
 * jsdom gives every element a zero-sized rect, so the drag's hit-testing is driven
 * by stubbing `getBoundingClientRect` — the same approach `DragDropSplit.test.tsx`
 * takes for the tab drag.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { PageStrip, insertionIndexAt, type CardBox } from "../components/common/PageStrip";
import { initialPages, type PageList } from "../lib/viewers/pageModel";

const box = (index: number, left: number, top: number): CardBox => ({
  index,
  left,
  top,
  right: left + 50,
  bottom: top + 70,
});

describe("insertionIndexAt", () => {
  // Three cards laid out left-to-right at x = 0, 60, 120 (each 50 wide).
  const row = [box(0, 0, 0), box(1, 60, 0), box(2, 120, 0)];
  // ...and the same three stacked top-to-bottom at y = 0, 80, 160 (each 70 tall).
  const column = [box(0, 0, 0), box(1, 0, 80), box(2, 0, 160)];

  it("lands before the first card whose midpoint the pointer has not passed (row)", () => {
    expect(insertionIndexAt(row, 5, 0, "row")).toBe(0); // left of card 0's middle
    expect(insertionIndexAt(row, 40, 0, "row")).toBe(1); // past card 0's middle
    expect(insertionIndexAt(row, 100, 0, "row")).toBe(2);
    expect(insertionIndexAt(row, 999, 0, "row")).toBe(3); // past them all → append
  });

  it("measures along the y axis in a column, not the x axis", () => {
    expect(insertionIndexAt(column, 0, 5, "column")).toBe(0);
    expect(insertionIndexAt(column, 0, 50, "column")).toBe(1);
    expect(insertionIndexAt(column, 0, 999, "column")).toBe(3);
    // A big x means nothing in a column — only the y axis is consulted.
    expect(insertionIndexAt(column, 999, 5, "column")).toBe(0);
  });

  it("appends when there is nothing to compare against", () => {
    expect(insertionIndexAt([], 10, 10, "row")).toBe(0);
  });
});

/** A strip wired to real state, so edits round-trip like they do in the app. */
function Harness({
  initial,
  onPages,
}: {
  initial: PageList;
  onPages?: (p: PageList) => void;
}) {
  const [pages, setPages] = useState(initial);
  return (
    <PageStrip
      pages={pages}
      orientation="row"
      onChange={(next) => {
        setPages(next);
        onPages?.(next);
      }}
      renderThumb={(ref) => <span className="thumb">{ref.page}</span>}
      titleFor={(ref) => `Page ${ref.page}`}
    />
  );
}

const cards = () => screen.getAllByRole("listitem");
const pageNumbers = () => cards().map((c) => c.querySelector(".thumb")?.textContent);

/**
 * Dispatch a pointer event the way the existing drag tests do (`DragDropSplit`):
 * jsdom's PointerEvent doesn't carry the fields we read, so a plain Event is
 * decorated with them, and `act` flushes the React state the handler sets.
 */
function pointer(type: string, x: number, y: number, target: EventTarget) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  act(() => {
    target.dispatchEvent(ev);
  });
}

/** Give the cards a layout: jsdom has none, so the drag has nothing to aim at. */
function layOutRow(els: HTMLElement[]) {
  els.forEach((el, i) => {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      left: i * 60,
      right: i * 60 + 50,
      top: 0,
      bottom: 70,
      width: 50,
      height: 70,
      x: i * 60,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });
}

describe("PageStrip", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes the whole selection when a selected card's ✕ is pressed", async () => {
    const user = userEvent.setup();
    render(<Harness initial={initialPages(4)} />);
    expect(pageNumbers()).toEqual(["1", "2", "3", "4"]);

    // Select pages 2..3 with a shift-click range, then delete via page 2's ✕.
    await user.click(cards()[1]);
    await user.keyboard("{Shift>}");
    await user.click(cards()[2]);
    await user.keyboard("{/Shift}");

    expect(cards()[1].className).toContain("is-selected");
    expect(cards()[2].className).toContain("is-selected");

    await user.click(cards()[1].querySelector(".page-strip-del") as HTMLElement);
    expect(pageNumbers()).toEqual(["1", "4"]);
  });

  it("acts on only the clicked card when it is outside the selection", async () => {
    const user = userEvent.setup();
    render(<Harness initial={initialPages(3)} />);

    await user.click(cards()[0]); // select page 1
    // ...then delete page 3, which is NOT selected: page 1 must survive.
    await user.click(cards()[2].querySelector(".page-strip-del") as HTMLElement);
    expect(pageNumbers()).toEqual(["1", "2"]);
  });

  it("turns a page, and marks a quarter turn so the thumbnail's box is swapped", async () => {
    const user = userEvent.setup();
    render(<Harness initial={initialPages(2)} />);

    await user.click(cards()[0].querySelector(".page-strip-rotate") as HTMLElement);
    expect(cards()[0].className).toContain("is-quarter-turned");
    expect(cards()[0].getAttribute("style")).toContain("90deg");

    // A second turn is a half turn: upright box again, but still rotated.
    await user.click(cards()[0].querySelector(".page-strip-rotate") as HTMLElement);
    expect(cards()[0].className).not.toContain("is-quarter-turned");
    expect(cards()[0].getAttribute("style")).toContain("180deg");
  });

  it("reorders by dragging a card past a neighbour's midpoint", () => {
    const seen: PageList[] = [];
    render(<Harness initial={initialPages(3)} onPages={(p) => seen.push(p)} />);
    layOutRow(cards());

    // Press page 1 and drag it right, past page 3's midpoint (x = 145).
    pointer("pointerdown", 10, 10, cards()[0]);
    pointer("pointermove", 150, 10, window);
    pointer("pointerup", 150, 10, window);

    expect(pageNumbers()).toEqual(["2", "3", "1"]);
    expect(seen[seen.length - 1].map((r) => r.page)).toEqual([2, 3, 1]);
  });

  it("drags a whole shift-selected block, keeping its internal order", async () => {
    const user = userEvent.setup();
    render(<Harness initial={initialPages(4)} />);

    // Select pages 1..2, then drag them to the end.
    await user.click(cards()[0]);
    await user.keyboard("{Shift>}");
    await user.click(cards()[1]);
    await user.keyboard("{/Shift}");

    layOutRow(cards());
    pointer("pointerdown", 10, 10, cards()[0]);
    pointer("pointermove", 400, 10, window);
    pointer("pointerup", 400, 10, window);

    expect(pageNumbers()).toEqual(["3", "4", "1", "2"]);
  });

  it("puts the arrangement back if the drag is abandoned with Escape", () => {
    render(<Harness initial={initialPages(3)} />);
    layOutRow(cards());

    pointer("pointerdown", 10, 10, cards()[0]);
    pointer("pointermove", 150, 10, window);
    expect(pageNumbers()).toEqual(["2", "3", "1"]); // moved live under the pointer

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(pageNumbers()).toEqual(["1", "2", "3"]); // ...and put back
  });
});
