/**
 * The htop-like monitor derives every live percentage on the frontend from the
 * delta of two successive backend snapshots (the backend only ships cumulative
 * counters). These tests lock that delta math: per-core CPU%, per-process CPU%
 * (top-style, normalised by core count), and MEM% — including the first-frame
 * and counter-reset guards that keep a fresh or pid-reused sample from spiking.
 */
import { describe, it, expect } from "vitest";

import {
  coreUsagePercent,
  procCpuPercent,
  memPercent,
  type CpuTimes,
} from "../components/monitoring/SystemMonitorPane";

describe("coreUsagePercent", () => {
  it("is 0 on the first frame (no previous sample)", () => {
    expect(coreUsagePercent(undefined, { busy: 50, total: 100 })).toBe(0);
  });

  it("computes busyΔ / totalΔ as a percentage", () => {
    const prev: CpuTimes = { busy: 100, total: 400 };
    const next: CpuTimes = { busy: 150, total: 500 };
    // busyΔ=50 over totalΔ=100 → 50%.
    expect(coreUsagePercent(prev, next)).toBeCloseTo(50);
  });

  it("returns 0 on a non-positive total delta (idle/stale sample)", () => {
    const same: CpuTimes = { busy: 100, total: 400 };
    expect(coreUsagePercent(same, same)).toBe(0);
  });

  it("returns 0 on a negative busy delta (counter reset)", () => {
    expect(coreUsagePercent({ busy: 200, total: 400 }, { busy: 10, total: 500 })).toBe(0);
  });

  it("clamps to 100", () => {
    // Impossible-but-defensive: busyΔ exceeds totalΔ.
    expect(coreUsagePercent({ busy: 0, total: 0 }, { busy: 500, total: 100 })).toBe(100);
  });
});

describe("procCpuPercent", () => {
  it("is 0 on the first frame (no previous jiffies)", () => {
    expect(procCpuPercent(undefined, 1000, 400, 8)).toBe(0);
  });

  it("normalises by core count (top-style % of one core)", () => {
    // A process that used 100 jiffies while the whole machine advanced 400 total
    // jiffies, on an 8-core box: (100/400)*8*100 = 200% (two cores busy).
    expect(procCpuPercent(900, 1000, 400, 8)).toBeCloseTo(200);
  });

  it("single-core box reports plain ratio", () => {
    expect(procCpuPercent(0, 50, 100, 1)).toBeCloseTo(50);
  });

  it("returns 0 on a non-positive total delta", () => {
    expect(procCpuPercent(900, 1000, 0, 8)).toBe(0);
  });

  it("returns 0 on a negative process delta (pid reuse / respawn)", () => {
    expect(procCpuPercent(1000, 10, 400, 8)).toBe(0);
  });
});

describe("memPercent", () => {
  it("computes rss / total as a percentage", () => {
    expect(memPercent(2048, 8192)).toBeCloseTo(25);
  });

  it("returns 0 when total is unknown", () => {
    expect(memPercent(2048, 0)).toBe(0);
  });
});
