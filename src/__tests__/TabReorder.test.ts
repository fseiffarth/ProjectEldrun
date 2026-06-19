/**
 * Tests for drag-and-drop tab reordering within a subwindow group (#26, Group
 * D.6 → split model). The per-group tab bar's HTML5 drag handlers call
 * useTabsStore.reorderInGroup(groupId, from, to); this exercises that store
 * action directly: the moved tab lands at the target index inside its group and
 * the change is mirrored into the active scope's layout tree (which CenterPanel
 * then persists via its debounced saveLayout effect).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useTabsStore, type GroupNode } from "../stores/tabs";

function tab(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

/** Build a single-group scope holding a,b,c and select it. */
function seed() {
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
  // Build a,b,c via addTab so a real layout tree exists.
  for (const k of ["a", "b", "c"]) {
    useTabsStore.getState().addTab(tab(k));
  }
}

function groupId() {
  return (useTabsStore.getState().layout as GroupNode).id;
}

function keys() {
  return (useTabsStore.getState().layout as GroupNode).tabKeys.map((k) => {
    const t = useTabsStore.getState().tabs.find((x) => x.key === k)!;
    return t.label;
  });
}

describe("tabs store — reorderInGroup", () => {
  beforeEach(seed);

  it("moves a tab from one index to another within its group", () => {
    useTabsStore.getState().reorderInGroup(groupId(), 0, 2); // a,b,c -> b,c,a
    expect(keys()).toEqual(["b", "c", "a"]);
  });

  it("mirrors the new order into the active scope layout for persistence", () => {
    const gid = groupId();
    useTabsStore.getState().reorderInGroup(gid, 2, 0); // a,b,c -> c,a,b
    expect(keys()).toEqual(["c", "a", "b"]);
    const stored = useTabsStore.getState().layoutByScope["p"] as GroupNode;
    const labels = stored.tabKeys.map(
      (k) => useTabsStore.getState().tabs.find((x) => x.key === k)!.label,
    );
    expect(labels).toEqual(["c", "a", "b"]);
  });

  it("ignores out-of-range indices", () => {
    useTabsStore.getState().reorderInGroup(groupId(), 5, 0);
    expect(keys()).toEqual(["a", "b", "c"]);
  });
});
