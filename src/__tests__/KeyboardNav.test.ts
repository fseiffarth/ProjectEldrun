/**
 * #62 — keyboard navigation primitives.
 *
 * Pure tree helper `neighborGroup` (directional subwindow focus by tree order,
 * including edges) and the store-level `toggleFullscreen` state machine. The DOM
 * wiring (chords → store actions) is covered in KeyboardNav.test.tsx.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  allGroups,
  neighborGroup,
  useTabsStore,
  type LayoutNode,
} from "../stores/tabs";

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
    fullscreenGroupId: null,
  });
}

describe("#62 neighborGroup (pure)", () => {
  // A row split [A | B], where B is itself a column split [B1 / B2]:
  //   row( A , col( B1 , B2 ) )
  const A: LayoutNode = { type: "group", id: "A", tabKeys: ["a"], activeKey: "a" };
  const B1: LayoutNode = { type: "group", id: "B1", tabKeys: ["b1"], activeKey: "b1" };
  const B2: LayoutNode = { type: "group", id: "B2", tabKeys: ["b2"], activeKey: "b2" };
  const tree: LayoutNode = {
    type: "split",
    id: "root",
    dir: "row",
    sizes: [0.5, 0.5],
    children: [
      A,
      { type: "split", id: "colB", dir: "column", sizes: [0.5, 0.5], children: [B1, B2] },
    ],
  };

  it("right from A enters the B column at its first group", () => {
    expect(neighborGroup(tree, "A", "right")).toBe("B1");
  });

  it("left from B1 returns to A", () => {
    expect(neighborGroup(tree, "B1", "left")).toBe("A");
  });

  it("down from B1 reaches B2; up from B2 reaches B1", () => {
    expect(neighborGroup(tree, "B1", "down")).toBe("B2");
    expect(neighborGroup(tree, "B2", "up")).toBe("B1");
  });

  it("returns null at edges", () => {
    expect(neighborGroup(tree, "A", "left")).toBeNull();
    expect(neighborGroup(tree, "A", "up")).toBeNull();
    expect(neighborGroup(tree, "B2", "down")).toBeNull();
    expect(neighborGroup(tree, "B1", "up")).toBeNull();
  });

  it("null/unknown group → null", () => {
    expect(neighborGroup(null, "A", "right")).toBeNull();
    expect(neighborGroup(tree, "nope", "right")).toBeNull();
  });
});

describe("#62 toggleFullscreen (store)", () => {
  beforeEach(reset);

  it("sets and clears fullscreenGroupId; toggling the same group clears it", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    const g = allGroups(useTabsStore.getState().layout)[0].id;

    useTabsStore.getState().toggleFullscreen(g);
    expect(useTabsStore.getState().fullscreenGroupId).toBe(g);

    // Same group toggles off.
    useTabsStore.getState().toggleFullscreen(g);
    expect(useTabsStore.getState().fullscreenGroupId).toBeNull();
  });

  it("toggleFullscreen(null) always clears", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    const g = allGroups(useTabsStore.getState().layout)[0].id;
    useTabsStore.getState().toggleFullscreen(g);
    useTabsStore.getState().toggleFullscreen(null);
    expect(useTabsStore.getState().fullscreenGroupId).toBeNull();
  });

  it("closing the fullscreened subwindow exits fullscreen", () => {
    const store = useTabsStore.getState();
    const a = store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    const b = store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
    const rootGroup = allGroups(useTabsStore.getState().layout)[0].id;
    useTabsStore.getState().splitWithTab(b.key, rootGroup, "right");
    const groups = allGroups(useTabsStore.getState().layout);
    const bGroup = groups.find((g) => g.tabKeys.includes(b.key))!;

    useTabsStore.getState().toggleFullscreen(bGroup.id);
    expect(useTabsStore.getState().fullscreenGroupId).toBe(bGroup.id);

    // Close b's subwindow → its group collapses, fullscreen must clear.
    useTabsStore.getState().closeGroup(bGroup.id);
    expect(useTabsStore.getState().fullscreenGroupId).toBeNull();
    // a survives.
    expect(useTabsStore.getState().tabs.find((t) => t.key === a.key)).toBeTruthy();
  });

  it("switching scope clears a stale fullscreen group", () => {
    const store = useTabsStore.getState();
    store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    const g = allGroups(useTabsStore.getState().layout)[0].id;
    useTabsStore.getState().toggleFullscreen(g);
    expect(useTabsStore.getState().fullscreenGroupId).toBe(g);

    useTabsStore.getState().setScope("other");
    expect(useTabsStore.getState().fullscreenGroupId).toBeNull();
  });
});
