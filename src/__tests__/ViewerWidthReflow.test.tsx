/**
 * Regression test for "file viewers don't adapt to window width" on WebKitGTK.
 *
 * In the main window each pane is absolutely positioned at a JS-MEASURED pixel
 * width/height (CenterPanel.measure() → groupRects → the `.center-pane` inline
 * style). The file viewers (markdown/text/PDF) are sized off that pane box, so if
 * the measurement never re-runs when the OS window shrinks, the pane keeps its
 * old (wider) width and the text never reflows.
 *
 * measure() is wired to a ResizeObserver on the panel, but older WebKitGTK builds
 * don't deliver ResizeObserver/'resize' for OS-level window resizes. The fix has
 * AppShell bridge Tauri's reliable onResized into a DOM 'resize' event and has
 * CenterPanel re-measure on it.
 *
 * jsdom has no layout engine and never fires ResizeObserver, so this test models
 * exactly that environment: it stubs getBoundingClientRect (so measure() yields a
 * real rect), shrinks the stubbed body, dispatches a `window.resize`, and asserts
 * the active pane's measured width follows. Without the window-resize listener the
 * pane stays at its stale width — which is the user-visible bug.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));

// CenterPanel installs detached-drag listeners and reads the window origin on
// mount; none of that is exercised here, so stub the Tauri window/event APIs.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    scaleFactor: () => Promise.resolve(1),
    innerPosition: () => Promise.resolve({ toLogical: () => ({ x: 0, y: 0 }) }),
    onMoved: () => Promise.resolve(() => {}),
    onResized: () => Promise.resolve(() => {}),
  }),
}));

// jsdom lacks ResizeObserver. A NO-OP stub is exactly the scenario under test:
// it models WebKitGTK never delivering ResizeObserver callbacks for OS resizes,
// so the window-'resize' listener is the only thing that can re-measure.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

// Pane contents are irrelevant here and pull in xterm.js / browser APIs jsdom
// lacks; stub them with inert markers.
vi.mock("../components/terminal/TerminalView", () => ({
  TerminalView: () => <div className="mock-terminal" />,
}));
vi.mock("../components/files/FileBrowser", () => ({
  FileBrowser: () => <div className="mock-files" />,
}));

import { CenterPanel } from "../components/layout/CenterPanel";
import { useTabsStore } from "../stores/tabs";
import { useProjectsStore } from "../stores/projects";

const BAR_H = 28;
// The stubbed body width is mutable so a "window resize" can shrink it. Height
// stays fixed; only width matters for the reflow.
let bodyWidth = 800;

function seedOneGroup() {
  useProjectsStore.setState({
    projects: [{ id: "p", name: "P", directory: "/p", local_file: "" } as never],
    activeId: "p",
  });
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  useTabsStore.getState().setScope("p");
  useTabsStore.getState().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
}

// Dispatch getBoundingClientRect by element class: the panel spans the full
// width; the measured group body (`.subwindow-pane-slot`) is the current
// bodyWidth below a tab bar. measure() reads the slot relative to the panel.
function installGeometry() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
    if (this.classList.contains("center-panel")) return rect(0, 0, bodyWidth, 600);
    if (this.classList.contains("subwindow-pane-slot")) return rect(0, BAR_H, bodyWidth, 600 - BAR_H);
    return rect(0, 0, bodyWidth, 600);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The visible pane carries the measured width as an inline style; the hidden
 *  ones are `display:none` with no width. Return the active pane's width string. */
function activePaneWidth(container: HTMLElement): string {
  const panes = Array.from(container.querySelectorAll<HTMLElement>(".center-pane"));
  const visible = panes.find((p) => p.style.width !== "");
  return visible?.style.width ?? "";
}

describe("CenterPanel — panes reflow on OS-window resize (WebKitGTK)", () => {
  beforeEach(() => {
    bodyWidth = 800;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("re-measures pane width when a window 'resize' fires (ResizeObserver-less env)", async () => {
    seedOneGroup();
    installGeometry();
    const { container } = render(<CenterPanel />);
    // Nudge a layout-effect re-run so the first measure() reads the stubbed rects.
    await act(async () => {
      useTabsStore.getState().setScope("root");
      useTabsStore.getState().setScope("p");
    });

    // Pane starts at the full 800px body.
    expect(activePaneWidth(container)).toBe("800px");

    // The OS window shrinks: the body is now 400px wide. jsdom fires no
    // ResizeObserver, so only the bridged 'resize' listener can re-measure.
    bodyWidth = 400;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    await flush();

    // With the fix the pane follows the narrower window; without it, it stays 800.
    expect(activePaneWidth(container)).toBe("400px");
  });
});
