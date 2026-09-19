import { describe, expect, it } from "vitest";
import { promptChartInWindow } from "../lib/agents/prompt/chart";

const now = new Date(2026, 8, 15, 12, 0, 0);
const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
const sent = { state: "sent" as const };
const scheduled = { state: "scheduled" as const };
const queued = { state: "queued" as const };

describe("prompt chart When window", () => {
  it("any admits everything, and a card with no instant is never excluded", () => {
    expect(promptChartInWindow(sent, at(-2_000), "any", now)).toBe(true);
    expect(promptChartInWindow(scheduled, null, "past", now)).toBe(true);
  });

  it("splits past from upcoming at now, with a queued card upcoming whatever its due minute", () => {
    expect(promptChartInWindow(sent, at(-1), "past", now)).toBe(true);
    expect(promptChartInWindow(scheduled, at(1), "past", now)).toBe(false);
    expect(promptChartInWindow(scheduled, at(1), "upcoming", now)).toBe(true);
    expect(promptChartInWindow(queued, at(-0.02), "upcoming", now)).toBe(true);
    expect(promptChartInWindow(queued, at(-0.02), "past", now)).toBe(false);
  });

  it("rolling windows run both ways from now", () => {
    expect(promptChartInWindow(sent, at(-0.5), "hour", now)).toBe(true);
    expect(promptChartInWindow(scheduled, at(0.5), "hour", now)).toBe(true);
    expect(promptChartInWindow(sent, at(-2), "hour", now)).toBe(false);
    expect(promptChartInWindow(scheduled, at(24 * 6), "week", now)).toBe(true);
    expect(promptChartInWindow(sent, at(-24 * 8), "week", now)).toBe(false);
    expect(promptChartInWindow(sent, at(-24 * 29), "month", now)).toBe(true);
    expect(promptChartInWindow(scheduled, at(24 * 31), "month", now)).toBe(false);
  });

  it("today is the calendar day, not the last 24 hours", () => {
    expect(promptChartInWindow(sent, new Date(2026, 8, 15, 0, 5), "today", now)).toBe(true);
    expect(promptChartInWindow(scheduled, new Date(2026, 8, 15, 23, 55), "today", now)).toBe(true);
    expect(promptChartInWindow(sent, new Date(2026, 8, 14, 23, 55), "today", now)).toBe(false);
  });
});
