/**
 * Tab colours (#264) — the palette a right-click on the desktop and the phone's
 * Colour sheet both write into.
 *
 * Three things are worth holding down, and they are the three that would fail
 * silently:
 *  - the colour SURVIVES a relaunch. It is a grouping mark on tabs that are
 *    reopened for you, so one that lives only in memory is worth nothing — and
 *    `toSavedTabEntry` is the single enumerated projection to disk, which is
 *    exactly the list a new field gets left off (see its own doc comment).
 *  - an id that is not in the palette NEVER comes back. The layout is a file,
 *    and the stored id is substituted straight into `--tab-accent`.
 *  - the scoped write lands in the named scope. The phone colours a tab in
 *    whichever project it is looking at, which need not be the one the window
 *    is showing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

import { toSavedTabEntry, useTabsStore, type SavedTabEntry, type TabEntry } from "../stores/tabs";
import { applyColorToTabs } from "../stores/detached";
import { TAB_COLORS, isTabColor, tabColorCss } from "../lib/theme/tabColors";
import { TabBar } from "../components/tabs/TabBar";
import { allGroups } from "../stores/tabs";
import { useDragStore } from "../stores/drag";

function shell(key: string, over: Partial<TabEntry> = {}): TabEntry {
  return { key, label: key, cmd: "", cwd: "/p", kind: "shell", scope: "p1", ...over };
}

function saved(over: Partial<SavedTabEntry> = {}): SavedTabEntry {
  return { key: "shell-1", label: "Shell", cmd: "", cwd: "/p/p1", kind: "shell", ...over };
}

beforeEach(() => {
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

describe("the palette", () => {
  it("resolves only its own ids, and to a colour rather than a name", () => {
    expect(isTabColor("teal")).toBe(true);
    expect(isTabColor("chartreuse")).toBe(false);
    expect(isTabColor(undefined)).toBe(false);
    expect(tabColorCss("teal")).toBe(TAB_COLORS.teal);
    // A hex, a CSS injection and a near-miss all read as "no colour" — nothing
    // but a palette id can reach the style attribute.
    expect(tabColorCss("#ff0000")).toBeUndefined();
    expect(tabColorCss("red; background:url(x)")).toBeUndefined();
    expect(tabColorCss("Blue")).toBeUndefined();
  });
});

describe("setTabColor", () => {
  it("paints and clears a tab of the active scope", () => {
    useTabsStore.setState({
      tabsByScope: { p1: [shell("shell-1"), shell("shell-2")] },
      tabs: [shell("shell-1"), shell("shell-2")],
      layoutByScope: { p1: { type: "group", id: "g1", tabKeys: ["shell-1", "shell-2"], activeKey: "shell-1" } },
    });
    useTabsStore.getState().setTabColor("shell-1", "teal");
    expect(useTabsStore.getState().tabsByScope.p1?.[0].color).toBe("teal");
    // Only the named tab.
    expect(useTabsStore.getState().tabsByScope.p1?.[1].color).toBeUndefined();
    useTabsStore.getState().setTabColor("shell-1", undefined);
    expect(useTabsStore.getState().tabsByScope.p1?.[0].color).toBeUndefined();
  });

  it("refuses an id outside the palette instead of storing it", () => {
    useTabsStore.setState({
      tabsByScope: { p1: [shell("shell-1")] },
      tabs: [shell("shell-1")],
      layoutByScope: { p1: { type: "group", id: "g1", tabKeys: ["shell-1"], activeKey: "shell-1" } },
    });
    useTabsStore.getState().setTabColor("shell-1", "chartreuse" as never);
    expect(useTabsStore.getState().tabsByScope.p1?.[0].color).toBeUndefined();
  });

  it("writes to the named scope, not the active one", () => {
    useTabsStore.setState({
      scope: "other",
      tabsByScope: { p1: [shell("shell-1")] },
      layoutByScope: { p1: { type: "group", id: "g1", tabKeys: ["shell-1"], activeKey: "shell-1" } },
    });
    useTabsStore.getState().setTabColorInScope("p1", "shell-1", "red");
    expect(useTabsStore.getState().tabsByScope.p1?.[0].color).toBe("red");
    expect(useTabsStore.getState().tabsByScope.other).toBeUndefined();
  });
});

describe("persistence", () => {
  it("projects the colour onto the saved tab, so a relaunch reopens it coloured", () => {
    expect(toSavedTabEntry(shell("shell-1", { color: "indigo" })).color).toBe("indigo");
    expect(toSavedTabEntry(shell("shell-1")).color).toBeUndefined();
  });

  it("restores a palette colour and drops anything else", () => {
    useTabsStore.getState().loadFromLayout(
      [
        saved({ key: "a", color: "purple" }),
        saved({ key: "b", color: "chartreuse" as never }),
        saved({ key: "c" }),
      ],
      "/p/p1",
      "p1",
    );
    const colors = (useTabsStore.getState().tabsByScope.p1 ?? []).map((t) => t.color);
    expect(colors).toEqual(["purple", undefined, undefined]);
  });
});

describe("a popout's optimistic apply", () => {
  it("recolours the forwarded payload, and treats an unknown id as a clear", () => {
    const tabs = [shell("shell-1", { color: "teal" }), shell("shell-2")];
    expect(applyColorToTabs(tabs, "shell-1", "green")[0].color).toBe("green");
    expect(applyColorToTabs(tabs, "shell-1", undefined)[0].color).toBeUndefined();
    expect(applyColorToTabs(tabs, "shell-1", "chartreuse" as never)[0].color).toBeUndefined();
    // A no-op write returns the same objects, so nothing re-renders for nothing.
    expect(applyColorToTabs(tabs, "shell-1", "teal")[0]).toBe(tabs[0]);
  });
});

describe("the tab's right-click menu", () => {
  beforeEach(() => {
    useDragStore.setState({ drag: null });
    cleanup();
  });

  it("paints the tab from a swatch, keeps the menu open, and clears it again", () => {
    useTabsStore.getState().addTab({ label: "shell", cmd: "bash", cwd: "/p", kind: "shell" });
    const group = allGroups(useTabsStore.getState().layout)[0];
    const key = group.tabKeys[0];
    const { container } = render(
      <TabBar groupId={group.id} projectCwd="/p" showGroupClose={false} />,
    );
    const tab = () => container.querySelector(".tab")!;
    // No colour to start with: the stripe slot is the tab kind's, as before.
    expect(tab().classList.contains("has-tab-color")).toBe(false);

    fireEvent.contextMenu(tab());
    // The picker portals with the menu.
    const swatch = document.querySelector('.tab-color-swatch[aria-label="Teal"]') as HTMLButtonElement;
    expect(swatch).toBeTruthy();
    fireEvent.click(swatch);

    const stored = () => useTabsStore.getState().tabs.find((t) => t.key === key)?.color;
    expect(stored()).toBe("teal");
    expect(tab().classList.contains("has-tab-color")).toBe(true);
    expect(tab().getAttribute("style")).toContain(TAB_COLORS.teal);
    // Trying a second hue must not need a second right-click — the picker is the
    // one row in this menu that does not close on use.
    expect(document.querySelector(".tab-new-menu")).toBeTruthy();
    expect(
      document.querySelector('.tab-color-swatch[aria-label="Teal"]')!.classList.contains("is-current"),
    ).toBe(true);

    fireEvent.click(document.querySelector(".tab-color-swatch--none") as HTMLButtonElement);
    expect(stored()).toBeUndefined();
    expect(tab().classList.contains("has-tab-color")).toBe(false);
  });
});
