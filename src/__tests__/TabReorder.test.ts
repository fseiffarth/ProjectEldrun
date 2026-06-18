/**
 * Tests for drag-and-drop tab reordering (#26, Group D.6). The tab bar's HTML5
 * drag handlers call useTabsStore.reorder(from, to); this exercises that store
 * action directly: the moved tab lands at the target index and the change is
 * mirrored into the active scope's tabsByScope bucket (which CenterPanel then
 * persists via its debounced saveLayout effect).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useTabsStore } from "../stores/tabs";

function tab(key: string) {
  return { key, label: key, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

describe("tabs store — reorder", () => {
  beforeEach(() => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    useTabsStore.setState({
      scope: "p",
      tabsByScope: { p: tabs },
      activeKeyByScope: { p: "a" },
      gridByScope: {},
      tabs,
      activeKey: "a",
      grid: false,
    });
  });

  it("moves a tab from one index to another", () => {
    useTabsStore.getState().reorder(0, 2); // a,b,c -> b,c,a
    expect(useTabsStore.getState().tabs.map((t) => t.key)).toEqual(["b", "c", "a"]);
  });

  it("mirrors the new order into the active scope bucket for persistence", () => {
    useTabsStore.getState().reorder(2, 0); // a,b,c -> c,a,b
    const state = useTabsStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual(["c", "a", "b"]);
    expect(state.tabsByScope["p"].map((t) => t.key)).toEqual(["c", "a", "b"]);
  });
});
