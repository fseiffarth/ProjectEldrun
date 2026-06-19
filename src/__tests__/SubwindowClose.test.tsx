/**
 * Component-level (DOM) wiring test for the per-subwindow close (×) button.
 *
 * The store-only CloseGroup.test.ts proves closeGroup() collapses the layout,
 * but it can't catch a wiring regression between the button's real React event
 * handlers and the store: a dropped onClick, a stopPropagation mistake, or a
 * re-render (the Subwindow's onMouseDownCapture focusGroup fires first) that
 * strands the click. This renders the REAL Subwindow → TabBar and drives the
 * button through React's own event system to prove the end-to-end path.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

// TabBar pulls invoke for the add menu (lazy, not at render); mock so the
// module graph resolves without a real Tauri bridge.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));

import { Subwindow } from "../components/tabs/Subwindow";
import { allGroups, useTabsStore } from "../stores/tabs";
import { useDragStore } from "../stores/drag";

function resetStores() {
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
  useDragStore.setState({ drag: null });
}

/** Build a 2-group layout: addTab a, addTab b, split b out to the right. */
function seedTwoGroups() {
  const store = useTabsStore.getState();
  const a = store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
  const b = store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
  // Both tabs are now in the single root group; split b out to the right.
  const rootGroupId = allGroups(useTabsStore.getState().layout)[0].id;
  useTabsStore.getState().splitWithTab(b.key, rootGroupId, "right");
  return { a, b };
}

describe("Subwindow close button — DOM wiring", () => {
  beforeEach(() => {
    resetStores();
    cleanup();
  });

  it("clicking .subwindow-close collapses the layout to the OTHER tab's group", () => {
    const { a, b } = seedTwoGroups();

    // After the split there are two groups; identify the one holding `b`.
    const groups = allGroups(useTabsStore.getState().layout);
    expect(groups).toHaveLength(2);
    const bGroup = groups.find((g) => g.tabKeys.includes(b.key))!;
    expect(bGroup).toBeTruthy();

    const { container } = render(
      <Subwindow groupId={bGroup.id} projectCwd="/p">
        <div>pane</div>
      </Subwindow>,
    );

    // groupCount === 2 → the close button must be rendered.
    const closeBtn = container.querySelector(".subwindow-close");
    expect(closeBtn, "close button should be present with 2 groups").toBeTruthy();

    // Drive the real button via React's event system (mousedown then click,
    // mirroring a user click — exercises the focusGroup-on-capture path).
    fireEvent.mouseDown(closeBtn!);
    fireEvent.click(closeBtn!);

    // The clicked (b) group is gone; the layout collapsed to a single root
    // group still containing the OTHER tab (a).
    const after = allGroups(useTabsStore.getState().layout);
    expect(after).toHaveLength(1);
    expect(after[0].tabKeys).toContain(a.key);
    expect(after[0].tabKeys).not.toContain(b.key);
    // b's payload was dropped from the flat tab list.
    expect(useTabsStore.getState().tabs.find((t) => t.key === b.key)).toBeUndefined();
    expect(useTabsStore.getState().tabs.find((t) => t.key === a.key)).toBeTruthy();
  });

  it("renders NO .subwindow-close with only one group", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "solo", cmd: "bash", cwd: "/p", kind: "shell" });
    const groups = allGroups(useTabsStore.getState().layout);
    expect(groups).toHaveLength(1);

    const { container } = render(
      <Subwindow groupId={groups[0].id} projectCwd="/p">
        <div>pane</div>
      </Subwindow>,
    );

    expect(container.querySelector(".subwindow-close")).toBeNull();
  });

  it("closing a NON-focused subwindow still works (focusGroup-on-capture then closeGroup)", () => {
    const { a, b } = seedTwoGroups();
    const groups = allGroups(useTabsStore.getState().layout);
    const aGroup = groups.find((g) => g.tabKeys.includes(a.key))!;
    const bGroup = groups.find((g) => g.tabKeys.includes(b.key))!;

    // Focus the OTHER (a) group, so the b subwindow we click is not focused.
    useTabsStore.getState().focusGroup(aGroup.id);
    expect(useTabsStore.getState().focusedGroupId).toBe(aGroup.id);

    const { container } = render(
      <Subwindow groupId={bGroup.id} projectCwd="/p">
        <div>pane</div>
      </Subwindow>,
    );

    const closeBtn = container.querySelector(".subwindow-close")!;
    fireEvent.mouseDown(closeBtn);
    fireEvent.click(closeBtn);

    const after = allGroups(useTabsStore.getState().layout);
    expect(after).toHaveLength(1);
    expect(after[0].tabKeys).toContain(a.key);
    expect(after[0].tabKeys).not.toContain(b.key);
  });

  it("closing a subwindow with stale drag state still collapses cleanly", () => {
    const { a, b } = seedTwoGroups();
    const groups = allGroups(useTabsStore.getState().layout);
    const bGroup = groups.find((g) => g.tabKeys.includes(b.key))!;

    // Simulate drag state left over pointing at the group being closed.
    useDragStore.setState({
      drag: {
        kind: "tab",
        key: b.key,
        fromGroup: bGroup.id,
        label: "b",
        pointerX: 0,
        pointerY: 0,
        overGroup: bGroup.id,
        edge: "left",
        reorderGroup: null,
        reorderIndex: null,
      },
    });

    const { container } = render(
      <Subwindow groupId={bGroup.id} projectCwd="/p">
        <div>pane</div>
      </Subwindow>,
    );

    const closeBtn = container.querySelector(".subwindow-close")!;
    fireEvent.mouseDown(closeBtn);
    fireEvent.click(closeBtn);

    const after = allGroups(useTabsStore.getState().layout);
    expect(after).toHaveLength(1);
    expect(after[0].tabKeys).toContain(a.key);
    expect(after[0].tabKeys).not.toContain(b.key);
  });
});
