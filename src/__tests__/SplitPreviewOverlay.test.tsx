/**
 * Geometry + visibility test for the split-preview overlay (the translucent
 * half/whole highlight shown while a tab is dragged over a subwindow). The user
 * reported the darkening not appearing; the structural fix moved the overlay
 * into CenterPanel's stacking context above the pane layer. jsdom can't verify
 * z-index paint, but it DOES preserve inline styles, so we assert the overlay
 * renders the correct half-rect for each edge and is absent when there is no
 * valid target.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

import { vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { SplitPreviewOverlay } from "../components/layout/CenterPanel";
import { useDragStore } from "../stores/drag";
import type { DropEdge } from "../stores/tabs";

const RECTS = { g1: { left: 100, top: 50, width: 400, height: 300 } };

function setEdge(edge: DropEdge, overGroup = "g1") {
  useDragStore.setState({
    drag: {
      kind: "tab",
      key: "k",
      fromGroup: "g1",
      label: "x",
      pointerX: 0,
      pointerY: 0,
      overGroup,
      edge,
      reorderGroup: null,
      reorderIndex: null,
    },
  });
}

function px(el: HTMLElement, prop: "left" | "top" | "width" | "height") {
  return el.style[prop];
}

describe("SplitPreviewOverlay geometry", () => {
  beforeEach(() => {
    cleanup();
    useDragStore.setState({ drag: null });
  });

  it("edge left → left half of the body", () => {
    setEdge("left");
    const { container } = render(<SplitPreviewOverlay groupRects={RECTS} />);
    const el = container.querySelector(".split-preview") as HTMLElement;
    expect(el).toBeTruthy();
    expect(px(el, "left")).toBe("100px");
    expect(px(el, "top")).toBe("50px");
    expect(px(el, "width")).toBe("200px"); // 400 * 0.5
    expect(px(el, "height")).toBe("300px");
  });

  it("edge right → right half of the body", () => {
    setEdge("right");
    const { container } = render(<SplitPreviewOverlay groupRects={RECTS} />);
    const el = container.querySelector(".split-preview") as HTMLElement;
    expect(px(el, "left")).toBe("300px"); // 100 + 400*0.5
    expect(px(el, "top")).toBe("50px");
    expect(px(el, "width")).toBe("200px");
    expect(px(el, "height")).toBe("300px");
  });

  it("edge top → top half of the body", () => {
    setEdge("top");
    const { container } = render(<SplitPreviewOverlay groupRects={RECTS} />);
    const el = container.querySelector(".split-preview") as HTMLElement;
    expect(px(el, "left")).toBe("100px");
    expect(px(el, "top")).toBe("50px");
    expect(px(el, "width")).toBe("400px");
    expect(px(el, "height")).toBe("150px"); // 300 * 0.5
  });

  it("edge bottom → bottom half of the body", () => {
    setEdge("bottom");
    const { container } = render(<SplitPreviewOverlay groupRects={RECTS} />);
    const el = container.querySelector(".split-preview") as HTMLElement;
    expect(px(el, "left")).toBe("100px");
    expect(px(el, "top")).toBe("200px"); // 50 + 300*0.5
    expect(px(el, "width")).toBe("400px");
    expect(px(el, "height")).toBe("150px");
  });

  it("edge center → fills the whole body", () => {
    setEdge("center");
    const { container } = render(<SplitPreviewOverlay groupRects={RECTS} />);
    const el = container.querySelector(".split-preview") as HTMLElement;
    expect(px(el, "left")).toBe("100px");
    expect(px(el, "top")).toBe("50px");
    expect(px(el, "width")).toBe("400px");
    expect(px(el, "height")).toBe("300px");
  });

  it("renders nothing when there is no drag", () => {
    useDragStore.setState({ drag: null });
    const { container } = render(<SplitPreviewOverlay groupRects={RECTS} />);
    expect(container.querySelector(".split-preview")).toBeNull();
  });

  it("renders nothing when overGroup is missing from groupRects", () => {
    setEdge("left", "ghost-group");
    const { container } = render(<SplitPreviewOverlay groupRects={RECTS} />);
    expect(container.querySelector(".split-preview")).toBeNull();
  });

  it("renders nothing when edge is null even with a valid overGroup", () => {
    useDragStore.setState({
      drag: {
        kind: "tab",
        key: "k",
        fromGroup: "g1",
        label: "x",
        pointerX: 0,
        pointerY: 0,
        overGroup: "g1",
        edge: null,
        reorderGroup: null,
        reorderIndex: null,
      },
    });
    const { container } = render(<SplitPreviewOverlay groupRects={RECTS} />);
    expect(container.querySelector(".split-preview")).toBeNull();
  });
});
