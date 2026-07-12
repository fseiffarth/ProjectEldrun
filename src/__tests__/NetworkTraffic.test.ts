import { describe, expect, it } from "vitest";
import {
  aggregateInterfaceCounters,
  formatBytes,
  rateFromSamples,
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

  it("summarizes persisted usage into today / month / overall (UTC)", () => {
    // 2026-07-03T12:00:00Z → today 2026-07-03, month 2026-07.
    const now = Date.parse("2026-07-03T12:00:00Z");
    const totals = summarizeNetUsage(
      {
        "2026-07-03": { rx: 100, tx: 40 },
        "2026-07-01": { rx: 10, tx: 5 },
        "2026-06-30": { rx: 1_000, tx: 2_000 },
      },
      now,
    );
    expect(totals.today).toEqual({ rx: 100, tx: 40 });
    expect(totals.month).toEqual({ rx: 110, tx: 45 });
    expect(totals.overall).toEqual({ rx: 1_110, tx: 2_045 });
  });

  it("returns zero totals for an empty usage map", () => {
    const totals = summarizeNetUsage({}, Date.parse("2026-07-03T12:00:00Z"));
    expect(totals.today).toEqual({ rx: 0, tx: 0 });
    expect(totals.month).toEqual({ rx: 0, tx: 0 });
    expect(totals.overall).toEqual({ rx: 0, tx: 0 });
  });
});
