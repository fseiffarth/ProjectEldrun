/**
 * Tests for the pure drag hit-test helpers: pickEdge region classification and
 * previewInset half/whole-body mapping.
 */
import { describe, it, expect } from "vitest";

import { pickEdge, previewInset, type Box } from "../components/tabs/dragGeometry";

const box: Box = { left: 0, top: 0, width: 100, height: 100 };

describe("dragGeometry — pickEdge", () => {
  it("dead-center is 'center'", () => {
    expect(pickEdge(box, 50, 50)).toBe("center");
  });

  it("left region", () => {
    expect(pickEdge(box, 5, 50)).toBe("left");
  });

  it("right region", () => {
    expect(pickEdge(box, 95, 50)).toBe("right");
  });

  it("top region", () => {
    expect(pickEdge(box, 50, 5)).toBe("top");
  });

  it("bottom region", () => {
    expect(pickEdge(box, 50, 95)).toBe("bottom");
  });

  it("respects an offset box origin", () => {
    const offset: Box = { left: 200, top: 100, width: 100, height: 100 };
    expect(pickEdge(offset, 250, 150)).toBe("center");
    expect(pickEdge(offset, 205, 150)).toBe("left");
  });
});

describe("dragGeometry — previewInset", () => {
  it("left → left half (right inset 0.5)", () => {
    expect(previewInset("left")).toEqual({ left: 0, top: 0, right: 0.5, bottom: 0 });
  });

  it("right → right half (left inset 0.5)", () => {
    expect(previewInset("right")).toEqual({ left: 0.5, top: 0, right: 0, bottom: 0 });
  });

  it("top → top half (bottom inset 0.5)", () => {
    expect(previewInset("top")).toEqual({ left: 0, top: 0, right: 0, bottom: 0.5 });
  });

  it("bottom → bottom half (top inset 0.5)", () => {
    expect(previewInset("bottom")).toEqual({ left: 0, top: 0.5, right: 0, bottom: 0 });
  });

  it("center → full body (all insets 0)", () => {
    expect(previewInset("center")).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });
});
