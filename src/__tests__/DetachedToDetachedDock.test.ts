/**
 * #42 (bug 4): move a tab from one open popout INTO another open popout of the
 * same scope — the store side of the "attach a detached-window tab to another
 * detached window" fix. `moveTabBetweenDetached` strips the tab from the source
 * popout's subtree, places it in the destination's, keeps the payload (and thus
 * the main-owned PTY) alive, and closes the source's OS window when it empties.
 *
 * This is the authority the host (`CenterPanel`'s `DETACHED_DRAG_END`) commits
 * into for a `dockDetached` decision; if these pass, a runtime "popout→popout
 * drag opens a stray new window" report is in the pointer/event layer, not here.
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

/**
 * Build a keep-alive in-window group plus a SRC popout `[x, y]` and a DST popout
 * `[z]`. The keep-alive group is required so detaching both others is allowed
 * (`detachGroup` refuses the lone group). Returns the popout record ids + keys.
 */
function twoPopoutsSrcHasTwo() {
  const keep = s().addTab(tab("keep"));
  const x = s().addTab(tab("x"));
  const y = s().addTab(tab("y"));
  const z = s().addTab(tab("z"));
  const rootGid = gid(keep.key);
  s().splitWithTab(z.key, rootGid, "right"); // DST group = [z]
  s().splitWithTab(x.key, rootGid, "bottom"); // [x] alone
  s().moveTab(y.key, gid(x.key)); // SRC group = [x, y]
  const srcId = gid(x.key);
  const dstId = gid(z.key);
  const srcLabel = s().detachGroup(srcId, { skipBackend: true })!;
  s().detachGroup(dstId, { skipBackend: true });
  invokeMock.mockClear();
  return { keep, x, y, z, srcId, dstId, srcLabel };
}

/** Same, but the SRC popout holds a single tab `[x]` (so a move empties it). */
function twoPopoutsSrcHasOne() {
  const keep = s().addTab(tab("keep"));
  const x = s().addTab(tab("x"));
  const z = s().addTab(tab("z"));
  const rootGid = gid(keep.key);
  s().splitWithTab(z.key, rootGid, "right"); // DST = [z]
  s().splitWithTab(x.key, rootGid, "bottom"); // SRC = [x]
  const srcId = gid(x.key);
  const dstId = gid(z.key);
  const srcLabel = s().detachGroup(srcId, { skipBackend: true })!;
  s().detachGroup(dstId, { skipBackend: true });
  invokeMock.mockClear();
  return { keep, x, z, srcId, dstId, srcLabel };
}

describe("tabs store — move a tab between two detached popouts (#42)", () => {
  beforeEach(reset);

  it("moves the tab into the sibling popout; the source shrinks but survives", () => {
    const { keep, x, y, z, srcId, dstId } = twoPopoutsSrcHasTwo();

    s().moveTabBetweenDetached("p", srcId, dstId, x.key);

    // Source popout still open, now holding only y; destination holds z + x.
    expect(orderedTabKeys(entry(srcId)!.subtree)).toEqual([y.key]);
    expect(orderedTabKeys(entry(dstId)!.subtree).sort()).toEqual([z.key, x.key].sort());
    // Every payload survives (the shared, main-owned PTYs never die).
    expect(s().tabsByScope["p"].map((t) => t.key).sort()).toEqual(
      [keep.key, x.key, y.key, z.key].sort(),
    );
    // The source wasn't emptied → no OS-window teardown.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("closes the source popout's OS window when the move empties it", () => {
    const { x, z, srcId, dstId, srcLabel } = twoPopoutsSrcHasOne();

    s().moveTabBetweenDetached("p", srcId, dstId, x.key);

    // Source record dropped; destination holds z + x.
    expect(entry(srcId)).toBeUndefined();
    expect(s().detachedGroupsByScope["p"]).toHaveLength(1);
    expect(orderedTabKeys(entry(dstId)!.subtree).sort()).toEqual([z.key, x.key].sort());
    // The emptied popout's OS window is closed via attach_subwindow.
    expect(invokeMock).toHaveBeenCalledWith("attach_subwindow", { registryId: srcLabel });
  });

  it("skipBackend suppresses the OS-window teardown on empty", () => {
    const { x, srcId, dstId } = twoPopoutsSrcHasOne();

    s().moveTabBetweenDetached("p", srcId, dstId, x.key, undefined, { skipBackend: true });

    expect(entry(srcId)).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("no-ops (no state change, no backend call) on illegal moves", () => {
    const { x, srcId, dstId } = twoPopoutsSrcHasTwo();
    const snapshot = JSON.stringify(s().detachedGroupsByScope["p"]);

    s().moveTabBetweenDetached("p", srcId, dstId, "nope"); // tab absent from source
    s().moveTabBetweenDetached("p", "ghost", dstId, x.key); // source popout gone
    s().moveTabBetweenDetached("p", srcId, "ghost", x.key); // dest popout gone
    s().moveTabBetweenDetached("p", srcId, srcId, x.key); // src === dst

    expect(JSON.stringify(s().detachedGroupsByScope["p"])).toBe(snapshot);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
