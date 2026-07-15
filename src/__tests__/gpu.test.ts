import { describe, expect, it } from "vitest";
import {
  formatBytes,
  gpuBusy,
  gpuPercent,
  gpuTone,
  gpuTooltip,
  gpuTotals,
  type GpuSample,
} from "../lib/gpu";

/** The machine this was built on: a Strix APU — a 512 MB carve-out + a 61 GB GTT pool. */
const apu: GpuSample = {
  name: "Strix [Radeon 880M / 890M]",
  driver: "amdgpu",
  vram_used: 440_770_560,
  vram_total: 536_870_912,
  shared_used: 18_052_190_208,
  shared_total: 65_855_619_072,
  busy_percent: 95,
};

/** A discrete card: all its memory is its own, and there is no shared pool. */
const dgpu: GpuSample = {
  name: "NVIDIA GeForce RTX 4090",
  driver: "nvidia",
  vram_used: 8 * 1024 ** 3,
  vram_total: 24 * 1024 ** 3,
  shared_used: 0,
  shared_total: 0,
  busy_percent: 37,
};

describe("gpuTotals", () => {
  it("sums both pools, which is the only figure an APU can answer 'will it fit?' with", () => {
    const { used, total } = gpuTotals([apu]);
    expect(used).toBe(apu.vram_used + apu.shared_used);
    expect(total).toBe(apu.vram_total + apu.shared_total);
    // The dedicated pool alone would read 82% full and never move.
    expect(gpuPercent(apu.vram_used, apu.vram_total)).toBeGreaterThan(80);
    expect(gpuPercent(used, total)).toBeLessThan(30);
  });

  it("collapses to plain device VRAM on a discrete card", () => {
    expect(gpuTotals([dgpu])).toEqual({ used: 8 * 1024 ** 3, total: 24 * 1024 ** 3 });
  });

  it("sums across adapters, and is zero for none", () => {
    expect(gpuTotals([apu, dgpu]).total).toBe(
      apu.vram_total + apu.shared_total + dgpu.vram_total,
    );
    expect(gpuTotals([])).toEqual({ used: 0, total: 0 });
  });
});

describe("gpuTone", () => {
  it("tones by ratio, so a big-but-empty GPU is not 'hot'", () => {
    // 8 GB in use — the old absolute thresholds (hot at 2 GB) called this high.
    expect(gpuTone(8 * 1024 ** 3, 24 * 1024 ** 3)).toBe("low");
    expect(gpuTone(15 * 1024 ** 3, 24 * 1024 ** 3)).toBe("medium");
    expect(gpuTone(23 * 1024 ** 3, 24 * 1024 ** 3)).toBe("high");
  });

  it("does not divide by a total it does not have", () => {
    expect(gpuTone(0, 0)).toBe("low");
    expect(gpuPercent(1024, 0)).toBe(0);
  });
});

describe("gpuBusy", () => {
  it("takes the busiest adapter, and distinguishes unknown from idle", () => {
    expect(gpuBusy([apu, dgpu])).toBe(95);
    expect(gpuBusy([{ ...dgpu, busy_percent: null }])).toBeNull();
    expect(gpuBusy([{ ...dgpu, busy_percent: 0 }])).toBe(0);
    expect(gpuBusy([])).toBeNull();
  });
});

describe("gpuTooltip", () => {
  it("keeps the pools apart and names Ollama's share", () => {
    const tip = gpuTooltip([apu], 3 * 1024 ** 3);
    expect(tip).toContain("Strix [Radeon 880M / 890M] — 95% busy");
    expect(tip).toContain("VRAM    420 MB / 512 MB");
    expect(tip).toContain("Shared  16.8 GB / 61.3 GB");
    expect(tip).toContain("Ollama models: 3.0 GB");
  });

  it("omits the shared line for a card that has no shared pool", () => {
    expect(gpuTooltip([dgpu], 0)).not.toContain("Shared");
  });
});

describe("formatBytes", () => {
  it("reads MB below a GiB and GB above it", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(536_870_912)).toBe("512 MB");
    expect(formatBytes(18_052_190_208)).toBe("16.8 GB");
  });
});
