/**
 * #56 — right-click a tab enters inline rename mode (no context menu, no prompt).
 *
 * Renders the real TabBar and drives the contextmenu / keyboard path through
 * React's own event system to prove:
 *   - contextmenu on a tab swaps the label for a focused, text-selected input
 *     and shows NO context menu;
 *   - typing + Enter commits the new label via renameTab;
 *   - Escape discards the edit, leaving the original label;
 *   - a pointerdown on the editing input does not start a tab drag.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));

import { TabBar } from "../components/tabs/TabBar";
import { allGroups, useTabsStore } from "../stores/tabs";
import { useDragStore } from "../stores/drag";

function reset() {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  useDragStore.setState({ drag: null });
}

function seedOneTab(label = "shell") {
  useTabsStore.getState().addTab({ label, cmd: "bash", cwd: "/p", kind: "shell" });
  const group = allGroups(useTabsStore.getState().layout)[0];
  const key = group.tabKeys[0];
  return { groupId: group.id, key };
}

describe("#56 inline tab rename", () => {
  beforeEach(() => {
    reset();
    cleanup();
  });

  it("contextmenu shows an input (label selected) and no context menu", () => {
    const { groupId } = seedOneTab("shell");
    const { container } = render(
      <TabBar groupId={groupId} projectCwd="/p" showGroupClose={false} />,
    );
    const tab = container.querySelector(".tab")!;
    fireEvent.contextMenu(tab);

    const input = container.querySelector("input.tab-label-edit") as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(input!.value).toBe("shell");
    // The whole label is selected for a fast retype.
    expect(input!.selectionStart).toBe(0);
    expect(input!.selectionEnd).toBe("shell".length);
    // No old-style tab context menu.
    expect(document.querySelector(".tab-context-menu")).toBeNull();
    // The plain label span is gone while editing.
    expect(container.querySelector(".tab-label")).toBeNull();
  });

  it("typing + Enter renames the tab and closes the editor", () => {
    const { groupId, key } = seedOneTab("old");
    const { container } = render(
      <TabBar groupId={groupId} projectCwd="/p" showGroupClose={false} />,
    );
    fireEvent.contextMenu(container.querySelector(".tab")!);
    const input = container.querySelector("input.tab-label-edit") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useTabsStore.getState().tabs.find((t) => t.key === key)!.label).toBe("renamed");
    expect(container.querySelector("input.tab-label-edit")).toBeNull();
    expect(container.querySelector(".tab-label")!.textContent).toBe("renamed");
  });

  it("Escape discards the edit, label unchanged", () => {
    const { groupId, key } = seedOneTab("keepme");
    const { container } = render(
      <TabBar groupId={groupId} projectCwd="/p" showGroupClose={false} />,
    );
    fireEvent.contextMenu(container.querySelector(".tab")!);
    const input = container.querySelector("input.tab-label-edit") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(useTabsStore.getState().tabs.find((t) => t.key === key)!.label).toBe("keepme");
    expect(container.querySelector("input.tab-label-edit")).toBeNull();
    expect(container.querySelector(".tab-label")!.textContent).toBe("keepme");
  });

  it("pointerdown on the editing input does not start a tab drag", () => {
    const { groupId } = seedOneTab("dragless");
    const { container } = render(
      <TabBar groupId={groupId} projectCwd="/p" showGroupClose={false} />,
    );
    fireEvent.contextMenu(container.querySelector(".tab")!);
    const input = container.querySelector("input.tab-label-edit") as HTMLInputElement;
    fireEvent.pointerDown(input, { button: 0, clientX: 10, clientY: 10 });
    // Moving far would normally cross the drag threshold; the input's
    // stopPropagation + the editingKey guard mean no drag was ever seeded.
    expect(useDragStore.getState().drag).toBeNull();
  });
});
