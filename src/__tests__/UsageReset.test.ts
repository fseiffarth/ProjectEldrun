import { describe, expect, it } from "vitest";
import { nextUsageReset, parseUsageReport, resolveResetAt } from "../../shared/usageReport";

/**
 * Placing a CLI's `resets …` phrase in time — the one thing auto-continue arms
 * off. Every case here is a shape Claude Code actually prints, or a shape that
 * must be REFUSED rather than guessed at: a wrong instant here sends a continue
 * hours early or a day late, unattended.
 */

/** A fixed Tuesday, 14:00 local, so "next Monday" and "later today" are stable. */
const TUE_1400 = new Date(2026, 8, 1, 14, 0, 0, 0);

describe("resolveResetAt", () => {
  it("reads a bare 12-hour time as the next time it comes round", () => {
    expect(resolveResetAt("6:20pm", TUE_1400)).toEqual(new Date(2026, 8, 1, 18, 20));
    // 9am has passed today, so it means tomorrow's.
    expect(resolveResetAt("9am", TUE_1400)).toEqual(new Date(2026, 8, 2, 9, 0));
  });

  it("reads a 24-hour time without a meridiem", () => {
    expect(resolveResetAt("18:20", TUE_1400)).toEqual(new Date(2026, 8, 1, 18, 20));
    expect(resolveResetAt("09:00", TUE_1400)).toEqual(new Date(2026, 8, 2, 9, 0));
  });

  it("handles noon and midnight the way the meridiem means them", () => {
    expect(resolveResetAt("12:30am", TUE_1400)).toEqual(new Date(2026, 8, 2, 0, 30));
    expect(resolveResetAt("12:30pm", TUE_1400)).toEqual(new Date(2026, 8, 2, 12, 30));
  });

  it("reads a weekday as the next such day, and never today once it has passed", () => {
    expect(resolveResetAt("Mon 9am", TUE_1400)).toEqual(new Date(2026, 8, 7, 9, 0));
    // Tuesday 6pm is still ahead of Tuesday 14:00, so it is today's.
    expect(resolveResetAt("Tue 6pm", TUE_1400)).toEqual(new Date(2026, 8, 1, 18, 0));
    // Tuesday 9am is behind it, so it is next Tuesday's.
    expect(resolveResetAt("Tue 9am", TUE_1400)).toEqual(new Date(2026, 8, 8, 9, 0));
  });

  it("reads today and tomorrow literally", () => {
    expect(resolveResetAt("tomorrow 09:00", TUE_1400)).toEqual(new Date(2026, 8, 2, 9, 0));
    // A `today` time already past comes back in the past — the caller reads
    // that as a stale panel; inventing tomorrow would arm a continue a day late.
    expect(resolveResetAt("today 9am", TUE_1400)).toEqual(new Date(2026, 8, 1, 9, 0));
  });

  it("refuses a phrase it cannot place rather than guessing", () => {
    // A calendar date: nothing here parses one, and reading the `3` as an hour
    // is exactly the confident wrong answer this must not give.
    expect(resolveResetAt("Feb 3, 9am", TUE_1400)).toBeNull();
    expect(resolveResetAt("soon", TUE_1400)).toBeNull();
    expect(resolveResetAt("", TUE_1400)).toBeNull();
    // A bare number is a day, not an hour: neither a colon nor a meridiem.
    expect(resolveResetAt("in 3", TUE_1400)).toBeNull();
    expect(resolveResetAt("25:00", TUE_1400)).toBeNull();
    expect(resolveResetAt("6:75pm", TUE_1400)).toBeNull();
  });
});

describe("nextUsageReset", () => {
  const PANEL = [
    "Current session: 71% used · resets 6:20pm",
    "Current week (all models): 38% used · resets Mon 9am",
    "Current week (Fable): 12% used",
    "Last 24h: 41 requests · 6 sessions",
  ].join("\n");

  it("picks the soonest rollover and names the meter it came from", () => {
    const reset = nextUsageReset(parseUsageReport(PANEL), TUE_1400);
    expect(reset?.label).toBe("Current session");
    expect(reset?.resets).toBe("resets 6:20pm".slice("resets ".length));
    expect(reset?.at).toEqual(new Date(2026, 8, 1, 18, 20));
  });

  it("falls through to a later window when the soonest one has no reset", () => {
    const reset = nextUsageReset(
      parseUsageReport("Current session: 71% used\nCurrent week (all models): 38% used · resets Mon 9am"),
      TUE_1400,
    );
    expect(reset?.label).toBe("Current week (all models)");
  });

  it("answers null when nothing in the panel can be placed in time", () => {
    expect(nextUsageReset(parseUsageReport("Current session: 71% used"), TUE_1400)).toBeNull();
    expect(nextUsageReset(parseUsageReport("nothing to see here"), TUE_1400)).toBeNull();
  });

  it("drops a rollover already in the past — that panel was read before it turned over", () => {
    const reset = nextUsageReset(
      parseUsageReport("Current session: 100% used · resets 9am\nCurrent week: 38% used · resets Mon 9am"),
      // 9am today is behind us, so a bare `9am` resolves to TOMORROW's 9am and
      // is legitimately the soonest; the past-drop is exercised by a weekday
      // phrase, which does not roll forward on its own.
      TUE_1400,
    );
    expect(reset?.at).toEqual(new Date(2026, 8, 2, 9, 0));
  });
});
