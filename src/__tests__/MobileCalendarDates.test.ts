import { describe, expect, it } from "vitest";
import { shownAllDayEnd, storedAllDayEnd } from "../../mobile-web/src/screens/Calendar";

/** The desktop stores an all-day end as the day after the last day (iCal's
 * exclusive DTEND); the editor shows the last day itself. Without the
 * conversion a single-day all-day event was sent with `end == start`, which
 * the desktop bridge rejects, so it could never be created from the phone. */
describe("mobile calendar all-day end conversion", () => {
  it("shows the inclusive last day of a stored exclusive end", () => {
    // A single-day event on the 26th is stored as end = the 27th.
    expect(shownAllDayEnd("2026-08-26", "2026-08-27")).toBe("2026-08-26");
    // A two-day event covering the 26th and 27th is stored as end = the 28th.
    expect(shownAllDayEnd("2026-08-26", "2026-08-28")).toBe("2026-08-27");
  });

  it("round-trips the edited last day back to the exclusive form", () => {
    expect(storedAllDayEnd("2026-08-26")).toBe("2026-08-27");
    expect(storedAllDayEnd(shownAllDayEnd("2026-08-26", "2026-08-27"))).toBe("2026-08-27");
  });

  it("crosses month boundaries in both directions", () => {
    expect(shownAllDayEnd("2026-08-31", "2026-09-01")).toBe("2026-08-31");
    expect(storedAllDayEnd("2026-08-31")).toBe("2026-09-01");
  });

  it("never shows an end before the start for a degenerate stored span", () => {
    // `end == start` should not exist on disk, but a shown end before the
    // start would immediately re-save as an invalid span.
    expect(shownAllDayEnd("2026-08-26", "2026-08-26")).toBe("2026-08-26");
  });
});
