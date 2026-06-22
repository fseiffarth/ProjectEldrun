/**
 * #42: detach / re-attach a tiling subwindow (group) in the tabs store.
 *
 * Covers: detach removes the group from `layoutByScope` and records it in
 * `detachedGroupsByScope` while keeping every tab payload in `tabsByScope`;
 * attach re-injects the group with regenerated ids; the lone group can't be
 * detached; save-side pruning (`withDetachedDocked`) re-docks detached tabs so
 * they persist; and the #55 owned-keys union keeps detached tabs scope-bound.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  useTabsStore,
  findGroup,
  allGroups,
  serializeTree,
  pruneSavedTree,
  withDetachedDocked,
  detachedTabKeys,
  isDetachedPtyId,
  type GroupNode,
  type SplitNode,
} from "../stores/tabs";

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

/** Find the (first) group node tagged `detached` in a serialized tree. */
function findDetachedGroup(
  tree: ReturnType<typeof serializeTree>,
): Extract<NonNullable<ReturnType<typeof serializeTree>>, { type: "group" }> | null {
  if (!tree) return null;
  if (tree.type === "group") return tree.detached ? tree : null;
  for (const c of tree.children) {
    const hit = findDetachedGroup(c);
    if (hit) return hit;
  }
  return null;
}

/** Build a 2-group row split [G(a), G(b)] and return the keys + group ids. */
function twoGroups() {
  const a = useTabsStore.getState().addTab(tab("a"));
  const b = useTabsStore.getState().addTab(tab("b"));
  const rootGid = (useTabsStore.getState().layout as GroupNode).id;
  useTabsStore.getState().splitWithTab(b.key, rootGid, "right");
  const root = useTabsStore.getState().layout as SplitNode;
  const left = root.children[0] as GroupNode; // [a]
  const right = root.children[1] as GroupNode; // [b]
  return { a, b, left, right };
}

describe("tabs store — detach / attach subwindow (#42)", () => {
  beforeEach(reset);

  it("detach removes the group from the layout but keeps its tab payloads", () => {
    const { a, b, right } = twoGroups();
    const label = useTabsStore.getState().detachGroup(right.id);
    expect(label).toBe(`detached-p-${right.id}`);

    const layout = useTabsStore.getState().layout as GroupNode;
    // Tree collapsed to the lone surviving group holding `a`.
    expect(layout.type).toBe("group");
    expect(layout.tabKeys).toEqual([a.key]);
    expect(findGroup(layout, right.id)).toBeNull();

    // The detached group is recorded; b's payload survives in tabsByScope.
    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    expect(detached).toHaveLength(1);
    expect(detached[0].id).toBe(right.id);
    expect(detached[0].subtree.tabKeys).toEqual([b.key]);
    expect(useTabsStore.getState().tabs.map((t) => t.key).sort()).toEqual(
      [a.key, b.key].sort(),
    );

    // The backend command fired exactly once with the right args. No restore
    // bounds for a fresh (user-initiated) detach, so geometry is null.
    expect(invokeMock).toHaveBeenCalledWith("detach_subwindow", {
      projectId: "p",
      groupId: right.id,
      x: null,
      y: null,
      width: null,
      height: null,
    });
  });

  it("flags a detached group's PTY ids so the main pane's unmount skips pty_kill", () => {
    const { b, right } = twoGroups();
    const ptyId = `p:${b.key}`;
    // Before detach the PTY is owned by the main pane → killable on unmount.
    expect(isDetachedPtyId(ptyId)).toBe(false);

    useTabsStore.getState().detachGroup(right.id);
    // Once detached, the main pane unmounts but must NOT kill the PTY — the
    // popped-out attach-only viewer is now reading it.
    expect(isDetachedPtyId(ptyId)).toBe(true);
    // A different/unknown id is unaffected; a malformed id (no scope) is false.
    expect(isDetachedPtyId("p:other")).toBe(false);
    expect(isDetachedPtyId("nocolon")).toBe(false);
  });

  it("refuses to detach the lone group", () => {
    const a = useTabsStore.getState().addTab(tab("a"));
    const gid = (useTabsStore.getState().layout as GroupNode).id;
    const label = useTabsStore.getState().detachGroup(gid);
    expect(label).toBeNull();
    // Layout untouched; nothing detached; no backend call.
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.tabKeys).toEqual([a.key]);
    expect(useTabsStore.getState().detachedGroupsByScope["p"] ?? []).toHaveLength(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("attach re-injects the group with regenerated ids and clears the entry", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id);
    invokeMock.mockClear();

    useTabsStore.getState().attachGroup(right.id, { edge: "right" });

    const layout = useTabsStore.getState().layout as SplitNode;
    expect(layout.type).toBe("split");
    const groups = allGroups(layout);
    const keys = groups.flatMap((g) => g.tabKeys).sort();
    expect(keys).toEqual([a.key, b.key].sort());
    // The re-docked group's node id was regenerated (not the old right.id).
    expect(findGroup(layout, right.id)).toBeNull();
    // The detached entry is gone.
    expect(useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("attach_subwindow", {
      registryId: `detached-p-${right.id}`,
    });
  });

  it("attach installs as root when the in-window tree emptied while detached", () => {
    const { a, b, left, right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id, { skipBackend: true });
    // Close the remaining in-window group's tab, emptying the layout.
    useTabsStore.getState().removeTab(a.key);
    expect(useTabsStore.getState().layout).toBeNull();
    void left;

    useTabsStore.getState().attachGroup(right.id, { skipBackend: true });
    const layout = useTabsStore.getState().layout as GroupNode;
    expect(layout.type).toBe("group");
    expect(layout.tabKeys).toEqual([b.key]);
  });

  it("skipBackend suppresses the IPC call (used by message-passed re-dock)", () => {
    const { right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id, { skipBackend: true });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("withDetachedDocked re-docks detached groups for persistence", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id, { skipBackend: true });

    const layout = useTabsStore.getState().layout;
    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    const merged = withDetachedDocked(serializeTree(layout), detached);
    // The persisted tree must contain BOTH a's docked group and the detached
    // group's tabs — so a restart restores the detached group as docked.
    const persistedKeys = collectSavedKeys(merged);
    expect(persistedKeys.sort()).toEqual([a.key, b.key].sort());

    // The #55 owned-keys union counts detached tabs as owned.
    expect(detachedTabKeys(detached)).toEqual([b.key]);
  });

  it("save-side pruning keeps a detached group's restorable tabs", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id, { skipBackend: true });
    const layout = useTabsStore.getState().layout;
    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    const merged = withDetachedDocked(serializeTree(layout), detached);
    // Both shells are restorable → both keys survive pruning.
    const keep = new Set([a.key, b.key]);
    const pruned = pruneSavedTree(merged, keep);
    expect(collectSavedKeys(pruned).sort()).toEqual([a.key, b.key].sort());
  });

  it("withDetachedDocked tags the detached group with its bounds for respawn", () => {
    const { right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id, { skipBackend: true });
    useTabsStore.getState().setDetachedBounds("p", right.id, { x: 10, y: 20, w: 800, h: 600 });
    const layout = useTabsStore.getState().layout;
    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    const merged = withDetachedDocked(serializeTree(layout), detached);
    const tagged = findDetachedGroup(merged);
    expect(tagged).not.toBeNull();
    expect(tagged?.bounds).toEqual({ x: 10, y: 20, w: 800, h: 600 });
  });

  it("loadFromLayout restores a detached group docked + queues it for respawn", () => {
    const { a, b, right } = twoGroups();
    useTabsStore.getState().detachGroup(right.id, { skipBackend: true });
    useTabsStore.getState().setDetachedBounds("p", right.id, { x: 5, y: 6, w: 700, h: 500 });
    const layout = useTabsStore.getState().layout;
    const detached = useTabsStore.getState().detachedGroupsByScope["p"];
    const groups = withDetachedDocked(serializeTree(layout), detached);
    const savedTabs = useTabsStore.getState().tabs.map((t) => ({
      key: t.key,
      label: t.label,
      cmd: t.cmd,
      cwd: t.cwd,
      kind: t.kind,
    }));
    void a;
    void b;

    // Simulate a restart: fresh store, load the persisted layout into a scope.
    reset();
    useTabsStore.getState().loadFromLayout(savedTabs, "/p", "p2", groups ?? undefined);

    // Both groups come back DOCKED so their panes mount + spawn PTYs first.
    const restored = allGroups(useTabsStore.getState().layoutByScope["p2"]);
    expect(restored.length).toBe(2);
    // Exactly one is queued for respawn, carrying its persisted bounds, and its
    // id matches a live group in the restored layout.
    const pending = useTabsStore.getState().consumePendingRespawn("p2");
    expect(pending.length).toBe(1);
    expect(pending[0].bounds).toEqual({ x: 5, y: 6, w: 700, h: 500 });
    expect(restored.some((g) => g.id === pending[0].id)).toBe(true);
    // Draining is idempotent.
    expect(useTabsStore.getState().consumePendingRespawn("p2")).toEqual([]);
  });

  it("withDetachedDocked returns the in-window tree unchanged with no detached groups", () => {
    const { a } = twoGroups();
    void a;
    const layout = serializeTree(useTabsStore.getState().layout);
    expect(withDetachedDocked(layout, [])).toBe(layout);
    expect(withDetachedDocked(layout, undefined)).toBe(layout);
  });
});

/** Flatten every tabKey referenced by a serialized layout tree. */
function collectSavedKeys(
  tree: ReturnType<typeof serializeTree>,
): string[] {
  if (!tree) return [];
  if (tree.type === "group") return [...tree.tabKeys];
  return tree.children.flatMap(collectSavedKeys);
}
