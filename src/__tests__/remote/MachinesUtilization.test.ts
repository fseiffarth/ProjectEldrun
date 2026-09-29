import { describe, expect, it } from "vitest";
import { showsUtilization, utilizationOf } from "../../components/header/MachinesIndicator";
import { targetKey } from "../../lib/remote/machineSync";
import type { RemoteUsageReport } from "../../stores/remote/remoteUsage";
import type { Settings } from "../../types";

const m = { user: "me", host: "box.example", port: 22 };
const key = targetKey(m);
const settings = (patch: Partial<Settings>) => patch as Settings;

function report(cpuPct: number, gpus: number[]): RemoteUsageReport {
  return {
    users: [], cpuPct, load1: 0, load5: 0, load15: 0, cpuCount: 4, memTotalMb: 0, memUsedMb: 0,
    gpus: gpus.map((u, i) => ({ name: `g${i}`, utilPct: u, memUsedMb: 0, memTotalMb: 0 })),
    topProcs: [], busy: false, reasons: [],
  };
}

describe("showsUtilization", () => {
  it("is off by default — every remote machine starts careful", () => {
    expect(showsUtilization(settings({}), m)).toBe(false);
  });
  it("is on once the machine is switched to Detailed", () => {
    expect(showsUtilization(settings({ careful_hosts: { [key]: false } }), m)).toBe(true);
  });
  it("is off on an HPC-tagged machine even when marked Detailed", () => {
    expect(
      showsUtilization(settings({ careful_hosts: { [key]: false }, hpc_hosts: { [key]: true } }), m),
    ).toBe(false);
  });
});

describe("utilizationOf", () => {
  it("takes the busiest GPU and clamps to 0–100", () => {
    expect(utilizationOf(report(130, [20, 75]))).toEqual({ cpu: 100, gpu: 75 });
  });
  it("omits the GPU on a host that reports none, rather than reading zero", () => {
    expect(utilizationOf(report(12, []))).toEqual({ cpu: 12, gpu: null });
  });
});
