/**
 * The desktop's side of the workspace service (headless owner plan, H1/H3):
 * a sync answer hands this window the ids of the tabs it created, the new
 * version, and what another client changed meanwhile — a label or colour the
 * service kept over this window's older copy, and a close it never saw.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { invoke } from "@tauri-apps/api/core";
import { adoptSyncOutcome, applyWorkspacePatch, refreshWorkspaceScope, useTabsStore, type TabEntry } from "../../stores/tabs";

function tab(key: string, label: string, id?: string): TabEntry {
  return { key, id, label, cmd: "", cwd: "/tmp", kind: "shell", scope: "p" };
}

describe("adoptSyncOutcome", () => {
  beforeEach(() => {
    useTabsStore.setState({
      scope: "p",
      tabsByScope: { p: [tab("k1", "A", "id-a"), tab("k2", "B", "id-b"), tab("k3", "C")] },
      tabs: [tab("k1", "A", "id-a"), tab("k2", "B", "id-b"), tab("k3", "C")],
      layoutByScope: { p: { type: "group", id: "g", tabKeys: ["k1", "k2", "k3"], activeKey: "k1" } },
      focusedGroupByScope: { p: "g" },
      detachedGroupsByScope: {},
      hiddenGroupsByScope: {},
      workspaceVersionByScope: { p: 3 },
    });
  });

  it("records the version, adopts minted ids, takes a newer label and colour, and drops a tab closed elsewhere", () => {
    adoptSyncOutcome(
      "p",
      {
        version: 7,
        stale: true,
        ops: [],
        tabs: [
          { key: "k1", id: "id-a", label: "From the phone", cmd: "", cwd: "/tmp", kind: "shell", color: "teal" },
          { key: "k3", id: "id-c", label: "C", cmd: "", cwd: "/tmp", kind: "shell" },
        ],
      },
      new Set(["k1", "k2", "k3"]),
    );
    const state = useTabsStore.getState();
    expect(state.workspaceVersionByScope.p).toBe(7);
    const byKey = Object.fromEntries(state.tabsByScope.p.map((t) => [t.key, t]));
    expect(byKey.k1.label).toBe("From the phone");
    expect(byKey.k1.color).toBe("teal");
    expect(byKey.k3.id).toBe("id-c");
    expect(byKey.k2).toBeUndefined();
    // The flat mirror and the layout tree followed the close.
    expect(state.tabs.map((t) => t.key)).toEqual(["k1", "k3"]);
    const layout = state.layoutByScope.p;
    expect(layout && layout.type === "group" ? layout.tabKeys : []).toEqual(["k1", "k3"]);
  });

  it("adds a tab another client created after this window's base, without stealing the active tab (H3)", () => {
    adoptSyncOutcome(
      "p",
      {
        version: 9,
        stale: true,
        ops: [{ op: "created", id: "id-new" }],
        tabs: [
          { key: "k1", id: "id-a", label: "A", cmd: "", cwd: "/tmp", kind: "shell" },
          { key: "k2", id: "id-b", label: "B", cmd: "", cwd: "/tmp", kind: "shell" },
          { key: "k3", id: "id-c", label: "C", cmd: "", cwd: "/tmp", kind: "shell" },
          // Created at version 5, after this window's base of 3: a phone's ＋
          // through the owner. It keeps the owner's tmux name and session id.
          { key: "headless-1", id: "id-new", label: "Claude", cmd: "claude", cwd: "/work", kind: "agent", sessionId: "uid-1", tmuxSession: "eldrun-p--agent-x", createdVersion: 5 },
          // Created at version 2, before the base: something this window
          // closed and has not persisted yet — never resurrected.
          { key: "old", id: "id-old", label: "Old", cmd: "", cwd: "/tmp", kind: "shell", createdVersion: 2 },
        ],
      },
      new Set(["k1", "k2", "k3"]),
    );
    const state = useTabsStore.getState();
    expect(state.tabsByScope.p.map((t) => t.label)).toEqual(["A", "B", "C", "Claude"]);
    const added = state.tabsByScope.p[3];
    expect(added.id).toBe("id-new");
    expect(added.key).not.toBe("headless-1");
    expect(added.tmuxSession).toBe("eldrun-p--agent-x");
    expect(added.sessionId).toBe("uid-1");
    expect(added.args).toEqual(["--resume", "uid-1"]);
    expect(added.scope).toBe("p");
    const layout = state.layoutByScope.p;
    expect(layout && layout.type === "group" ? layout.tabKeys : []).toEqual(["k1", "k2", "k3", added.key]);
    expect(layout && layout.type === "group" ? layout.activeKey : null).toBe("k1");
    expect(state.tabs.map((t) => t.key)).toContain(added.key);
    expect(state.workspaceVersionByScope.p).toBe(9);
  });

  it("never closes a tab this window did not send, and ignores a colour outside the palette", () => {
    adoptSyncOutcome(
      "p",
      { version: 4, stale: false, ops: [], tabs: [{ key: "k1", id: "id-a", label: "A", cmd: "", cwd: "/tmp", kind: "shell", color: "not-a-colour" as never }] },
      new Set(["k1"]),
    );
    const state = useTabsStore.getState();
    expect(state.tabsByScope.p.map((t) => t.key)).toEqual(["k1", "k2", "k3"]);
    expect(state.tabsByScope.p[0].color).toBeUndefined();
    expect(state.workspaceVersionByScope.p).toBe(4);
  });
});

describe("applyWorkspacePatch", () => {
  const seed = () =>
    useTabsStore.setState({
      scope: "p",
      tabsByScope: { p: [tab("k1", "A", "id-a"), tab("k2", "B", "id-b")] },
      tabs: [tab("k1", "A", "id-a"), tab("k2", "B", "id-b")],
      layoutByScope: { p: { type: "group", id: "g", tabKeys: ["k1", "k2"], activeKey: "k1" } },
      focusedGroupByScope: { p: "g" },
      detachedGroupsByScope: {},
      hiddenGroupsByScope: {},
      workspaceVersionByScope: { p: 3 },
    });

  beforeEach(() => {
    seed();
    vi.mocked(invoke).mockReset();
  });

  it("fetches the snapshot for a newer version and reconciles every tab this window holds", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      version: 5,
      tabLayout: [{ key: "x", id: "id-a", label: "Renamed elsewhere", cmd: "", cwd: "/tmp", kind: "shell" }],
    });
    await applyWorkspacePatch({ scope: "p", version: 5, ops: [{ op: "updated", id: "id-a" }, { op: "closed", id: "id-b" }] });
    expect(invoke).toHaveBeenCalledWith("workspace_snapshot", { projectId: "p" });
    const state = useTabsStore.getState();
    expect(state.workspaceVersionByScope.p).toBe(5);
    expect(state.tabsByScope.p.map((t) => [t.key, t.label])).toEqual([["k1", "Renamed elsewhere"]]);
  });

  it("refreshWorkspaceScope re-reads a loaded scope when the file moved on (the sidecar's poke)", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      version: 6,
      tabLayout: [
        { key: "x", id: "id-a", label: "A", cmd: "", cwd: "/tmp", kind: "shell" },
        { key: "y", id: "id-b", label: "B", cmd: "", cwd: "/tmp", kind: "shell" },
        { key: "z", id: "id-new", label: "Shell", cmd: "", cwd: "/tmp", kind: "shell", tmuxSession: "eldrun-p--shell-1", createdVersion: 6 },
      ],
    });
    await refreshWorkspaceScope("p");
    expect(invoke).toHaveBeenCalledWith("workspace_snapshot", { projectId: "p" });
    expect(useTabsStore.getState().tabsByScope.p.map((t) => t.label)).toEqual(["A", "B", "Shell"]);
    expect(useTabsStore.getState().workspaceVersionByScope.p).toBe(6);
    await refreshWorkspaceScope("other");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("ignores a patch this window already knows, or for a scope it has not loaded", async () => {
    await applyWorkspacePatch({ scope: "p", version: 3, ops: [{ op: "reordered" }] });
    await applyWorkspacePatch({ scope: "other", version: 9, ops: [{ op: "reordered" }] });
    expect(invoke).not.toHaveBeenCalled();
    expect(useTabsStore.getState().tabsByScope.p.map((t) => t.key)).toEqual(["k1", "k2"]);
  });
});
