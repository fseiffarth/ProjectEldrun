import { describe, expect, it } from "vitest";
import { parseUsageReport } from "../../shared/usageReport";
import { usageResetMarks, usageWindowKind } from "../lib/agentUsageResets";

/** A fixed Tuesday, 14:00 local. */
const TUE_1400 = new Date(2026, 8, 1, 14, 0, 0, 0);

const PANEL = [
  "Current session: 71% used · resets 6:20pm",
  "Current week (all models): 38% used · resets Mon 9am",
  "Current week (Fable): 52% used · resets Mon 9am",
  "Last 24h: 41 requests · 6 sessions",
].join("\n");

describe("usageWindowKind", () => {
  it("tells the session window from the weekly one", () => {
    expect(usageWindowKind("Current session")).toBe("session");
    expect(usageWindowKind("5-hour window")).toBe("session");
    expect(usageWindowKind("Current week (all models)")).toBe("week");
    expect(usageWindowKind("Weekly limit")).toBe("week");
    expect(usageWindowKind("Last 24h")).toBeNull();
  });
});

describe("usageResetMarks", () => {
  it("marks the next session reset once and merges meters sharing a weekly reset", () => {
    const report = parseUsageReport(PANEL);
    const marks = usageResetMarks("claude", report, TUE_1400, new Date(2026, 8, 1), new Date(2026, 8, 2));
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ agent: "claude", kind: "session", percent: 71 });
    expect(marks[0].at).toEqual(new Date(2026, 8, 1, 18, 20));
  });

  it("repeats the weekly reset across the range, past weeks included, and keeps the fullest meter", () => {
    const report = parseUsageReport(PANEL);
    const marks = usageResetMarks("claude", report, TUE_1400, new Date(2026, 7, 1), new Date(2026, 9, 1))
      .filter((mark) => mark.kind === "week");
    expect(marks.map((mark) => mark.at)).toEqual([
      new Date(2026, 7, 3, 9), new Date(2026, 7, 10, 9), new Date(2026, 7, 17, 9),
      new Date(2026, 7, 24, 9), new Date(2026, 7, 31, 9), new Date(2026, 8, 7, 9),
      new Date(2026, 8, 14, 9), new Date(2026, 8, 21, 9), new Date(2026, 8, 28, 9),
    ]);
    expect(marks[0].labels).toEqual(["Current week (all models)", "Current week (Fable)"]);
    expect(marks[0].percent).toBe(52);
  });

  it("repeats a dated weekly reset the way it repeats a weekday one", () => {
    // Claude Code 2.1.272 names the weekly reset by its date, not its weekday.
    const report = parseUsageReport("Current week (all models): 54% used · resets Sep 7, 9am");
    const marks = usageResetMarks("claude", report, TUE_1400, new Date(2026, 7, 25), new Date(2026, 8, 22));
    expect(marks.map((mark) => mark.at)).toEqual([
      new Date(2026, 7, 31, 9), new Date(2026, 8, 7, 9), new Date(2026, 8, 14, 9), new Date(2026, 8, 21, 9),
    ]);
    expect(marks[0].resets).toBe("Sep 7, 9am");
  });

  it("draws nothing for a session reset outside the range or a phrase it cannot place", () => {
    const report = parseUsageReport("Current session: 10% used · resets Feb 3\nCurrent week: 5% used");
    expect(usageResetMarks("claude", report, TUE_1400, new Date(2026, 0, 1), new Date(2027, 0, 1))).toEqual([]);
    const later = parseUsageReport("Current session: 10% used · resets 6:20pm");
    expect(usageResetMarks("claude", later, TUE_1400, new Date(2026, 8, 2), new Date(2026, 8, 3))).toEqual([]);
  });
});
