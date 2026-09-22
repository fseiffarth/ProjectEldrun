/**
 * #42 on native Wayland: the coordinate-free drop claim (`lib/window/dropClaim`).
 * Without desktop coordinates the source window cannot name the window it
 * released over; the window that receives the pointer next claims the drop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { bus } = vi.hoisted(() => ({
  bus: {
    handlers: new Map<string, (ev: { payload: unknown }) => void>(),
    emitted: [] as Array<[string, unknown]>,
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, fn: (ev: { payload: unknown }) => void) => {
    bus.handlers.set(name, fn);
    return Promise.resolve(() => bus.handlers.delete(name));
  }),
  emit: vi.fn((name: string, payload: unknown) => {
    bus.emitted.push([name, payload]);
    return Promise.resolve();
  }),
}));

import {
  DETACHED_DROP_CLAIM,
  DETACHED_DROP_PROBE,
  awaitPointerClaim,
  installPointerTracker,
  probeDropTarget,
  resetPointerTracker,
  type DetachedDropClaim,
} from "../../lib/window/dropClaim";

function pointer(type: string, x: number, y: number) {
  const ev = new Event(type, { bubbles: true });
  Object.assign(ev, { clientX: x, clientY: y });
  window.dispatchEvent(ev);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  bus.handlers.clear();
  bus.emitted.length = 0;
  resetPointerTracker();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("awaitPointerClaim", () => {
  it("fires once on the first pointer event and then disarms", () => {
    const onPointer = vi.fn();
    const onTimeout = vi.fn();
    awaitPointerClaim(onPointer, onTimeout);
    pointer("mousemove", 40, 50);
    pointer("mousemove", 41, 51);
    vi.advanceTimersByTime(5000);
    expect(onPointer).toHaveBeenCalledExactlyOnceWith(40, 50);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("times out when no pointer event arrives, and a cancel silences both", () => {
    const onPointer = vi.fn();
    const onTimeout = vi.fn();
    awaitPointerClaim(onPointer, onTimeout, { timeoutMs: 100 });
    vi.advanceTimersByTime(101);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onPointer).not.toHaveBeenCalled();

    const cancel = awaitPointerClaim(onPointer, onTimeout, { timeoutMs: 100 });
    cancel();
    pointer("mousemove", 1, 1);
    vi.advanceTimersByTime(101);
    expect(onPointer).not.toHaveBeenCalled();
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("claims synchronously from a pointer event the tracker saw after the release", () => {
    installPointerTracker();
    const releasedAt = Date.now() - 10;
    pointer("mousemove", 300, 200); // the crossing beat the probe's IPC hop
    const onPointer = vi.fn();
    awaitPointerClaim(onPointer, vi.fn(), { since: releasedAt });
    expect(onPointer).toHaveBeenCalledExactlyOnceWith(300, 200);
  });

  it("ignores a tracked pointer event that predates the release", () => {
    installPointerTracker();
    pointer("mousemove", 300, 200);
    const onPointer = vi.fn();
    awaitPointerClaim(onPointer, vi.fn(), { since: Date.now() + 1000 });
    expect(onPointer).not.toHaveBeenCalled();
    pointer("mousemove", 5, 6);
    expect(onPointer).toHaveBeenCalledExactlyOnceWith(5, 6);
  });
});

describe("probeDropTarget", () => {
  const probe = {
    token: "main:t:1",
    scope: "p",
    sourceLabel: "main",
    tabKey: "k",
    label: "k",
    releasedAt: 0,
  };

  it("broadcasts the probe after listening, and resolves with the matching claim", async () => {
    const pending = probeDropTarget(probe, 500);
    await vi.waitFor(() => expect(bus.emitted.some(([n]) => n === DETACHED_DROP_PROBE)).toBe(true));
    // The claim listener was registered BEFORE the probe went out.
    expect(bus.handlers.has(DETACHED_DROP_CLAIM)).toBe(true);
    const claim: DetachedDropClaim = {
      token: "main:t:1",
      windowLabel: "pop",
      groupId: "g-pop",
      clientX: 10,
      clientY: 20,
      target: { groupId: "inner", edge: "right" },
    };
    bus.handlers.get(DETACHED_DROP_CLAIM)!({ payload: { ...claim, token: "other" } });
    bus.handlers.get(DETACHED_DROP_CLAIM)!({ payload: claim });
    await expect(pending).resolves.toEqual(claim);
    // Listener torn down once settled.
    expect(bus.handlers.has(DETACHED_DROP_CLAIM)).toBe(false);
  });

  it("resolves null when nobody claims within the timeout", async () => {
    const pending = probeDropTarget(probe, 200);
    await vi.waitFor(() => expect(bus.emitted.some(([n]) => n === DETACHED_DROP_PROBE)).toBe(true));
    vi.advanceTimersByTime(201);
    await expect(pending).resolves.toBeNull();
  });
});
