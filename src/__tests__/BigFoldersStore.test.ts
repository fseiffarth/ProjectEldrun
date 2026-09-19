/**
 * The giant-folder prompt's store (`stores/bigFolders`): a once-per-project
 * latch for the unasked setup question, an explicit project id that survives a
 * switch, and — Group B #233 — a popout forwarding the open to the main window
 * instead of flipping a store nobody in its window renders.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const emitMock = vi.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve());
vi.mock("@tauri-apps/api/event", () => ({ emit: (...a: unknown[]) => emitMock(...a) }));

import { useBigFoldersStore } from "../stores/bigFolders";
import { setDetachedWindowContext, type DetachedWindowContext } from "../stores/detachedContext";

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
  useBigFoldersStore.setState({ projectId: null, askedProjects: new Set() });
});

describe("openOnce", () => {
  it("asks a project exactly once per session, then stays quiet", () => {
    const s = useBigFoldersStore.getState();
    s.openOnce("p1");
    expect(useBigFoldersStore.getState().projectId).toBe("p1");
    s.close();
    s.openOnce("p1");
    expect(useBigFoldersStore.getState().projectId).toBeNull();
    // Another project is a fresh question.
    s.openOnce("p2");
    expect(useBigFoldersStore.getState().projectId).toBe("p2");
  });

  it("counts a manual open as having asked", () => {
    useBigFoldersStore.getState().open("p1");
    useBigFoldersStore.getState().close();
    useBigFoldersStore.getState().openOnce("p1");
    expect(useBigFoldersStore.getState().projectId).toBeNull();
  });
});

describe("open", () => {
  it("keeps asking about the project it measured, not the active one", () => {
    useBigFoldersStore.getState().open("p1");
    useBigFoldersStore.getState().open("p2"); // a later, explicit open retargets
    expect(useBigFoldersStore.getState().projectId).toBe("p2");
    expect([...useBigFoldersStore.getState().askedProjects]).toEqual(["p1", "p2"]);
  });

  it("forwards to the main window from a popout instead of flipping a dead store", () => {
    setDetachedWindowContext(popout);
    useBigFoldersStore.getState().open("p1");
    expect(emitMock).toHaveBeenCalledWith("detached-open-dialog", { kind: "bigFolders", projectId: "p1" });
    expect(useBigFoldersStore.getState().projectId).toBeNull();
    expect(useBigFoldersStore.getState().askedProjects.size).toBe(0);
  });
});
