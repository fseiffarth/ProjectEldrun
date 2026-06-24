/**
 * Detach send-off animation: the pure `flyVector` helper that aims the fly-out
 * card toward the edge the content exited through, and the store's viewport
 * clamping so an off-window drop still animates somewhere visible.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { flyVector, useDetachAnimStore } from "../stores/detachAnim";

describe("flyVector", () => {
  const VW = 1000;
  const VH = 800;

  it("points right when the exit is to the right of centre", () => {
    const { dx, dy } = flyVector(990, 400, VW, VH);
    expect(dx).toBeGreaterThan(0);
    expect(Math.abs(dy)).toBeLessThan(Math.abs(dx)); // mostly horizontal
  });

  it("points up-left toward a top-left exit", () => {
    const { dx, dy } = flyVector(0, 0, VW, VH);
    expect(dx).toBeLessThan(0);
    expect(dy).toBeLessThan(0);
  });

  it("has constant magnitude regardless of distance", () => {
    const near = flyVector(600, 400, VW, VH);
    const far = flyVector(2000, 400, VW, VH); // way off-screen, same direction
    expect(Math.hypot(near.dx, near.dy)).toBeCloseTo(Math.hypot(far.dx, far.dy), 0);
  });

  it("lifts upward for a dead-centre exit (degenerate)", () => {
    const { dx, dy } = flyVector(VW / 2, VH / 2, VW, VH);
    expect(dx).toBe(0);
    expect(dy).toBeLessThan(0);
  });
});

describe("useDetachAnimStore.flyOut", () => {
  beforeEach(() => {
    useDetachAnimStore.setState({ flourish: null });
    // jsdom default viewport.
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  });

  it("clamps an off-window origin back into the viewport", () => {
    useDetachAnimStore.getState().flyOut({ x: 5000, y: -200, w: 240, h: 150, label: "Tab" });
    const f = useDetachAnimStore.getState().flourish!;
    expect(f.x).toBeLessThanOrEqual(1024 - 16);
    expect(f.x).toBeGreaterThanOrEqual(16);
    expect(f.y).toBeGreaterThanOrEqual(16);
  });

  it("bumps the nonce on each play so a repeat fly-out re-triggers", () => {
    const s = useDetachAnimStore.getState();
    s.flyOut({ x: 100, y: 100, w: 10, h: 10, label: "a" });
    const n1 = useDetachAnimStore.getState().flourish!.nonce;
    s.flyOut({ x: 100, y: 100, w: 10, h: 10, label: "a" });
    const n2 = useDetachAnimStore.getState().flourish!.nonce;
    expect(n2).toBeGreaterThan(n1);
  });

  it("clears only when the nonce matches (a newer play isn't cut off)", () => {
    const s = useDetachAnimStore.getState();
    s.flyOut({ x: 100, y: 100, w: 10, h: 10, label: "a" });
    const stale = useDetachAnimStore.getState().flourish!.nonce;
    s.flyOut({ x: 100, y: 100, w: 10, h: 10, label: "b" });
    s.clear(stale); // animationend from the OLD card
    expect(useDetachAnimStore.getState().flourish).not.toBeNull();
    s.clear(useDetachAnimStore.getState().flourish!.nonce);
    expect(useDetachAnimStore.getState().flourish).toBeNull();
  });
});
