// Tests for the dev-only perf monitor's pure half (src/dev/perfStats.ts):
// the ring buffers, the per-command aggregation the IPC table renders, the
// stall window and the formatters. The side-effectful half (the patched
// invoke, the timers) is deliberately untested here — it exists only in a
// live dev window.
import { describe, expect, it } from "vitest";
import {
  aggregateCalls,
  fmtBytes,
  fmtMs,
  pushRing,
  stallSummary,
  type IpcCall,
  type Stall,
} from "../dev/perfStats";

const call = (cmd: string, ts: number, ms: number, ok = true): IpcCall => ({
  cmd,
  ts,
  ms,
  ok,
});

describe("pushRing", () => {
  it("appends until the cap, then drops the oldest", () => {
    const arr: number[] = [];
    for (let i = 0; i < 7; i++) pushRing(arr, i, 5);
    expect(arr).toEqual([2, 3, 4, 5, 6]);
  });

  it("mutates in place (the panel holds the same reference)", () => {
    const arr: number[] = [1, 2, 3];
    const ref = arr;
    pushRing(arr, 4, 3);
    expect(ref).toEqual([2, 3, 4]);
  });
});

describe("aggregateCalls", () => {
  const NOW = 1_000_000;

  it("folds calls into one row per command with totals, avg and max", () => {
    const rows = aggregateCalls(
      [call("a", NOW, 10), call("a", NOW, 30), call("b", NOW, 5)],
      NOW,
      60_000,
    );
    const a = rows.find((r) => r.cmd === "a")!;
    expect(a.count).toBe(2);
    expect(a.totalMs).toBe(40);
    expect(a.avgMs).toBe(20);
    expect(a.maxMs).toBe(30);
    expect(a.errors).toBe(0);
  });

  it("sorts by total time descending — the panel's 'what costs most' order", () => {
    const rows = aggregateCalls(
      [call("cheap", NOW, 1), call("dear", NOW, 500), call("cheap", NOW, 2)],
      NOW,
      60_000,
    );
    expect(rows.map((r) => r.cmd)).toEqual(["dear", "cheap"]);
  });

  it("counts failures per command", () => {
    const rows = aggregateCalls(
      [call("x", NOW, 1, false), call("x", NOW, 1, true), call("x", NOW, 1, false)],
      NOW,
      60_000,
    );
    expect(rows[0].errors).toBe(2);
  });

  it("computes the rate from the window only, totals from the whole buffer", () => {
    // 3 calls, but only 2 within the last 60s → perMin counts those two.
    const rows = aggregateCalls(
      [call("p", NOW - 120_000, 5), call("p", NOW - 30_000, 5), call("p", NOW, 5)],
      NOW,
      60_000,
    );
    expect(rows[0].count).toBe(3);
    expect(rows[0].perMin).toBe(2);
  });

  it("returns nothing for an empty buffer", () => {
    expect(aggregateCalls([], NOW, 60_000)).toEqual([]);
  });
});

describe("stallSummary", () => {
  const NOW = 500_000;
  const stall = (ts: number, ms: number): Stall => ({ ts, ms, kind: "lag" });

  it("counts only stalls inside the window and reports the worst", () => {
    const s = stallSummary(
      [stall(NOW - 120_000, 900), stall(NOW - 10_000, 80), stall(NOW - 5_000, 200)],
      NOW,
      60_000,
    );
    expect(s.count).toBe(2);
    expect(s.worstMs).toBe(200); // the 900ms one is outside the window
  });

  it("is empty-safe", () => {
    expect(stallSummary([], NOW, 60_000)).toEqual({ count: 0, worstMs: 0 });
  });
});

describe("formatters", () => {
  it("fmtMs picks a readable unit", () => {
    expect(fmtMs(0.4)).toBe("0.4ms");
    expect(fmtMs(12.3)).toBe("12ms");
    expect(fmtMs(1234)).toBe("1.2s");
    expect(fmtMs(12_000)).toBe("12s");
  });

  it("fmtBytes picks a readable unit", () => {
    expect(fmtBytes(312)).toBe("312B");
    expect(fmtBytes(4300)).toBe("4.2KB");
    expect(fmtBytes(1_900_000)).toBe("1.8MB");
  });
});
