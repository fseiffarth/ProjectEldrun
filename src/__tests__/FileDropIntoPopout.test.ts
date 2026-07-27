/**
 * A file dragged from the right panel and released OVER an open popout must dock
 * into it as an embed tab — mirroring a tab dragged onto a popout — instead of
 * spawning a new standalone window. commitFileDrop's `detachedTarget` branch
 * creates the embed tab in the scope, moves it into the popout's subtree
 * (addTab + dockTabIntoDetached), and re-seeds the popout with the new key as
 * `landedKey` so it plays the drop-in landing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock, emitMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
  emitMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: (...a: unknown[]) => emitMock(...a) }));
// detachedDropTargets imports WebviewWindow at module load; it is only exercised
// by the live drag session (not this commit path), so a bare stub is enough.
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: {} }));

const openFileMock = vi.fn(() => Promise.resolve({} as never));
vi.mock("../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: openFileMock }) },
}));

import { commitFileDrop } from "../components/tabs/commitFileDrop";
import { detachedSeedEvent } from "../stores/detached";
import { useTabsStore, type GroupNode, type SplitNode } from "../stores/tabs";
import { type TabDrag, type EmbedCap } from "../stores/drag";

const PASS: EmbedCap = { os_embeddable: true, app_embeddable: true, resolved_exec: "mousepad" };

function tab(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

// Build [G1=[b,c] (detached), G2=[a] (live)] and return ids + keys + popout label.
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
  const a = useTabsStore.getState().addTab(tab("a"));
  const b = useTabsStore.getState().addTab(tab("b"));
  const c = useTabsStore.getState().addTab(tab("c"));
  const rootGid = (useTabsStore.getState().layout as GroupNode).id;
  useTabsStore.getState().splitWithTab(a.key, rootGid, "right"); // G1=[b,c], new=[a]
  const root = useTabsStore.getState().layout as SplitNode;
  const left = root.children[0] as GroupNode; // [b,c]
  const right = root.children[1] as GroupNode; // [a]
  useTabsStore.getState().detachGroup(left.id); // detach [b,c]
  const entry = useTabsStore.getState().detachedGroupsByScope["p"][0];
  invokeMock.mockClear();
  emitMock.mockClear();
  return { a, b, c, g1: left.id, g2: right.id, label: entry.label };
}

function fileDrag(): TabDrag {
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

describe("commitFileDrop — dock a file INTO a popout", () => {
  beforeEach(() => openFileMock.mockClear());

  it("appends a new embed tab to the popout's subtree as its active tab", () => {
    const { b, c, g1 } = setup();
    commitFileDrop(fileDrag(), "p", "/p", null, { scope: "p", groupId: g1 });

    const det = useTabsStore.getState().detachedGroupsByScope["p"];
    expect(det).toHaveLength(1);
    const sub = det[0].subtree as GroupNode;
    const embed = useTabsStore.getState().tabs.find((t) => t.kind === "embed")!;
    expect(embed.label).toBe("notes.md");
    expect(embed.embedPath).toBe("/p/notes.md");
    // Docked at the end of the popout's bar and activated there.
    expect(sub.tabKeys).toEqual([b.key, c.key, embed.key]);
    expect(sub.activeKey).toBe(embed.key);
    // It never opens externally and spawns no new window.
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("re-seeds the popout with the docked key as landedKey", () => {
    const { label, g1 } = setup();
    commitFileDrop(fileDrag(), "p", "/p", null, { scope: "p", groupId: g1 });

    const embed = useTabsStore.getState().tabs.find((t) => t.kind === "embed")!;
    const seedCall = emitMock.mock.calls.find((c) => c[0] === detachedSeedEvent(label));
    expect(seedCall).toBeTruthy();
    const payload = seedCall![1] as { landedKey?: string; tabs: { key: string }[] };
    expect(payload.landedKey).toBe(embed.key);
    // The seed carries the popout's tabs including the freshly-docked embed.
    expect(payload.tabs.some((t) => t.key === embed.key)).toBe(true);
  });
});
