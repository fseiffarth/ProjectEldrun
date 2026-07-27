/**
 * #42 (bug 1): Shift-dropping a tab out of a popout must pop it into its OWN new
 * window. For a MULTI-tab popout that spawns a fresh single-tab popout; for a
 * LONE-tab popout it must be a clean no-op (the source is already its own window),
 * never the old local-split + Shift-bail hang.
 *
 * The host's `newWindow` branch (`decideDetachedTabDrop` → this action) commits
 * into `detachTabToNewWindow`; this pins its two outcomes directly.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { useTabsStore, allGroups, orderedTabKeys } from "../stores/tabs";

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

const s = () => useTabsStore.getState();
const gid = (key: string) => allGroups(s().layout).find((g) => g.tabKeys.includes(key))!.id;
const entry = (id: string) => s().detachedGroupsByScope["p"].find((d) => d.id === id);

describe("tabs store — Shift-pop a popout tab into a new window (#42)", () => {
  beforeEach(reset);

  it("multi-tab popout: pops the tab into a fresh single-tab popout, source shrinks", () => {
    const keep = s().addTab(tab("keep"));
    const x = s().addTab(tab("x"));
    const y = s().addTab(tab("y"));
    const rootGid = gid(keep.key);
    s().splitWithTab(x.key, rootGid, "right"); // [x] alone
    s().moveTab(y.key, gid(x.key)); // SRC popout content = [x, y]
    const srcId = gid(x.key);
    s().detachGroup(srcId, { skipBackend: true });
    invokeMock.mockClear();

    const label = s().detachTabToNewWindow("p", srcId, x.key, { x: 10, y: 20, w: 900, h: 640 });

    expect(label).toBeTruthy();
    // Source popout shrinks to just y; a new detached record holds x alone.
    expect(orderedTabKeys(entry(srcId)!.subtree)).toEqual([y.key]);
    const fresh = s().detachedGroupsByScope["p"].find((d) => d.label === label)!;
    expect(orderedTabKeys(fresh.subtree)).toEqual([x.key]);
    // The new OS window is spawned; the payload stays shared (PTY survives).
    expect(invokeMock).toHaveBeenCalledWith(
      "detach_subwindow",
      expect.objectContaining({ projectId: "p", groupId: expect.any(String) }),
    );
    expect(s().tabsByScope["p"].map((t) => t.key).sort()).toEqual(
      [keep.key, x.key, y.key].sort(),
    );
  });

  it("lone-tab popout: no-op (no new record, no window) — the no-hang guarantee", () => {
    const keep = s().addTab(tab("keep"));
    const x = s().addTab(tab("x"));
    const rootGid = gid(keep.key);
    s().splitWithTab(x.key, rootGid, "right"); // SRC popout content = [x]
    const srcId = gid(x.key);
    s().detachGroup(srcId, { skipBackend: true });
    invokeMock.mockClear();
    const before = s().detachedGroupsByScope["p"].length;

    const label = s().detachTabToNewWindow("p", srcId, x.key, { x: 0, y: 0, w: 900, h: 640 });

    expect(label).toBeNull();
    expect(s().detachedGroupsByScope["p"]).toHaveLength(before);
    expect(orderedTabKeys(entry(srcId)!.subtree)).toEqual([x.key]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
