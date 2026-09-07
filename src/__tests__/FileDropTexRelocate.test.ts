/**
 * A `.tex` dropped from the side panel goes through `openTexWorkspace`, whose
 * one-tab rule used to FOCUS an already-open workspace wherever it was and
 * ignore the drop target — so dropping a `.tex` onto a popout while its
 * workspace was open in the main window lit the popout's split preview and then
 * visibly did nothing. The drop names a destination: the existing workspace tab
 * must be RELOCATED there (`relocateExistingTab`), never duplicated.
 */
import { describe, it, expect, vi } from "vitest";

const { invokeMock, emitMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
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

import { commitFileDrop } from "../components/tabs/commitFileDrop";
import { detachedSeedEvent } from "../stores/detached";
import { orderedTabKeys, useTabsStore, type GroupNode, type SplitNode } from "../stores/tabs";
import { type TabDrag } from "../stores/drag";

const TEX = "/p/poster/Poster.tex";

function shell(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}
function workspace() {
  return {
    label: "Poster.tex",
    cmd: "",
    cwd: "/p/poster",
    kind: "embed" as const,
    embedPath: TEX,
    viewer: "texworkspace" as const,
  };
}

// [G1=[b,c] (detached) | G2=[a] (live)]; the workspace tab is added afterwards
// by each test, into the home it wants to start from.
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
  const left = root.children[0] as GroupNode;
  const right = root.children[1] as GroupNode;
  useTabsStore.getState().detachGroup(left.id);
  const entry = useTabsStore.getState().detachedGroupsByScope["p"][0];
  invokeMock.mockClear();
  emitMock.mockClear();
  return { a, b, c, g1: left.id, g2: right.id, label: entry.label };
}

function texDrag(over: Partial<TabDrag> = {}): TabDrag {
  return {
    kind: "file",
    key: "",
    fromGroup: "",
    label: "Poster.tex",
    pointerX: 0,
    pointerY: 0,
    overGroup: null,
    edge: null,
    reorderGroup: null,
    reorderIndex: null,
    filePath: TEX,
    fileName: "Poster.tex",
    viewer: "tex",
    embedCap: null,
    ...over,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const workspaceTabs = () =>
  useTabsStore.getState().tabs.filter((t) => t.viewer === "texworkspace");

describe("a .tex drop relocates an already-open workspace instead of ignoring the target", () => {
  it("main window → popout: the existing tab moves INTO the popout (no 2nd workspace)", async () => {
    const { b, c, g1, g2, label } = setup();
    const ws = useTabsStore.getState().addTab(workspace()); // lands in live G2
    expect(orderedTabKeys(useTabsStore.getState().layout)).toContain(ws.key);

    commitFileDrop(texDrag(), "p", "/p", null, { scope: "p", groupId: g1 });
    await settle();

    expect(workspaceTabs()).toHaveLength(1);
    const sub = useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as GroupNode;
    expect(sub.tabKeys).toEqual([b.key, c.key, ws.key]);
    expect(sub.activeKey).toBe(ws.key);
    // Gone from the in-window layout, and the popout was re-seeded with it as
    // the landed tab.
    expect(orderedTabKeys(useTabsStore.getState().layout)).not.toContain(ws.key);
    expect(useTabsStore.getState().layout && g2).toBeTruthy();
    const seed = emitMock.mock.calls.find((call) => call[0] === detachedSeedEvent(label));
    expect((seed?.[1] as { landedKey?: string }).landedKey).toBe(ws.key);
  });

  it("main window → popout pane edge: the existing tab carves the pane it was dropped on", async () => {
    const { g1 } = setup();
    const ws = useTabsStore.getState().addTab(workspace());

    commitFileDrop(texDrag(), "p", "/p", null, {
      scope: "p",
      groupId: g1,
      target: { groupId: g1, edge: "right" },
    });
    await settle();

    expect(workspaceTabs()).toHaveLength(1);
    const sub = useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as SplitNode;
    expect(sub.type).toBe("split");
    const newPane = sub.children[1] as GroupNode;
    expect(newPane.tabKeys).toEqual([ws.key]);
  });

  it("popout → the same popout: stays a single tab, re-seeded and activated there", async () => {
    const { b, c, g1 } = setup();
    // Open the workspace directly inside the popout.
    const ws = useTabsStore.getState().addTab(workspace());
    useTabsStore.getState().dockTabIntoDetached("p", g1, ws.key);
    // Make a shell the popout's active tab so the drop has something to change.
    useTabsStore.getState().applyDetachedEdit("p", g1, { kind: "activate", key: b.key });
    emitMock.mockClear();

    commitFileDrop(texDrag(), "p", "/p", null, {
      scope: "p",
      groupId: g1,
      target: { groupId: g1, edge: "center" },
    });
    await settle();

    expect(workspaceTabs()).toHaveLength(1);
    const sub = useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as GroupNode;
    expect(new Set(sub.tabKeys)).toEqual(new Set([b.key, c.key, ws.key]));
    expect(sub.tabKeys.filter((k) => k === ws.key)).toHaveLength(1);
    expect(sub.activeKey).toBe(ws.key);
  });

  it("popout → main window split: the existing tab docks back at that edge", async () => {
    const { g1, g2 } = setup();
    const ws = useTabsStore.getState().addTab(workspace());
    useTabsStore.getState().dockTabIntoDetached("p", g1, ws.key);

    commitFileDrop(texDrag({ overGroup: g2, edge: "bottom" }), "p", "/p", null);
    await settle();

    expect(workspaceTabs()).toHaveLength(1);
    const st = useTabsStore.getState();
    expect(orderedTabKeys(st.layout)).toContain(ws.key);
    expect(orderedTabKeys(st.detachedGroupsByScope["p"][0].subtree)).not.toContain(ws.key);
  });

  it("in-window split when the workspace is already in-window: moved, not duplicated", async () => {
    const { g2 } = setup();
    const ws = useTabsStore.getState().addTab(workspace()); // in G2 beside `a`

    commitFileDrop(texDrag({ overGroup: g2, edge: "left" }), "p", "/p", null);
    await settle();

    expect(workspaceTabs()).toHaveLength(1);
    const root = useTabsStore.getState().layout as SplitNode;
    // G2 was split: the workspace now sits alone in its own pane.
    const panes = orderedTabKeys(root);
    expect(panes).toContain(ws.key);
    const own = (function find(n: typeof root | GroupNode): GroupNode | null {
      if (n.type === "group") return n.tabKeys.includes(ws.key) ? n : null;
      for (const ch of n.children) {
        const f = find(ch as typeof root | GroupNode);
        if (f) return f;
      }
      return null;
    })(root);
    expect(own?.tabKeys).toEqual([ws.key]);
  });

  it("a CHILD of an open document dropped on a popout becomes its own editor tab there", async () => {
    const { b, c, g1 } = setup();
    const CHILD = "/p/poster/PosterTemplate.tex";
    // The build-root resolver folds the child into the Poster.tex document
    // (`Poster.tex` \inputs it).
    invokeMock.mockImplementation((cmd: unknown, args: unknown) =>
      cmd === "resolve_tex_root" && (args as { path: string }).path === CHILD
        ? Promise.resolve(TEX)
        : Promise.resolve(undefined),
    );
    try {
      const ws = useTabsStore.getState().addTab(workspace()); // open in the main window

      commitFileDrop(
        texDrag({ filePath: CHILD, fileName: "PosterTemplate.tex", label: "PosterTemplate.tex" }),
        "p",
        "/p",
        null,
        { scope: "p", groupId: g1 },
      );
      await settle();

      // The workspace is still the one tab it was, still in the main window…
      expect(workspaceTabs()).toHaveLength(1);
      expect(orderedTabKeys(useTabsStore.getState().layout)).toContain(ws.key);
      // …and the child landed in the popout as a plain editor tab of ITS file.
      const child = useTabsStore.getState().tabs.find((t) => t.embedPath === CHILD)!;
      expect(child).toBeTruthy();
      expect(child.viewer).toBe("tex");
      expect(child.label).toBe("PosterTemplate.tex");
      const sub = useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as GroupNode;
      expect(sub.tabKeys).toEqual([b.key, c.key, child.key]);
      expect(sub.activeKey).toBe(child.key);
    } finally {
      invokeMock.mockImplementation(() => Promise.resolve(undefined));
    }
  });

  it("a fresh workspace (nothing open) is still placed via `place`, unchanged", async () => {
    const { b, c, g1 } = setup();
    commitFileDrop(texDrag(), "p", "/p", null, { scope: "p", groupId: g1 });
    await settle();

    const ws = workspaceTabs();
    expect(ws).toHaveLength(1);
    const sub = useTabsStore.getState().detachedGroupsByScope["p"][0].subtree as GroupNode;
    expect(sub.tabKeys).toEqual([b.key, c.key, ws[0].key]);
  });
});
