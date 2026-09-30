import { describe, expect, it } from "vitest";
import { HUB_R, orbitLayout } from "../../lib/shortcuts/steeringOrbit";

const sizes = [
  { w: 120, h: 90 },
  { w: 100, h: 40 },
  { w: 140, h: 110 },
  { w: 90, h: 20 },
  { w: 110, h: 60 },
  { w: 80, h: 20 },
  { w: 100, h: 40 },
];

describe("steering orbit layout", () => {
  it("gives every group a circle that holds its key list", () => {
    const { circles } = orbitLayout(sizes, 1920, 1080);
    circles.forEach((c, i) => expect(c.d).toBeGreaterThanOrEqual(Math.hypot(sizes[i].w, sizes[i].h)));
  });

  it("fans the circles left to right above the hub without overlaps", () => {
    const { circles } = orbitLayout(sizes, 1920, 1080);
    for (let i = 1; i < circles.length; i++) expect(circles[i].x).toBeGreaterThan(circles[i - 1].x);
    for (let i = 0; i < circles.length; i++) {
      const a = circles[i];
      expect(Math.hypot(a.x, a.y)).toBeGreaterThan(HUB_R + a.d / 2);
      for (let j = i + 1; j < circles.length; j++) {
        const b = circles[j];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual((a.d + b.d) / 2);
      }
    }
  });

  it("keeps the fan inside the window", () => {
    for (const [vw, vh] of [
      [1920, 1080],
      [800, 600],
    ]) {
      const { bottom, scale, circles } = orbitLayout(sizes, vw, vh);
      for (const c of circles) {
        expect(bottom + scale * (c.y - c.d / 2)).toBeGreaterThanOrEqual(0);
        expect(scale * (Math.abs(c.x) + c.d / 2)).toBeLessThanOrEqual(vw / 2);
      }
    }
  });

  it("puts a lone circle straight above the hub", () => {
    const [c] = orbitLayout([{ w: 80, h: 20 }], 1920, 1080).circles;
    expect(c.x).toBeCloseTo(0);
    expect(c.y).toBeGreaterThan(0);
  });
});
