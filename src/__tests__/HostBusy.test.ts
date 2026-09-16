/**
 * The busy reading behind the pulsing machine lamp (`stores/hostBusy`).
 *
 * What these pin: a reading is keyed by SSH target (so one probe lights every
 * record of the same machine), it goes stale rather than lying, a host that
 * is not connected never pulses, a probe is never stacked, a failed probe
 * leaves the last reading alone, and an ad-hoc global probe never touches an
 * HPC-tagged host — or any host while settings are still unloaded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { busyLabel, busyReading, isBusy, useHostBusyStore } from "../stores/hostBusy";
import { useSettingsStore } from "../stores/settings";
import { targetKey } from "../lib/machineSync";

const gpu = { user: "alice", host: "gpu.example.org", port: 22 };
const MIN = 60 * 1000;

/** Let a probe's `await invoke(...)` settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  invokeMock.mockReset();
  useHostBusyStore.setState({ readings: {}, inFlight: {} });
  useSettingsStore.setState({ settings: {}, loaded: true });
});

describe("busyReading", () => {
  it("answers null with no target, no host, no reading, or zero sessions", () => {
    const state = { readings: { [targetKey(gpu)]: { sessions: 0, names: [], at: Date.now() } } };
    expect(busyReading(state, undefined)).toBeNull();
    expect(busyReading(state, { host: "" })).toBeNull();
    expect(busyReading({ readings: {} }, gpu)).toBeNull();
    // Zero live sessions is "not busy", not a reading to pulse on.
    expect(busyReading(state, gpu)).toBeNull();
  });

  it("returns a fresh reading and drops one older than the stale window", () => {
    const fresh = { sessions: 2, names: ["train", "build"], at: Date.now() - MIN };
    expect(busyReading({ readings: { [targetKey(gpu)]: fresh } }, gpu)).toBe(fresh);

    // The cache is a last-known reading, not live truth: past ten minutes a
    // lamp pulsing for a run that may have ended is worse than none.
    const old = { sessions: 2, names: ["train"], at: Date.now() - 11 * MIN };
    expect(busyReading({ readings: { [targetKey(gpu)]: old } }, gpu)).toBeNull();
    // The window is a parameter, so a caller can be stricter.
    expect(busyReading({ readings: { [targetKey(gpu)]: fresh } }, gpu, 30 * 1000)).toBeNull();
  });

  it("finds one machine under every spelling of its target", () => {
    // Keyed by target, never by record id: the header, the project pill and the
    // Machines hub each hold their own copy of this host and must agree.
    const reading = { sessions: 1, names: ["train"], at: Date.now() };
    const state = { readings: { [targetKey(gpu)]: reading } };
    expect(busyReading(state, { user: "alice", host: "GPU.example.org" })).toBe(reading);
    expect(busyReading(state, { user: " alice ", host: "gpu.example.org", port: 22 })).toBe(reading);
    expect(busyReading(state, { user: "bob", host: "gpu.example.org" })).toBeNull();
  });
});

describe("isBusy / busyLabel", () => {
  it("never pulses a host that is not connected, whatever the cache says", () => {
    const state = {
      readings: { [targetKey(gpu)]: { sessions: 1, names: ["train"], at: Date.now() } },
    };
    expect(isBusy(state, gpu, true)).toBe(true);
    expect(isBusy(state, gpu, false)).toBe(false);
  });

  it("words the tooltip for one and for several sessions", () => {
    expect(busyLabel({ sessions: 1, names: ["train"], at: 0 })).toBe("1 session running: train");
    expect(busyLabel({ sessions: 2, names: ["build", "train"], at: 0 })).toBe(
      "2 sessions running: build, train",
    );
  });
});

describe("probeGlobal", () => {
  it("lists the host's tmux sessions ad hoc and records them by target", async () => {
    invokeMock.mockResolvedValue([
      { name: "train", windows: 1, created: 1, attached: false },
      { name: "build", windows: 2, created: 2, attached: true },
    ]);
    await useHostBusyStore.getState().probeGlobal(gpu);
    expect(invokeMock).toHaveBeenCalledWith("global_machine_tmux_list", {
      user: "alice",
      host: "gpu.example.org",
      port: 22,
    });
    const reading = useHostBusyStore.getState().readings[targetKey(gpu)];
    expect(reading.sessions).toBe(2);
    // A detached session counts — a run nobody is watching is still a run.
    expect(reading.names).toEqual(["train", "build"]);
    expect(useHostBusyStore.getState().inFlight).toEqual({});
  });

  it("never logs into an HPC-tagged host for a lamp", async () => {
    // The caller is a sweep run from a menu that opens on hover; an unasked-for
    // login on a shared login node every time the pointer crosses the header is
    // exactly what the tag forbids.
    useSettingsStore.setState({ settings: { hpc_hosts: { [targetKey(gpu)]: true } }, loaded: true });
    await useHostBusyStore.getState().probeGlobal(gpu);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("fails closed while settings are still unloaded", async () => {
    useSettingsStore.setState({ settings: null, loaded: false });
    await useHostBusyStore.getState().probeGlobal(gpu);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not stack a second probe while one is in flight", async () => {
    let release!: (rows: unknown) => void;
    invokeMock.mockReturnValue(new Promise((r) => (release = r)));
    const first = useHostBusyStore.getState().probeGlobal(gpu);
    const second = useHostBusyStore.getState().probeGlobal(gpu);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    release([{ name: "train", windows: 1, created: 1, attached: false }]);
    await Promise.all([first, second]);
    expect(useHostBusyStore.getState().readings[targetKey(gpu)].sessions).toBe(1);
    expect(useHostBusyStore.getState().inFlight).toEqual({});
  });

  it("leaves the previous reading alone when the probe fails", async () => {
    // An unreachable host is the connection lamp's news, not this one's.
    const prior = { sessions: 1, names: ["train"], at: Date.now() };
    useHostBusyStore.setState({ readings: { [targetKey(gpu)]: prior } });
    invokeMock.mockRejectedValue("ssh: connect timed out");
    await useHostBusyStore.getState().probeGlobal(gpu);
    await settle();
    expect(useHostBusyStore.getState().readings[targetKey(gpu)]).toBe(prior);
    // …but the in-flight mark is dropped, so the next sweep can probe again.
    expect(useHostBusyStore.getState().inFlight).toEqual({});
  });
});

describe("probeProjectHost", () => {
  it("rides the project pool, naming the primary as null and a worker by id", async () => {
    invokeMock.mockResolvedValue([]);
    await useHostBusyStore.getState().probeProjectHost("p1", "primary", gpu);
    expect(invokeMock).toHaveBeenLastCalledWith("remote_tmux_list", { projectId: "p1", hostId: null });

    const worker = { user: "alice", host: "node7.example.org" };
    await useHostBusyStore.getState().probeProjectHost("p1", "w-7", worker);
    expect(invokeMock).toHaveBeenLastCalledWith("remote_tmux_list", { projectId: "p1", hostId: "w-7" });
    // An empty list is a reading of zero, which busyReading then reads as "not busy".
    expect(useHostBusyStore.getState().readings[targetKey(worker)].sessions).toBe(0);
    expect(busyReading(useHostBusyStore.getState(), worker)).toBeNull();
  });
});

describe("clear", () => {
  it("forgets a host's reading on disconnect and leaves the others", () => {
    const other = { host: "cpu.example.org" };
    useHostBusyStore.setState({
      readings: {
        [targetKey(gpu)]: { sessions: 1, names: ["train"], at: Date.now() },
        [targetKey(other)]: { sessions: 1, names: ["sync"], at: Date.now() },
      },
    });
    useHostBusyStore.getState().clear({ user: "alice", host: "GPU.example.org" });
    expect(useHostBusyStore.getState().readings[targetKey(gpu)]).toBeUndefined();
    expect(useHostBusyStore.getState().readings[targetKey(other)]).toBeDefined();
  });
});
