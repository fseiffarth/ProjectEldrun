import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Native Wayland: global coordinates are dummy zeroes, not desktop positions.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(false)) }));
const { listeners } = vi.hoisted(() => ({
  listeners: new Map<string, (ev: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, fn: (ev: { payload: unknown }) => void) => {
    listeners.set(name, fn);
    return Promise.resolve(() => {});
  }),
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
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => <div /> }));
vi.mock("../../components/header/WindowControls", () => ({ WindowControls: () => null }));

import { DetachedCenterPanel } from "../../components/layout/DetachedCenterPanel";
import { useDragStore } from "../../stores/drag/drag";
import type { GroupNode, LayoutNode, TabEntry } from "../../stores/tabs";
import { emit } from "@tauri-apps/api/event";
import { DETACHED_DRAG_START } from "../../stores/detached";
import {
  DETACHED_DROP_CLAIM,
  DETACHED_DROP_PROBE,
  resetPointerTracker,
  type DetachedDropProbe,
} from "../../lib/window/dropClaim";

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
  resetPointerTracker();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const emitted = (name: string) =>
  vi.mocked(emit).mock.calls.filter(([n]) => n === name).map(([, payload]) => payload);

const probeFrom = (over: Partial<DetachedDropProbe>): DetachedDropProbe => ({
  token: "t1",
  scope: "p",
  sourceLabel: "other-popout",
  groupId: "other",
  tabKey: "z",
  label: "z",
  releasedAt: Date.now(),
  ...over,
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

describe("coordinate-free cross-window drops (#42 on native Wayland)", () => {
  it("probes the other windows when a tab is released outside the popout", async () => {
    const { container, onSplit, onMove, onReorder } = mount();
    pointer("pointerdown", 150, 14, container.querySelectorAll(".tab")[1]);
    pointer("pointermove", 165, 14);
    await act(async () => { await Promise.resolve(); });
    pointer("pointermove", 1200, 300); // the implicit grab keeps streaming: outside 800×600
    pointer("pointerup", 1200, 300);
    expect(onSplit).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
    expect(onReorder).not.toHaveBeenCalled();
    expect(useDragStore.getState().drag).toBeNull();
    expect(emitted(DETACHED_DRAG_START)).toEqual([]);
    expect(emitted(DETACHED_DROP_PROBE)).toEqual([
      expect.objectContaining({ scope: "p", sourceLabel: "popout", groupId: "popout", tabKey: "b", label: "b" }),
    ]);
  });

  it("does not probe for a release the popout committed itself", async () => {
    const { container, onSplit } = mount();
    pointer("pointerdown", 150, 14, container.querySelectorAll(".tab")[1]);
    pointer("pointermove", 165, 14);
    await act(async () => { await Promise.resolve(); });
    pointer("pointermove", 700, 220);
    pointer("pointerup", 700, 220);
    expect(onSplit).toHaveBeenCalledOnce();
    expect(emitted(DETACHED_DROP_PROBE)).toEqual([]);
  });

  it("claims another window's probe with the pane under the pointer", async () => {
    mount();
    const onProbe = listeners.get(DETACHED_DROP_PROBE)!;
    expect(onProbe).toBeTruthy();
    act(() => { onProbe({ payload: probeFrom({}) }); });
    pointer("mousemove", 700, 220); // the post-release crossing: body, right edge
    expect(emitted(DETACHED_DROP_CLAIM)).toEqual([
      { token: "t1", windowLabel: "popout", groupId: "popout", clientX: 700, clientY: 220,
        target: { groupId: "g", edge: "right" } },
    ]);
    // One claim per probe: a later move must not answer again.
    pointer("mousemove", 50, 14);
    expect(emitted(DETACHED_DROP_CLAIM)).toHaveLength(1);
  });

  it("claims a bar release as an insertion slot", () => {
    mount();
    act(() => { listeners.get(DETACHED_DROP_PROBE)!({ payload: probeFrom({ token: "t2" }) }); });
    pointer("mousemove", 120, 14); // between tab a (0–100) and tab b (100–200), past b's midpoint? no: slot 1
    expect(emitted(DETACHED_DROP_CLAIM)).toEqual([
      expect.objectContaining({ token: "t2", target: { groupId: "g", index: 1 } }),
    ]);
  });

  it("ignores its own probe and probes of another scope", () => {
    mount();
    const onProbe = listeners.get(DETACHED_DROP_PROBE)!;
    act(() => { onProbe({ payload: probeFrom({ sourceLabel: "popout", groupId: "popout" }) }); });
    pointer("mousemove", 700, 220);
    act(() => { onProbe({ payload: probeFrom({ token: "t3", scope: "q" }) }); });
    pointer("mousemove", 700, 220);
    expect(emitted(DETACHED_DROP_CLAIM)).toEqual([]);
  });
});
