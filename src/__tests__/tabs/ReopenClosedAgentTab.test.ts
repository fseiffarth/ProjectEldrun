/**
 * "Reopen closed agent tab" (`stores/agents/closedAgentTabs`): a user close
 * through `closeTabInScope` keeps a resumable agent tab, and a reopen brings it
 * back in its old place on the resume args a restart would give it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(() => Promise.resolve()), listen: vi.fn() }));

import { orderedTabKeys, useTabsStore, type GroupNode, type TabEntry } from "../../stores/tabs";
import { closeTabInScope } from "../../lib/remote/closeRemoteTab";
import {
  MAX_CLOSED_AGENT_TABS,
  noteClosedPopoutTabs,
  reopenClosedAgentTab,
  useClosedAgentTabsStore,
} from "../../stores/agents/closedAgentTabs";

function seed() {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    detachedGroupsByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  useClosedAgentTabsStore.setState({ byScope: {} });
}

function add(tab: Partial<TabEntry> & { label: string }): TabEntry {
  return useTabsStore.getState().addTab({ cmd: "bash", cwd: "/p", kind: "shell", ...tab });
}

function labels(): string[] {
  const group = useTabsStore.getState().layout as GroupNode;
  return group.tabKeys.map((k) => useTabsStore.getState().tabs.find((t) => t.key === k)!.label);
}

describe("reopen closed agent tab", () => {
  beforeEach(seed);

  it("brings a closed Claude tab back in its place, resuming its session", () => {
    add({ label: "a" });
    const claude = add({
      label: "claude",
      cmd: "claude",
      kind: "agent",
      args: ["--session-id", "s-1"],
      sessionId: "s-1",
      initialInput: "first prompt",
      color: "blue",
    });
    add({ label: "b" });
    closeTabInScope("p", claude.key);
    expect(labels()).toEqual(["a", "b"]);

    const back = reopenClosedAgentTab("p")!;
    expect(labels()).toEqual(["a", "claude", "b"]);
    expect(back.key).not.toBe(claude.key);
    expect(back.sessionId).toBe("s-1");
    expect(back.args).toEqual(["--resume", "s-1"]);
    expect(back.scheduleTargetId).toBe(claude.scheduleTargetId);
    expect(back.color).toBe("blue");
    // The first prompt was typed once; a reopen must not type it again.
    expect(back.initialInput).toBeUndefined();
    expect((useTabsStore.getState().layout as GroupNode).activeKey).toBe(back.key);
    // Taken: a second reopen has nothing left.
    expect(reopenClosedAgentTab("p")).toBeNull();
  });

  it("keeps only tabs a restart would resume, and never a Host session", () => {
    const shell = add({ label: "sh" });
    const fresh = add({ label: "aider", cmd: "aider", kind: "agent" });
    const host = add({ label: "host", cmd: "claude", kind: "agent", sessionId: "h", hostSession: true });
    for (const tab of [shell, fresh, host]) closeTabInScope("p", tab.key);
    expect(useClosedAgentTabsStore.getState().byScope.p ?? []).toEqual([]);
  });

  it("reopens newest first, or the one named, and remembers a bounded list", () => {
    const tabs = Array.from({ length: MAX_CLOSED_AGENT_TABS + 2 }, (_, i) =>
      add({ label: `c${i}`, cmd: "claude", kind: "agent", sessionId: `s-${i}` }),
    );
    for (const tab of tabs) closeTabInScope("p", tab.key);
    const list = useClosedAgentTabsStore.getState().byScope.p;
    expect(list).toHaveLength(MAX_CLOSED_AGENT_TABS);
    expect(list[0].tab.label).toBe(`c${MAX_CLOSED_AGENT_TABS + 1}`);

    const named = list[3];
    expect(reopenClosedAgentTab("p", named.id)!.label).toBe(named.tab.label);
    expect(reopenClosedAgentTab("p")!.label).toBe(`c${MAX_CLOSED_AGENT_TABS + 1}`);
  });

  it("skips a closed tab whose conversation is open again elsewhere", () => {
    const first = add({ label: "old", cmd: "claude", kind: "agent", sessionId: "same" });
    const other = add({ label: "other", cmd: "claude", kind: "agent", sessionId: "s-2" });
    closeTabInScope("p", other.key);
    closeTabInScope("p", first.key);
    add({ label: "again", cmd: "claude", kind: "agent", sessionId: "same" });
    expect(reopenClosedAgentTab("p")!.label).toBe("other");
  });

  it("gives a reopened tab a fresh tmux name when the close ended its session", () => {
    const claude = add({ label: "claude", cmd: "claude", kind: "agent", sessionId: "s-1" });
    useClosedAgentTabsStore.getState().note("p", {
      id: "x",
      tab: claude,
      closedAt: 0,
      sessionEnded: true,
    });
    useTabsStore.getState().removeTab(claude.key);
    const back = reopenClosedAgentTab("p")!;
    expect(back.tmuxSession).toBeTruthy();
    expect(back.tmuxSession).not.toBe(claude.tmuxSession);
  });

  describe("closed in a popout", () => {
    /** Three tabs [x, claude, y] popped out into one popout window. */
    function popout() {
      add({ label: "main" });
      const tabs = [
        add({ label: "x" }),
        add({ label: "claude", cmd: "claude", kind: "agent", sessionId: "s-p" }),
        add({ label: "y" }),
      ];
      const pane: GroupNode = { type: "group", id: "pane-1", tabKeys: tabs.map((t) => t.key), activeKey: tabs[0].key };
      const main = useTabsStore.getState().layout as GroupNode;
      useTabsStore.setState((s) => ({
        layoutByScope: { ...s.layoutByScope, p: { ...main, tabKeys: [main.tabKeys[0]], activeKey: main.tabKeys[0] } },
        layout: { ...main, tabKeys: [main.tabKeys[0]], activeKey: main.tabKeys[0] },
        detachedGroupsByScope: { p: [{ id: "pop", label: "detached-pop", subtree: pane }] },
      }));
      return tabs;
    }
    const popoutKeys = () => orderedTabKeys(useTabsStore.getState().detachedGroupsByScope.p[0].subtree);
    const labelOf = (key: string) => useTabsStore.getState().tabsByScope.p.find((t) => t.key === key)!.label;

    it("reopens a tab closed in a popout back into its place there", () => {
      const [, claude] = popout();
      noteClosedPopoutTabs("p", "pop", [claude.key]);
      useTabsStore.getState().applyDetachedEdit("p", "pop", { kind: "close", key: claude.key, user: true });
      expect(popoutKeys().map(labelOf)).toEqual(["x", "y"]);

      const back = reopenClosedAgentTab("p")!;
      expect(back.args).toEqual(["--resume", "s-p"]);
      // A popout's close ended no tmux session, so a still-running one is reattached.
      expect(back.tmuxSession).toBe(claude.tmuxSession);
      expect(popoutKeys().map(labelOf)).toEqual(["x", "claude", "y"]);
      expect(labels()).toEqual(["main"]);
    });

    it("a popout's own reopen takes the tab closed there first, and lands it in that popout", () => {
      const [, claude] = popout();
      const mainClaude = add({ label: "main claude", cmd: "claude", kind: "agent", sessionId: "s-m" });
      noteClosedPopoutTabs("p", "pop", [claude.key]);
      useTabsStore.getState().applyDetachedEdit("p", "pop", { kind: "close", key: claude.key, user: true });
      closeTabInScope("p", mainClaude.key); // newer, but closed in the main window

      expect(reopenClosedAgentTab("p", undefined, "pop")!.label).toBe("claude");
      expect(popoutKeys().map(labelOf)).toEqual(["x", "claude", "y"]);
      // Nothing closed there any more: the scope's newest comes to this popout.
      expect(reopenClosedAgentTab("p", undefined, "pop")!.label).toBe("main claude");
      expect(popoutKeys().map(labelOf)).toContain("main claude");
      expect(labels()).toEqual(["main"]);
    });

    it("reopens in the main layout once the popout itself is gone", () => {
      const [, claude] = popout();
      noteClosedPopoutTabs("p", "pop", popoutKeys());
      useTabsStore.getState().closeDetachedGroup("p", "pop");
      expect(useClosedAgentTabsStore.getState().byScope.p).toHaveLength(1);

      const back = reopenClosedAgentTab("p")!;
      expect(back.sessionId).toBe(claude.sessionId);
      expect(labels()).toEqual(["main", "claude"]);
    });
  });
});
