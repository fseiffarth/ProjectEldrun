/**
 * Tests for per-scope grid-view state in the tabs store (TODO Group K, #35).
 *
 * Grid mode is tracked per scope so each project independently shows either a
 * single active terminal or all its terminals laid out in a grid. toggleGrid()
 * flips the current scope's flag and mirrors it into the flat `grid` shortcut;
 * setScope() must restore the target scope's flag.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useTabsStore } from "../stores/tabs";

describe("tabs store — grid view", () => {
  beforeEach(() => {
    useTabsStore.setState({
      scope: "project-a",
      tabsByScope: {},
      activeKeyByScope: {},
      gridByScope: {},
      tabs: [],
      activeKey: null,
      grid: false,
    });
  });

  it("toggleGrid flips the current scope and mirrors into the flat shortcut", () => {
    expect(useTabsStore.getState().grid).toBe(false);

    useTabsStore.getState().toggleGrid();
    let state = useTabsStore.getState();
    expect(state.grid).toBe(true);
    expect(state.gridByScope["project-a"]).toBe(true);

    useTabsStore.getState().toggleGrid();
    state = useTabsStore.getState();
    expect(state.grid).toBe(false);
    expect(state.gridByScope["project-a"]).toBe(false);
  });

  it("grid mode is per-scope and restored on setScope", () => {
    useTabsStore.getState().toggleGrid(); // project-a -> grid on

    useTabsStore.getState().setScope("project-b");
    // project-b has never toggled grid → off, and project-a's flag is untouched.
    expect(useTabsStore.getState().grid).toBe(false);
    expect(useTabsStore.getState().gridByScope["project-a"]).toBe(true);

    useTabsStore.getState().setScope("project-a");
    expect(useTabsStore.getState().grid).toBe(true);
  });
});
