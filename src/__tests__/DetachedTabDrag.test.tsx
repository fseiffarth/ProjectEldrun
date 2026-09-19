import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Native Wayland: global coordinates are dummy zeroes, not desktop positions.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(false)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
  getCurrentWindow: () => ({
    label: "popout",
    innerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerSize: () => Promise.resolve({ width: 800, height: 600 }),
    scaleFactor: () => Promise.resolve(1),
    onMoved: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("../components/tabs/TabPane", () => ({ TabPane: () => <div /> }));
vi.mock("../components/header/WindowControls", () => ({ WindowControls: () => null }));

import { DetachedCenterPanel } from "../components/layout/DetachedCenterPanel";
import { useDragStore } from "../stores/drag/drag";
import type { GroupNode, LayoutNode, TabEntry } from "../stores/tabs";
import { emit } from "@tauri-apps/api/event";
import { DETACHED_DRAG_START } from "../stores/detached";

const tabs: TabEntry[] = ["a", "b"].map((key) => ({
  key, label: key, kind: "shell", cmd: "bash", cwd: "/p",
}));
const tree: GroupNode = { type: "group", id: "g", tabKeys: ["a", "b"], activeKey: "a" };

function mount(layout: LayoutNode = tree) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    let left = 0, top = 0, width = 800, height = 600;
    if (this.classList.contains("subwindow-pane-region")) { top = 28; height = 572; }
    if (this.classList.contains("tab-bar")) height = 28;
    if (this.classList.contains("tab")) {
      left = Array.from(this.parentElement!.children).filter((c) => c.classList.contains("tab")).indexOf(this) * 100;
      width = 100; height = 28;
    }
    if (layout.type === "split") {
      const group = this.closest(".subwindow");
      const right = group?.querySelector('[data-group-id="right"]');
      left += right ? 400 : 0;
      if (!this.classList.contains("tab")) width = 400;
    }
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} };
  });
  const onSplit = vi.fn(), onMove = vi.fn(), onReorder = vi.fn();
  const result = render(<DetachedCenterPanel
    scope="p" popoutId="popout" tree={layout} tabs={tabs}
    onSplit={onSplit} onMove={onMove} onReorder={onReorder}
    onActivate={vi.fn()} onClose={vi.fn()} onSetLocation={vi.fn()}
    onResize={vi.fn()} onAddTab={vi.fn()} onFiles={vi.fn()}
  />);
  return { ...result, onSplit, onMove, onReorder };
}

function pointer(type: string, x: number, y: number, target: EventTarget = window) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { clientX: x, clientY: y, button: 0, pointerId: 1, shiftKey: false });
  act(() => { target.dispatchEvent(ev); });
}

afterEach(() => {
  cleanup();
  useDragStore.getState().end();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("detached tab gestures without desktop coordinates", () => {
  it.each(["pointerup", "pointercancel"])("previews and commits a local split on %s", async (release) => {
    const { container, onSplit } = mount();
    pointer("pointerdown", 150, 14, container.querySelectorAll(".tab")[1]);
    pointer("pointermove", 165, 14);
    await act(async () => { await Promise.resolve(); });
    pointer("pointermove", 700, 220);
    expect(useDragStore.getState().drag).toMatchObject({ overGroup: "g", edge: "right" });
    const preview = container.querySelector<HTMLElement>(".split-preview");
    expect(preview?.style.left).toBe("400px");
    expect(preview?.style.width).toBe("400px");
    pointer(release, 0, 0); // synthetic WebKitGTK release coordinates must not replace the preview
    expect(onSplit).toHaveBeenCalledExactlyOnceWith("b", "g", "right");
    expect(useDragStore.getState().drag).toBeNull();
    expect(vi.mocked(emit).mock.calls.some(([name]) => name === DETACHED_DRAG_START)).toBe(false);
  });

  it("reorders the bar and aborts a subsequent split with Escape", () => {
    const { container, onReorder, onSplit } = mount();
    pointer("pointerdown", 150, 14, container.querySelectorAll(".tab")[1]);
    pointer("pointermove", 160, 14);
    pointer("pointermove", 20, 14);
    pointer("pointerup", 20, 14);
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(["b", "a"]);
    pointer("pointerdown", 150, 14, container.querySelectorAll(".tab")[1]);
    pointer("pointermove", 700, 220);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    pointer("pointerup", 700, 220);
    expect(onSplit).not.toHaveBeenCalled();
    expect(useDragStore.getState().drag).toBeNull();
  });

  it("moves a tab between panes inside the detached window", () => {
    const { container, onMove } = mount({
      type: "split", id: "s", dir: "row", sizes: [0.5, 0.5],
      children: [
        { ...tree, tabKeys: ["a"] },
        { type: "group", id: "right", tabKeys: ["b"], activeKey: "b" },
      ],
    });
    pointer("pointerdown", 50, 14, container.querySelectorAll(".tab")[0]);
    pointer("pointermove", 200, 150);
    pointer("pointermove", 600, 314);
    expect(useDragStore.getState().drag).toMatchObject({ overGroup: "right", edge: "center" });
    pointer("pointerup", 600, 314);
    expect(onMove).toHaveBeenCalledExactlyOnceWith("a", "right");
    expect(useDragStore.getState().drag).toBeNull();
  });
});
