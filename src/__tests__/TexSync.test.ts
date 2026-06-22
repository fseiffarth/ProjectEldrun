/**
 * Unit tests for the SyncTeX helper math (#56) and the two cross-tab request
 * stores that carry forward/reverse-search results between the editor and PDF
 * tabs. All pure / store-level — no component rendering.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  pdfPointToBigPoints,
  bigPointsToCssRect,
  lineStartOffset,
  offsetToLineCol,
} from "../components/files/tex";
import { useEditorJumpStore } from "../stores/editorJump";
import { usePdfSyncStore } from "../stores/pdfSync";

describe("SyncTeX coordinate math", () => {
  it("pdfPointToBigPoints divides the in-rect offset by scale", () => {
    const rect = { left: 10, top: 20 };
    // At scale 2, a click 200px right / 100px down of the page origin is 100x50
    // big points.
    expect(pdfPointToBigPoints(rect, 210, 120, 2)).toEqual({ x: 100, y: 50 });
    // At scale 1 it is the raw offset.
    expect(pdfPointToBigPoints(rect, 30, 25, 1)).toEqual({ x: 20, y: 5 });
  });

  it("bigPointsToCssRect is the inverse mapping (multiply by scale)", () => {
    const css = bigPointsToCssRect({ page: 1, x: 100, y: 50, w: 200, h: 12 }, 2);
    expect(css).toEqual({ left: 200, top: 100, width: 400, height: 24 });
  });
});

describe("editor line/offset helpers", () => {
  const text = "alpha\nbeta\ngamma\n";

  it("lineStartOffset returns the char offset of a 1-based line start", () => {
    expect(lineStartOffset(text, 1)).toBe(0);
    expect(lineStartOffset(text, 2)).toBe(6); // after "alpha\n"
    expect(lineStartOffset(text, 3)).toBe(11); // after "beta\n"
    // Past the end clamps to the text length.
    expect(lineStartOffset(text, 99)).toBe(text.length);
  });

  it("offsetToLineCol is the inverse of lineStartOffset for line starts", () => {
    expect(offsetToLineCol(text, 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToLineCol(text, 6)).toEqual({ line: 2, column: 1 });
    // Mid-line: column counts from the line start (1-based).
    expect(offsetToLineCol(text, 8)).toEqual({ line: 2, column: 3 });
  });
});

describe("editorJump store", () => {
  beforeEach(() => useEditorJumpStore.setState({ requestsByPath: {} }));

  it("records a jump with an incrementing nonce, and consume clears it", () => {
    const { requestJump } = useEditorJumpStore.getState();
    requestJump("/p/a.tex", 12);
    expect(useEditorJumpStore.getState().requestsByPath["/p/a.tex"]).toEqual({
      line: 12,
      nonce: 1,
    });
    // A repeat jump to the same file bumps the nonce so it re-fires.
    requestJump("/p/a.tex", 12);
    expect(useEditorJumpStore.getState().requestsByPath["/p/a.tex"].nonce).toBe(2);

    useEditorJumpStore.getState().consume("/p/a.tex");
    expect(useEditorJumpStore.getState().requestsByPath["/p/a.tex"]).toBeUndefined();
  });
});

describe("pdfSync store", () => {
  beforeEach(() => usePdfSyncStore.setState({ byPath: {} }));

  it("records a reveal with an incrementing nonce, and consume clears it", () => {
    const rect = { page: 2, x: 1, y: 2, w: 3, h: 4 };
    usePdfSyncStore.getState().requestReveal("/p/a.pdf", rect);
    expect(usePdfSyncStore.getState().byPath["/p/a.pdf"]).toEqual({ rect, nonce: 1 });

    usePdfSyncStore.getState().requestReveal("/p/a.pdf", rect);
    expect(usePdfSyncStore.getState().byPath["/p/a.pdf"].nonce).toBe(2);

    usePdfSyncStore.getState().consume("/p/a.pdf");
    expect(usePdfSyncStore.getState().byPath["/p/a.pdf"]).toBeUndefined();
  });
});
