/**
 * The old per-scope grid-view toggle (TODO Group K, #35) was replaced by the
 * tiling split-subwindow model. There is no longer a `grid` flag; arrangement
 * lives in a per-scope layout tree. These tests pin the surviving behaviour the
 * grid tests used to guard: layout/active state is tracked per scope and is
 * restored when the scope is switched back.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useTabsStore, type GroupNode } from "../stores/tabs";

function tab(key: string) {
  return { key, label: key, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

describe("tabs store — per-scope layout state", () => {
  beforeEach(() => {
    useTabsStore.setState({
      scope: "project-a",
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
    });
  });

  it("the grid flag and its actions no longer exist on the store", () => {
    const s = useTabsStore.getState() as unknown as Record<string, unknown>;
    expect(s.grid).toBeUndefined();
    expect(s.toggleGrid).toBeUndefined();
    expect(s.setGrid).toBeUndefined();
    expect(s.gridByScope).toBeUndefined();
  });

  it("each scope keeps its own layout tree", () => {
    useTabsStore.getState().addTab(tab("a")); // project-a gets a root group
    const aLayout = useTabsStore.getState().layout as GroupNode;
    expect(aLayout.type).toBe("group");
    expect(aLayout.tabKeys.length).toBe(1);

    useTabsStore.getState().setScope("project-b");
    // project-b is uninitialized → empty.
    expect(useTabsStore.getState().layout).toBeNull();
    expect(useTabsStore.getState().tabs).toEqual([]);
    // project-a's layout is untouched.
    expect(useTabsStore.getState().layoutByScope["project-a"]).toBeTruthy();
  });

  it("restores a scope's layout + active tab on setScope", () => {
    const a1 = useTabsStore.getState().addTab(tab("a1"));
    useTabsStore.getState().addTab(tab("a2"));
    useTabsStore.getState().setActive(a1.key);
    expect(useTabsStore.getState().activeKey).toBe(a1.key);

    useTabsStore.getState().setScope("project-b");
    expect(useTabsStore.getState().activeKey).toBeNull();

    useTabsStore.getState().setScope("project-a");
    expect(useTabsStore.getState().activeKey).toBe(a1.key);
    expect((useTabsStore.getState().layout as GroupNode).tabKeys.length).toBe(2);
  });
});
