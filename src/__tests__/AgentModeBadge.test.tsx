/**
 * The planner/doer badge as the user actually meets it: rendered by the real
 * TabBar, driven by real clicks. The unit tests in AgentMode.test.ts prove the arg
 * rewrite; these prove the badge is *gated* correctly (experimental setting off →
 * it does not exist; unsupported agent → it does not exist) and that clicking it
 * flips the mode and rewrites the launch args — which is what respawns the PTY.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));

import { TabBar } from "../components/tabs/TabBar";
import { allGroups, useTabsStore } from "../stores/tabs";
import { useDragStore } from "../stores/drag";
import { useSettingsStore } from "../stores/settings";
import { useActivityStore } from "../stores/activity";

function reset(agentModeToggle: boolean) {
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
  useSettingsStore.setState({ settings: { agent_mode_toggle: agentModeToggle }, loaded: true });
  useActivityStore.setState({ busyByTab: {} });
}

/**
 * Seed one agent tab and render its bar. `busy` marks the tab's PTY as mid-turn
 * BEFORE the render — the bar reads the busy map during render, so setting it
 * afterwards would leave the click handler closed over the stale (empty) map.
 */
function seedAgent(cmd: string, busy = false) {
  useTabsStore.getState().addTab({
    label: cmd,
    cmd,
    cwd: "/p",
    kind: "agent",
    args: ["--session-id", "uuid-1"],
  });
  const group = allGroups(useTabsStore.getState().layout)[0];
  const key = group.tabKeys[0];
  // Busy is keyed by the composed PTY id (`<scope>:<tabKey>`).
  if (busy) useActivityStore.setState({ busyByTab: { [`p:${key}`]: true } });
  const { container } = render(
    <TabBar groupId={group.id} projectCwd="/p" showGroupClose={false} />,
  );
  return { container, key };
}

const tabOf = (key: string) => useTabsStore.getState().tabs.find((t) => t.key === key);

afterEach(cleanup);

describe("Plan/Auto badge gating", () => {
  it("does not exist while the experimental setting is off", () => {
    reset(false);
    const { container } = seedAgent("claude");
    expect(container.querySelector(".tab-agent-mode")).toBeNull();
  });

  it("does not exist on an agent that can't be mode-switched safely (Codex)", () => {
    reset(true);
    const { container } = seedAgent("codex");
    expect(container.querySelector(".tab-agent-mode")).toBeNull();
  });

  it("shows on a Claude tab, starting in the agent's own default (unset)", () => {
    reset(true);
    const { container } = seedAgent("claude");
    const badge = container.querySelector(".tab-agent-mode");
    expect(badge).toBeTruthy();
    expect(badge!.className).toContain("unset");
  });
});

describe("clicking the badge", () => {
  beforeEach(() => reset(true));

  it("goes unset → Plan, folding the flag into the launch args", () => {
    const { container, key } = seedAgent("claude");
    fireEvent.click(container.querySelector(".tab-agent-mode")!);

    expect(tabOf(key)?.agentMode).toBe("plan");
    // The args are what TerminalView keys its spawn effect on — this rewrite IS
    // the respawn.
    expect(tabOf(key)?.args).toEqual(["--session-id", "uuid-1", "--permission-mode", "plan"]);
    expect(container.querySelector(".tab-agent-mode")!.className).toContain("plan");
  });

  it("does not start a tab drag (the badge is self-contained)", () => {
    const { container } = seedAgent("claude");
    fireEvent.pointerDown(container.querySelector(".tab-agent-mode")!);
    expect(useDragStore.getState().drag).toBeNull();
  });

  it("asks first when the agent is mid-turn, and leaves it alone if declined", () => {
    const { container, key } = seedAgent("claude", true);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    fireEvent.click(container.querySelector(".tab-agent-mode")!);

    // Declining must not restart the agent — the args (and so the PTY) stand.
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(tabOf(key)?.agentMode).toBeUndefined();
    expect(tabOf(key)?.args).toEqual(["--session-id", "uuid-1"]);
    confirmSpy.mockRestore();
  });

  it("switches a mid-turn agent when the restart is accepted", () => {
    const { container, key } = seedAgent("claude", true);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    fireEvent.click(container.querySelector(".tab-agent-mode")!);

    expect(tabOf(key)?.agentMode).toBe("plan");
    expect(tabOf(key)?.args).toEqual(["--session-id", "uuid-1", "--permission-mode", "plan"]);
    confirmSpy.mockRestore();
  });
});
