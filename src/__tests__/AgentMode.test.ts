/**
 * Per-tab planner/doer mode (experimental `agent_mode_toggle`). The mode is a
 * *launch flag*, so it lives in the tab's args and switching it respawns the PTY;
 * the durable record is `TabEntry.agentMode`, because args are rebuilt from
 * scratch on restore. These tests lock the capability gate, the idempotence of the
 * arg rewrite (a stacked `--permission-mode` would be a broken launch), the
 * initialInput retirement, and the save → project.json → load round-trip that makes
 * the split survive a restart.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { supportsAgentMode, withAgentMode } from "../components/tabs/agentModes";
import { useTabsStore, type SavedLayoutTree } from "../stores/tabs";

const invokeMock = vi.mocked(invoke);

function resetStore() {
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
}

describe("agent-mode capability gate", () => {
  it("admits Claude and Gemini — both have an absolute mode flag and a working resume", () => {
    expect(supportsAgentMode("claude")).toBe(true);
    // Gemini has --approval-mode (absolute) AND resumes (continue-last).
    expect(supportsAgentMode("gemini")).toBe(true);
    // Codex resumes, but has no plan mode (only a read-only sandbox).
    expect(supportsAgentMode("codex")).toBe(false);
    expect(supportsAgentMode("vibe")).toBe(false);
    expect(supportsAgentMode("")).toBe(false);
  });

  it("leaves an unsupported agent's args strictly alone (same reference)", () => {
    const args = ["--continue"];
    expect(withAgentMode("codex", args, "plan")).toBe(args);
  });
});

describe("withAgentMode", () => {
  it("maps plan → plan and auto → acceptEdits (NOT bypassPermissions)", () => {
    expect(withAgentMode("claude", [], "plan")).toEqual(["--permission-mode", "plan"]);
    expect(withAgentMode("claude", [], "auto")).toEqual(["--permission-mode", "acceptEdits"]);
  });

  it("maps Gemini plan → plan and auto → auto_edit (NOT yolo)", () => {
    expect(withAgentMode("gemini", [], "plan")).toEqual(["--approval-mode", "plan"]);
    expect(withAgentMode("gemini", [], "auto")).toEqual(["--approval-mode", "auto_edit"]);
    // "auto" must never reach the auto-approve-ALL level.
    expect(withAgentMode("gemini", [], "auto")).not.toContain("yolo");
  });

  it("is idempotent for Gemini too, and re-applies onto its continue-last resume args", () => {
    let args = withAgentMode("gemini", ["--resume", "latest"], "plan");
    args = withAgentMode("gemini", args, "auto");
    expect(args).toEqual(["--resume", "latest", "--approval-mode", "auto_edit"]);
    expect(args.filter((a) => a === "--approval-mode")).toHaveLength(1);
  });

  it("is idempotent: repeated toggling never stacks the flag", () => {
    let args = withAgentMode("claude", [], "plan");
    args = withAgentMode("claude", args, "auto");
    args = withAgentMode("claude", args, "plan");
    expect(args).toEqual(["--permission-mode", "plan"]);
    expect(args.filter((a) => a === "--permission-mode")).toHaveLength(1);
  });

  it("preserves sibling args — the session id must survive the rewrite", () => {
    const args = withAgentMode("claude", ["--session-id", "uuid-1", "--remote-control"], "auto");
    expect(args).toEqual([
      "--session-id",
      "uuid-1",
      "--remote-control",
      "--permission-mode",
      "acceptEdits",
    ]);
  });

  it("strips the old flag's VALUE too, not just the flag", () => {
    // A naive filter would leave a bare "plan" behind, which Claude would read as
    // a prompt argument.
    const args = withAgentMode("claude", ["--permission-mode", "plan", "--resume", "id"], "auto");
    expect(args).not.toContain("plan");
    expect(args).toEqual(["--resume", "id", "--permission-mode", "acceptEdits"]);
  });
});

describe("setAgentMode", () => {
  beforeEach(resetStore);

  it("records the mode and folds it into the launch args (which drives the respawn)", () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    const tab = store.addTab({
      label: "Claude",
      cmd: "claude",
      cwd: "/p",
      kind: "agent",
      args: ["--session-id", "uuid-1"],
    });

    useTabsStore.getState().setAgentMode(tab.key, "plan");
    const t = useTabsStore.getState().tabs.find((x) => x.key === tab.key);
    expect(t?.agentMode).toBe("plan");
    expect(t?.args).toEqual(["--session-id", "uuid-1", "--permission-mode", "plan"]);
  });

  it("retires initialInput, so the respawn can't re-type /rename into a resumed session", () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    const tab = store.addTab({
      label: "Claude",
      cmd: "claude",
      cwd: "/p",
      kind: "agent",
      initialInput: "/rename proj",
    });

    useTabsStore.getState().setAgentMode(tab.key, "auto");
    expect(
      useTabsStore.getState().tabs.find((x) => x.key === tab.key)?.initialInput,
    ).toBeUndefined();
  });

  it("no-ops (stable array) when unchanged, and for an agent with no mode support", () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    const claude = store.addTab({ label: "Claude", cmd: "claude", cwd: "/p", kind: "agent" });
    const codex = useTabsStore
      .getState()
      .addTab({ label: "Codex", cmd: "codex", cwd: "/p", kind: "agent" });

    useTabsStore.getState().setAgentMode(claude.key, "plan");
    const before = useTabsStore.getState().tabs;
    useTabsStore.getState().setAgentMode(claude.key, "plan");
    expect(useTabsStore.getState().tabs).toBe(before);

    // Codex has no mode mapping — the store must not record a mode it never passed.
    useTabsStore.getState().setAgentMode(codex.key, "plan");
    expect(useTabsStore.getState().tabs).toBe(before);
    expect(
      useTabsStore.getState().tabs.find((t) => t.key === codex.key)?.agentMode,
    ).toBeUndefined();
  });
});

describe("agentMode round-trips through save/load", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    resetStore();
  });

  it("persists agentMode in the saved tab layout", async () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    const tab = store.addTab({
      label: "Claude",
      cmd: "claude",
      cwd: "/p",
      kind: "agent",
      sessionId: "uuid-1",
      args: ["--session-id", "uuid-1"],
    });
    useTabsStore.getState().setAgentMode(tab.key, "plan");

    await useTabsStore.getState().saveLayout("/p/project.json");

    const call = invokeMock.mock.calls.find((c) => c[0] === "save_tab_layout");
    expect(call).toBeTruthy();
    const arg = call![1] as {
      tabs: { label: string; agentMode?: string }[];
      groups: SavedLayoutTree | null;
    };
    expect(arg.tabs.find((t) => t.label === "Claude")?.agentMode).toBe("plan");
  });

  it("restores the mode ONTO the rebuilt resume args", () => {
    // The restore path rebuilds args from RESUMABLE_AGENTS, so the mode flag has to
    // be re-applied on top of `--resume <id>` — otherwise the tab silently comes
    // back in the agent's default mode and the planner/doer split is lost.
    useTabsStore.getState().loadFromLayout(
      [
        {
          key: "agent-9",
          label: "Claude",
          cmd: "claude",
          cwd: "/p",
          kind: "agent",
          sessionId: "uuid-1",
          agentMode: "plan",
        },
      ],
      "/p",
      "p",
    );
    const tabs = useTabsStore.getState().tabsByScope["p"];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].agentMode).toBe("plan");
    expect(tabs[0].args).toEqual(["--resume", "uuid-1", "--permission-mode", "plan"]);
  });

  it("a tab with no persisted mode restores exactly as before (no flag added)", () => {
    useTabsStore.getState().loadFromLayout(
      [
        {
          key: "agent-9",
          label: "Claude",
          cmd: "claude",
          cwd: "/p",
          kind: "agent",
          sessionId: "uuid-1",
        },
      ],
      "/p",
      "p",
    );
    const tabs = useTabsStore.getState().tabsByScope["p"];
    expect(tabs[0].args).toEqual(["--resume", "uuid-1"]);
    expect(tabs[0].agentMode).toBeUndefined();
  });
});
