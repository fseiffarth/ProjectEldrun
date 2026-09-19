import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMailListDate } from "../lib/mail";

describe("formatMailListDate", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the arrival time on an older message", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 17, 12, 0));
    const iso = new Date(2026, 8, 10, 14, 32).toISOString();
    const out = formatMailListDate(iso, "en-GB", true);
    expect(out).toContain("14:32");
    expect(out).toContain("10");
    expect(out).not.toContain("2026");
  });

  it("names the year outside the current one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 17, 12, 0));
    const out = formatMailListDate(new Date(2025, 0, 3, 8, 5).toISOString(), "en-GB", true);
    expect(out).toContain("2025");
    expect(out).toContain("08:05");
  });

  it("shows only the time for today, and an unparseable date verbatim", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 17, 18, 0));
    expect(formatMailListDate(new Date(2026, 8, 17, 9, 7).toISOString(), "en-GB", true)).toBe("09:07");
    expect(formatMailListDate("garbage", "en-GB", true)).toBe("garbage");
  });
});
