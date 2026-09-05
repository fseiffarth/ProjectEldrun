/**
 * Ctrl/Cmd+P over a focused PDF prints the document.
 *
 * The chord is contested: `QuickOpen` registers it on `window` in the CAPTURE
 * phase and calls `stopPropagation()`, so the PDF pane's own `onKeyDown` — a
 * React handler, i.e. bubble phase on the host element — never runs unless the
 * palette stands aside first. That yield is what this pins: it is invisible in
 * the PDF viewer's own code, so a future edit to the palette could take the
 * chord back without anything failing.
 *
 * Focus is the whole test. With the cursor anywhere else the palette keeps the
 * chord, which is what Ctrl+P means in an editor everywhere else.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));

import { QuickOpen } from "../components/files/QuickOpen";
import { useProjectsStore } from "../stores/projects";

const project: ProjectEntry = {
  id: "p1",
  name: "p1",
  status: "active",
  position: 0,
  local_file: "/p/p1/project.json",
};

/** The palette is open when its query input is on screen. */
const paletteOpen = () => screen.queryByRole("textbox") != null;

function renderWithPdfPane() {
  const { container } = render(
    <>
      <QuickOpen />
      <div className="file-viewer-pdf-host">
        <div className="file-viewer-pdf-scroll" tabIndex={0} data-testid="pdf-scroll" />
      </div>
      <div data-testid="elsewhere" tabIndex={0} />
    </>,
  );
  return container;
}

beforeEach(() => {
  useProjectsStore.setState({ projects: [project], activeId: "p1", loaded: true });
});

describe("Ctrl+P over a PDF", () => {
  it("leaves the chord to the focused PDF pane", () => {
    renderWithPdfPane();
    fireEvent.keyDown(screen.getByTestId("pdf-scroll"), { key: "p", ctrlKey: true });
    expect(paletteOpen()).toBe(false);
  });

  it("still opens the palette from anywhere else", () => {
    renderWithPdfPane();
    fireEvent.keyDown(screen.getByTestId("elsewhere"), { key: "p", ctrlKey: true });
    expect(paletteOpen()).toBe(true);
  });

  it("yields from anywhere inside the pane, not just the scroll area", () => {
    // The overlays (find bar, page-jump, remark cards) are all inside the host,
    // and the chord means the same from any of them.
    const container = renderWithPdfPane();
    const host = container.querySelector(".file-viewer-pdf-host")!;
    const nested = document.createElement("input");
    host.appendChild(nested);
    fireEvent.keyDown(nested, { key: "p", ctrlKey: true });
    expect(screen.queryByRole("textbox")).toBe(nested);
  });
});
