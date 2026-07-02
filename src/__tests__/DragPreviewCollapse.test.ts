/**
 * Live source-subwindow collapse during a tab drag (dragPreviewLayout). When a
 * subwindow's ONLY tab is dragged, the rendered layout prunes that subwindow so
 * its siblings reflow to fill — it closes "on dragging", not just on the drop.
 * This is render-only: the helper returns a NEW tree and never mutates the store
 * layout (an aborted drag restores instantly), and only fires for the lone-tab
 * case in a multi-subwindow layout.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  useTabsStore,
  allGroups,
  findGroup,
  type GroupNode,
  type SplitNode,
} from "../stores/tabs";
import { dragPreviewLayout } from "../components/tabs/dragPreview";

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

/** Two side-by-side subwindows, each holding a single tab: left=[a], right=[b]. */
function twoLoneSubwindows() {
  const a = s().addTab(tab("a"));
  const b = s().addTab(tab("b"));
  const rootGid = (s().layout as GroupNode).id;
  s().splitWithTab(b.key, rootGid, "right");
  const root = s().layout as SplitNode;
  const left = root.children[0] as GroupNode;
  const right = root.children[1] as GroupNode;
  expect(left.tabKeys).toEqual([a.key]);
  expect(right.tabKeys).toEqual([b.key]);
  return { a, b, left, right };
}

describe("dragPreviewLayout — live source-subwindow collapse", () => {
  beforeEach(reset);

  it("collapses the lone-tab source to its sibling while dragging it", () => {
    const { a, b, left } = twoLoneSubwindows();
    const layout = s().layout;

    const preview = dragPreviewLayout(layout, "tab", a.key, left.id, false);

    // The left (source) subwindow is pruned → the split unwraps to the lone right
    // group, which now fills the panel.
    expect(preview?.type).toBe("group");
    expect((preview as GroupNode).tabKeys).toEqual([b.key]);
    // The store layout itself is untouched (still the two-group split).
    expect(s().layout).toBe(layout);
    expect(allGroups(s().layout)).toHaveLength(2);
  });

  it("leaves the layout unchanged when the source group has other tabs", () => {
    // left=[a1,a2], right=[b]; drag a1 — its subwindow survives (a2 stays), so no
    // live collapse.
    const a1 = s().addTab(tab("a1"));
    const a2 = s().addTab(tab("a2"));
    const rootGid = (s().layout as GroupNode).id;
    const b = s().addTab(tab("b"));
    s().splitWithTab(b.key, rootGid, "right");
    const layout = s().layout;
    const left = (layout as SplitNode).children[0] as GroupNode;
    expect(left.tabKeys).toEqual([a1.key, a2.key]);

    const preview = dragPreviewLayout(layout, "tab", a1.key, left.id, false);
    expect(preview).toBe(layout); // unchanged
  });

  it("leaves the layout unchanged when it is the only subwindow", () => {
    const a = s().addTab(tab("a"));
    const layout = s().layout;
    const gid = (layout as GroupNode).id;
    // Lone tab AND only subwindow → nothing to expand into, so no collapse.
    expect(dragPreviewLayout(layout, "tab", a.key, gid, false)).toBe(layout);
  });

  it("ignores non-tab drags (file/link/detached) and missing drag state", () => {
    const { a, left } = twoLoneSubwindows();
    const layout = s().layout;
    expect(dragPreviewLayout(layout, "file", "", "", false)).toBe(layout);
    expect(dragPreviewLayout(layout, null, null, null, false)).toBe(layout);
    // A tab drag whose source group doesn't match (stale id) is a no-op too.
    expect(dragPreviewLayout(layout, "tab", a.key, "g-nonexistent", false)).toBe(layout);
    void left;
  });

  it("does not collapse while a group is fullscreen", () => {
    const { a, left } = twoLoneSubwindows();
    const layout = s().layout;
    expect(dragPreviewLayout(layout, "tab", a.key, left.id, true)).toBe(layout);
  });

  it("collapses a lone source nested in a 3-way split, keeping the other two", () => {
    // Build [G(a), G(b), G(c)] then drag b (the middle lone tab).
    const a = s().addTab(tab("a"));
    const b = s().addTab(tab("b"));
    const c = s().addTab(tab("c"));
    const gid = (s().layout as GroupNode).id;
    s().splitWithTab(b.key, gid, "right");
    const grps = allGroups(s().layout);
    s().splitWithTab(c.key, grps[grps.length - 1].id, "right");
    const layout = s().layout;
    const bGroup = allGroups(layout).find((g) => g.tabKeys[0] === b.key)!;

    const preview = dragPreviewLayout(layout, "tab", b.key, bGroup.id, false);
    const previewGroups = allGroups(preview);
    expect(previewGroups).toHaveLength(2);
    expect(previewGroups.map((g) => g.tabKeys[0]).sort()).toEqual([a.key, c.key].sort());
    // b's group is gone from the preview, but still present in the live store.
    expect(findGroup(preview, bGroup.id)).toBeNull();
    expect(findGroup(s().layout, bGroup.id)).toBeTruthy();
  });
});
