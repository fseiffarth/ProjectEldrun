/**
 * Regression tests for agent-tab path contamination across projects.
 *
 * Root cause: loadFromLayout() in projects.ts was called without targetScope.
 * When switch_project_runtime resolved after the user had already switched to a
 * different project, the returned tabs were written into whatever scope was
 * active at resolution time — so e.g. ExampleOne's scope could receive ExampleTwo's
 * layout (or vice versa), and the agent tab's cwd would be wrong.
 *
 * Fix: always pass targetScope so the write goes to the intended scope bucket
 * regardless of the current active scope.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useTabsStore } from "../stores/tabs";

describe("loadFromLayout — scope isolation", () => {
  beforeEach(() => {
    // Merge-reset the data fields only so function implementations are preserved.
    useTabsStore.setState({
      scope: "project-a",
      tabsByScope: {},
      activeKeyByScope: {},
      tabs: [],
      activeKey: null,
    });
  });

  it("writes to targetScope even when current scope differs", () => {
    const layout = [
      { key: "agent-1", label: "claude", cmd: "claude", cwd: "/stale", kind: "agent" as const },
    ];

    useTabsStore.getState().loadFromLayout(layout, "/project-b-dir", "project-b");

    const state = useTabsStore.getState();
    expect(state.tabsByScope["project-b"]).toHaveLength(1);
    expect(state.tabsByScope["project-a"]).toBeFalsy();
    // flat shortcuts are NOT updated (current scope is still project-a)
    expect(state.tabs).toHaveLength(0);
    expect(state.activeKey).toBeNull();
  });

  it("agent tab cwd is always replaced by defaultCwd, never the saved cwd", () => {
    const layout = [
      { key: "agent-2", label: "claude", cmd: "claude", cwd: "/example-one", kind: "agent" as const },
    ];

    useTabsStore.getState().loadFromLayout(layout, "/example-two", "project-example");

    const tab = useTabsStore.getState().tabsByScope["project-example"]?.[0];
    expect(tab?.cwd).toBe("/example-two");
    expect(tab?.cwd).not.toContain("example-one");
  });

  it("shell tab cwd is kept from layout (only agents are overridden)", () => {
    const layout = [
      { key: "shell-1", label: "bash", cmd: "bash", cwd: "/some/shell/dir", kind: "shell" as const },
    ];

    useTabsStore.getState().loadFromLayout(layout, "/project-dir", "project-x");

    const tab = useTabsStore.getState().tabsByScope["project-x"]?.[0];
    expect(tab?.cwd).toBe("/some/shell/dir");
  });

  it("does not overwrite an already-populated scope (guard matches projects.ts check)", () => {
    // Pre-populate project-b with a live tab
    const live = [
      { key: "agent-live", label: "claude", cmd: "claude", cwd: "/correct", kind: "agent" as const },
    ];
    useTabsStore.getState().loadFromLayout(live, "/correct", "project-b");

    // Simulate a late async resolve trying to overwrite project-b
    const stale = [
      { key: "agent-stale", label: "claude", cmd: "claude", cwd: "/wrong", kind: "agent" as const },
    ];
    const liveTabs = useTabsStore.getState().tabsByScope["project-b"];
    if (!liveTabs || liveTabs.length === 0) {
      useTabsStore.getState().loadFromLayout(stale, "/wrong", "project-b");
    }

    // Still has the original live tab, not the stale one
    expect(useTabsStore.getState().tabsByScope["project-b"]).toHaveLength(1);
    expect(useTabsStore.getState().tabsByScope["project-b"][0].key).toBe("agent-live");
  });

  it("flat tabs and activeKey reflect targetScope when targetScope equals current scope", () => {
    useTabsStore.getState().setScope("project-c");

    const layout = [
      { key: "agent-c1", label: "claude", cmd: "claude", cwd: "/stale-c", kind: "agent" as const },
      { key: "agent-c2", label: "gemini", cmd: "gemini", cwd: "/stale-c", kind: "agent" as const },
    ];

    useTabsStore.getState().loadFromLayout(layout, "/project-c-dir", "project-c");

    const state = useTabsStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeKey).toBe("agent-c1");
    expect(state.tabs[0].cwd).toBe("/project-c-dir");
    expect(state.tabs[1].cwd).toBe("/project-c-dir");
  });
});
