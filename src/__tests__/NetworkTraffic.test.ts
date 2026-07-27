import { describe, expect, it } from "vitest";
import {
  aggregateInterfaceCounters,
  formatBytes,
  formatFileCount,
  rateFromSamples,
  isoWeekKeys,
  summarizeNetFileUsage,
  summarizeNetUsage,
} from "../components/monitoring/NetworkTrafficPane";

describe("network traffic calculations", () => {
  it("aggregates only active non-loopback interfaces by default", () => {
    const counters = aggregateInterfaceCounters(
      [
        { name: "lo", rxBytes: 100, txBytes: 200, up: true, loopback: true },
        { name: "eth0", rxBytes: 1_000, txBytes: 2_000, up: true, loopback: false },
        { name: "wlan0", rxBytes: 4_000, txBytes: 8_000, up: false, loopback: false },
        { name: "tun0", rxBytes: 16_000, txBytes: 32_000, up: true, loopback: false },
      ],
      "aggregate",
    );
    expect(counters).toEqual({ id: "aggregate", rx: 17_000, tx: 34_000 });
  });

  it("selects a named interface including loopback or a down interface", () => {
    const counters = aggregateInterfaceCounters(
      [{ name: "lo", rxBytes: 12, txBytes: 34, up: true, loopback: true }],
      "lo",
    );
    expect(counters).toEqual({ id: "lo", rx: 12, tx: 34 });
  });

  it("derives rates from elapsed time and rejects resets", () => {
    const previous = { id: "eth0", at: 1_000, rx: 10_000, tx: 20_000 };
    expect(
      rateFromSamples(previous, { id: "eth0", at: 3_000, rx: 14_000, tx: 22_000 }),
    ).toEqual({ rxRate: 2_000, txRate: 1_000, rxDelta: 4_000, txDelta: 2_000 });
    expect(
      rateFromSamples(previous, { id: "eth0", at: 3_000, rx: 1, tx: 1 }),
    ).toEqual({ rxRate: 0, txRate: 0, rxDelta: 0, txDelta: 0 });
    expect(
      rateFromSamples(previous, { id: "new-connection", at: 3_000, rx: 14_000, tx: 22_000 }),
    ).toEqual({ rxRate: 0, txRate: 0, rxDelta: 0, txDelta: 0 });
  });

  it("formats byte counts compactly", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MiB");
  });

  it("summarizes persisted usage into hour / today / week / month / overall (UTC)", () => {
    // 2026-07-03T12:30Z is a Friday → hour 2026-07-03T12, ISO week Mon 06-29
    // through Sun 07-05, month 2026-07. 06-28 (Sunday) is the week before, and
    // the three June days sit in the month before.
    const now = Date.parse("2026-07-03T12:30:00Z");
    const totals = summarizeNetUsage(
      {
        hours: {
          "2026-07-03T12": { rx: 7, tx: 3 },
          "2026-07-03T11": { rx: 93, tx: 37 },
        },
        days: {
          "2026-07-03": { rx: 100, tx: 40 },
          "2026-06-30": { rx: 10, tx: 5 },
          "2026-06-29": { rx: 1, tx: 1 },
          "2026-06-28": { rx: 1_000, tx: 2_000 },
        },
      },
      now,
    );
    expect(totals.hour).toEqual({ rx: 7, tx: 3 });
    expect(totals.today).toEqual({ rx: 100, tx: 40 });
    expect(totals.week).toEqual({ rx: 111, tx: 46 });
    expect(totals.month).toEqual({ rx: 100, tx: 40 });
    expect(totals.overall).toEqual({ rx: 1_111, tx: 2_046 });
  });

  it("keeps day-derived totals intact when the hour window has been pruned", () => {
    // Hours are retained for 14 days, days forever: an old day still counts
    // toward week/month/overall with no hour bucket left to back it.
    const totals = summarizeNetUsage(
      { hours: {}, days: { "2026-05-02": { rx: 500, tx: 100 } } },
      Date.parse("2026-07-03T12:00:00Z"),
    );
    expect(totals.hour).toEqual({ rx: 0, tx: 0 });
    expect(totals.overall).toEqual({ rx: 500, tx: 100 });
  });

  it("returns zero totals for an empty usage report", () => {
    const totals = summarizeNetUsage({ hours: {}, days: {} }, Date.parse("2026-07-03T12:00:00Z"));
    expect(totals.hour).toEqual({ rx: 0, tx: 0 });
    expect(totals.today).toEqual({ rx: 0, tx: 0 });
    expect(totals.week).toEqual({ rx: 0, tx: 0 });
    expect(totals.month).toEqual({ rx: 0, tx: 0 });
    expect(totals.overall).toEqual({ rx: 0, tx: 0 });
  });

  it("anchors the ISO week to Monday, including on its Monday and Sunday edges", () => {
    const week = [
      "2026-06-29",
      "2026-06-30",
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
    ];
    // Monday 00:00 and Sunday 23:59 UTC must yield the same seven days — the
    // Sunday edge is the one a naive getUTCDay()-based offset gets wrong.
    expect(isoWeekKeys(Date.parse("2026-06-29T00:00:00Z"))).toEqual(week);
    expect(isoWeekKeys(Date.parse("2026-07-03T12:30:00Z"))).toEqual(week);
    expect(isoWeekKeys(Date.parse("2026-07-05T23:59:59Z"))).toEqual(week);
    // The next Monday rolls over to a fresh week.
    expect(isoWeekKeys(Date.parse("2026-07-06T00:00:00Z"))[0]).toBe("2026-07-06");
  });

  it("summarizes per-project FILE counts into hour / today / week / month / overall", () => {
    const now = Date.parse("2026-07-03T12:30:00Z");
    const totals = summarizeNetFileUsage(
      {
        hours: {},
        days: {},
        fileHours: {
          "2026-07-03T12": { down: 2, up: 0 },
          "2026-07-03T11": { down: 5, up: 1 },
        },
        fileDays: {
          "2026-07-03": { down: 9, up: 3 },
          "2026-06-30": { down: 1, up: 0 },
          "2026-06-28": { down: 100, up: 20 },
        },
      },
      now,
    );
    expect(totals.hour).toEqual({ down: 2, up: 0 });
    expect(totals.today).toEqual({ down: 9, up: 3 });
    expect(totals.week).toEqual({ down: 10, up: 3 });
    expect(totals.month).toEqual({ down: 9, up: 3 });
    expect(totals.overall).toEqual({ down: 110, up: 23 });
  });

  it("returns zero file totals when the report has no file-count maps yet", () => {
    const totals = summarizeNetFileUsage(
      { hours: {}, days: {} },
      Date.parse("2026-07-03T12:00:00Z"),
    );
    expect(totals.hour).toEqual({ down: 0, up: 0 });
    expect(totals.overall).toEqual({ down: 0, up: 0 });
  });

  it("formats file counts with locale grouping", () => {
    expect(formatFileCount(0)).toBe("0");
    // The grouping separator is deliberately the *runtime's* locale ("," en,
    // "." de, narrow-NBSP fr…), so pin the expectation to the same API rather
    // than to en-US — hardcoding "1,234" fails on any non-English machine.
    expect(formatFileCount(1234)).toBe((1234).toLocaleString());
    expect(formatFileCount(1234)).toMatch(/^1\D234$/); // grouping did happen
  });
});
