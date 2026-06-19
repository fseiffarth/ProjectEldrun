/**
 * A file dropped onto a tab bar (TODO Group K #40), with capability passing,
 * must add EXACTLY ONE kind:"embed" tab labelled after the file, landing at the
 * resolved drop slot. The slot assertion is meaningful only AFTER R1's
 * addTab(appends)+moveTab(to index) sequence — addTab ignores index and appends
 * to the focused group, so commitFileDrop must move the new tab to the slot.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const openFileMock = vi.fn(() => Promise.resolve({} as never));
vi.mock("../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: openFileMock }) },
}));

import { commitFileDrop } from "../components/tabs/commitFileDrop";
import { useTabsStore, type GroupNode } from "../stores/tabs";
import { type TabDrag, type EmbedCap } from "../stores/drag";

const PASS: EmbedCap = { os_embeddable: true, app_embeddable: true, resolved_exec: "mousepad" };

function seedThree() {
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
  const c = store.addTab({ label: "c", cmd: "bash", cwd: "/p", kind: "shell" });
  const groupId = (useTabsStore.getState().layout as GroupNode).id;
  return { a, b, c, groupId };
}

function dropAt(groupId: string, slot: number): TabDrag {
  return {
    kind: "file",
    key: "",
    fromGroup: "",
    label: "notes.md",
    pointerX: 0,
    pointerY: 0,
    overGroup: null,
    edge: null,
    reorderGroup: groupId,
    reorderIndex: slot,
    filePath: "/p/notes.md",
    fileName: "notes.md",
    embedCap: PASS,
  };
}

describe("commitFileDrop — adds one embed tab at the resolved slot", () => {
  beforeEach(() => openFileMock.mockClear());

  it("adds exactly one embed tab named after the file", () => {
    const { groupId } = seedThree();
    commitFileDrop(dropAt(groupId, 1), "p", "/p");
    const embeds = useTabsStore.getState().tabs.filter((t) => t.kind === "embed");
    expect(embeds).toHaveLength(1);
    expect(embeds[0].label).toBe("notes.md");
    expect(embeds[0].embedPath).toBe("/p/notes.md");
    expect(embeds[0].embedExec).toBe("mousepad"); // from resolved_exec
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("lands the embed tab at the resolved middle slot (after addTab+moveTab)", () => {
    const { a, b, c, groupId } = seedThree();
    commitFileDrop(dropAt(groupId, 1), "p", "/p");
    const group = useTabsStore.getState().layout as GroupNode;
    const embedKey = useTabsStore.getState().tabs.find((t) => t.kind === "embed")!.key;
    // Slot 1 → between a and b: [a, embed, b, c].
    expect(group.tabKeys).toEqual([a.key, embedKey, b.key, c.key]);
  });

  it("lands the embed tab at slot 0 (front of the bar)", () => {
    const { a, b, c, groupId } = seedThree();
    commitFileDrop(dropAt(groupId, 0), "p", "/p");
    const group = useTabsStore.getState().layout as GroupNode;
    const embedKey = useTabsStore.getState().tabs.find((t) => t.kind === "embed")!.key;
    expect(group.tabKeys).toEqual([embedKey, a.key, b.key, c.key]);
  });

  it("lands the embed tab at the end slot", () => {
    const { a, b, c, groupId } = seedThree();
    commitFileDrop(dropAt(groupId, 3), "p", "/p");
    const group = useTabsStore.getState().layout as GroupNode;
    const embedKey = useTabsStore.getState().tabs.find((t) => t.kind === "embed")!.key;
    expect(group.tabKeys).toEqual([a.key, b.key, c.key, embedKey]);
  });

  it("creates a built-in-viewer tab (no embedExec) when the drag carries a viewer", () => {
    const { groupId } = seedThree();
    const drag = dropAt(groupId, 1);
    drag.viewer = "pdf";
    drag.fileName = "doc.pdf";
    drag.filePath = "/p/doc.pdf";
    commitFileDrop(drag, "p", "/p");
    const embed = useTabsStore.getState().tabs.find((t) => t.kind === "embed")!;
    expect(embed.viewer).toBe("pdf");
    expect(embed.embedPath).toBe("/p/doc.pdf");
    // The built-in viewer renders in-app, so no external handler is carried even
    // though the prefetched capability resolved one.
    expect(embed.embedExec).toBeUndefined();
  });
});
