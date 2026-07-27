/**
 * SSH-sync Phase 1 — the frontend sync store. Locks that the manifest cache
 * indexes `sync_status` rows by path, that the actions invoke the matching
 * backend commands (and refresh afterwards), and that the `sync-progress` stream
 * updates the in-flight progress / refreshes on completion.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { useSyncStore, listenSyncProgress } from "../stores/sync";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

function reset() {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([] as never);
  useSyncStore.setState({ byProject: {}, progressByProject: {} });
}

describe("sync store actions", () => {
  beforeEach(reset);

  it("refreshStatus indexes rows by rel_path", async () => {
    invokeMock.mockResolvedValueOnce([
      { rel_path: "src/main.rs", is_dir: false, selected: true, state: "green" },
      { rel_path: "docs", is_dir: true, selected: true, state: "green" },
    ] as never);
    await useSyncStore.getState().refreshStatus("p1");
    const m = useSyncStore.getState().byProject["p1"];
    expect(m["src/main.rs"]).toEqual({ state: "green", selected: true, isDir: false });
    expect(m["docs"].isDir).toBe(true);
  });

  it("pull invokes sync_pull then refreshes status", async () => {
    await useSyncStore.getState().pull("p1", "src/lib.rs");
    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("sync_pull");
    expect(calls).toContain("sync_status");
    const pullArgs = invokeMock.mock.calls.find((c) => c[0] === "sync_pull")![1];
    expect(pullArgs).toEqual({ projectId: "p1", relPath: "src/lib.rs" });
  });

  it("markSelected forwards the selection + dir flag", async () => {
    await useSyncStore.getState().markSelected("p1", ["a", "b"], false, true);
    const args = invokeMock.mock.calls.find((c) => c[0] === "sync_mark_selected")![1];
    expect(args).toEqual({ projectId: "p1", relPaths: ["a", "b"], selected: false, isDir: true });
  });

  it("syncWholeProject and syncNow call their commands", async () => {
    await useSyncStore.getState().syncWholeProject("p1");
    await useSyncStore.getState().syncNow("p1");
    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("sync_whole_project");
    expect(calls).toContain("sync_now");
  });

  it("push forwards force + returns conflicts", async () => {
    invokeMock.mockResolvedValueOnce({ pushed: 1, conflicts: ["a.txt"] } as never);
    const res = await useSyncStore.getState().push("p1", "a.txt", false);
    expect(res).toEqual({ pushed: 1, conflicts: ["a.txt"] });
    const args = invokeMock.mock.calls.find((c) => c[0] === "sync_push")![1];
    expect(args).toEqual({ projectId: "p1", relPath: "a.txt", force: false });
    // It refreshes status afterwards.
    expect(invokeMock.mock.calls.some((c) => c[0] === "sync_status")).toBe(true);
  });
});

describe("sync-progress subscription", () => {
  beforeEach(() => {
    reset();
    listenMock.mockClear();
  });

  it("tracks in-flight progress and clears + refreshes on done", async () => {
    let handler: ((ev: { payload: unknown }) => void) | null = null;
    listenMock.mockImplementationOnce((_evt, cb) => {
      handler = cb as typeof handler;
      return Promise.resolve(() => {});
    });
    await listenSyncProgress();
    expect(handler).toBeTruthy();

    handler!({ payload: { project_id: "p1", phase: "file", rel_path: "a.txt", done: 1, total: 3 } });
    expect(useSyncStore.getState().progressByProject["p1"]).toEqual({ rel: "a.txt", done: 1, total: 3 });

    handler!({ payload: { project_id: "p1", phase: "done", rel_path: "", done: 3, total: 3 } });
    expect(useSyncStore.getState().progressByProject["p1"]).toBeNull();
    // The done event triggers a status refresh.
    expect(invokeMock.mock.calls.some((c) => c[0] === "sync_status")).toBe(true);
  });
});
