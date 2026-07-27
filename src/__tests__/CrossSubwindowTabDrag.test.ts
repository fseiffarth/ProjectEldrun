/**
 * Regression guard for the tab-drag operations a user performs across tiled
 * subwindows: moving a tab from one subwindow into another (both surviving),
 * and splitting a subwindow inside an already-split layout to carve a third.
 *
 * These exercise the store authority (`moveTab` / `splitWithTab`) that the
 * pointer-drag in TabBar/CenterPanel commits into. If these pass, a runtime
 * "can't drag across subwindows / can't split" report is NOT a layout-logic
 * regression — look at the pointer/event layer (e.g. `dragDropEnabled` must be
 * false so WebKitGTK doesn't hijack the pointer with pointercancel).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  useTabsStore,
  allGroups,
  type GroupNode,
  type SplitNode,
} from "../stores/tabs";

function tab(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

function reset() {
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
}

const s = () => useTabsStore.getState();

/** Build two subwindows side by side: left = [a1, a2], right = [b]. */
function twoSubwindows() {
  const a1 = s().addTab(tab("a1"));
  const a2 = s().addTab(tab("a2"));
  const rootGid = (s().layout as GroupNode).id;
  const b = s().addTab(tab("b")); // joins the same group as a1/a2…
  s().splitWithTab(b.key, rootGid, "right"); // …then splits off to the right
  const root = s().layout as SplitNode;
  const left = root.children[0] as GroupNode;
  const right = root.children[1] as GroupNode;
  expect(left.tabKeys).toEqual([a1.key, a2.key]);
  expect(right.tabKeys).toEqual([b.key]);
  return { a1, a2, b, left, right };
}

describe("tabs store — cross-subwindow drag", () => {
  beforeEach(reset);

  it("moves a tab from one subwindow into another, both subwindows surviving", () => {
    const { a1, a2, b, right } = twoSubwindows();

    // Drag a2 out of the left subwindow into the right one. The left still
    // holds a1, so the split must NOT collapse — we still have two subwindows.
    s().moveTab(a2.key, right.id);

    const root = s().layout as SplitNode;
    expect(root.type).toBe("split");
    expect(root.children).toHaveLength(2);
    const [left2, right2] = root.children as GroupNode[];
    expect(left2.tabKeys).toEqual([a1.key]);
    expect(right2.tabKeys.sort()).toEqual([a2.key, b.key].sort());
    // The moved tab is the active one in its new home.
    expect(right2.activeKey).toBe(a2.key);
  });

  it("moveTab can land the tab at a specific index in the target subwindow", () => {
    const { a2, b, right } = twoSubwindows();
    s().moveTab(a2.key, right.id, 0); // drop before b
    const right2 = (s().layout as SplitNode).children[1] as GroupNode;
    expect(right2.tabKeys).toEqual([a2.key, b.key]);
  });

  it("splits a subwindow inside an existing split to create a third subwindow", () => {
    const { a1, a2, b, right } = twoSubwindows();

    // Drop a2 onto the bottom edge of the right subwindow → a new group below.
    s().splitWithTab(a2.key, right.id, "bottom");

    const groups = allGroups(s().layout);
    expect(groups).toHaveLength(3);
    const keySets = groups.map((g) => g.tabKeys);
    // Left keeps a1; right keeps b; a2 is alone in the new subwindow.
    expect(keySets.some((k) => k.length === 1 && k[0] === a1.key)).toBe(true);
    expect(keySets.some((k) => k.length === 1 && k[0] === b.key)).toBe(true);
    expect(keySets.some((k) => k.length === 1 && k[0] === a2.key)).toBe(true);
  });
});
