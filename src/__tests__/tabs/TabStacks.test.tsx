/**
 * Tab groups inside a tab bar (`lib/tabStacks`, `TabStackChip`): tabs sharing a
 * group name fold into one chip, and hovering the chip lists them ready to pick.
 *
 * Held down here:
 *  - the fold itself — one chip per name, at its first member's slot, carrying
 *    that slot's `data-tab-index` (the drop-slot resolver reads it, so a drag
 *    over a bar with a chip still lands between the right two tabs);
 *  - hover opens the list, a click on a row activates that tab;
 *  - joining a group moves the tab beside its members;
 *  - the group survives a relaunch, and a stored name is normalized, not
 *    trusted (the layout is a file on disk).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

import {
  allGroups,
  toSavedTabEntry,
  useTabsStore,
  type SavedTabEntry,
  type TabEntry,
} from "../../stores/tabs";
import { applyStackToTabs } from "../../stores/detached";
import { MAX_STACK_NAME, normalizeStackName, stackJoinOrder, stackNames, stripItems } from "../../lib/tabStacks";
import { TabBar } from "../../components/tabs/TabBar";
import { useDragStore } from "../../stores/drag/drag";

function shell(key: string, over: Partial<TabEntry> = {}): TabEntry {
  return { key, label: key, cmd: "", cwd: "/p", kind: "shell", scope: "p1", ...over };
}

function saved(over: Partial<SavedTabEntry> = {}): SavedTabEntry {
  return { key: "shell-1", label: "Shell", cmd: "", cwd: "/p/p1", kind: "shell", ...over };
}

function seed(tabs: TabEntry[], activeKey: string) {
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { p1: tabs },
    tabs,
    layoutByScope: {
      p1: { type: "group", id: "g1", tabKeys: tabs.map((t) => t.key), activeKey },
    },
    layout: { type: "group", id: "g1", tabKeys: tabs.map((t) => t.key), activeKey },
    focusedGroupByScope: { p1: "g1" },
    focusedGroupId: "g1",
    activeKey,
  });
}

beforeEach(() => {
  cleanup();
  useDragStore.setState({ drag: null });
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
});

describe("the fold", () => {
  it("puts one chip per group at its first member's slot", () => {
    const tabs = [
      shell("a"),
      shell("b", { stack: "Build" }),
      shell("c"),
      shell("d", { stack: "Build" }),
      shell("e", { stack: "Docs" }),
    ];
    const items = stripItems(tabs);
    expect(items.map((i) => (i.type === "tab" ? i.tab.key : `[${i.name}]`))).toEqual([
      "a",
      "[Build]",
      "c",
      "[Docs]",
    ]);
    const build = items[1];
    expect(build.type === "stack" && build.index).toBe(1);
    expect(build.type === "stack" && build.members.map((m) => [m.tab.key, m.index])).toEqual([
      ["b", 1],
      ["d", 3],
    ]);
    expect(stackNames(tabs)).toEqual(["Build", "Docs"]);
  });

  it("normalizes a name, and reads anything else as no group", () => {
    expect(normalizeStackName("  Build   jobs ")).toBe("Build jobs");
    expect(normalizeStackName("   ")).toBeUndefined();
    expect(normalizeStackName(42)).toBeUndefined();
    expect(normalizeStackName(undefined)).toBeUndefined();
    expect(normalizeStackName("x".repeat(200))).toHaveLength(MAX_STACK_NAME);
  });

  it("orders a joining tab right after the group's last member", () => {
    const stackOf = (k: string) => ({ b: "G", d: "G" } as Record<string, string>)[k];
    expect(stackJoinOrder(["a", "b", "c", "d", "e"], "a", "G", stackOf)).toEqual(["b", "c", "d", "a", "e"]);
    expect(stackJoinOrder(["b", "a", "d"], "a", "G", stackOf)).toEqual(["b", "d", "a"]);
    // Already beside its members, or a brand-new group: nothing moves.
    expect(stackJoinOrder(["a", "b", "c", "d", "e"], "e", "G", stackOf)).toBeNull();
    expect(stackJoinOrder(["b", "d", "e"], "e", "G", stackOf)).toBeNull();
    expect(stackJoinOrder(["a", "b"], "a", "New", stackOf)).toBeNull();
  });
});

describe("setTabStack", () => {
  it("joins a tab to a group beside its members, and takes it out again", () => {
    seed([shell("a"), shell("b", { stack: "G" }), shell("c")], "a");
    useTabsStore.getState().setTabStack("a", "G");
    const s = useTabsStore.getState();
    expect(s.tabsByScope.p1?.find((t) => t.key === "a")?.stack).toBe("G");
    expect(allGroups(s.layout)[0].tabKeys).toEqual(["b", "a", "c"]);

    useTabsStore.getState().setTabStack("a", "   ");
    expect(useTabsStore.getState().tabsByScope.p1?.find((t) => t.key === "a")?.stack).toBeUndefined();
  });
});

describe("persistence", () => {
  it("projects the group onto the saved tab and restores it normalized", () => {
    expect(toSavedTabEntry(shell("a", { stack: "Build" })).stack).toBe("Build");
    useTabsStore.getState().loadFromLayout(
      [
        saved({ key: "a", stack: "  Build " }),
        saved({ key: "b", stack: 7 as never }),
        saved({ key: "c" }),
      ],
      "/p/p1",
      "p1",
    );
    const stacks = (useTabsStore.getState().tabsByScope.p1 ?? []).map((t) => t.stack);
    expect(stacks).toEqual(["Build", undefined, undefined]);
  });

  it("a popout's optimistic apply normalizes the same way", () => {
    const tabs = [shell("a"), shell("b")];
    expect(applyStackToTabs(tabs, "a", " G ")[0].stack).toBe("G");
    expect(applyStackToTabs(tabs, "a", "")[0].stack).toBeUndefined();
    expect(applyStackToTabs(tabs, "a", undefined)[0]).toBe(tabs[0]);
  });
});

describe("the chip in the tab bar", () => {
  it("folds the group into one chip whose hover list activates a tab", () => {
    vi.useFakeTimers();
    try {
      seed([shell("a"), shell("b", { stack: "Build" }), shell("c", { stack: "Build" })], "a");
      const { container } = render(<TabBar groupId="g1" projectCwd="/p" showGroupClose={false} />);

      const strip = container.querySelectorAll(".tab-strip > .tab");
      expect(strip).toHaveLength(2);
      const chip = container.querySelector(".tab.tab-stack") as HTMLElement;
      expect(chip.dataset.tabIndex).toBe("1");
      expect(chip.querySelector(".tab-stack-name")?.textContent).toBe("Build");
      expect(chip.querySelector(".tab-stack-count")?.textContent).toBe("2");
      expect(chip.classList.contains("active")).toBe(false);
      expect(container.querySelector(".tab-bar")?.getAttribute("data-tab-count")).toBe("3");

      fireEvent.mouseEnter(chip);
      const rows = document.querySelectorAll<HTMLElement>(".tab-stack-menu .tab-stack-row");
      expect(Array.from(rows).map((r) => r.dataset.tabKey)).toEqual(["b", "c"]);

      fireEvent.click(rows[1]);
      expect(allGroups(useTabsStore.getState().layout)[0].activeKey).toBe("c");
      // Picking closes the list; the chip now reads as the current tab.
      expect(document.querySelector(".tab-stack-menu")).toBeNull();
      const active = container.querySelector(".tab.tab-stack") as HTMLElement;
      expect(active.classList.contains("active")).toBe(true);
      expect(active.querySelector(".tab-stack-current")?.textContent).toBe("c");

      // Leaving the chip closes the list after the short grace period.
      fireEvent.mouseEnter(active);
      expect(document.querySelector(".tab-stack-menu")).toBeTruthy();
      fireEvent.mouseLeave(active);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(document.querySelector(".tab-stack-menu")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers the bar's groups in a tab's right-click menu", () => {
    seed([shell("a"), shell("b", { stack: "Build" })], "a");
    const { container } = render(<TabBar groupId="g1" projectCwd="/p" showGroupClose={false} />);
    fireEvent.contextMenu(container.querySelector(".tab:not(.tab-stack)")!);
    const join = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab-new-menu-item")).find(
      (b) => b.textContent?.includes("Add to group “Build”"),
    );
    expect(join).toBeTruthy();
    fireEvent.click(join!);
    expect(useTabsStore.getState().tabs.find((t) => t.key === "a")?.stack).toBe("Build");
    expect(container.querySelectorAll(".tab-strip > .tab")).toHaveLength(1);
  });
});
