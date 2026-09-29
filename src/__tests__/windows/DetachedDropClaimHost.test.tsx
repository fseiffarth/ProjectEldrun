/**
 * #42 on native Wayland: the MAIN window hosting a coordinate-free drop
 * (`lib/window/dropClaim`). A popout with no desktop geometry releases a tab
 * and broadcasts a PROBE; the main window either sees the pointer in its own
 * DOM (→ docks the tab into main at the pane under it), receives a CLAIM from a
 * sibling popout (→ moves the tab there), or hears nothing (→ leaves the tab
 * where it was). Exercises the REAL CenterPanel host against the tabs store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(false)) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: vi.fn(() => Promise.resolve(null)) },
}));
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
  getCurrentWindow: () => ({
    label: "main",
    scaleFactor: () => Promise.resolve(1),
    innerPosition: () => Promise.resolve({ toLogical: () => ({ x: 0, y: 0 }) }),
    onMoved: () => Promise.resolve(() => {}),
    onResized: () => Promise.resolve(() => {}),
  }),
  cursorPosition: () => Promise.resolve({ x: 0, y: 0 }),
}));
vi.mock("../../components/terminal/TerminalView", () => ({
  TerminalView: () => <div className="mock-terminal" />,
}));
vi.mock("../../components/files/FileBrowser", () => ({
  FileBrowser: () => <div className="mock-files" />,
}));

import { CenterPanel } from "../../components/layout/CenterPanel";
import { useTabsStore, allGroups, type GroupNode, type SplitNode } from "../../stores/tabs";
import { useDragStore } from "../../stores/drag/drag";
import { useProjectsStore } from "../../stores/projects";
import {
  DETACHED_DROP_CLAIM,
  DETACHED_DROP_PROBE,
  DROP_CLAIM_TIMEOUT_MS,
  resetPointerTracker,
  type DetachedDropClaim,
  type DetachedDropProbe,
} from "../../lib/window/dropClaim";

const PANEL = { left: 0, top: 0, width: 800, height: 600 };
const BAR_H = 28;
const BODY = { left: 0, top: BAR_H, width: 800, height: 600 - BAR_H };

function installGeometry(getContainer: () => HTMLElement) {
  const slot = () => getContainer().querySelector(".subwindow-pane-slot") as HTMLElement | null;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const rect = (r: typeof PANEL) =>
      ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} }) as DOMRect;
    if (this.classList.contains("center-panel")) return rect(PANEL);
    if (this.classList.contains("subwindow-pane-slot")) return rect(BODY);
    if (this.classList.contains("tab")) {
      const idx = Number(this.dataset.tabIndex ?? 0);
      return rect({ left: idx * 100, top: 0, width: 100, height: BAR_H });
    }
    if (this.classList.contains("tab-bar")) return rect({ left: 0, top: 0, width: 800, height: BAR_H });
    return rect(PANEL);
  });
  document.elementFromPoint = ((_x: number, y: number) => {
    if (y < BAR_H) return getContainer().querySelector(".tab-bar");
    return slot();
  }) as typeof document.elementFromPoint;
}

function pointer(type: string, x: number, y: number) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  act(() => {
    window.dispatchEvent(ev);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const s = () => useTabsStore.getState();
const gid = (key: string) => allGroups(s().layout).find((g) => g.tabKeys.includes(key))!.id;

/** Main holds [a, b]; popout SRC holds [c]; popout DST holds [d]. */
async function mountSeeded() {
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
    detachedGroupsByScope: {},
  });
  s().setScope("p");
  const a = s().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
  const b = s().addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
  const c = s().addTab({ label: "c", cmd: "bash", cwd: "/p", kind: "shell" });
  const d = s().addTab({ label: "d", cmd: "bash", cwd: "/p", kind: "shell" });
  const rootGid = gid(a.key);
  s().splitWithTab(c.key, rootGid, "right");
  s().splitWithTab(d.key, rootGid, "bottom");
  const srcId = gid(c.key);
  const dstId = gid(d.key);
  s().detachGroup(srcId, { skipBackend: true });
  s().detachGroup(dstId, { skipBackend: true });
  const src = s().detachedGroupsByScope["p"].find((e) => e.id === srcId)!;
  const dst = s().detachedGroupsByScope["p"].find((e) => e.id === dstId)!;

  let containerEl: HTMLElement;
  installGeometry(() => containerEl);
  const r = render(<CenterPanel />);
  containerEl = r.container;
  await act(async () => {
    s().setScope("root");
    s().setScope("p");
  });
  return { a, b, c, d, src, dst, container: containerEl };
}

const probe = (over: Partial<DetachedDropProbe>): DetachedDropProbe => ({
  token: "tok",
  scope: "p",
  sourceLabel: "src-window",
  groupId: "src",
  tabKey: "c",
  label: "c",
  releasedAt: Date.now(),
  ...over,
});

describe("CenterPanel — coordinate-free drop host (#42 on native Wayland)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
    useDragStore.getState().end();
    resetPointerTracker();
    listeners.clear();
  });

  it("docks the probed tab into main at the pane its own pointer lands on", async () => {
    const { a, b, c, src } = await mountSeeded();
    const onProbe = listeners.get(DETACHED_DROP_PROBE)!;
    expect(onProbe).toBeTruthy();
    act(() => {
      onProbe({ payload: probe({ groupId: src.id, tabKey: c.key, sourceLabel: src.label }) });
    });
    // The host is in the same `detached` drag state the geometric START uses.
    expect(useDragStore.getState().drag).toMatchObject({ kind: "detached", detachedTabKey: c.key });
    await flush();
    pointer("mousemove", 700, BAR_H + 200); // right half of the body → split right
    await act(async () => {
      vi.runOnlyPendingTimers(); // the deferred resolve+settle
    });
    await flush();

    const layout = s().layout as SplitNode;
    expect(layout.type).toBe("split");
    expect(layout.dir).toBe("row");
    const [first, second] = layout.children as GroupNode[];
    expect(first.tabKeys).toEqual([a.key, b.key]);
    expect(second.tabKeys).toEqual([c.key]);
    expect(s().detachedGroupsByScope["p"].find((e) => e.id === src.id)).toBeUndefined();
    expect(useDragStore.getState().drag).toBeNull();
  });

  it("moves the probed tab into the sibling popout that claims it", async () => {
    const { c, d, src, dst } = await mountSeeded();
    act(() => {
      listeners.get(DETACHED_DROP_PROBE)!({
        payload: probe({ groupId: src.id, tabKey: c.key, sourceLabel: src.label }),
      });
    });
    await flush();
    const claim: DetachedDropClaim = {
      token: "tok",
      windowLabel: dst.label,
      groupId: dst.id,
      clientX: 10,
      clientY: 10,
      target: { groupId: dst.subtree.id, index: 0 },
    };
    act(() => {
      listeners.get(DETACHED_DROP_CLAIM)!({ payload: claim });
    });
    await flush();

    const dstNow = s().detachedGroupsByScope["p"].find((e) => e.id === dst.id)!;
    expect(allGroups(dstNow.subtree).flatMap((g) => g.tabKeys)).toEqual([c.key, d.key]);
    expect(s().detachedGroupsByScope["p"].find((e) => e.id === src.id)).toBeUndefined();
    expect(allGroups(s().layout).flatMap((g) => g.tabKeys)).not.toContain(c.key);
    expect(useDragStore.getState().drag).toBeNull();
  });

  it("leaves the tab in its popout when nobody claims within the timeout", async () => {
    const { c, src } = await mountSeeded();
    const before = JSON.stringify(s().detachedGroupsByScope);
    act(() => {
      listeners.get(DETACHED_DROP_PROBE)!({
        payload: probe({ groupId: src.id, tabKey: c.key, sourceLabel: src.label }),
      });
    });
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(DROP_CLAIM_TIMEOUT_MS + 1);
    });
    await flush();
    expect(JSON.stringify(s().detachedGroupsByScope)).toBe(before);
    expect(allGroups(s().layout).flatMap((g) => g.tabKeys)).not.toContain(c.key);
    expect(useDragStore.getState().drag).toBeNull();
    // A stale claim for that probe changes nothing either.
    act(() => {
      listeners.get(DETACHED_DROP_CLAIM)!({
        payload: { token: "tok", windowLabel: "x", groupId: "x", clientX: 0, clientY: 0, target: null },
      });
    });
    expect(JSON.stringify(s().detachedGroupsByScope)).toBe(before);
  });

  it("ignores a probe the main window sent itself (its TabBar consumes the claim)", async () => {
    await mountSeeded();
    act(() => {
      listeners.get(DETACHED_DROP_PROBE)!({
        payload: probe({ sourceLabel: "main", groupId: undefined, tabKey: "a" }),
      });
    });
    expect(useDragStore.getState().drag).toBeNull();
  });
});
