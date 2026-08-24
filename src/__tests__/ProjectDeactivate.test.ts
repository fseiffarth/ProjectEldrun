import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../types";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(),
  message: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...args: unknown[]) => mocks.confirm(...args),
  message: (...args: unknown[]) => mocks.message(...args),
}));

import { useProjectsStore } from "../stores/projects";
import { useTabsStore, type GroupNode, type TabEntry } from "../stores/tabs";

const project = (id: string, status: string, position: number): ProjectEntry => ({
  id,
  name: id,
  status,
  position,
  local_file: `/p/${id}/project.json`,
});

const shell: TabEntry = {
  key: "shell-1",
  scope: "a",
  label: "Shell",
  cmd: "",
  cwd: "/p/a",
  kind: "shell",
  tmuxAttach: "train",
};
const layout: GroupNode = {
  type: "group",
  id: "g-a",
  tabKeys: [shell.key],
  activeKey: shell.key,
};

describe("project deactivation", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
    mocks.confirm.mockReset();
    mocks.confirm.mockResolvedValue(true);
    mocks.message.mockReset();
    mocks.message.mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [project("a", "current", 0), project("b", "active", 1)],
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

  it("saves, stops tab-owned sessions and PTYs, switches, then unloads the scope", async () => {
    await useProjectsStore.getState().deactivateProject("a");

    expect(mocks.confirm).toHaveBeenCalledOnce();
    const commands = mocks.invoke.mock.calls.map((call) => call[0]);
    expect(commands.indexOf("save_tab_layout")).toBeLessThan(commands.indexOf("local_tmux_kill"));
    expect(commands.indexOf("local_tmux_kill")).toBeLessThan(commands.indexOf("pty_kill_scope"));
    expect(mocks.invoke).toHaveBeenCalledWith("local_tmux_kill", { session: "train" });
    expect(mocks.invoke).toHaveBeenCalledWith("pty_kill_scope", { scope: "a" });
    expect(useProjectsStore.getState().projects.find((p) => p.id === "a")?.status).toBe("inactive");
    expect(useProjectsStore.getState().activeId).toBe("b");
    expect(useTabsStore.getState().tabsByScope.a).toBeUndefined();
  });

  it("does not stop anything when confirmation is declined", async () => {
    mocks.confirm.mockResolvedValue(false);
    await useProjectsStore.getState().deactivateProject("a");
    expect(mocks.invoke).not.toHaveBeenCalledWith("pty_kill_scope", expect.anything());
    expect(useProjectsStore.getState().projects[0].status).toBe("current");
    expect(useTabsStore.getState().tabsByScope.a).toHaveLength(1);
  });

  it("aborts before termination when the strict layout save fails", async () => {
    mocks.invoke.mockImplementation((command: string) =>
      command === "save_tab_layout"
        ? Promise.reject(new Error("disk full"))
        : Promise.resolve(undefined),
    );
    await useProjectsStore.getState().deactivateProject("a");
    expect(mocks.invoke).not.toHaveBeenCalledWith("local_tmux_kill", expect.anything());
    expect(mocks.invoke).not.toHaveBeenCalledWith("pty_kill_scope", expect.anything());
    expect(useProjectsStore.getState().projects[0].status).toBe("current");
    expect(mocks.message).toHaveBeenCalledOnce();
  });

  it("reports a persistent-session failure without hiding the project", async () => {
    mocks.invoke.mockImplementation((command: string) =>
      command === "local_tmux_kill"
        ? Promise.reject(new Error("tmux failed"))
        : Promise.resolve(undefined),
    );
    await useProjectsStore.getState().deactivateProject("a");
    expect(mocks.invoke).not.toHaveBeenCalledWith("pty_kill_scope", expect.anything());
    expect(useProjectsStore.getState().projects[0].status).toBe("current");
    expect(useTabsStore.getState().tabsByScope.a).toHaveLength(1);
    expect(mocks.message).toHaveBeenCalledOnce();
  });
});
