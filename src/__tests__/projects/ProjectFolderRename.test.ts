import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../types";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  message: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: (...args: unknown[]) => mocks.message(...args),
}));

import { useProjectsStore } from "../../stores/projects";
import { useStopProjectStore } from "../../stores/stopProjectPrompt";
import { useTabsStore, type GroupNode, type TabEntry } from "../../stores/tabs";

const project = (id: string, status: string, position: number): ProjectEntry => ({
  id,
  name: id,
  status,
  position,
  local_file: `/p/${id}/project.json`,
  directory: `/p/${id}`,
});

const shell: TabEntry = { key: "shell-1", scope: "a", label: "Shell", cmd: "", cwd: "/p/a", kind: "shell" };
const layout: GroupNode = { type: "group", id: "g-a", tabKeys: [shell.key], activeKey: shell.key };

function answerStopPrompt(proceed: boolean) {
  useStopProjectStore.setState({ request: () => Promise.resolve(proceed) });
}

/** `rename_project_dir` answers with the re-pointed registry entry, as closed. */
function mockBackend() {
  mocks.invoke.mockImplementation((cmd: string, args?: { projectId: string; leaf: string }) => {
    if (cmd === "rename_project_dir" && args) {
      return Promise.resolve({
        ...project(args.projectId, "inactive", 0),
        directory: `/p/${args.leaf}`,
        local_file: `/p/${args.leaf}/project.json`,
      });
    }
    return Promise.resolve(undefined);
  });
}

const commands = () => mocks.invoke.mock.calls.map((call) => call[0] as string);
const entry = (id: string) => useProjectsStore.getState().projects.find((p) => p.id === id);

describe("renameProjectFolder", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mockBackend();
    mocks.message.mockReset();
    mocks.message.mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [project("a", "current", 0), project("b", "active", 1), project("c", "inactive", 2)],
      activeId: "a",
    });
    useTabsStore.setState({
      scope: "a",
      tabs: [shell],
      layout,
      focusedGroupId: layout.id,
      activeKey: shell.key,
      tabsByScope: { a: [shell] },
      layoutByScope: { a: layout },
      focusedGroupByScope: { a: layout.id },
      detachedGroupsByScope: {},
      hiddenGroupsByScope: {},
      pendingRespawnByScope: {},
    });
  });

  it("renames a closed project's folder without opening it", async () => {
    await useProjectsStore.getState().renameProjectFolder("c", "renamed");
    expect(mocks.invoke).toHaveBeenCalledWith("rename_project_dir", { projectId: "c", leaf: "renamed" });
    expect(commands()).not.toContain("pty_kill_scope");
    expect(entry("c")).toMatchObject({ directory: "/p/renamed", status: "inactive" });
    expect(useProjectsStore.getState().activeId).toBe("a");
  });

  it("closes an open project first, then reopens it as the current one", async () => {
    answerStopPrompt(true);
    await useProjectsStore.getState().renameProjectFolder("a", "renamed");
    const order = commands();
    // The terminals holding the old path are gone before the folder moves.
    expect(order.indexOf("pty_kill_scope")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("pty_kill_scope")).toBeLessThan(order.indexOf("rename_project_dir"));
    expect(entry("a")).toMatchObject({ directory: "/p/renamed", status: "current" });
    expect(useProjectsStore.getState().activeId).toBe("a");
  });

  it("renames nothing when the user keeps the project open", async () => {
    answerStopPrompt(false);
    await expect(useProjectsStore.getState().renameProjectFolder("a", "renamed")).rejects.toThrow();
    expect(commands()).not.toContain("rename_project_dir");
    expect(entry("a")).toMatchObject({ directory: "/p/a", status: "current" });
  });
});
