/**
 * Tests for closeGroup(): closing a whole subwindow drops its tabs, collapses
 * the emptied group, renormalizes sibling sizes, and keeps focus on a survivor.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  useTabsStore,
  findGroup,
  allGroups,
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

/** Build a 3-way row split [G(a), G(b), G(c)] and return the keys + group ids. */
function threeWaySplit() {
  const a = useTabsStore.getState().addTab(tab("a"));
  const b = useTabsStore.getState().addTab(tab("b"));
  const c = useTabsStore.getState().addTab(tab("c"));
  const gid = (useTabsStore.getState().layout as { id: string }).id;
  useTabsStore.getState().splitWithTab(b.key, gid, "right");
  const grps = allGroups(useTabsStore.getState().layout);
  const last = grps[grps.length - 1];
  useTabsStore.getState().splitWithTab(c.key, last.id, "right");
  return { a, b, c };
}

describe("tabs store — closeGroup", () => {
  beforeEach(reset);

  it("closing the middle group leaves two and resizes siblings to sum ~1", () => {
    const { a, b, c } = threeWaySplit();
    const groups = allGroups(useTabsStore.getState().layout);
    expect(groups.length).toBe(3);
    const middle = groups[1];
    const middleTab = middle.tabKeys[0];

    useTabsStore.getState().closeGroup(middle.id);

    const after = useTabsStore.getState().layout as SplitNode;
    expect(allGroups(after).length).toBe(2);
    // The middle group's tab payload is gone from the flat list.
    const keys = useTabsStore.getState().tabs.map((t) => t.key);
    expect(keys).not.toContain(middleTab);
    // Surviving tabs (a and c — b was the middle here) remain.
    expect(keys).toContain(a.key);
    expect(keys).toContain(c.key);
    void b;
    // Sibling sizes renormalize.
    expect(after.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });

  it("closing the only group empties the scope", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const gid = (useTabsStore.getState().layout as { id: string }).id;
    useTabsStore.getState().closeGroup(gid);
    expect(useTabsStore.getState().layout).toBeNull();
    expect(useTabsStore.getState().tabs).toEqual([]);
    void a;
  });

  it("closing the focused group re-homes focus to a survivor", () => {
    const { a } = threeWaySplit();
    const groups = allGroups(useTabsStore.getState().layout);
    const middle = groups[1];
    useTabsStore.getState().focusGroup(middle.id);
    expect(useTabsStore.getState().focusedGroupId).toBe(middle.id);

    useTabsStore.getState().closeGroup(middle.id);

    const after = useTabsStore.getState().layout;
    const focus = useTabsStore.getState().focusedGroupId;
    expect(focus).not.toBe(middle.id);
    expect(findGroup(after, focus!)).toBeTruthy();
    void a;
  });

  // Mirrors the real user flow that was reported as "closing might fail":
  // open two tabs, split the second off into its own group (which becomes the
  // freshly-split, focused group), then close THAT group via its × button.
  it("closing the freshly-split focused group restores a single root group", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const rootId = (useTabsStore.getState().layout as { id: string }).id;
    useTabsStore.getState().splitWithTab(b.key, rootId, "right");

    // Two groups now; the new (b) group is focused.
    const groups = allGroups(useTabsStore.getState().layout);
    expect(groups.length).toBe(2);
    const focusId = useTabsStore.getState().focusedGroupId;
    const focused = groups.find((g) => g.id === focusId)!;
    expect(focused.tabKeys).toEqual([b.key]);

    useTabsStore.getState().closeGroup(focused.id);

    // Collapses back to a single root group holding the survivor (a).
    const after = useTabsStore.getState().layout;
    const remaining = allGroups(after);
    expect(remaining.length).toBe(1);
    expect(remaining[0].tabKeys).toEqual([a.key]);
    // Focus is a live group; b's tab + payload are gone.
    const focus = useTabsStore.getState().focusedGroupId;
    expect(findGroup(after, focus!)).toBeTruthy();
    const keys = useTabsStore.getState().tabs.map((t) => t.key);
    expect(keys).toEqual([a.key]);
  });

  // The mirror case: close the OTHER (non-focused) group after the same split.
  it("closing the non-focused group restores a single root group", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const b = useTabsStore.getState().addTab(tab("b"));
    const rootId = (useTabsStore.getState().layout as { id: string }).id;
    useTabsStore.getState().splitWithTab(b.key, rootId, "right");

    const groups = allGroups(useTabsStore.getState().layout);
    expect(groups.length).toBe(2);
    const focusId = useTabsStore.getState().focusedGroupId;
    // The non-focused group is the original (a) group.
    const other = groups.find((g) => g.id !== focusId)!;
    expect(other.tabKeys).toEqual([a.key]);

    useTabsStore.getState().closeGroup(other.id);

    const after = useTabsStore.getState().layout;
    const remaining = allGroups(after);
    expect(remaining.length).toBe(1);
    expect(remaining[0].tabKeys).toEqual([b.key]);
    const focus = useTabsStore.getState().focusedGroupId;
    expect(findGroup(after, focus!)).toBeTruthy();
    const keys = useTabsStore.getState().tabs.map((t) => t.key);
    expect(keys).toEqual([b.key]);
  });

  it("closing an unknown group id is a no-op", () => {
    const { a, b, c } = threeWaySplit();
    const before = useTabsStore.getState().layout;
    useTabsStore.getState().closeGroup("does-not-exist");
    expect(useTabsStore.getState().layout).toBe(before);
    expect(useTabsStore.getState().tabs.length).toBe(3);
    void a; void b; void c;
  });
});
