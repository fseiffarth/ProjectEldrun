/**
 * Host usage reports (`stores/remoteUsage`): keyed by HOST rather than project,
 * read through two probe commands behind one `recheck` (a global machine
 * authenticates ad hoc, a project host rides its pool), best-effort so a dead
 * host leaves its last report rather than tearing down the dialog — and the
 * dialog opens only from its button, never because a report arrived.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  machineKey,
  projectHostKey,
  useRemoteUsageStore,
  type RemoteUsageReport,
} from "../stores/remoteUsage";

const report = (cpuPct: number): RemoteUsageReport => ({
  users: [],
  cpuPct,
  load1: 0,
  load5: 0,
  load15: 0,
  cpuCount: 8,
  memTotalMb: 1,
  memUsedMb: 0,
  gpus: [],
  topProcs: [],
  busy: false,
  reasons: [],
});

beforeEach(() => {
  invokeMock.mockReset();
  useRemoteUsageStore.setState({ reports: {}, isOpen: false });
});

describe("keys", () => {
  it("cannot collide between a global machine and a project host", () => {
    expect(machineKey("m1")).toBe("gm:m1");
    expect(projectHostKey("p1", "primary")).toBe("ph:p1:primary");
    expect(projectHostKey("p1", "w-1")).not.toBe(projectHostKey("p1", "primary"));
  });
});

describe("recheck", () => {
  it("probes a global machine ad hoc by user/host/port", async () => {
    invokeMock.mockResolvedValue(report(42));
    await useRemoteUsageStore.getState().recheck({
      kind: "machine",
      key: machineKey("m1"),
      label: "gpu",
      user: "alice",
      host: "gpu.example.org",
      port: 2222,
    });
    expect(invokeMock).toHaveBeenCalledWith("global_machine_usage_check", {
      user: "alice",
      host: "gpu.example.org",
      port: 2222,
    });
    expect(useRemoteUsageStore.getState().reports["gm:m1"].cpuPct).toBe(42);
  });

  it("probes a project host through its pool by project and host id", async () => {
    invokeMock.mockResolvedValue(report(7));
    await useRemoteUsageStore.getState().recheck({
      kind: "projectHost",
      key: projectHostKey("p1", "w-1"),
      label: "worker",
      projectId: "p1",
      hostId: "w-1",
    });
    expect(invokeMock).toHaveBeenCalledWith("remote_usage_check", { projectId: "p1", hostId: "w-1" });
    expect(useRemoteUsageStore.getState().reports["ph:p1:w-1"].cpuPct).toBe(7);
  });

  it("leaves the cached report in place when the probe fails", async () => {
    useRemoteUsageStore.getState().setReport("gm:m1", report(42));
    invokeMock.mockRejectedValue("credential gone");
    await expect(
      useRemoteUsageStore.getState().recheck({
        kind: "machine",
        key: "gm:m1",
        label: "gpu",
        host: "gpu.example.org",
      }),
    ).resolves.toBeUndefined();
    expect(useRemoteUsageStore.getState().reports["gm:m1"].cpuPct).toBe(42);
  });
});

describe("dialog visibility", () => {
  it("is on demand: an arriving report never opens it", () => {
    useRemoteUsageStore.getState().setReport("ph:p1:primary", report(1));
    expect(useRemoteUsageStore.getState().isOpen).toBe(false);
    useRemoteUsageStore.getState().open();
    expect(useRemoteUsageStore.getState().isOpen).toBe(true);
    useRemoteUsageStore.getState().close();
    expect(useRemoteUsageStore.getState().isOpen).toBe(false);
    // Closing keeps the reports, so the next open has something to show at once.
    expect(useRemoteUsageStore.getState().reports["ph:p1:primary"]).toBeDefined();
  });
});
