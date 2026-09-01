/**
 * `relocateExistingTab` inside a MULTI-pane popout: the already-open workspace
 * tab must land in whichever pane the file was dropped on — the second pane as
 * readily as the first — whether it currently lives in the main window or in
 * the other pane of the same popout.
 */
import { describe, it, expect, vi } from "vitest";

const { invokeMock, emitMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
  emitMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: (...a: unknown[]) => emitMock(...a),
  // The detached store now listens as well as emits (Group B: the settings,
  // status and activity channels), and a named import missing from a mock is an
  // import-time failure, not a runtime one.
  listen: () => Promise.resolve(() => {}),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: {} }));
vi.mock("../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));

import { relocateExistingTab } from "../components/tabs/commitFileDrop";
import {
  findGroupOfTab,
  orderedTabKeys,
  useTabsStore,
  type GroupNode,
  type SplitNode,
} from "../stores/tabs";

function shell(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}
function workspace() {
  return {
    label: "Poster.tex",
    cmd: "",
    cwd: "/p/poster",
    kind: "embed" as const,
    embedPath: "/p/poster/Poster.tex",
    viewer: "texworkspace" as const,
  };
}

// Popout = [L=[b] | R=[c]] (b split out to the LEFT of c, so L is the pane the
// popout minted after detaching); main window keeps [a].
function setup() {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  useTabsStore.getState().setScope("p");
  const a = useTabsStore.getState().addTab(shell("a"));
  const b = useTabsStore.getState().addTab(shell("b"));
  const c = useTabsStore.getState().addTab(shell("c"));
  const rootGid = (useTabsStore.getState().layout as GroupNode).id;
  useTabsStore.getState().splitWithTab(a.key, rootGid, "right");
  const root = useTabsStore.getState().layout as SplitNode;
  const left = root.children[0] as GroupNode; // [b,c]
  useTabsStore.getState().detachGroup(left.id);
  const entry = useTabsStore.getState().detachedGroupsByScope["p"][0];
  const origPane = (entry.subtree as GroupNode).id;
  useTabsStore.getState().applyDetachedEdit("p", entry.id, {
    kind: "split",
    key: b.key,
    targetGroupId: origPane,
    edge: "left",
  });
  const sub = useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as SplitNode;
  const L = sub.children[0] as GroupNode;
  const R = sub.children[1] as GroupNode;
  expect(L.tabKeys).toEqual([b.key]);
  expect(R.tabKeys).toEqual([c.key]);
  expect(R.id).toBe(origPane);
  invokeMock.mockClear();
  emitMock.mockClear();
  return { a, b, c, popout: entry.id, L: L.id, R: R.id };
}

const subtree = () => useTabsStore.getState().detachedGroupsByScope["p"][0].subtree;

describe("relocateExistingTab — multi-pane popout", () => {
  it("main → the popout's NEW (left) pane, centre: merges into that pane", () => {
    const { b, popout, L } = setup();
    const ws = useTabsStore.getState().addTab(workspace());
    relocateExistingTab(ws.key, {
      kind: "detached",
      scope: "p",
      groupId: popout,
      target: { groupId: L, edge: "center" },
    });
    const home = findGroupOfTab(subtree(), ws.key)!;
    expect(home.group.id).toBe(L);
    expect(home.group.tabKeys).toEqual([b.key, ws.key]);
    expect(home.group.activeKey).toBe(ws.key);
    expect(orderedTabKeys(useTabsStore.getState().layout)).not.toContain(ws.key);
  });

  it("main → the popout's original (right) pane, centre: merges into that pane", () => {
    const { c, popout, R } = setup();
    const ws = useTabsStore.getState().addTab(workspace());
    relocateExistingTab(ws.key, {
      kind: "detached",
      scope: "p",
      groupId: popout,
      target: { groupId: R, edge: "center" },
    });
    const home = findGroupOfTab(subtree(), ws.key)!;
    expect(home.group.id).toBe(R);
    expect(home.group.tabKeys).toEqual([c.key, ws.key]);
  });

  it("right pane → left pane inside the same popout (centre): moves across", () => {
    const { b, c, popout, L, R } = setup();
    const ws = useTabsStore.getState().addTab(workspace());
    useTabsStore.getState().dockTabIntoDetached("p", popout, ws.key, { groupId: R, edge: "center" });
    expect(findGroupOfTab(subtree(), ws.key)!.group.id).toBe(R);

    relocateExistingTab(ws.key, {
      kind: "detached",
      scope: "p",
      groupId: popout,
      target: { groupId: L, edge: "center" },
    });
    const home = findGroupOfTab(subtree(), ws.key)!;
    expect(home.group.id).toBe(L);
    expect(home.group.tabKeys).toEqual([b.key, ws.key]);
    expect(home.group.activeKey).toBe(ws.key);
    // Exactly one copy in the whole popout; the right pane kept its shell.
    expect(orderedTabKeys(subtree()).filter((k) => k === ws.key)).toHaveLength(1);
    expect(findGroupOfTab(subtree(), c.key)!.group.id).toBe(R);
  });

  it("right pane → left pane's bottom edge: carves a new pane under the left one", () => {
    const { popout, L, R } = setup();
    const ws = useTabsStore.getState().addTab(workspace());
    useTabsStore.getState().dockTabIntoDetached("p", popout, ws.key, { groupId: R, edge: "center" });

    relocateExistingTab(ws.key, {
      kind: "detached",
      scope: "p",
      groupId: popout,
      target: { groupId: L, edge: "bottom" },
    });
    const home = findGroupOfTab(subtree(), ws.key)!;
    expect(home.group.id).not.toBe(L);
    expect(home.group.id).not.toBe(R);
    expect(home.group.tabKeys).toEqual([ws.key]);
    expect(orderedTabKeys(subtree()).filter((k) => k === ws.key)).toHaveLength(1);
  });

  it("a target pane the store does not know falls back to the first pane, never nowhere", () => {
    const { b, popout } = setup();
    const ws = useTabsStore.getState().addTab(workspace());
    relocateExistingTab(ws.key, {
      kind: "detached",
      scope: "p",
      groupId: popout,
      target: { groupId: "not-a-pane", edge: "center" },
    });
    const home = findGroupOfTab(subtree(), ws.key)!;
    expect(home.group.tabKeys).toContain(b.key);
    expect(home.group.tabKeys).toContain(ws.key);
  });
});
