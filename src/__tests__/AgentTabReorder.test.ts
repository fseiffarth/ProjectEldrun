/**
 * The Agents view's drag reorder (`reorderTabInScope`). The view lists
 * `tabsByScope[scope]` — the order the "native" sort shows — and drops a row
 * beside another, so the action moves the tab in that flat order and, when both
 * tabs share a layout group, in the group's `tabKeys` too, so the tab bar tells
 * the same story. A cross-group drop has no slot to express: the list reorders,
 * the layout is left alone.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { findGroupOfTab, useTabsStore, type GroupNode } from "../stores/tabs";

function tab(label: string) {
  return { label, cmd: "claude", cwd: "/p", kind: "agent" as const };
}

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
  for (const k of ["a", "b", "c"]) useTabsStore.getState().addTab(tab(k));
}

/** Tab key by label, as the view has (it drags TabEntry keys around). */
function key(label: string) {
  return useTabsStore.getState().tabs.find((t) => t.label === label)!.key;
}

/** The flat scope order the Agents list reads. */
function listed() {
  return (useTabsStore.getState().tabsByScope["p"] ?? []).map((t) => t.label);
}

/** The tab bar's order for the group holding `a`. */
function barred() {
  const layout = useTabsStore.getState().layoutByScope["p"] ?? null;
  const group = findGroupOfTab(layout, key("a"))!.group;
  return group.tabKeys.map(
    (k) => useTabsStore.getState().tabs.find((t) => t.key === k)!.label,
  );
}

describe("tabs store — reorderTabInScope", () => {
  beforeEach(seed);

  it("drops a tab before another, in the list and in the tab bar", () => {
    useTabsStore.getState().reorderTabInScope("p", key("c"), key("a"), "before");
    expect(listed()).toEqual(["c", "a", "b"]);
    expect(barred()).toEqual(["c", "a", "b"]);
  });

  it("drops a tab after another", () => {
    useTabsStore.getState().reorderTabInScope("p", key("a"), key("c"), "after");
    expect(listed()).toEqual(["b", "c", "a"]);
    expect(barred()).toEqual(["b", "c", "a"]);
  });

  it("is a no-op on itself, on an unknown anchor, and on another scope", () => {
    useTabsStore.getState().reorderTabInScope("p", key("a"), key("a"), "after");
    useTabsStore.getState().reorderTabInScope("p", key("a"), "nope", "before");
    useTabsStore.getState().reorderTabInScope("other", key("a"), key("c"), "after");
    expect(listed()).toEqual(["a", "b", "c"]);
    expect(barred()).toEqual(["a", "b", "c"]);
  });

  it("reorders the list but not the layout when the two tabs are in different groups", () => {
    // Split `c` off into its own group: it and `a` no longer share a bar.
    const layout = useTabsStore.getState().layout as GroupNode;
    useTabsStore.getState().splitWithTab(key("c"), layout.id, "right");
    useTabsStore.getState().reorderTabInScope("p", key("c"), key("a"), "before");
    expect(listed()).toEqual(["c", "a", "b"]);
    // `a`'s own bar keeps the tabs it had, in the order it had them.
    expect(barred()).toEqual(["a", "b"]);
  });
});
