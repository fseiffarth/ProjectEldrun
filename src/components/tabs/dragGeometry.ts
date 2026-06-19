import type { DropEdge } from "../../stores/tabs";

/** A pane rectangle in any consistent coordinate space (panel-relative px). */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Decide which drop edge a pointer at (x,y) maps to within `box`. The central
 * region (a `centerFrac`-wide cross) is "center" (move into the group); outside
 * it the dominant axis picks left/right vs top/bottom.
 */
export function pickEdge(box: Box, x: number, y: number, centerFrac = 0.34): DropEdge {
  const nx = (x - box.left) / box.width - 0.5;
  const ny = (y - box.top) / box.height - 0.5;
  if (Math.abs(nx) < centerFrac / 2 && Math.abs(ny) < centerFrac / 2) {
    return "center";
  }
  if (Math.abs(nx) > Math.abs(ny)) {
    return nx < 0 ? "left" : "right";
  }
  return ny < 0 ? "top" : "bottom";
}

/**
 * Fractional insets (0..1) of the split-preview rectangle for an edge. left/right
 * occupy a vertical half; top/bottom a horizontal half; center fills the body.
 */
export function previewInset(edge: DropEdge): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  switch (edge) {
    case "left":
      return { left: 0, top: 0, right: 0.5, bottom: 0 };
    case "right":
      return { left: 0.5, top: 0, right: 0, bottom: 0 };
    case "top":
      return { left: 0, top: 0, right: 0, bottom: 0.5 };
    case "bottom":
      return { left: 0, top: 0.5, right: 0, bottom: 0 };
    case "center":
    default:
      return { left: 0, top: 0, right: 0, bottom: 0 };
  }
}
