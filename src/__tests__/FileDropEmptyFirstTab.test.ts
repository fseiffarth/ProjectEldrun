/**
 * When a scope has NO tabs yet, the only drop target is the full-panel empty
 * placeholder subwindow (CenterPanel renders it with groupId EMPTY_GROUP_ID).
 * A file dragged from the right panel and dropped anywhere over the main window
 * — resolving to EMPTY_GROUP_ID as either the tab-bar reorder target or the body
 * overGroup — must become the FIRST tab (addTab builds the root group). A drop
 * released over the right panel resolves to no target and must do nothing (no
 * tab, no external open).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const openFileMock = vi.fn(() => Promise.resolve({} as never));
vi.mock("../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: openFileMock }) },
}));

import { commitFileDrop } from "../components/tabs/commitFileDrop";
import { EMPTY_GROUP_ID, useTabsStore, type GroupNode } from "../stores/tabs";
import { type TabDrag, type EmbedCap } from "../stores/drag";

const PASS: EmbedCap = { os_embeddable: true, app_embeddable: true, resolved_exec: "mousepad" };

function seedEmpty() {
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
  useTabsStore.getState().setScope("p");
}

function baseDrag(): TabDrag {
  return {
    kind: "file",
    key: "",
    fromGroup: "",
    label: "notes.md",
    pointerX: 0,
    pointerY: 0,
    overGroup: null,
    edge: null,
    reorderGroup: null,
    reorderIndex: null,
    filePath: "/p/notes.md",
    fileName: "notes.md",
    embedCap: PASS,
  };
}

describe("commitFileDrop — empty state creates the first tab", () => {
  beforeEach(() => {
    seedEmpty();
    openFileMock.mockClear();
  });

  it("dropping over the empty placeholder body creates the first tab", () => {
    const drag = { ...baseDrag(), overGroup: EMPTY_GROUP_ID, edge: "center" as const };
    commitFileDrop(drag, "p", "/p");
    const state = useTabsStore.getState();
    const root = state.layout as GroupNode;
    expect(root).not.toBeNull();
    expect(root.type).toBe("group");
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].kind).toBe("embed");
    expect(state.tabs[0].label).toBe("notes.md");
    expect(root.tabKeys).toEqual([state.tabs[0].key]);
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("dropping over the empty placeholder tab bar creates the first tab", () => {
    const drag = { ...baseDrag(), reorderGroup: EMPTY_GROUP_ID, reorderIndex: 0 };
    commitFileDrop(drag, "p", "/p");
    const state = useTabsStore.getState();
    expect(state.layout).not.toBeNull();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].kind).toBe("embed");
  });

  it("dropping with no resolved target (e.g. over the right panel) does nothing", () => {
    commitFileDrop(baseDrag(), "p", "/p");
    const state = useTabsStore.getState();
    expect(state.layout).toBeNull();
    expect(state.tabs).toHaveLength(0);
    expect(openFileMock).not.toHaveBeenCalled();
  });
});
