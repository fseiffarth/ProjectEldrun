import { describe, expect, it } from "vitest";
import {
  flattenRows,
  formatBytes,
  layoutRings,
  ringPath,
  sharePercent,
  squarify,
  type DuNode,
} from "../lib/diskUsage";

const TAU = Math.PI * 2;

function file(name: string, size: number, parent = ""): DuNode {
  return {
    name,
    path: `${parent}/${name}`,
    size,
    is_dir: false,
    children: [],
    hidden_children: 0,
    hidden_bytes: 0,
  };
}

function dir(name: string, children: DuNode[], parent = "", hidden = { count: 0, bytes: 0 }): DuNode {
  const path = `${parent}/${name}`;
  return {
    name,
    path,
    size: children.reduce((s, c) => s + c.size, 0) + hidden.bytes,
    is_dir: true,
    children: [...children].sort((a, b) => b.size - a.size),
    hidden_children: hidden.count,
    hidden_bytes: hidden.bytes,
  };
}

/** /root { big/ { b.bin 600, c.bin 200 }, small.bin 200 } — 1000 bytes total. */
function tree(): DuNode {
  const big = dir("big", [file("b.bin", 600, "/root/big"), file("c.bin", 200, "/root/big")], "/root");
  return dir("root", [big, file("small.bin", 200, "/root")], "");
}

describe("formatBytes", () => {
  it("steps through the units at each 1024 boundary", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 K");
    expect(formatBytes(1024 * 1024)).toBe("1.0 M");
    expect(formatBytes(1024 ** 3)).toBe("1.00 G");
    expect(formatBytes(1024 ** 4)).toBe("1.00 T");
  });

  it("drops the decimal once a unit reaches double digits", () => {
    expect(formatBytes(10 * 1024)).toBe("10 K");
    expect(formatBytes(9.5 * 1024)).toBe("9.5 K");
  });

  it("renders a non-size as a dash rather than NaN", () => {
    expect(formatBytes(NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("sharePercent", () => {
  it("is a percentage of the parent, and 0 when the parent is empty", () => {
    expect(sharePercent(250, 1000)).toBe(25);
    expect(sharePercent(5, 0)).toBe(0);
  });
});

describe("flattenRows", () => {
  it("yields only the root when nothing is expanded", () => {
    const rows = flattenRows(tree(), new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0].node.name).toBe("root");
    expect(rows[0].depth).toBe(0);
    expect(rows[0].expandable).toBe(true);
  });

  it("reveals a directory's children, biggest first, when it is expanded", () => {
    const rows = flattenRows(tree(), new Set(["/root"]));
    expect(rows.map((r) => r.node.name)).toEqual(["root", "big", "small.bin"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1]);
  });

  it("recurses into nested expanded directories and carries the parent size", () => {
    const rows = flattenRows(tree(), new Set(["/root", "/root/big"]));
    expect(rows.map((r) => r.node.name)).toEqual(["root", "big", "b.bin", "c.bin", "small.bin"]);
    // b.bin's share bar is drawn against `big` (800), not the root (1000).
    const bBin = rows.find((r) => r.node.name === "b.bin")!;
    expect(bBin.parentSize).toBe(800);
    expect(bBin.expandable).toBe(false);
  });

  it("ignores an expanded path that has no children to show", () => {
    const rows = flattenRows(tree(), new Set(["/root", "/root/small.bin"]));
    expect(rows.map((r) => r.node.name)).toEqual(["root", "big", "small.bin"]);
  });
});

describe("layoutRings", () => {
  it("does not draw the root — it is the centre disc", () => {
    const arcs = layoutRings(tree());
    expect(arcs.every((a) => a.depth >= 1)).toBe(true);
    expect(arcs.some((a) => a.node?.name === "root")).toBe(false);
  });

  it("gives each ring's slices the full circle, split by size", () => {
    const arcs = layoutRings(tree());
    const ring1 = arcs.filter((a) => a.depth === 1);
    expect(ring1.map((a) => a.node?.name)).toEqual(["big", "small.bin"]);

    // big is 800/1000 of the root, small.bin the remaining 200/1000.
    expect(ring1[0].a1 - ring1[0].a0).toBeCloseTo(TAU * 0.8);
    expect(ring1[1].a1 - ring1[1].a0).toBeCloseTo(TAU * 0.2);
    // ...and together they close the circle with no gap.
    expect(ring1[0].a0).toBeCloseTo(0);
    expect(ring1[ring1.length - 1].a1).toBeCloseTo(TAU);
  });

  it("nests a child inside its parent's sweep", () => {
    const arcs = layoutRings(tree());
    const big = arcs.find((a) => a.node?.name === "big")!;
    const ring2 = arcs.filter((a) => a.depth === 2);
    expect(ring2.map((a) => a.node?.name)).toEqual(["b.bin", "c.bin"]);
    for (const arc of ring2) {
      expect(arc.a0).toBeGreaterThanOrEqual(big.a0 - 1e-9);
      expect(arc.a1).toBeLessThanOrEqual(big.a1 + 1e-9);
    }
    // b.bin is 600/800 of big.
    expect(ring2[0].a1 - ring2[0].a0).toBeCloseTo((big.a1 - big.a0) * 0.75);
  });

  it("colours a whole branch from its top-level ancestor", () => {
    const arcs = layoutRings(tree());
    const big = arcs.find((a) => a.node?.name === "big")!;
    const bBin = arcs.find((a) => a.node?.name === "b.bin")!;
    const small = arcs.find((a) => a.node?.name === "small.bin")!;
    expect(bBin.colorIndex).toBe(big.colorIndex);
    expect(small.colorIndex).not.toBe(big.colorIndex);
  });

  it("stops at maxDepth", () => {
    const arcs = layoutRings(tree(), 1);
    expect(arcs.every((a) => a.depth === 1)).toBe(true);
  });

  it("drops slivers thinner than the minimum angle, along with their subtrees", () => {
    const speck = dir("speck", [file("tiny.bin", 1, "/root/speck")], "/root");
    const root = dir("root", [file("huge.bin", 1_000_000, "/root"), speck], "");
    const arcs = layoutRings(root, 6, 1.2);
    expect(arcs.map((a) => a.node?.name)).toEqual(["huge.bin"]);
  });

  it("draws the capped remainder of a wide directory as an 'others' slice", () => {
    const root = dir("root", [file("a.bin", 750, "/root")], "", { count: 9, bytes: 250 });
    const arcs = layoutRings(root);
    const others = arcs.find((a) => a.node === null)!;
    expect(others).toBeDefined();
    expect(others.a1 - others.a0).toBeCloseTo(TAU * 0.25);
    // It sits after the real children, closing the circle.
    expect(others.a1).toBeCloseTo(TAU);
  });
});

describe("ringPath", () => {
  it("starts at 12 o'clock and sweeps clockwise", () => {
    const d = ringPath(0, 0, 10, 20, 0, Math.PI / 2);
    // Outer start point: straight up from the centre.
    expect(d.startsWith("M 0 -20")).toBe(true);
    // A quarter turn clockwise lands on the +x axis, so it is the short way round.
    expect(d).toContain("A 20 20 0 0 1 20 ");
  });

  it("flags the large-arc case past a half turn", () => {
    const d = ringPath(0, 0, 5, 10, 0, Math.PI * 1.5);
    expect(d).toContain("A 10 10 0 1 1");
  });

  it("keeps a full-circle sector drawable by stopping just short of closing", () => {
    const d = ringPath(0, 0, 5, 10, 0, TAU);
    // Coincident endpoints would render nothing, so the sweep is nudged back.
    expect(d).not.toContain("NaN");
    const [, endX] = /A 10 10 0 1 1 (-?[\d.]+) (-?[\d.]+)/.exec(d)!;
    expect(Math.abs(Number(endX))).toBeLessThan(0.01);
  });
});

describe("squarify", () => {
  const box = { x: 0, y: 0, w: 400, h: 300 };

  it("tiles the box exactly, with areas proportional to size", () => {
    const cells = squarify(tree(), box);
    expect(cells.map((c) => c.node?.name).sort()).toEqual(["big", "small.bin"]);

    const area = box.w * box.h;
    const total = cells.reduce((s, c) => s + c.w * c.h, 0);
    expect(total).toBeCloseTo(area, 6);

    const big = cells.find((c) => c.node?.name === "big")!;
    expect(big.w * big.h).toBeCloseTo(area * 0.8, 6);
  });

  it("keeps every cell inside the box", () => {
    const many = dir(
      "root",
      Array.from({ length: 25 }, (_, i) => file(`f${i}.bin`, (i + 1) * 37, "/root")),
      "",
    );
    for (const cell of squarify(many, box)) {
      expect(cell.x).toBeGreaterThanOrEqual(-1e-6);
      expect(cell.y).toBeGreaterThanOrEqual(-1e-6);
      expect(cell.x + cell.w).toBeLessThanOrEqual(box.x + box.w + 1e-6);
      expect(cell.y + cell.h).toBeLessThanOrEqual(box.y + box.h + 1e-6);
      expect(cell.w).toBeGreaterThan(0);
      expect(cell.h).toBeGreaterThan(0);
    }
  });

  it("produces squarer cells than a naive slice-and-dice would", () => {
    const many = dir(
      "root",
      Array.from({ length: 12 }, (_, i) => file(`f${i}.bin`, 100, "/root")),
      "",
    );
    const cells = squarify(many, box);
    expect(cells).toHaveLength(12);
    // 12 equal cells in a 400×300 box: a slice-and-dice would give 33×300 slivers
    // (ratio 9); squarified cells should be far closer to square.
    const worst = Math.max(...cells.map((c) => Math.max(c.w / c.h, c.h / c.w)));
    expect(worst).toBeLessThan(2);
  });

  it("gives the capped remainder its own cell", () => {
    const root = dir("root", [file("a.bin", 750, "/root")], "", { count: 9, bytes: 250 });
    const cells = squarify(root, box);
    const others = cells.find((c) => c.node === null)!;
    expect(others.w * others.h).toBeCloseTo(box.w * box.h * 0.25, 6);
  });

  it("returns nothing for an empty node or a collapsed box", () => {
    expect(squarify(dir("empty", []), box)).toEqual([]);
    expect(squarify(tree(), { x: 0, y: 0, w: 0, h: 300 })).toEqual([]);
  });
});
