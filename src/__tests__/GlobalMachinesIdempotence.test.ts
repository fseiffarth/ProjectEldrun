/**
 * Regression test for the renderer spin: a lamp write that changes nothing must
 * not notify.
 *
 * `setStatus` and `probeAll` rebuilt `status` unconditionally, and zustand
 * notifies on identity — so writing a machine the state it was already in woke
 * every subscriber of this store. `MachinesIndicator` alone holds fourteen
 * selectors against it, so one no-op re-ran all fourteen and re-rendered the
 * header, which re-rendered the project pills, the file panel and the tree under
 * them.
 *
 * Measured in the running app, idle, via the perf probe:
 *
 *              before                     after
 *   commits    150 per 10s                33 per 10s
 *   gm writes  66 per 10s (64 = status)   0
 *   stalls     1 x 263ms per 10s          0
 *
 * That is the whole of the "WebKit renderer pegged, window unresponsive" report:
 * the main thread was re-rendering the entire chrome ~14 times a second for no
 * state change at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
// Pulled in by the store's connect/disconnect paths; irrelevant here.
vi.mock("../lib/machineSync", () => ({
  syncGlobalConnected: vi.fn(),
  syncGlobalDisconnected: vi.fn(),
}));

import { useGlobalMachinesStore } from "../stores/globalMachines";
import { useSettingsStore } from "../stores/settings";
import type { Settings } from "../types";

const MACHINES = [
  { id: "m1", host: "a.example", user: "u" },
  { id: "m2", host: "b.example", user: "u" },
];

describe("globalMachines — a no-op status write must not notify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGlobalMachinesStore.setState({
      machines: MACHINES as never,
      status: { m1: "connected", m2: "connected" },
      reachable: { m1: true, m2: true },
      loaded: true,
    });
    // `probeAll` skips HPC-tagged machines via `mayAutoTouch`, which fails closed on
    // an unloaded settings store — without this it would sweep nothing at all.
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
  });

  it("setStatus does not notify when the lamp already holds that value", () => {
    const seen = vi.fn();
    const unsub = useGlobalMachinesStore.subscribe(seen);

    useGlobalMachinesStore.getState().setStatus("m1", "connected");
    expect(seen).not.toHaveBeenCalled();

    // A real transition must still get through — the fix must not make the lamp
    // stop working, which would be a far worse bug than the one it cures.
    useGlobalMachinesStore.getState().setStatus("m1", "error");
    expect(seen).toHaveBeenCalledTimes(1);
    expect(useGlobalMachinesStore.getState().status.m1).toBe("error");

    unsub();
  });

  it("probeAll does not notify when every machine is already in the probed state", async () => {
    // Both already reachable, and both probe ok → nothing changed.
    mockInvoke.mockResolvedValue({ ok: true });
    const seen = vi.fn();
    const unsub = useGlobalMachinesStore.subscribe(seen);

    await useGlobalMachinesStore.getState().probeAll();
    // This is the valuable half: `probeAll` writes EVERY machine at once, so on a
    // fleet of N an unchanged sweep used to invalidate the whole list at once.
    expect(seen).not.toHaveBeenCalled();

    unsub();
  });

  // The expectation moved from `status` to `reachable` on purpose. A probe answers
  // "did the host answer", which is NOT "does this app hold a session on it" — and
  // `status` means the second, because `lib/machineSync` propagates it onto any
  // project holding the same host and opens that project's pool. Letting a hover-time
  // sweep write `status` is what lit a machine green with no session behind it while
  // the project stayed unconnected. The idempotence guarantee this file exists for is
  // unchanged; only the field it guards moved.
  it("probeAll still notifies, once, when a machine actually changed — on `reachable`", async () => {
    mockInvoke.mockImplementation((_cmd: string, args: { host?: string }) =>
      Promise.resolve({ ok: args?.host !== "b.example" }),
    );
    const seen = vi.fn();
    const unsub = useGlobalMachinesStore.subscribe(seen);

    await useGlobalMachinesStore.getState().probeAll();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(useGlobalMachinesStore.getState().reachable).toEqual({ m1: true, m2: false });
    // …and the session lamps are left exactly as they were: nothing about a probe
    // opens or ends a session.
    expect(useGlobalMachinesStore.getState().status).toEqual({
      m1: "connected",
      m2: "connected",
    });

    unsub();
  });
});
