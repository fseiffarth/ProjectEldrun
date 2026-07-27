/**
 * #42: the canonical cross-window coordinate space (physical desktop px) and the
 * per-platform drag-event flags. These pure helpers are the safety net that makes
 * the detached drag-drop DPI-correct on Windows/macOS without regressing Linux —
 * the app can't be launched in CI, so the round-trips below are the proof that the
 * physical↔client mapping (and the engine flag table) is correct under scaling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// coords.ts imports cursorPosition/getCurrentWindow at module load; the pure
// helpers under test don't call them, but stub the module so the import is inert.
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
  getCurrentWindow: vi.fn(() => ({})),
}));

import {
  physToClient,
  clientToPhys,
  pointInOuter,
  type WindowFrame,
} from "../lib/coords";

/** A frame with deliberately DIFFERENT inner vs outer origins, so a test can prove
 *  the client mapping uses `innerPhys` only (Windows invisible frame / macOS title
 *  area would make outer ≠ inner). */
function frame(opts: {
  inner: { x: number; y: number };
  outer?: { x: number; y: number };
  size?: { w: number; h: number };
  scale: number;
}): WindowFrame {
  return {
    innerPhys: opts.inner,
    outerPhys: opts.outer ?? opts.inner,
    outerSize: opts.size ?? { w: 800, h: 600 },
    scale: opts.scale,
  };
}

describe("physToClient / clientToPhys round-trip", () => {
  const scales = [1, 1.25, 1.5, 2.0];
  // Non-zero AND negative origins (a monitor left/above the primary has negative
  // physical coordinates under a multi-monitor desktop).
  const origins = [
    { x: 0, y: 0 },
    { x: 1920, y: 0 },
    { x: -1920, y: -200 },
    { x: 137, y: -1080 },
  ];

  for (const scale of scales) {
    for (const inner of origins) {
      it(`is identity through physical→client→physical at scale ${scale}, origin (${inner.x},${inner.y})`, () => {
        const f = frame({ inner, scale });
        for (const p of [
          { x: inner.x, y: inner.y },
          { x: inner.x + 400, y: inner.y + 300 },
          // A point OUTSIDE the viewport (extrapolation): the cursor is over
          // ANOTHER window when the popout streams its position.
          { x: inner.x - 250, y: inner.y + 5000 },
        ]) {
          const c = physToClient(f, p);
          const back = clientToPhys(f, c);
          expect(back.x).toBeCloseTo(p.x, 6);
          expect(back.y).toBeCloseTo(p.y, 6);
        }
      });
    }
  }

  it("divides the physical delta by the window's own scale", () => {
    const f = frame({ inner: { x: 100, y: 50 }, scale: 2 });
    // 300 physical px right of the inner origin = 150 client (CSS) px at DPR 2.
    expect(physToClient(f, { x: 400, y: 50 })).toEqual({ x: 150, y: 0 });
    expect(physToClient(f, { x: 100, y: 250 })).toEqual({ x: 0, y: 100 });
  });

  it("maps client px back out through the same scale", () => {
    const f = frame({ inner: { x: 100, y: 50 }, scale: 1.5 });
    expect(clientToPhys(f, { x: 200, y: 100 })).toEqual({ x: 100 + 300, y: 50 + 150 });
  });
});

describe("physToClient ignores outerPhys (uses innerPhys only)", () => {
  it("returns the same client point regardless of the outer origin", () => {
    const inner = { x: 1000, y: 500 };
    const p = { x: 1240, y: 740 };
    // Three frames identical except for their OUTER origin (frame/shadow offset).
    const a = physToClient(frame({ inner, outer: inner, scale: 1.25 }), p);
    const b = physToClient(frame({ inner, outer: { x: 992, y: 470 }, scale: 1.25 }), p);
    const c = physToClient(frame({ inner, outer: { x: -50, y: -50 }, scale: 1.25 }), p);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

describe("pointInOuter — physical AABB against the outer rect", () => {
  const f = frame({
    inner: { x: 110, y: 140 },
    outer: { x: 100, y: 120 },
    size: { w: 400, h: 300 },
    scale: 1.5,
  });
  it("is true strictly inside", () => {
    expect(pointInOuter(f, { x: 300, y: 250 })).toBe(true);
  });
  it("is true on every corner (inclusive bounds)", () => {
    expect(pointInOuter(f, { x: 100, y: 120 })).toBe(true);
    expect(pointInOuter(f, { x: 500, y: 120 })).toBe(true);
    expect(pointInOuter(f, { x: 100, y: 420 })).toBe(true);
    expect(pointInOuter(f, { x: 500, y: 420 })).toBe(true);
  });
  it("is false just outside each edge", () => {
    expect(pointInOuter(f, { x: 99, y: 250 })).toBe(false);
    expect(pointInOuter(f, { x: 501, y: 250 })).toBe(false);
    expect(pointInOuter(f, { x: 300, y: 119 })).toBe(false);
    expect(pointInOuter(f, { x: 300, y: 421 })).toBe(false);
  });
  it("does not involve scale (both operands are physical)", () => {
    const f2 = frame({ inner: { x: 0, y: 0 }, outer: { x: 0, y: 0 }, size: { w: 10, h: 10 }, scale: 3 });
    expect(pointInOuter(f2, { x: 5, y: 5 })).toBe(true);
    expect(pointInOuter(f2, { x: 11, y: 5 })).toBe(false);
  });
});

describe("dragPlatform — per-platform event flags", () => {
  // dragPlatform is computed once at module load from navigator.platform, so each
  // case stubs the platform and re-imports the module fresh.
  const original = Object.getOwnPropertyDescriptor(navigator, "platform");
  async function loadFor(platform: string) {
    Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
    vi.resetModules();
    return (await import("../lib/dragPlatform")).dragPlatform;
  }
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "platform", original);
  });

  it("Linux (WebKitGTK): cancel commits, no capture, window follows", async () => {
    const p = await loadFor("Linux x86_64");
    expect(p).toEqual({
      cancelCommits: true,
      needsPointerCapture: false,
      followWindowOnDockDrag: true,
    });
  });

  it("Windows (WebView2): cancel commits, capture needed, no window follow", async () => {
    // WebView2 ends these drags with `pointercancel` (preventDefault'd pointerdown
    // + capture on the collapsing `.tab`), so cancel must COMMIT, like WebKitGTK —
    // a genuine capture loss is caught by the blur→abort net instead.
    const p = await loadFor("Win32");
    expect(p).toEqual({
      cancelCommits: true,
      needsPointerCapture: true,
      followWindowOnDockDrag: false,
    });
  });

  it("macOS (WKWebView): cancel aborts, capture needed, no window follow", async () => {
    const p = await loadFor("MacIntel");
    expect(p).toEqual({
      cancelCommits: false,
      needsPointerCapture: true,
      followWindowOnDockDrag: false,
    });
  });
});

describe("bindDragRelease — Shift survives a modifier-less pointercancel", () => {
  // WebView2 ends drags with a SYNTHESIZED pointercancel that carries no
  // modifier state, so the binding must track Shift itself (keydown/keyup +
  // pointermove) rather than trust the terminal event. jsdom has no
  // PointerEvent; MouseEvent carries shiftKey and listeners match on type.
  const original = Object.getOwnPropertyDescriptor(navigator, "platform");
  async function loadFor(platform: string) {
    Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
    vi.resetModules();
    return (await import("../lib/dragPlatform")).bindDragRelease;
  }
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "platform", original);
  });

  it("commits shift=true from a prior shift-held pointermove (WebView2 cancel)", async () => {
    const bind = await loadFor("Win32");
    const onCommit = vi.fn();
    const onAbort = vi.fn();
    bind({ onCommit, onAbort });
    window.dispatchEvent(new MouseEvent("pointermove", { shiftKey: true }));
    window.dispatchEvent(new MouseEvent("pointercancel", { shiftKey: false }));
    expect(onCommit).toHaveBeenCalledWith(true);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("counts a Shift pressed while stationary (keydown, no pointermove)", async () => {
    const bind = await loadFor("Win32");
    const onCommit = vi.fn();
    bind({ onCommit, onAbort: vi.fn() });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }));
    window.dispatchEvent(new MouseEvent("pointercancel", { shiftKey: false }));
    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it("a Shift released again before the drop commits shift=false", async () => {
    const bind = await loadFor("Win32");
    const onCommit = vi.fn();
    bind({ onCommit, onAbort: vi.fn() });
    window.dispatchEvent(new MouseEvent("pointermove", { shiftKey: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", shiftKey: false }));
    window.dispatchEvent(new MouseEvent("pointercancel", { shiftKey: false }));
    expect(onCommit).toHaveBeenCalledWith(false);
  });

  it("a genuine pointerup keeps its own shiftKey (Linux unchanged)", async () => {
    const bind = await loadFor("Linux x86_64");
    const onCommit = vi.fn();
    bind({ onCommit, onAbort: vi.fn() });
    window.dispatchEvent(new MouseEvent("pointerup", { shiftKey: true }));
    expect(onCommit).toHaveBeenCalledWith(true);
  });
});
