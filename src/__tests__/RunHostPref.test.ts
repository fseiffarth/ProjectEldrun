/**
 * The per-project run-host preference (`stores/runHostPref`): the live cache
 * updates on the click and the disk write is fire-and-forget, and a reload's
 * `seed` never clobbers a choice made this session — the two can only differ
 * if the user just changed it before the reload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { useRunHostPrefStore } from "../stores/runHostPref";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined as never);
  useRunHostPrefStore.setState({ byProject: {} });
});

describe("set", () => {
  it("updates the cache at once and writes through to the project", () => {
    useRunHostPrefStore.getState().set("p1", "host:w-gpu");
    expect(useRunHostPrefStore.getState().byProject).toEqual({ p1: "host:w-gpu" });
    expect(invokeMock).toHaveBeenCalledWith("set_project_run_host", {
      projectId: "p1",
      location: "host:w-gpu",
    });
  });

  it("keeps the choice when the disk write fails — never worth blocking the run", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("read-only fs"));
    useRunHostPrefStore.getState().set("p1", "remote");
    await new Promise((r) => setTimeout(r, 0));
    expect(useRunHostPrefStore.getState().byProject.p1).toBe("remote");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("seed", () => {
  it("hydrates persisted choices, skipping projects with none", () => {
    useRunHostPrefStore.getState().seed([
      { projectId: "p1", location: "remote" },
      { projectId: "p2", location: undefined },
      { projectId: "p3", location: "local" },
    ]);
    expect(useRunHostPrefStore.getState().byProject).toEqual({ p1: "remote", p3: "local" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("never overwrites a choice already made this session", () => {
    useRunHostPrefStore.getState().set("p1", "host:w-gpu");
    useRunHostPrefStore.getState().seed([{ projectId: "p1", location: "remote" }]);
    expect(useRunHostPrefStore.getState().byProject.p1).toBe("host:w-gpu");
  });

  it("is safe to call on every projects reload", () => {
    useRunHostPrefStore.getState().seed([{ projectId: "p1", location: "remote" }]);
    useRunHostPrefStore.getState().seed([{ projectId: "p1", location: "remote" }]);
    useRunHostPrefStore.getState().seed([]);
    expect(useRunHostPrefStore.getState().byProject).toEqual({ p1: "remote" });
  });
});
