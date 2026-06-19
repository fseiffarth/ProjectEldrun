/**
 * A file dragged from the right panel onto a subwindow BODY EDGE (not a tab bar)
 * carves out a NEW subwindow holding the file's embed tab — mirroring how a tab
 * drag edge-splits. A "center" drop instead adds the embed tab into the existing
 * target group. The original group's tabs are never disturbed.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const openFileMock = vi.fn(() => Promise.resolve({} as never));
vi.mock("../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: openFileMock }) },
}));

import { commitFileDrop } from "../components/tabs/commitFileDrop";
import { useTabsStore, allGroups, findGroupOfTab, type GroupNode, type SplitNode } from "../stores/tabs";
import { type TabDrag, type EmbedCap } from "../stores/drag";

const PASS: EmbedCap = { os_embeddable: true, app_embeddable: true, resolved_exec: "mousepad" };

function seedOneGroup() {
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
  const store = useTabsStore.getState();
  store.setScope("p");
  const a = store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
  const b = store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
  const groupId = (useTabsStore.getState().layout as GroupNode).id;
  return { a, b, groupId };
}

function dropOnEdge(groupId: string, edge: TabDrag["edge"]): TabDrag {
  return {
    kind: "file",
    key: "",
    fromGroup: "",
    label: "notes.md",
    pointerX: 0,
    pointerY: 0,
    overGroup: groupId,
    edge,
    reorderGroup: null,
    reorderIndex: null,
    filePath: "/p/notes.md",
    fileName: "notes.md",
    embedCap: PASS,
  };
}

describe("commitFileDrop — edge drop splits into a new subwindow", () => {
  it("carves a new group at the right edge holding the embed tab", () => {
    const { a, b, groupId } = seedOneGroup();
    commitFileDrop(dropOnEdge(groupId, "right"), "p", "/p");

    const layout = useTabsStore.getState().layout as SplitNode;
    expect(layout.type).toBe("split");
    expect(layout.dir).toBe("row");

    const groups = allGroups(layout);
    expect(groups).toHaveLength(2);

    // Original group keeps its tabs untouched; new group holds only the embed.
    const orig = groups.find((g) => g.id === groupId)!;
    expect(orig.tabKeys).toEqual([a.key, b.key]);

    const embed = useTabsStore.getState().tabs.find((t) => t.kind === "embed")!;
    expect(embed.label).toBe("notes.md");
    const newGroup = groups.find((g) => g.id !== groupId)!;
    expect(newGroup.tabKeys).toEqual([embed.key]);
    // Right edge → new group comes after the original.
    expect(layout.children.indexOf(newGroup)).toBeGreaterThan(layout.children.indexOf(orig));
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("a top-edge drop creates a column split with the new group before", () => {
    const { groupId } = seedOneGroup();
    commitFileDrop(dropOnEdge(groupId, "top"), "p", "/p");
    const layout = useTabsStore.getState().layout as SplitNode;
    expect(layout.dir).toBe("column");
    const embed = useTabsStore.getState().tabs.find((t) => t.kind === "embed")!;
    const found = findGroupOfTab(layout, embed.key)!;
    expect(layout.children.indexOf(found.group)).toBe(0);
  });

  it("a center drop adds the embed tab into the existing group (no split)", () => {
    const { a, b, groupId } = seedOneGroup();
    commitFileDrop(dropOnEdge(groupId, "center"), "p", "/p");
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.type).toBe("group");
    const embed = useTabsStore.getState().tabs.find((t) => t.kind === "embed")!;
    expect(layout.tabKeys).toEqual([a.key, b.key, embed.key]);
  });
});
