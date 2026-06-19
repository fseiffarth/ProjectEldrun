/**
 * Save-side tab persistence filtering. Shell/files tabs always survive a
 * restart. Resumable agent tabs (Claude or Codex with a sessionId) now survive
 * too and carry their sessionId; an agent tab without a sessionId, or a
 * not-yet-wired agent (Gemini/Vibe), is still dropped. These tests lock in
 * saveLayout's keep-filter and the shared pruneSavedTree / isRestorableKind /
 * isResumableAgentTab / isRestorableTab helpers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import {
  isRestorableKind,
  isResumableAgentTab,
  isRestorableTab,
  pruneSavedTree,
  useTabsStore,
  type SavedLayoutTree,
} from "../stores/tabs";

const invokeMock = vi.mocked(invoke);

describe("isRestorableKind", () => {
  it("keeps shell and files, drops agent and local_agent", () => {
    expect(isRestorableKind("shell")).toBe(true);
    expect(isRestorableKind("files")).toBe(true);
    expect(isRestorableKind("agent")).toBe(false);
    expect(isRestorableKind("local_agent")).toBe(false);
  });
});

describe("isResumableAgentTab / isRestorableTab", () => {
  it("treats a Claude or Codex agent tab with a sessionId as resumable", () => {
    for (const cmd of ["claude", "codex"]) {
      const tab = { kind: "agent" as const, cmd, sessionId: "abc-123" };
      expect(isResumableAgentTab(tab)).toBe(true);
      expect(isRestorableTab(tab)).toBe(true);
    }
  });

  it("drops a resumable-agent tab without a sessionId", () => {
    for (const cmd of ["claude", "codex"]) {
      const tab = { kind: "agent" as const, cmd };
      expect(isResumableAgentTab(tab)).toBe(false);
      expect(isRestorableTab(tab)).toBe(false);
    }
  });

  it("drops a not-yet-wired agent even with a sessionId", () => {
    for (const cmd of ["gemini", "vibe"]) {
      const tab = { kind: "agent" as const, cmd, sessionId: "abc-123" };
      expect(isResumableAgentTab(tab)).toBe(false);
      expect(isRestorableTab(tab)).toBe(false);
    }
  });

  it("keeps shell/files tabs via kind regardless of sessionId", () => {
    expect(isRestorableTab({ kind: "shell", cmd: "bash" })).toBe(true);
    expect(isRestorableTab({ kind: "files", cmd: "__eldrun_files__" })).toBe(true);
  });
});

describe("pruneSavedTree", () => {
  it("drops keys not in the keep set and collapses emptied groups", () => {
    const tree: SavedLayoutTree = {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "group", tabKeys: ["agent-1"], activeKey: "agent-1" },
        { type: "group", tabKeys: ["shell-1", "agent-2"], activeKey: "agent-2" },
      ],
    };
    const pruned = pruneSavedTree(tree, new Set(["shell-1"]));
    // The agent-only group collapses; the split with one survivor collapses too.
    expect(pruned).toEqual({ type: "group", tabKeys: ["shell-1"], activeKey: "shell-1" });
  });

  it("returns null when nothing survives", () => {
    const tree: SavedLayoutTree = { type: "group", tabKeys: ["agent-1"], activeKey: "agent-1" };
    expect(pruneSavedTree(tree, new Set())).toBeNull();
  });
});

describe("saveLayout — persists restorable tabs (incl. resumable agents)", () => {
  beforeEach(() => {
    invokeMock.mockClear();
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
  });

  it("keeps a Claude agent tab with a sessionId (with its sessionId) and shell/files", async () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    store.addTab({
      label: "claude",
      cmd: "claude",
      cwd: "/p",
      kind: "agent",
      sessionId: "abc-123",
    });
    store.addTab({ label: "bash", cmd: "bash", cwd: "/p", kind: "shell" });
    store.addTab({ label: "Files", cmd: "__eldrun_files__", cwd: "/p", kind: "files" });

    await useTabsStore.getState().saveLayout("/p/project.json");

    const call = invokeMock.mock.calls.find((c) => c[0] === "save_tab_layout");
    expect(call).toBeTruthy();
    const arg = call![1] as {
      tabs: { kind: string; cmd: string; sessionId?: string }[];
      groups: SavedLayoutTree | null;
    };
    expect(arg.tabs.map((t) => t.kind).sort()).toEqual(["agent", "files", "shell"]);
    const claude = arg.tabs.find((t) => t.cmd === "claude");
    expect(claude?.sessionId).toBe("abc-123");
    // The resumable agent key survives in the persisted tree.
    expect(JSON.stringify(arg.groups)).toContain("agent");
  });

  it("drops a Claude agent tab without a sessionId and prunes the tree", async () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    store.addTab({ label: "claude", cmd: "claude", cwd: "/p", kind: "agent" });
    store.addTab({ label: "bash", cmd: "bash", cwd: "/p", kind: "shell" });

    await useTabsStore.getState().saveLayout("/p/project.json");

    const call = invokeMock.mock.calls.find((c) => c[0] === "save_tab_layout");
    const arg = call![1] as { tabs: { kind: string }[]; groups: SavedLayoutTree | null };
    expect(arg.tabs.map((t) => t.kind)).toEqual(["shell"]);
    expect(JSON.stringify(arg.groups)).not.toContain("agent");
  });

  it("keeps a Codex agent tab with a sessionId", async () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    store.addTab({
      label: "codex",
      cmd: "codex",
      cwd: "/p",
      kind: "agent",
      sessionId: "codex-key-1",
    });
    store.addTab({ label: "bash", cmd: "bash", cwd: "/p", kind: "shell" });

    await useTabsStore.getState().saveLayout("/p/project.json");

    const call = invokeMock.mock.calls.find((c) => c[0] === "save_tab_layout");
    const arg = call![1] as { tabs: { kind: string; cmd: string; sessionId?: string }[] };
    const codex = arg.tabs.find((t) => t.cmd === "codex");
    expect(codex?.sessionId).toBe("codex-key-1");
  });

  it("drops a not-yet-wired agent even with a sessionId", async () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    store.addTab({
      label: "gemini",
      cmd: "gemini",
      cwd: "/p",
      kind: "agent",
      sessionId: "abc-123",
    });
    store.addTab({ label: "bash", cmd: "bash", cwd: "/p", kind: "shell" });

    await useTabsStore.getState().saveLayout("/p/project.json");

    const call = invokeMock.mock.calls.find((c) => c[0] === "save_tab_layout");
    const arg = call![1] as { tabs: { kind: string }[]; groups: SavedLayoutTree | null };
    expect(arg.tabs.map((t) => t.kind)).toEqual(["shell"]);
    expect(JSON.stringify(arg.groups)).not.toContain("agent");
  });
});
