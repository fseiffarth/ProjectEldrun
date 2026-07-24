/**
 * Tests for the small pure pieces exported from `components/embed/deck/DeckView`
 * — currently just the slide-overview rail's resize clamp, mirroring the same
 * bounds-check test `SubwindowFilesSidebar.test.ts` runs for its own resizable
 * column.
 */

import { describe, it, expect } from "vitest";
import {
  DECK_RAIL_MAX_WIDTH,
  DECK_RAIL_MIN_WIDTH,
  clampRailWidth,
} from "../components/embed/deck/DeckView";

describe("clampRailWidth", () => {
  it("clamps to the documented bounds", () => {
    expect(clampRailWidth(1)).toBe(DECK_RAIL_MIN_WIDTH);
    expect(clampRailWidth(10_000)).toBe(DECK_RAIL_MAX_WIDTH);
  });

  it("rounds to a whole pixel", () => {
    expect(clampRailWidth(150.6)).toBe(151);
  });

  it("leaves an in-range width alone", () => {
    expect(clampRailWidth(150)).toBe(150);
  });
});
