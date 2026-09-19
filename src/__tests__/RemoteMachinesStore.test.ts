/**
 * The Remote-machines manager's store (`stores/remote/remoteMachines`): keyed by an
 * explicit project id so a project switch never retargets an open manager, a
 * machine handoff seeded into `pendingDrop` (remote project) or `extendTarget`
 * (local project), and — Group B #233 — a popout forwarding the open.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const emitMock = vi.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve());
vi.mock("@tauri-apps/api/event", () => ({ emit: (...a: unknown[]) => emitMock(...a) }));

import { useRemoteMachinesStore } from "../stores/remote/remoteMachines";
import { setDetachedWindowContext, type DetachedWindowContext } from "../stores/detachedContext";

const machine = { id: "m1", host: "gpu.example.org", user: "alice", port: 22, label: "gpu" };
const popout: DetachedWindowContext = {
  scope: "p1",
  groupId: "g1",
  label: "detached-p1-g1",
  targetGroupId: () => "g1",
  pushEdit: () => {},
  closeTab: () => {},
};

beforeEach(() => {
  emitMock.mockClear();
  setDetachedWindowContext(null);
  useRemoteMachinesStore.setState({ projectId: null, pendingDrop: null, extendTarget: null });
});

describe("open / close", () => {
  it("opens on an explicit project, with or without a machine to confirm", () => {
    useRemoteMachinesStore.getState().open("p1");
    expect(useRemoteMachinesStore.getState()).toMatchObject({ projectId: "p1", pendingDrop: null });
    useRemoteMachinesStore.getState().open("p2", machine);
    expect(useRemoteMachinesStore.getState()).toMatchObject({ projectId: "p2", pendingDrop: machine });
  });

  it("re-opening without a machine drops a stale pending one", () => {
    useRemoteMachinesStore.getState().open("p1", machine);
    useRemoteMachinesStore.getState().open("p1");
    expect(useRemoteMachinesStore.getState().pendingDrop).toBeNull();
  });

  it("close clears the project and its pending machine, but not a local-project extend", () => {
    useRemoteMachinesStore.getState().requestExtend("p3", machine);
    useRemoteMachinesStore.getState().open("p1", machine);
    useRemoteMachinesStore.getState().close();
    expect(useRemoteMachinesStore.getState()).toMatchObject({ projectId: null, pendingDrop: null });
    expect(useRemoteMachinesStore.getState().extendTarget).toEqual({ projectId: "p3", machine });
    useRemoteMachinesStore.getState().clearExtend();
    expect(useRemoteMachinesStore.getState().extendTarget).toBeNull();
  });

  it("forwards an open from a popout to the main window", () => {
    setDetachedWindowContext(popout);
    useRemoteMachinesStore.getState().open("p1", machine);
    expect(emitMock).toHaveBeenCalledWith("detached-open-dialog", {
      kind: "remoteMachines",
      projectId: "p1",
    });
    expect(useRemoteMachinesStore.getState().projectId).toBeNull();
  });
});
