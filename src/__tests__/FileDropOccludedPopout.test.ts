/**
 * Regression: a file dragged from the right panel and released INSIDE the main
 * window must split in-window even when an OCCLUDED popout (one behind the main
 * window) happens to sit under the cursor. Previously FileTree folded
 * `overDetached` into its "outside the window" test, so an occluded popout — which
 * the frontmost guard correctly refuses to dock into — still forced a brand-new
 * standalone viewer window instead of an in-window split.
 *
 * The decision now lives in the pure `fileDropGoesToNewWindow`: only Shift or a
 * release genuinely outside the viewport opens a new window; a popout under the
 * cursor never does. Part A pins that predicate; Part B locks the user-facing
 * outcome — with `detachBounds === null` (what an occluded popout now yields) a
 * viewer file splits in-window rather than detaching.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const openFileMock = vi.fn(() => Promise.resolve({} as never));
vi.mock("../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: openFileMock }) },
}));

import { commitFileDrop, fileDropGoesToNewWindow } from "../components/tabs/commitFileDrop";
import { useTabsStore, allGroups, type GroupNode, type SplitNode } from "../stores/tabs";
import { type TabDrag, type EmbedCap } from "../stores/drag";

const PASS: EmbedCap = { os_embeddable: true, app_embeddable: true, resolved_exec: "mousepad" };
const VIEWPORT = { w: 1000, h: 800 };

describe("fileDropGoesToNewWindow — only Shift or a truly-outside release detaches", () => {
  it("stays in-window for a release inside the viewport with no Shift", () => {
    // This is the occluded-popout case: an invisible popout behind the cursor
    // must NOT force a new window — the main window is what's actually under it.
    expect(
      fileDropGoesToNewWindow({ shiftKey: false, lastClient: { x: 500, y: 400 }, viewport: VIEWPORT }),
    ).toBe(false);
  });

  it("detaches when Shift is held (explicit new-window override)", () => {
    expect(
      fileDropGoesToNewWindow({ shiftKey: true, lastClient: { x: 500, y: 400 }, viewport: VIEWPORT }),
    ).toBe(true);
  });

  it("detaches when the release is outside any viewport edge", () => {
    const inside = { x: 500, y: 400 };
    expect(fileDropGoesToNewWindow({ shiftKey: false, lastClient: { ...inside, x: -1 }, viewport: VIEWPORT })).toBe(true);
    expect(fileDropGoesToNewWindow({ shiftKey: false, lastClient: { ...inside, y: -1 }, viewport: VIEWPORT })).toBe(true);
    expect(fileDropGoesToNewWindow({ shiftKey: false, lastClient: { ...inside, x: VIEWPORT.w }, viewport: VIEWPORT })).toBe(true);
    expect(fileDropGoesToNewWindow({ shiftKey: false, lastClient: { ...inside, y: VIEWPORT.h }, viewport: VIEWPORT })).toBe(true);
  });
});

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

// A viewer file dropped over a subwindow body edge — mirrors the user's repro
// (a markdown/pdf file, the kind that wrongly spawned a standalone viewer window).
function viewerDropOnEdge(groupId: string): TabDrag {
  return {
    kind: "file",
    key: "",
    fromGroup: "",
    label: "notes.md",
    pointerX: 0,
    pointerY: 0,
    overGroup: groupId,
    edge: "right",
    reorderGroup: null,
    reorderIndex: null,
    filePath: "/p/notes.md",
    fileName: "notes.md",
    viewer: "markdown",
    embedCap: PASS,
  };
}

describe("commitFileDrop — occluded popout yields an in-window split, not a new window", () => {
  it("splits in-window (no detach) for a viewer file with detachBounds === null", () => {
    const { a, b, groupId } = seedOneGroup();
    // detachNewTab is the standalone-window path the bug wrongly took; it must
    // not fire when the release resolves to an in-window target.
    const detachSpy = vi.spyOn(useTabsStore.getState(), "detachNewTab");

    // null detachBounds is exactly what the fix now produces for an occluded
    // popout under the cursor (fileDropGoesToNewWindow → false).
    commitFileDrop(viewerDropOnEdge(groupId), "p", "/p", null);

    const layout = useTabsStore.getState().layout as SplitNode;
    expect(layout.type).toBe("split");
    const groups = allGroups(layout);
    expect(groups).toHaveLength(2);

    const orig = groups.find((g) => g.id === groupId)!;
    expect(orig.tabKeys).toEqual([a.key, b.key]); // untouched
    const embed = useTabsStore.getState().tabs.find((t) => t.kind === "embed")!;
    expect(embed.label).toBe("notes.md");
    expect(embed.viewer).toBe("markdown");
    const newGroup = groups.find((g) => g.id !== groupId)!;
    expect(newGroup.tabKeys).toEqual([embed.key]);

    // Crucially: no standalone window and no external open.
    expect(detachSpy).not.toHaveBeenCalled();
    expect(openFileMock).not.toHaveBeenCalled();
  });
});
