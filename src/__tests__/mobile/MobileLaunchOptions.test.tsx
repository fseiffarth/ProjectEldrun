/**
 * The phone's ＋ asks the desktop what it can start an agent *in*: a project's
 * linked worktrees (opaque ids, never a path) and its agents' cloud launches.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import type { ProjectEntry, Settings } from "../../types";

const paper: ProjectEntry = {
  id: "p-paper",
  name: "Paper",
  status: "active",
  position: 1,
  local_file: "/projects/paper/project.json",
  directory: "/projects/paper",
  eldrun_mobile_access: true,
};

const worktree = (path: string, branch: string, isMain: boolean) => ({
  path, branch, head: "abc", is_main: isMain, is_locked: false, lock_reason: "",
  is_prunable: false, prunable_reason: "", is_bare: false, is_current: isMain,
});

async function ask(request: Record<string, unknown>) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === "eldrun-mobile-desktop-request");
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  const invokeMock = vi.mocked(invoke);
  invokeMock.mockClear();
  deliver({ payload: request });
  await vi.waitFor(() => expect(invokeMock.mock.calls.some(
    ([command]) => command === "mobile_desktop_respond",
  )).toBe(true));
  const call = invokeMock.mock.calls.find(([command]) => command === "mobile_desktop_respond");
  return (call?.[1] as { response: Record<string, unknown> }).response;
}

describe("Mobile bridge — launch options", () => {
  beforeEach(async () => {
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      if (command === "list_agents") {
        return Promise.resolve([
          { bin: "claude", installed: true },
          { bin: "gemini", installed: true },
        ]);
      }
      if (command === "git_worktree_list") {
        return Promise.resolve([
          worktree("/projects/paper", "develop", true),
          worktree("/projects/paper/.eldrun/worktrees/fix", "fix-build", false),
        ]);
      }
      if (command === "mobile_opaque_id") {
        const { domain, value } = args as { domain: string; value: string };
        return Promise.resolve(`${domain}-${value.length}`);
      }
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [paper], activeId: paper.id, loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
  });

  it("names worktrees by opaque id and branch, and lists only the agents' cloud launches", async () => {
    const response = await ask({ type: "launch_options", request_id: "l1", project_id: paper.id });
    expect(response.status).toBe("launch_options");
    expect(response.worktrees).toEqual([
      { id: "worktree-15", label: "", branch: "develop", main: true },
      { id: "worktree-37", label: "fix", branch: "fix-build", main: false },
    ]);
    expect(JSON.stringify(response)).not.toContain("/projects/paper");
    expect(response.cloud).toEqual([
      { agent_id: "agent-6", action: "new", task: true },
      { agent_id: "agent-6", action: "open", task: false },
    ]);
  });

  it("refuses a project the phone may not reach", async () => {
    const response = await ask({ type: "launch_options", request_id: "l2", project_id: "p-other" });
    expect(response).toMatchObject({ status: "error", code: "project_ineligible" });
  });
});
