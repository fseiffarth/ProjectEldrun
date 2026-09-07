/**
 * #240: what a press on a popout's title bar means (`decideTitlebarPress`) —
 * start an OS window move, or fit the window back onto its screen.
 *
 * The regression it guards: a title-bar drag carries the WINDOW under the cursor,
 * so the grab point keeps the same CLIENT coordinates however far the window
 * travelled. Dragging a popout, releasing, and grabbing it again to carry on —
 * the ordinary way anyone nudges a window across a desk — therefore produced two
 * presses that were, in client px and in time, indistinguishable from a
 * double-click. The snap branch consumes the press instead of moving, so every
 * quick re-grab did nothing and the popout stopped being movable.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  decideTitlebarPress,
  TITLEBAR_DOUBLE_CLICK_MS,
  TITLEBAR_DOUBLE_CLICK_SLOP,
} from "../stores/detached";

const T0 = 1_000_000;
const first = { t: T0, x: 100, y: 12 };

describe("decideTitlebarPress", () => {
  it("the first press of a session moves (nothing armed)", () => {
    expect(
      decideTitlebarPress({ prev: { t: 0, x: 0, y: 0 }, now: first, lastMoveAt: 0 }),
    ).toBe("move");
  });

  it("a close, quick second press with no window move between → snap", () => {
    expect(
      decideTitlebarPress({
        prev: first,
        now: { t: T0 + 120, x: 103, y: 14 },
        lastMoveAt: T0 - 5000,
      }),
    ).toBe("snap");
  });

  it("a re-grab after the window MOVED is a move, not a double-click", () => {
    // Same client point (the window followed the cursor) and well inside the
    // double-click window — only the move in between tells the two apart.
    expect(
      decideTitlebarPress({
        prev: first,
        now: { t: T0 + 120, x: 100, y: 12 },
        lastMoveAt: T0 + 40,
      }),
    ).toBe("move");
  });

  it("a move exactly at the first press does not disarm (>, not >=)", () => {
    expect(
      decideTitlebarPress({ prev: first, now: { t: T0 + 50, x: 100, y: 12 }, lastMoveAt: T0 }),
    ).toBe("snap");
  });

  it("too slow → move", () => {
    expect(
      decideTitlebarPress({
        prev: first,
        now: { t: T0 + TITLEBAR_DOUBLE_CLICK_MS, x: 100, y: 12 },
        lastMoveAt: 0,
      }),
    ).toBe("move");
  });

  it("too far → move", () => {
    expect(
      decideTitlebarPress({
        prev: first,
        now: { t: T0 + 50, x: 100 + TITLEBAR_DOUBLE_CLICK_SLOP, y: 12 },
        lastMoveAt: 0,
      }),
    ).toBe("move");
  });
});
