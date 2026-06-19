/**
 * Tests for the persistent script-run state (#34, Group R). The running-scripts
 * set and the `script-finished` clearing live in the activity store (not in
 * FileTree) so the run animation survives the right panel unmounting on hide.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useActivityStore } from "../stores/activity";

describe("activity store script-run state", () => {
  beforeEach(() => {
    invoke.mockReset();
    useActivityStore.setState({ runningScripts: new Set() });
  });

  it("marks a script running and spawns it detached with run_id = path", () => {
    invoke.mockResolvedValue(null);
    useActivityStore.getState().runScript("/proj/build.sh", "/proj");
    expect(useActivityStore.getState().runningScripts.has("/proj/build.sh")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("run_script_detached", {
      scriptPath: "/proj/build.sh",
      cwd: "/proj",
      runId: "/proj/build.sh",
    });
  });

  it("clears the running flag when the detached spawn fails", async () => {
    invoke.mockRejectedValue(new Error("spawn failed"));
    useActivityStore.getState().runScript("/proj/bad.sh", "/proj");
    expect(useActivityStore.getState().runningScripts.has("/proj/bad.sh")).toBe(true);
    await vi.waitFor(() =>
      expect(useActivityStore.getState().runningScripts.has("/proj/bad.sh")).toBe(false),
    );
  });
});
