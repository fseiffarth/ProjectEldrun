/**
 * #42: dragging ONE PANE (inner group) out of a MULTI-pane detached popout.
 *
 * Regression for the "pane drop docked EVERY subwindow" bug: the pane's bar grip
 * used to start a whole-popout drag, so releasing it over the main window ran
 * `attachGroup(popoutId)` and re-injected the popout's ENTIRE subtree — every
 * sibling pane — into the main layout. The pane path must move ONLY the dragged
 * group and leave the siblings floating.
 *
 * Covers: the pure `decideDetachedPaneDrop` ladder, `attachDetachedPane`
 * (multi-pane extraction, sibling survival, lone-pane delegation to the
 * whole-group dock), and `detachPaneToNewWindow` (free-space release; lone-pane
 * refusal).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { decideDetachedPaneDrop } from "../stores/detached";
import {
  useTabsStore,
  allGroups,
  orderedTabKeys,
  type GroupNode,
  type SplitNode,
} from "../stores/tabs";

const base = {
  cancelled: false,
  shift: false,
  inMain: false,
  overPopoutId: null as string | null,
  srcGroupId: "src",
};

describe("decideDetachedPaneDrop", () => {
  it("cancelled → none, winning over everything else", () => {
    expect(decideDetachedPaneDrop({ ...base, cancelled: true }).kind).toBe("none");
    expect(
      decideDetachedPaneDrop({
        ...base,
        cancelled: true,
        shift: true,
        inMain: true,
        overPopoutId: "b",
      }).kind,
    ).toBe("none");
  });

  it("Shift → newWindow, overriding main and popouts", () => {
    expect(decideDetachedPaneDrop({ ...base, shift: true }).kind).toBe("newWindow");
    expect(decideDetachedPaneDrop({ ...base, shift: true, inMain: true }).kind).toBe("newWindow");
    expect(decideDetachedPaneDrop({ ...base, shift: true, overPopoutId: "b" }).kind).toBe(
      "newWindow",
    );
  });

  it("over a SIBLING popout → none (no pane→popout merge), even over main", () => {
    expect(decideDetachedPaneDrop({ ...base, overPopoutId: "b" }).kind).toBe("none");
    expect(decideDetachedPaneDrop({ ...base, overPopoutId: "b", inMain: true }).kind).toBe("none");
  });

  it("the SOURCE popout doesn't count as a sibling — inMain still docks", () => {
    expect(decideDetachedPaneDrop({ ...base, overPopoutId: "src", inMain: true }).kind).toBe(
      "dockMain",
    );
  });

  it("over the main window → dockMain; free space → newWindow", () => {
    expect(decideDetachedPaneDrop({ ...base, inMain: true }).kind).toBe("dockMain");
    expect(decideDetachedPaneDrop({ ...base }).kind).toBe("newWindow");
  });
});

function tab(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

function reset() {
  invokeMock.mockClear();
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    pendingRespawnByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
}

/**
 * Build the bug's exact shape: a main layout of [a] plus a detached TWO-pane
 * popout holding [b] and [c] (detach a two-tab group, then split it inside the
 * popout). Returns the popout id + the two inner pane groups.
 */
function twoPanePopout() {
  const store = useTabsStore.getState();
  const a = store.addTab(tab("a"));
  const b = store.addTab(tab("b"));
  const c = store.addTab(tab("c"));
  const rootGid = (useTabsStore.getState().layout as GroupNode).id;
  // Move b+c into their own group to the right, then detach that group.
  useTabsStore.getState().splitWithTab(b.key, rootGid, "right");
  const right = (useTabsStore.getState().layout as SplitNode).children[1] as GroupNode;
  useTabsStore.getState().moveTab(c.key, right.id);
  const label = useTabsStore.getState().detachGroup(right.id)!;
  expect(label).toBeTruthy();
  const popoutId = right.id;
  // Split inside the popout: [b] | [c].
  useTabsStore.getState().splitDetachedGroup("p", popoutId, c.key, popoutId, "right");
  const entry = useTabsStore.getState().detachedGroupsByScope.p.find((d) => d.id === popoutId)!;
  const panes = allGroups(entry.subtree);
  expect(panes).toHaveLength(2);
  const paneB = panes.find((g) => g.tabKeys.includes(b.key))!;
  const paneC = panes.find((g) => g.tabKeys.includes(c.key))!;
  return { a, b, c, popoutId, paneB, paneC };
}

describe("tabs store — attachDetachedPane (#42)", () => {
  beforeEach(reset);

  it("docks ONLY the dragged pane; the sibling pane stays floating (the regression)", () => {
    const { a, b, c, popoutId, paneC } = twoPanePopout();
    invokeMock.mockClear();

    useTabsStore.getState().attachDetachedPane("p", popoutId, paneC.id);

    // Main layout gained exactly c — never b (the old bug docked the whole subtree).
    const mainKeys = orderedTabKeys(useTabsStore.getState().layout);
    expect(mainKeys).toContain(a.key);
    expect(mainKeys).toContain(c.key);
    expect(mainKeys).not.toContain(b.key);
    // The popout survives, holding just the remaining pane.
    const entry = useTabsStore.getState().detachedGroupsByScope.p.find((d) => d.id === popoutId)!;
    expect(entry).toBeTruthy();
    expect(orderedTabKeys(entry.subtree)).toEqual([b.key]);
    // Its OS window must NOT close.
    expect(invokeMock).not.toHaveBeenCalledWith("attach_subwindow", expect.anything());
    // No payload lost or duplicated.
    expect(useTabsStore.getState().tabsByScope.p).toHaveLength(3);
  });

  it("merges into a center target group instead of splitting when asked", () => {
    const { a, c, popoutId, paneC } = twoPanePopout();
    const mainGroup = allGroups(useTabsStore.getState().layout)[0];
    useTabsStore
      .getState()
      .attachDetachedPane("p", popoutId, paneC.id, { targetGroupId: mainGroup.id, edge: "center" });
    const groups = allGroups(useTabsStore.getState().layout);
    const merged = groups.find((g) => g.id === mainGroup.id)!;
    expect(merged.tabKeys).toEqual([a.key, c.key]);
    expect(merged.activeKey).toBe(c.key);
  });

  it("the popout's ONLY pane delegates to the whole-group dock (window closes)", () => {
    const { b, c, popoutId, paneB, paneC } = twoPanePopout();
    useTabsStore.getState().attachDetachedPane("p", popoutId, paneC.id);
    invokeMock.mockClear();
    // Now the popout is single-pane; its subtree root collapsed to paneB's group.
    useTabsStore.getState().attachDetachedPane("p", popoutId, paneB.id);
    const mainKeys = orderedTabKeys(useTabsStore.getState().layout);
    expect(mainKeys).toContain(b.key);
    expect(mainKeys).toContain(c.key);
    expect(useTabsStore.getState().detachedGroupsByScope.p).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("attach_subwindow", expect.anything());
  });

  it("no-ops when the popout or pane is gone", () => {
    const { popoutId, paneC } = twoPanePopout();
    const before = useTabsStore.getState();
    useTabsStore.getState().attachDetachedPane("p", "nope", paneC.id);
    useTabsStore.getState().attachDetachedPane("p", popoutId, "nope");
    expect(useTabsStore.getState().layout).toBe(before.layout);
    expect(useTabsStore.getState().detachedGroupsByScope).toBe(before.detachedGroupsByScope);
  });
});

describe("tabs store — detachPaneToNewWindow (#42)", () => {
  beforeEach(reset);

  it("pops the pane into its own popout, leaving the sibling in the source", () => {
    const { b, c, popoutId, paneC } = twoPanePopout();
    invokeMock.mockClear();
    const bounds = { x: 10, y: 20, w: 900, h: 640 };

    const label = useTabsStore.getState().detachPaneToNewWindow("p", popoutId, paneC.id, bounds);

    expect(label).toBeTruthy();
    const entries = useTabsStore.getState().detachedGroupsByScope.p;
    expect(entries).toHaveLength(2);
    const src = entries.find((d) => d.id === popoutId)!;
    const fresh = entries.find((d) => d.label === label)!;
    expect(orderedTabKeys(src.subtree)).toEqual([b.key]);
    expect(orderedTabKeys(fresh.subtree)).toEqual([c.key]);
    expect(fresh.bounds).toEqual(bounds);
    expect(invokeMock).toHaveBeenCalledWith("detach_subwindow", expect.objectContaining({
      projectId: "p",
      x: 10,
      y: 20,
    }));
  });

  it("refuses the popout's only pane — it already IS that pane's window", () => {
    const { popoutId, paneC } = twoPanePopout();
    useTabsStore.getState().attachDetachedPane("p", popoutId, paneC.id);
    const entry = useTabsStore.getState().detachedGroupsByScope.p[0];
    const lone = allGroups(entry.subtree)[0];
    invokeMock.mockClear();
    const label = useTabsStore
      .getState()
      .detachPaneToNewWindow("p", popoutId, lone.id, { x: 0, y: 0, w: 100, h: 100 });
    expect(label).toBeNull();
    expect(useTabsStore.getState().detachedGroupsByScope.p).toHaveLength(1);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
