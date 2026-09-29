/**
 * The single-client timer lease (headless owner plan, H2 interim): a window
 * fires its timers only while the backend grants it the lease, assumes it
 * holds one until told otherwise, and keeps firing on a backend that has no
 * lease at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { TIMER_LEASE_CLIENT, holdsTimerLease, useTimerLeaseStore } from "../../stores/timerLease";

const invokeMock = vi.mocked(invoke);

describe("the timer lease store", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useTimerLeaseStore.setState({ held: true, holder: undefined });
  });

  it("holds the lease until the backend names another window", async () => {
    expect(holdsTimerLease()).toBe(true);
    invokeMock.mockResolvedValueOnce({ held: false, holder: "other-window", expiresAt: 1 });
    await useTimerLeaseStore.getState().probe();
    expect(holdsTimerLease()).toBe(false);
    expect(useTimerLeaseStore.getState().holder).toBe("other-window");
    expect(invokeMock).toHaveBeenCalledWith("timer_lease_acquire", { clientId: TIMER_LEASE_CLIENT });

    invokeMock.mockResolvedValueOnce({ held: true, holder: TIMER_LEASE_CLIENT, expiresAt: 2 });
    await useTimerLeaseStore.getState().probe();
    expect(holdsTimerLease()).toBe(true);
    expect(useTimerLeaseStore.getState().holder).toBeUndefined();
  });

  it("keeps firing on a backend without the lease, and keeps the last answer on any other failure", async () => {
    invokeMock.mockResolvedValueOnce({ held: false, holder: "other", expiresAt: 1 });
    await useTimerLeaseStore.getState().probe();
    expect(holdsTimerLease()).toBe(false);

    invokeMock.mockRejectedValueOnce(new Error("lock failed"));
    await useTimerLeaseStore.getState().probe();
    expect(holdsTimerLease()).toBe(false);

    invokeMock.mockRejectedValueOnce(new Error("Command timer_lease_acquire not found"));
    await useTimerLeaseStore.getState().probe();
    expect(holdsTimerLease()).toBe(true);
  });

  it("releases with this window's id and never throws", async () => {
    invokeMock.mockRejectedValueOnce(new Error("gone"));
    await expect(useTimerLeaseStore.getState().release()).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("timer_lease_release", { clientId: TIMER_LEASE_CLIENT });
  });
});
