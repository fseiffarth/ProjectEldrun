/**
 * The file→tab drop (TODO Group K #40) accepts any file dropped on a tab bar:
 * commitFileDrop creates an "embed" tab named after the file regardless of the
 * prefetched embed capability — the drop is always meaningful. Capability is
 * carried on the tab (embedExec) for a later phase to render the app frameless
 * in-tab; until then the tab opens the file externally. A drop that is NOT over
 * a tab bar falls back to opening the file externally via the windows store.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

// Spy on the windows store's openFile to assert a stray drop never opens.
const openFileMock = vi.fn(() => Promise.resolve({} as never));
vi.mock("../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: openFileMock }) },
}));

import { commitFileDrop } from "../components/tabs/commitFileDrop";
import { useTabsStore } from "../stores/tabs";
import { type TabDrag, type EmbedCap } from "../stores/drag";

function seedGroup() {
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
  useTabsStore.getState().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
  // Single root group now exists.
  const groupId = useTabsStore.getState().layout!.type === "group"
    ? (useTabsStore.getState().layout as { id: string }).id
    : "";
  return groupId;
}

function fileDrag(cap: EmbedCap | null, groupId: string): TabDrag {
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
    reorderIndex: 1,
    filePath: "/p/notes.md",
    fileName: "notes.md",
    embedCap: cap,
  };
}

const PASS: EmbedCap = { os_embeddable: true, app_embeddable: true, resolved_exec: "mousepad" };

describe("commitFileDrop — tab-bar drop", () => {
  beforeEach(() => {
    openFileMock.mockClear();
  });

  it("creates an embed tab when dropped on a tab bar (capability passing)", () => {
    const g = seedGroup();
    commitFileDrop(fileDrag(PASS, g), "p", "/p");
    const embed = useTabsStore.getState().tabs.find((t) => t.kind === "embed");
    expect(embed).toBeTruthy();
    expect(embed!.label).toBe("notes.md");
    expect(embed!.embedExec).toBe("mousepad");
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("still creates an embed tab when os_embeddable is false (capability does not gate)", () => {
    const g = seedGroup();
    commitFileDrop(
      fileDrag({ os_embeddable: false, app_embeddable: true, resolved_exec: "mousepad" }, g),
      "p",
      "/p",
    );
    expect(useTabsStore.getState().tabs.some((t) => t.kind === "embed")).toBe(true);
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("still creates an embed tab when app_embeddable is false", () => {
    const g = seedGroup();
    commitFileDrop(
      fileDrag({ os_embeddable: true, app_embeddable: false, resolved_exec: "gedit" }, g),
      "p",
      "/p",
    );
    expect(useTabsStore.getState().tabs.some((t) => t.kind === "embed")).toBe(true);
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("still creates an embed tab when capability is null (query failed / in flight)", () => {
    const g = seedGroup();
    commitFileDrop(fileDrag(null, g), "p", "/p");
    expect(useTabsStore.getState().tabs.some((t) => t.kind === "embed")).toBe(true);
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("does nothing when there is no drop target (stray drop must not open the file)", () => {
    const g = seedGroup();
    const drag = fileDrag(PASS, g);
    drag.reorderGroup = null;
    drag.reorderIndex = null;
    commitFileDrop(drag, "p", "/p");
    expect(useTabsStore.getState().tabs.some((t) => t.kind === "embed")).toBe(false);
    expect(openFileMock).not.toHaveBeenCalled();
  });
});
